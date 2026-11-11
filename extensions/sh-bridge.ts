/**
 * sh-bridge — call ANY registered tool of this session from the shell side
 * (Phase-0 tail, PLAN.md Ф0 in ~/projects/pi-fresh). The engine-free
 * replacement for fabric's FABRIC_SOCK tool delegation.
 *
 * Two surfaces, ONE executor:
 *   - the `tools_call` tool (model-facing): delegates to any other tool via
 *     ctx.executeTool — including tools with codemode/deferred exposure that
 *     never appear on the model surface;
 *   - a per-session Unix socket exported to child env as PI_TOOLS_SOCK:
 *     newline-delimited JSON, one request {"tool", "args", "background"} →
 *     one response {"ok", ...result|error}. The `pit` CLI (bin/pit) is the
 *     shell-side client; children (pi -p, subagent shells) inherit the env
 *     var and delegate the same way.
 *
 * ARMING (host API constraint, verified against pi 1.5.0): executeTool
 * exists ONLY on the context handed to a tool's execute() — event-handler
 * contexts never carry it. So the socket server borrows the executeTool
 * captured at the LAST tools_call execute (latest wins; the closure stays
 * valid for the runner's lifetime). Before the first tools_call execute the
 * bridge is unarmed and answers with an actionable error. Exposure is
 * therefore "direct" (docs have no literal 'callable' value): the model must
 * be able to reach the tool, or the capture would never happen.
 *
 * background:true routes through the shell-bg job/wake-card path: the
 * request returns at once with a job handle, the tool runs detached, its
 * result lands in the job log and completion wakes this session with the
 * typed bg event — exactly like a detached shell command.
 *
 * Fail-open: bridge infrastructure errors (socket dir unavailable, listen
 * failure) warn on stderr and disable the socket; they never break a session.
 */
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { appendFileSync, chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { bindBg, bgTail, registerBgJob, setBgOwnerSession, wakeSession, type BgJob } from './shell-bg.ts';

/** Socket directory, one socket per session id (mirrors session-owner's pi-owners). */
export const SOCK_DIR = join(process.env.XDG_RUNTIME_DIR || '/tmp', 'pi-tools');
/** Pseudo-tool name the socket serves tool listings under (keeps the wire protocol untouched). */
export const LIST_TOOL = '_list';

type ExecuteToolFn = ExtensionToolContext['executeTool'];
/** The borrowed nested-call handle from the last tools_call execute; undefined = unarmed. */
let armed: ExecuteToolFn | undefined;

/** Footer status surface (TUI/RPC); captured at session_start, best-effort. */
let uiStatus: { setStatus?: (key: string, value: string | undefined) => void } | undefined;

const refreshStatus = (): void => {
  try {
    uiStatus?.setStatus?.('pit', armed ? '⇅ pit' : '· pit');
  } catch {
    /* footer is cosmetic: never fail arming on it */
  }
};

const setArmed = (fn: ExecuteToolFn | undefined): void => {
  armed = fn;
  refreshStatus();
};

/** Cold-bridge probe: the pure contour rides the anchor on the first run while this is false. */
export function isArmed(): boolean {
  return armed !== undefined;
}

export function armFromExecute(ctx: { executeTool?: ExecuteToolFn } | undefined): void {
  if (typeof ctx?.executeTool === 'function') setArmed(ctx.executeTool);
}

let piRef: ExtensionAPI | undefined;
let server: Server | undefined;
let sockPath: string | undefined;

/** Text of an AgentToolResult's content blocks (the part shells actually read). */
const resultText = (r: { content?: unknown } | undefined): string =>
  Array.isArray(r?.content)
    ? (r.content as { type?: string; text?: unknown }[])
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
    : '';

/**
 * Run one delegated call on the armed handle. A stale handle (runner
 * invalidated by reload/session replacement) reads as unarmed, not as a
 * tool failure — the caller is told how to re-arm.
 */
async function runArmed(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; content: unknown; details: unknown; durationMs?: number } | { ok: false; error: string }> {
  if (!armed) {
    return {
      ok: false,
      error: 'bridge not armed: pi exposes executeTool only inside a tool execute — call the tools_call tool once in this session, then retry',
    };
  }
  try {
    // Fresh never-aborting signal: the captured default would inherit the
    // FIRST tools_call call's signal, and an aborted parent must not kill
    // later socket-side runs.
    const outcome = await armed(tool, args, { signal: new AbortController().signal });
    return {
      ok: !outcome.isError,
      content: outcome.result.content,
      details: outcome.result.details,
      ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
    };
  } catch (e) {
    setArmed(undefined); // stale/throwing handle: force re-arm on the next execute
    refreshStatus();
    return { ok: false, error: `bridge handle failed (${(e as Error).message}) — call tools_call once to re-arm` };
  }
}

/** background:true path: job handle now, typed wake card when the tool settles. */
const runDetached = (job: BgJob, tool: string, args: Record<string, unknown>): void => {
  runArmed(tool, args).then((r) => {
    const text = r.ok ? resultText({ content: r.content }) || JSON.stringify(r.content) : `error: ${r.error}`;
    try {
      appendFileSync(job.logPath, `${text}\n`);
    } catch {
      /* best effort: the wake tail still carries the outcome */
    }
    wakeSession(job, r.ok ? 0 : 1, false, bgTail(text));
  });
};

/** One request line → one response line (the whole wire protocol). */
async function serveRequest(req: unknown): Promise<Record<string, unknown>> {
  if (req === null || typeof req !== 'object') return { ok: false, error: 'bad request: expected a JSON object' };
  const { tool, args, background } = req as { tool?: unknown; args?: unknown; background?: unknown };
  if (tool === LIST_TOOL) {
    const tools = piRef?.getAllTools() ?? [];
    return {
      ok: true,
      tools: tools.map((t) => ({
        name: t.name,
        exposure: (t as { exposure?: string }).exposure ?? 'direct',
        description: (t as { description?: string }).description ?? '',
        parameters: (t as { parameters?: unknown }).parameters ?? undefined,
      })),
    };
  }
  if (typeof tool !== 'string' || tool.length === 0) return { ok: false, error: 'bad request: "tool" must be a tool name' };
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args)))
    return { ok: false, error: 'bad request: "args" must be a JSON object' };
  const callArgs = (args ?? {}) as Record<string, unknown>;
  if (background === true) {
    if (!armed) {
      return {
        ok: false,
        error: 'bridge not armed: pi exposes executeTool only inside a tool execute — call the tools_call tool once in this session, then retry',
      };
    }
    // Same registry a detached shell command lands in: id, log file with the
    // index line, footer segment, completion wake (shell-bg owns the sweep).
    const job = registerBgJob(undefined, `tools_call ${tool}`, Date.now(), '');
    setTimeout(() => runDetached(job, tool, callArgs), 0).unref?.();
    return { ok: true, background: true, job: { id: job.id, logPath: job.logPath } };
  }
  return runArmed(tool, callArgs);
}

