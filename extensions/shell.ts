/**
 * shell-lab — the one tool: `shell`.
 *
 * One command in, one result out. The execution itself (spawn bash --norc,
 * BASH_ENV env, bounded output, timeout + abort, orphan grace, hang-detach)
 * lives in the ONE shared core ./shell-exec.ts — the prose arm calls the same
 * core, so a command behaves identically on both surfaces. This file is the
 * tool surface: gate → core → postProcess, plus the render/description.
 * Shell path pinned in shell-exec.ts — flip to '/bin/sh' to go FreeBSD sh.
 *
 * Gate adoption (wave-3 re-scope step 1, gap-table rows 2-3 ADOPTION; the
 * fork landed the policy facade in main 813998d5): the pre-exec gate and
 * postProcess route through the host shell policy facade over pi.events
 * (pi-fabric:shell-policy:{gate,post,config}:v1 — see pi-fabric
 * src/core/shell-policy-facade.ts + protocol.ts FabricShellPolicyFacadeV1)
 * whenever its config channel answers available:true. The duplicated lab
 * policy machinery is RETIRED from this file: the real shellcheck invocation
 * (+ SC exclude list, determinism env-stripping, MAX_ISSUES formatting), the
 * retry valve, the output offload/digest/sniff budget, the LAB_RULES
 * footnote and the local PI_SHELL_GATE kill switch — all of it lives in the
 * host middleware once now (FabricShellPolicyMiddleware), shared with
 * fabric_exec's own arm, so "everything executed passed the gate" holds.
 * The standalone FALLBACK (facade absent: bun tests, plain pi hosts without
 * pi-fabric, config not yet bootstrapped) is deliberately minimal: a
 * `bash --norc -n` parse check in front of the command, and a postProcess
 * that passes output through untouched — no lint, no offload, no hints.
 *
 * Kill switch — one name total: the facade honors PI_FABRIC_SHELL_GATE=off
 * per call on the host side (config channel reports the name); the legacy
 * PI_SHELL_GATE alias died with this adoption and is honored nowhere.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { highlightCode, observePiTheme } from './highlight-stub.ts';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { spawnSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
// The auto-background core (job registry + footer segment, detached log
// files, completion wake, orphan sweep) lives in ./shell-bg.ts: shared by
// both arms, so both surfaces detach identically.
import {
  BG_ENABLED,
  BG_MARKER,
  bindBg,
  setBgOwnerSession,
  sweepOrphans,
} from './shell-bg.ts';
// Council step 1 — the ONE execution core: spawn (bash --norc), timeout,
// output-cap, hang-detach via shell-bg, exit/ms/timedOut. The prose arm's
// runBlock is a thin wrapper over the same runShellExec; the regression
// tests pin both arms to the same exit/output. Tool-arm behavior unchanged.
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  SHELL,
  runShellExec,
  type ShellExecOutcome,
} from './shell-exec.ts';
// Zone A.6 (shared): the BG_EVENT_TYPE wake-card renderer lives with the
// other card builders in shell-prose.ts; registering it here too covers the
// tool arm (PI_SHELL_PROSE off/soft) — map-set, idempotent across arms.
import { registerBgEventRenderer } from './shell-prose.ts';

// ---- call telemetry ---------------------------------------------------------

// One JSONL line per call (blocked ones too — that is the friction
// signal) for practice-week metrics and future hint patterns. Fail-open,
// fire-and-forget: telemetry must never slow or break a command.
// (The env contract — BASH_ENV → .pi/agent-env.sh — moved into the shared
// execution core, so both arms resolve the same PATH/PLAN9.)
// Post-adoption each line also records WHERE the policy ran: gate/post are
// 'facade' (host shell policy via pi.events) or 'fallback' (standalone
// parse check / pass-through) — the legacy-fallback telemetry line the
// synthesis demanded, on every call that did not go through the facade.
const CALLS_LOG = join(process.cwd(), '.pi', 'calls.jsonl');

let logWarnedOnce = false;
function logCall(entry: Record<string, unknown>): void {
  appendFile(CALLS_LOG, JSON.stringify(entry) + '\n', 'utf8').catch(() => {
    logWarnedOnce = true; // silent: console noise shreds the TUI
  });
}

// ---- background -----------------------------------------------------------
//
// Execution (spawn/timeout/output-cap/orphan-grace/hang-race) is the shared
// core ./shell-exec.ts. The bg infrastructure it detaches INTO (job registry,
// footer 'bg: N running', BG_EVENT_TYPE wake with the untrusted preamble,
// bgTail bound, orphan sweep) is imported from ./shell-bg.ts — see that file
// for the full contract.

// ---- shell policy facade (gate adoption, wave-3) --------------------------
//
// The fork publishes ONE shell policy — pre-exec gate + output budget, the
// exact middleware fabric_exec runs — as extension API over pi.events
// (mirroring the PR2 background-job publication). This module is a thin
// CLIENT, not a second policy. The wire: emit a versioned request carrying a
// `respond` callback; the host's registered listener answers synchronously
// (pi's EventBus invokes handlers during emit), so the answer is on hand
// before emit returns.
//
// Availability is re-probed on the config channel per call: the host
// resolves executor.shellPolicy lazily at session bootstrap, so a tool
// registered before the session config must not latch a stale
// available:false. config:v1 also reports the kill-switch name and the
// thresholds — read from the answer, never re-guessed here.
//
// Routing is fail-safe toward the FALLBACK, never toward a block: bus
// absent, emit throwing, no listener answering (nothing registered, or the
// host's reader refused the payload), oversized command/output past the
// wire caps, or a malformed answer — every one of those takes the
// standalone path below. No verdict is ever invented from garbage.

export const SHELL_POLICY_GATE_CHANNEL = 'pi-fabric:shell-policy:gate:v1';
export const SHELL_POLICY_POST_CHANNEL = 'pi-fabric:shell-policy:post:v1';
export const SHELL_POLICY_CONFIG_CHANNEL = 'pi-fabric:shell-policy:config:v1';
/** The ONE gate kill switch, honored by the facade per call on the host
 * side. The legacy PI_SHELL_GATE alias was removed at adoption. */
export const SHELL_POLICY_KILL_SWITCH_ENV = 'PI_FABRIC_SHELL_GATE';
/** Wire cap from the protocol (MAX_FABRIC_SHELL_JOB_COMMAND): past it the
 * host reader refuses the request, so the facade is skipped up front. */
export const MAX_SHELL_POLICY_COMMAND = 16_384;
/** Wire cap from the protocol (MAX_FABRIC_SHELL_POLICY_OUTCOME_OUTPUT). */
export const MAX_SHELL_POLICY_OUTCOME_OUTPUT = 262_144;

/** What the config channel answers (FabricShellPolicyConfigSurfaceV1 shape,
 * mirrored structurally — the lab does not import the fork's protocol). */
export interface ShellPolicyConfigSnapshot {
  version: 1;
  /** False before the session config exists: gate never blocks, post passes. */
  available: boolean;
  /** Pre-exec gate half configured on (the kill switch still wins per call). */
  gate: boolean;
  /** Post-exec output budget half configured on. */
  outputBudget: boolean;
  /** Env var whose value `off` disables the gate — checked on the host side. */
  killSwitchEnv: string;
  offloadBytes: number;
  offloadOneLineBytes: number;
  dumpDir: string;
}

/** The block verdict rides as its message only (FabricExecutionPolicyBlockV1:
 * the host already formatted the model-facing diagnostic; the lab passes the
 * string through and never re-renders findings). The post verdict is the
 * {notes, output} pair defined below. */
interface ShellPolicyPostResultV1 {
  notes: string[];
  output: string;
}

/** Structural slice of pi's EventBus the client needs. */
type PolicyBus = { emit(channel: string, data: unknown): void };

let policyBus: PolicyBus | null = null;