const handleConn = (sock: Socket): void => {
  let buf = '';
  sock.on('data', (d: Buffer) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length === 0) continue;
      let req: unknown;
      try {
        req = JSON.parse(line);
      } catch (e) {
        sock.write(`${JSON.stringify({ ok: false, error: `bad request: ${e instanceof Error ? e.message : String(e)}` })}\n`);
        continue;
      }
      serveRequest(req)
        .then((res) => sock.write(`${JSON.stringify(res)}\n`))
        .catch((e: unknown) => sock.write(`${JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })}\n`));
    }
  });
  sock.on('error', () => undefined); // a died client never kills the server
};

/** Start (or restart) the per-session socket; fail-open on infra errors. */
const startServer = (pi: ExtensionAPI, sid: string | null): void => {
  piRef = pi;
  stopServer(); // reload edge: never leak a previous listener
  bindBg(pi); // bg wake (sendMessage) works even before the first shell call
  setBgOwnerSession(sid); // same stamp the shell arms session_start with
  const name = `${sid ?? `pid${process.pid}`}.sock`;
  try {
    mkdirSync(SOCK_DIR, { recursive: true });
    chmodSync(SOCK_DIR, 0o700);
    sockPath = join(SOCK_DIR, name);
    try {
      unlinkSync(sockPath); // a dead session's leftover would EADDRINUSE
    } catch {
      /* not there: clean listen */
    }
    server = createServer(handleConn);
    server.listen(sockPath);
    chmodSync(sockPath, 0o600); // session-private: only this user's children
    process.env.PI_TOOLS_SOCK = sockPath; // children inherit at spawn time
  } catch (e) {
    process.stderr.write(`sh-bridge: socket unavailable (${(e as Error).message}) — pit calls disabled, tools_call still works\n`);
    server = undefined;
    sockPath = undefined;
  }
};