/** Bind the bus the policy channels live on (pi.events at registration).
 * Pass null to detach — the standalone fallback takes over. Any (re)bind
 * invalidates the stored config snapshot: a snapshot taken from another bus
 * (or a detached one) must never read as the live facade's answer. */
export function bindShellPolicyBus(bus: PolicyBus | null): void {
  policyBus = bus;
  lastConfig = null;
}

/** One synchronous round-trip on a policy channel. Returns undefined when
 * the bus is absent, emit throws, or no listener called respond — all of
 * those mean "facade not there", and the caller takes its fallback path. */
function facadeAsk(
  channel: string,
  request: Record<string, unknown>,
): { answered: true; value: unknown } | undefined {
  if (!policyBus) return undefined;
  let value: unknown;
  let answered = false;
  try {
    policyBus.emit(channel, {
      ...request,
      respond: (v: unknown) => {
        answered = true;
        value = v;
      },
    });
  } catch {
    return undefined; // a throwing listener is a broken channel, not a verdict
  }
  return answered ? { answered: true, value } : undefined;
}

let lastConfig: ShellPolicyConfigSnapshot | null = null;

/** Ask the config channel; store + return the snapshot. null = no facade or
 * a malformed surface (never guessed into shape). */
export function probeShellPolicyConfig(): ShellPolicyConfigSnapshot | null {
  const r = facadeAsk(SHELL_POLICY_CONFIG_CHANNEL, { version: 1 });
  const v = r?.value;
  if (
    typeof v !== 'object' ||
    v === null ||
    (v as Record<string, unknown>).version !== 1 ||
    typeof (v as Record<string, unknown>).available !== 'boolean'
  ) {
    lastConfig = null;
    return null;
  }
  const c = v as Record<string, unknown>;
  lastConfig = {
    version: 1,
    available: c.available as boolean,
    gate: c.gate === true,
    outputBudget: c.outputBudget === true,
    killSwitchEnv: typeof c.killSwitchEnv === 'string' ? c.killSwitchEnv : SHELL_POLICY_KILL_SWITCH_ENV,
    offloadBytes: typeof c.offloadBytes === 'number' && Number.isFinite(c.offloadBytes) ? c.offloadBytes : 0,
    offloadOneLineBytes:
      typeof c.offloadOneLineBytes === 'number' && Number.isFinite(c.offloadOneLineBytes)
        ? c.offloadOneLineBytes
        : 0,
    dumpDir: typeof c.dumpDir === 'string' ? c.dumpDir : '',
  };
  return lastConfig;
}

/** The stored registration/per-call config snapshot (null = facade absent). */
export function shellPolicyConfig(): ShellPolicyConfigSnapshot | null {
  return lastConfig;
}

/** Facade usable RIGHT NOW: config channel answered with available:true. */
function facadeLive(): boolean {
  return probeShellPolicyConfig()?.available === true;
}

/** Gate via the facade. undefined = facade not usable this call; null =
 * may run; string = block diagnostic (host-formatted, passed through). */
function facadeGate(cmd: string): string | null | undefined {
  if (cmd.length > MAX_SHELL_POLICY_COMMAND) return undefined;
  const r = facadeAsk(SHELL_POLICY_GATE_CHANNEL, { version: 1, command: cmd });
  if (!r) return undefined;
  const v = r.value;
  if (v === null) return null;
  if (typeof v === 'object' && v !== null) {
    const b = v as Record<string, unknown>;
    if (b.version === 1 && typeof b.message === 'string' && b.message.length > 0) return b.message;
  }
  return undefined; // garbage answer is not a verdict: fall back, don't guess
}

/** Post via the facade. undefined = facade not usable this call. */
function facadePost(cmd: string, result: ShellResult): ShellPolicyPostResultV1 | undefined {
  const output = result?.output;
  if (typeof output !== 'string') return undefined;
  if (cmd.length > MAX_SHELL_POLICY_COMMAND || output.length > MAX_SHELL_POLICY_OUTCOME_OUTPUT) {
    return undefined; // the host reader would refuse the payload
  }
  const outcome = { ok: result.ok === true, exitCode: result.exitCode ?? null, output };
  const r = facadeAsk(SHELL_POLICY_POST_CHANNEL, { version: 1, command: cmd, outcome });
  if (!r) return undefined;
  const v = r.value;
  if (typeof v !== 'object' || v === null) return undefined;
  const p = v as Record<string, unknown>;
  if (
    !Array.isArray(p.notes) ||
    !p.notes.every((n) => typeof n === 'string') ||
    typeof p.output !== 'string'
  ) {
    return undefined;
  }
  return { notes: p.notes as string[], output: p.output };
}

export type PolicyRoute = 'facade' | 'fallback';

/** Pre-exec gate, adopted form. Facade live → its verdict (kill switch
 * PI_FABRIC_SHELL_GATE honored host-side, per call); else the minimal
 * standalone parse check. `route` feeds the telemetry line. Exported for
 * tests; gateCheck is the plain block/null view. */
export function gateRoute(cmd: string): { block: string | null; route: PolicyRoute } {
  if (facadeLive()) {
    const verdict = facadeGate(cmd);
    if (verdict !== undefined) return { block: verdict, route: 'facade' };
  }
  return { block: fallbackGate(cmd), route: 'fallback' };
}

/** Standalone fallback: ONLY a bash -n parse check. No lint, no valve, no
 * switch — that machinery lives in the host facade now; this path exists so
 * facade-less hosts (tests, plain pi) keep a cheap syntax tripwire. */
function fallbackGate(cmd: string): string | null {
  const parseErr = gateBashN(cmd);
  if (parseErr) return `shell-gate: bash cannot parse this — fix before running:\n${parseErr}`;
  return null;
}

/** Block message, or null when the command may run. Exported for tests
 * (shell-exec.test.ts smoke-imports it alongside postProcess). */
export function gateCheck(cmd: string): string | null {
  return gateRoute(cmd).block;
}

/** Parse layer. null = gate broken (fail-open) or command parses. The one
 * check the lab keeps when the facade is absent. */
function gateBashN(cmd: string): string | null {
  try {
    const r = spawnSync(SHELL, ['--norc', '-n', '-c', cmd], {
      timeout: 5_000,
      encoding: 'utf8',
    });
    if (r.error || r.signal) return null;
    if (r.status === 0) return null;
    const out = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.trim();
    return out.length > 0 ? out.slice(0, 600) : 'bash refused to parse the command';
  } catch {
    return null;
  }
}

/** Post-exec budget, adopted form. Facade live → its notes + digested
 * output (offload pointer, JSON hint, `# full` valve — host-side); else the
 * output passes through untouched. Exported for tests. */
export function postRoute(
  cmd: string,
  result: ShellResult,
): { notes: string[]; output: string; route: PolicyRoute } {
  if (facadeLive()) {
    const viaFacade = facadePost(cmd, result);
    if (viaFacade) return { notes: viaFacade.notes, output: viaFacade.output, route: 'facade' };
  }
  return { notes: [], output: result.output, route: 'fallback' };
}

/** Post-process a finished run (plain view; shell-exec.test.ts smoke-imports
 * it). The old local offload/digest/sniff machinery died at adoption. */
export function postProcess(cmd: string, result: ShellResult): { notes: string[]; output: string } {
  const r = postRoute(cmd, result);
  return { notes: r.notes, output: r.output };
}

// ---- post-exec context guard ----------------------------------------------
// RETIRED here at adoption: the dump-dir offload, digest, JSON sniff, `# full`
// valve and hints now run ONCE in the host middleware and reach this tool via
// the facade post channel. The facade's answer replaces the old local block;
// see the header for what the facade-less fallback does (nothing).

// ---- the call row (renderCall) --------------------------------------------
//
// Compact one-row view of the call for the operator (PLAN TODO:314): an
// accent prompt glyph (theme.fg('accent')), the FIRST command line
// bash-highlighted via highlightCode (the preloaded-grammar path the default
// fallback renderer also uses — colors come from the theme, never literals),
// and multi-line commands collapsed to a `… +N lines` marker (same marker
// the prose cards use). The rest of a long command is deliberate opacity:
// the row is a map pin, not a transcript. Pure and exported so render tests
// pin the bytes without any UI.