const stopServer = (): void => {
  try {
    server?.close();
  } catch {
    /* best effort */
  }
  server = undefined;
  if (sockPath) {
    try {
      unlinkSync(sockPath);
    } catch {
      /* already gone */
    }
    if (process.env.PI_TOOLS_SOCK === sockPath) delete process.env.PI_TOOLS_SOCK;
    sockPath = undefined;
  }
  setArmed(undefined);
  refreshStatus();
};

export default function (pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx: ExtensionContext) => {
    const sid = ctx.sessionManager?.getSessionId?.() ?? null;
    uiStatus = ctx.ui as { setStatus?: (key: string, value: string | undefined) => void } | undefined;
    refreshStatus();
    startServer(pi, sid);
  });

  pi.on('session_shutdown', () => stopServer());

  pi.registerCommand('pit-warm', {
    description: 'Warm the pit bridge: the next run declares the tools_call anchor once (the pure contour does this automatically while the bridge is cold)',
    handler: async (ctx) => {
      if (isArmed()) {
        try {
          ctx.ui?.notify?.('pit bridge is already warm', 'info');
        } catch {
          /* cosmetic */
        }
        return;
      }
      if (process.env.PI_SH_BARE === '1') {
        try {
          ctx.ui?.notify?.('bare contour: bridge stays cold by design (PI_SH_BARE) — spawn without it to use pit', 'info');
        } catch {
          /* cosmetic */
        }
        return;
      }
      // Same delivery channel as bg-wake (sendLocalWake in shell-bg):
      // invisible to the operator, still read by the model, triggers the turn.
      pi.sendMessage(
        {
          customType: 'pit-warm-request',
          content:
            'Прогрев моста: прямо сейчас один раз вызови тул tools_call с {"tool":"bash","args":{"command":"echo pit-warm"}} и продолжай нормально.',
          display: false,
        },
        { deliverAs: 'steer', triggerTurn: true },
      );
    },
  });

  pi.registerTool({
    name: 'tools_call',
    label: 'Tools call',
    exposure: 'direct',
    description:
      'Call any registered tool of this session by name (including tools not on your surface, ' +
      'like codemode/deferred ones). Also the arming surface for the pit CLI: child processes ' +
      'reach this bridge through the PI_TOOLS_SOCK socket, which borrows the executeTool handle ' +
      'captured by THIS tool\'s execution — so a session where tools_call never ran cannot serve ' +
      'pit calls. background:true returns a job handle at once and wakes this session on completion.',
    parameters: Type.Object({
      tool: Type.String({ description: 'Tool name to execute (see pit list / getAllTools).' }),
      args: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: 'Arguments object for the tool.' })),
      background: Type.Optional(Type.Boolean({ description: 'Detach: return a job handle now, wake this session on completion.' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      setArmed(ctx.executeTool); // latest execute wins: always the live runner's handle
      const res = await serveRequest({ tool: params.tool, args: params.args, background: params.background });
      const text = res.ok
        ? resultText({ content: res.content }) || JSON.stringify(res.content)
        : `error: ${res.error ?? 'no reason given (nested calls can be unavailable mid-message in print mode — the bridge is armed regardless)'}`;
      return {
        content: [{ type: 'text', text: res.ok ? text || '(no output)' : text }],
        details: res as unknown as Record<string, unknown>,
        ...(res.ok ? {} : { isError: true }),
      };
    },
  });
}