/** The call row separator: `$ <first line>`. The tool name is redundant next
 * to `$` (operator, 2026-11-11: «shell + $ - масло масляное») and the ❯
 * glyph stays OUT of the call row — it belongs to result cards only
 * (fork tool-result-card.ts). */
const CALL_ROW_PROMPT = '$';

/** Structural slice of Theme the call row needs (no Theme import: the mock
 * suites register plain objects, mirroring workers-dock's CardTheme). */
type CallTheme = { fg(color: string, text: string): string };

/** Normalized cmd for the call row: string as-is; array of lines joined with
 * \n with ONE trailing empty line dropped — the exact rule execute() applies,
 * so the row never shows a line count the run will not have. */
export function callRowCmd(args: unknown): string {
  const raw = (args as { cmd?: unknown } | null | undefined)?.cmd;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const joined = raw.filter((l) => typeof l === 'string').join('\n');
    return joined.endsWith('\n') ? joined.slice(0, -1) : joined;
  }
  return '';
}

/** The row body: dim `$` prompt + first line (highlighted, bold
 * like the prose cards' command line) [+ `… +N lines`]. Empty/absent cmd
 * renders the `...` placeholder the upstream tools use. Bold is guarded:
 * mock/plain themes in tests and older hosts may not carry it (same guard as
 * buildCardLines). */
export function shellCallLine(args: unknown, theme: CallTheme): string {
  const lines = callRowCmd(args).split('\n');
  const first = (lines[0] ?? '').trimEnd();
  const boldable = theme as CallTheme & { bold?: (text: string) => string };
  const bold = (s: string): string => (typeof boldable.bold === 'function' ? boldable.bold(s) : s);
  // Shiki-backed highlighter (pi-fabric/highlight): returns null while the
  // highlighter lazily initializes or when highlighting is off - the row then
  // renders the plain first line and picks up colors on a later render pass.
  const highlighted = highlightCode(first, 'bash');
  const body =
    first.length > 0 ? bold((highlighted ?? [first]).join('\n')) : theme.fg('toolOutput', '...');
  const folded = lines.length > 1 ? theme.fg('muted', ` … +${lines.length - 1} lines`) : '';
  return theme.fg('dim', CALL_ROW_PROMPT) + ' ' + body + folded;
}

// Bodies already pushed into a reused row component: the change detector for
// the cheap-update path (invalidate only when the bytes actually moved).
const callRowBody = new WeakMap<object, string>();

// ---- the tool ------------------------------------------------------------

export interface ShellResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
  /** Present when the call detached; the child keeps running in the background. */
  backgrounded?: boolean;
  taskId?: string;
  logPath?: string;
  pid?: number;
}

/**
 * Tool-surface mapping of the ONE core outcome (council step 1). Pure and
 * exported so the regression tests can pin both arms to the same bytes:
 * the tool sees the same outcome a prose block sees, dressed as ShellResult.
 */
export function toolResultFromOutcome(o: ShellExecOutcome): ShellResult {
  if (o.kind === 'background') {
    return {
      ok: true,
      exitCode: null,
      output:
        `[moved to background after ${o.seconds}s as task ${o.id} (pid ${o.pid ?? '?'}), completion steers this session]\n` +
        `log: ${o.logPath}\nPoll: tail ${o.logPath}; stop: kill ${o.pid ?? ''}\n` +
        `Output so far:\n${o.output}`,
      timedOut: false,
      aborted: false,
      backgrounded: true,
      taskId: o.id,
      logPath: o.logPath,
      pid: o.pid,
    };
  }
  let output = o.output;
  if (o.truncated && !o.orphans) {
    output += `\n[output truncated, kept last ${o.outputLines} of ${o.totalLines} lines]`;
  }
  return {
    ok: o.spawnError === true ? false : !o.timedOut && !o.aborted,
    exitCode: o.exitCode,
    output,
    timedOut: o.timedOut,
    aborted: o.aborted,
  };
}

export default function (pi: ExtensionAPI) {
  // HARD prose arm (PI_SHELL_PROSE=hard): the tool dissolves entirely -
  // the model acts only through prose blocks (shell-prose.ts). Registering
  // nothing is the whole point: no fallback channel exists in hard.
  if (process.env.PI_SHELL_PROSE === 'hard') return;

  // Gate adoption (wave-3): bind the policy bus and take the config-channel
  // snapshot at registration. gate/post re-probe availability per call, so
  // this snapshot is the boot-time answer (telemetry + shellPolicyConfig()
  // readers), not a latch on the live half.
  bindShellPolicyBus(pi.events);
  probeShellPolicyConfig();

  // Grab the UI context at load so the footer segment works before the
  // first shell call (execute() rebinds on every call).
  pi.on('session_start', (_event, ctx) => {
    bindBg(pi, ctx.ui); // sweep/wake need piRef + the footer uiRef before the first execute()
    try {
      registerBgEventRenderer(pi); // ⏿ wake cards render in the tool arm too
    } catch {
      /* never break session start over a renderer */
    }
    // The sweep is session-scoped: claim ownership FIRST (new logs carry the
    // stamp), then sweep only THIS session's dead jobs — the bg dir is global,
    // and a fresh session must not be fed another session's leftovers.
    const sid =
      (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.() ??
      null;
    setBgOwnerSession(sid);
    sweepOrphans(sid);
  });

  pi.registerTool({
    name: 'shell',
    label: 'Shell',
    description:
      'Run one shell command. Reading, searching, editing, agents, MCP — all of it is commands here. ' +
      'Long commands need NO special handling: past ~90s the call detaches automatically (log + handle returned; completion steers this session) — write the plain command, never "&" and never polling loops. ' +
      'Keep output small: pipe through head/jq/toonq. ' +
      'cmd may be a string or an array of lines (the lines are joined with \\n — no escaping needed).',
    parameters: Type.Object({
      cmd: Type.Union(
        [
          Type.String({
            description:
              'The shell command to run (multi-line ok). Alternatively pass an array of lines.',
          }),
          Type.Array(Type.String(), {
            description:
              'The command as an array of lines — joined with "\\n" (no escaping needed). A single trailing empty line is dropped.',
          }),
        ],
        {
          description:
            'The shell command to run: a string OR an array of lines — the array of lines is joined with "\\n", no escaping needed.',
        },
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: 'Kill the command after this many ms (default 120000, max 600000)',
        }),
      ),
    }),
    renderCall(args, theme, context) {
      try {
        observePiTheme(theme); // feed the live theme variant to the shiki highlighter
        const body = shellCallLine(args, theme);
        // Cheap updates (PLAN TODO:314): reuse the row's previous component
        // (streaming re-invokes renderCall per args chunk — one allocation
        // per call row, not per chunk). Duck-typed setText, not instanceof:
        // the component may come from a different module instance of pi-tui.
        const prev = context.lastComponent as Text | undefined;
        const component =
          prev && typeof prev.setText === 'function' ? prev : new Text('', 0, 0);
        const changed = callRowBody.get(component) !== body;
        component.setText(body); // same text → pi-tui keeps the wrapped-line cache
        if (changed && typeof component.invalidate === 'function') component.invalidate();
        callRowBody.set(component, body);
        return component;
      } catch (e) {
        // Defensive: any rendering failure hands the row back to pi's DEFAULT
        // renderer. The API-conformant mechanism is a throw — tool-execution
        // catches it and installs its own createCallFallback(); returning
        // undefined would skip that and render an empty region.
        throw e;
      }
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      bindBg(pi, ctx?.ui);
      const t0 = Date.now();
      // cmd accepts a string OR an array of lines (cheap authoring relief:
      // no escaping). Normalize once, before anything else — the bg marker,
      // gate, spawn, telemetry and postprocess all see the joined string.
      // A single trailing empty line in the array (editors like to add one)
      // is dropped.
      // Models stringify JSON arrays into the string param (observed live:
      // zai emitted cmd: '["echo", ...]' as TEXT). Coerce that back into the
      // array form so the authoring relief survives model behavior; a shell
      // test like '[ -f x ]' never parses as JSON, so the try/catch is safe.
      let rawCmd: string | string[] = params.cmd;
      if (typeof rawCmd === 'string' && rawCmd.startsWith('[')) {
        try {
          const parsed: unknown = JSON.parse(rawCmd);
          if (Array.isArray(parsed) && parsed.every((line): line is string => typeof line === 'string')) {
            rawCmd = parsed;
          }
        } catch {
          /* not JSON: an ordinary command that starts with '[' */
        }
      }
      const fromArray = Array.isArray(rawCmd);
      const joined = fromArray ? rawCmd.join('\n') : rawCmd;
      const cmd = fromArray && joined.endsWith('\n') ? joined.slice(0, -1) : joined;
      // Trailing "# bg" detaches at once; strip it before gate and postprocess.
      let cmdRun = cmd;
      let wantBg = false;
      if (BG_ENABLED && BG_MARKER.test(cmdRun)) {
        wantBg = true;
        cmdRun = cmdRun.replace(BG_MARKER, '').trimEnd();
      }
      // Adopted gate: the host facade when available (kill switch
      // PI_FABRIC_SHELL_GATE honored there, per call), else the standalone
      // parse check. No local env handling remains.
      const gate = gateRoute(cmdRun);
      if (gate.block) {
        logCall({
          ts: new Date().toISOString(),
          cmd: cmd.slice(0, 500),
          blocked: true,
          gate: gate.route,
          exit: null,
          ms: Date.now() - t0,
        });
        return {
          content: [
            {
              type: 'text',
              text: `exit: null\n[blocked by shell-gate, command not run]\n${gate.block}`.trimEnd(),
            },
          ],
          details: {
            ok: false,
            exitCode: null,
            output: gate.block,
            timedOut: false,
            aborted: false,
            blocked: true,
          },
        };
      }

      const explicitTimeout = typeof params.timeoutMs === 'number';
      const timeoutMs = Math.min(
        Math.max(Math.floor(params.timeoutMs ?? DEFAULT_TIMEOUT_MS), 1),
        MAX_TIMEOUT_MS,
      );

      // The ONE execution core (council step 1): spawn, timeout, output-cap,
      // orphan grace, hang-detach — identical for the tool and the prose arm.
      // An explicit timeoutMs is the caller's hard cap; without one a detached
      // job may run to the max instead of dying at the default foreground cap.
      // Live elapsed seconds ride onTick: UI-only partials (the model sees
      // only the final result).
      const result = toolResultFromOutcome(
        await runShellExec({
          cmd: cmdRun,
          timeoutMs: explicitTimeout ? timeoutMs : undefined,
          wantBg,
          signal,
          onTick: onUpdate
            ? () => {
                onUpdate({
                  content: [{ type: 'text', text: `[shell: running ${Math.round((Date.now() - t0) / 1000)}s]` }],
                  details: undefined,
                });
              }
            : undefined,
        }),
      );

      const post = postRoute(cmd, result);
      logCall({
        ts: new Date().toISOString(),
        cmd: cmd.slice(0, 500),
        blocked: false,
        gate: gate.route,
        post: post.route,
        exit: result.exitCode,
        ms: Date.now() - t0,
      });

      const notes: string[] = [`exit: ${result.exitCode} · ${((Date.now() - t0) / 1000).toFixed(1)}s`];
      if (result.timedOut) notes.push(`[killed by timeout after ${timeoutMs}ms]`);
      if (result.aborted) notes.push('[aborted]');
      notes.push(...post.notes);

      return {
        content: [{ type: 'text', text: `${notes.join(' ')}\n${post.output}`.trimEnd() }],
        details: result as unknown as Record<string, unknown>,
      };
    },
  });
}
