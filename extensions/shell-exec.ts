/**
 * shell-exec — the ONE execution core, shared by both arms (council step 1).
 *
 * One command in, one outcome out: spawn $SHELL -c <cmd> in the session cwd
 * (bash --norc family), the caller's env contract (BASH_ENV → .pi/agent-env.sh,
 * so both surfaces resolve the same PATH/PLAN9), bounded output
 * (truncateTail), timeout + abort kill, orphan grace for a bare `cmd &`
 * (grandchildren hold the pipes), and the hang race against the shell-bg
 * registry: past the threshold the RUNNING child detaches (log file, footer
 * segment, completion wake) and the outcome becomes a handle.
 *
 * WHY ONE CORE: the tool arm (shell.ts) and the prose arm (shell-prose.ts)
 * used to carry two independently written executors that had already drifted
 * (bg-detach, BASH_ENV, orphan grace lived only in the tool). Both arms now
 * call runShellExec; the wrappers only map their own surfaces. The reference
 * semantics are the TOOL arm's (historically the production surface; the
 * prose arm is the interface now) — the tool's behavior is unchanged by
 * this extraction; the prose arm converges to it.
 *
 * Policy layers stay in the callers on purpose (upstream PR №1 shapes them as
 * policy-middleware): the tool's gate (shellcheck) and postProcess, the
 * prose block's parse check and limits. This module is execution only:
 * spawn, timeout, output-cap, hang-detach, exit/ms/timedOut.
 */
import {
  truncateTail,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
} from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
// The auto-background infrastructure (constants, job registry + footer
// segment, detached log files, completion wake, orphan sweep) stays in
// ./shell-bg.ts; the core owns the detach race, the registry owns the jobs.
import {
  BG_ENABLED,
  BG_HANG_MS,
  bgTail,
  registerBgJob,
  wakeSession,
  type BgJob,
} from './shell-bg.ts';

export const SHELL = '/usr/local/bin/bash'; // future experiment: '/bin/sh' (FreeBSD sh)
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

// Non-interactive bash sources $BASH_ENV on every call: the project's
// .pi/agent-env.sh carries PATH/PLAN9 context (aliases stay out — they do
// not expand non-interactively). Missing file = no BASH_ENV, zero cost.
// ONE env for both arms — a command resolves identically no matter which
// surface invoked it.
//
// process.cwd() THROWS once the directory is gone (a repo rename + session
// resume leaves a dead cwd), so every call-time read must go through
// liveCwd(); LAST_KNOWN_CWD is captured at load — while the path still
// resolves — as the "expected path" the dead-cwd error can still state.
function liveCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined; // ENOENT … uv_cwd: the directory was deleted
  }
}
// The last cwd that VALIDATED (starts at the session-start path): once the
// live read throws, this is the "expected path" the dead-cwd error states.
let lastKnownCwd = liveCwd();
const AGENT_ENV_FILE = lastKnownCwd === undefined ? undefined : join(lastKnownCwd, '.pi', 'agent-env.sh');
const BASH_ENV_PATH = AGENT_ENV_FILE !== undefined && existsSync(AGENT_ENV_FILE) ? AGENT_ENV_FILE : undefined;

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (BASH_ENV_PATH) env.BASH_ENV = BASH_ENV_PATH;
  return env;
}

// ---- the detach decision (pure, exported for tests) -----------------------
//
// Same contract as the shell tool: a call that did not ask for bg races
// childDone vs the hang timer (BG_HANG_MS); the timer winning detaches the
// RUNNING child instead of holding the turn. An explicit timeout stays the
// hard cap for the detached job's DETACH timing too; the caller's max is the
// default. (The running core inlines the same math — see the timers below.)

export type DetachPolicy = 'immediate' | 'hang' | 'never';

/** immediate = the `# bg` flag; hang = auto at BG_HANG_MS; never = PI_SHELL_BG=off. Pure. */
export function detachPolicy(block: { bg?: boolean }, enabled: boolean = BG_ENABLED): DetachPolicy {
  if (!enabled) return 'never';
  return block.bg ? 'immediate' : 'hang';
}

/** ms until the auto-detach fires; 0 = never (bg off). Floor 1s; capped by the hang threshold and hard-cap − 2s. Pure. */
export function hangDetachMs(
  block: { timeoutMs: number; timeoutExplicit?: boolean },
  enabled: boolean = BG_ENABLED,
): number {
  if (!enabled) return 0;
  const hardCap = block.timeoutExplicit ? Math.min(block.timeoutMs, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;
  return Math.max(1_000, Math.min(BG_HANG_MS, hardCap - 2_000));
}

// ---- the core --------------------------------------------------------------

export interface ShellExecOptions {
  /** The command string handed to `bash -c`. */
  cmd: string;
  /**
   * Explicit caller cap in ms (clamped 1..MAX_TIMEOUT_MS). Absent = the
   * caller's max is the cap (tool-arm semantics: without an explicit timeout
   * a detached job may run to the max instead of dying at the default
   * foreground cap).
   */
  timeoutMs?: number;
  /** Harness abort signal; ignored once the call has detached (the job outlives it). */
  signal?: AbortSignal;
  /** `# bg` marker already stripped by the caller → detach at once. */
  wantBg?: boolean;
  /** UI tick (tool arm): called immediately, then every 1s until settle. */
  onTick?: () => void;
}

/** Foreground outcome: the child settled, bounded output + bookkeeping. */
export interface ShellExecExit {
  kind: 'exit';
  exitCode: number | null;
  /** Combined stdout+stderr, tail-bounded; the orphan note appended when orphans. */
  output: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
  timedOut: boolean;
  aborted: boolean;
  ms: number;
  /** Bare `cmd &`: grandchildren still held the pipes; their output is discarded. */
  orphans: boolean;
  /** The child never spawned (the message is the bare `spawn error: …`). */
  spawnError?: boolean;
}

/** The call lost the hang race (or asked for `# bg`): the child keeps running as a bg job. */
export interface ShellExecBackground {
  kind: 'background';
  id: string;
  cmd: string;
  logPath: string;
  pid: number | undefined;
  ms: number;
  /** Whole seconds since start at detach (min 1) — for the handle message. */
  seconds: number;
  /** Bounded output so far (bgTail + truncateTail) — what reached the pipes before the detach. */
  output: string;
}

export type ShellExecOutcome = ShellExecExit | ShellExecBackground;

/**
 * Run the ONE command. Foreground with bounded output, timeout + abort kill —
 * and the hang race: childDone vs the hang timer. The timer winning does NOT
 * kill anything: the running child is registered as a bg job (it keeps
 * running, its output streams to the log file, completion wakes this session
 * via shell-bg) and the outcome becomes a handle, so the turn continues
 * normally.
 */
export function runShellExec(opts: ShellExecOptions): Promise<ShellExecOutcome> {
  const t0 = Date.now();
  const explicitTimeout = typeof opts.timeoutMs === 'number';
  const timeoutMs = Math.min(
    Math.max(Math.floor(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS), 1),
    MAX_TIMEOUT_MS,
  );
  // An explicit timeoutMs is the caller's hard cap; without one a detached
  // job may run to the max instead of dying at the default foreground cap.
  const hardCapMs = explicitTimeout ? timeoutMs : MAX_TIMEOUT_MS;

  // LOUD dead-cwd death (incident 2026-11-10, session 01a1c3b1): a resumed
  // session after a repo rename carries a cwd that no longer exists —
  // process.cwd() itself throws, so the spawn below used to die on getcwd
  // BEFORE execution, inside the promise executor, and the rejection
  // surfaced as NOTHING: no result, no error card (the prose arm went five
  // degenerate turns without a corrective signal). Validate the directory
  // exists/readable FIRST and resolve the SAME structured error shape the
  // core already uses for spawn failures — both arms render it as a visible
  // card, and the model is told what to ask the operator for.
  let cwdNow: string | undefined;
  let cwdOk = false;
  try {
    cwdNow = process.cwd();
    cwdOk = statSync(cwdNow).isDirectory(); // throws ENOENT/EACCES… gone or unreadable
    if (cwdOk) lastKnownCwd = cwdNow; // remember the last path that was alive
  } catch {
    cwdOk = false;
  }
  if (!cwdOk || cwdNow === undefined) {
    const expected = cwdNow ?? lastKnownCwd ?? '(unknown)';
    return {
      kind: 'exit',
      exitCode: null,
      output:
        `spawn error: the session working directory is gone — expected: ${expected}.\n` +
        'This is not a fault in the command: typically the repository was renamed or moved while the session stayed open, and a resumed session keeps the dead cwd — the shell cannot even start (getcwd fails before anything executes). Nothing was executed.\n' +
        'Ask the operator to restart the session from the right directory, then resend the block.',
      truncated: false,
      totalLines: 3,
      outputLines: 3,
      timedOut: false,
      aborted: false,
      ms: Date.now() - t0,
      orphans: false,
      spawnError: true,
    };
  }

  return new Promise<ShellExecOutcome>((resolve) => {
    const child = spawn(SHELL, ['-c', opts.cmd], {
      cwd: cwdNow,
      env: childEnv(), // BASH_ENV → .pi/agent-env.sh (PATH, PLAN9) — both arms
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let job: BgJob | undefined;
    let orphans = false;
    // Declared before the onTick block below: an assignment above the
    // let was the TDZ that killed every shell call (worker bug, seen live).
    let elapsedTimer: ReturnType<typeof setInterval> | undefined;

    // Live elapsed seconds in the tool row: onUpdate partials are
    // UI-only (the model sees only the final result). 1s cadence,
    // cleared on every settle path.
    if (opts.onTick) {
      opts.onTick();
      elapsedTimer = setInterval(opts.onTick, 1_000);
    }

    const finishExit = (
      exitCode: number | null,
      output: string,
      truncated: boolean,
      totalLines: number,
      outputLines: number,
      spawnError = false,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(detachTimer);
      if (elapsedTimer) clearInterval(elapsedTimer);
      if (orphans) {
        // Grandchildren still hold the inherited pipes (bare "cmd &"):
        // stop collecting instead of waiting for their EOF forever.
        child.stdout.removeAllListeners('data');
        child.stderr.removeAllListeners('data');
        child.stdout.resume();
        child.stderr.resume();
        output = `${output}\n[note: background descendants still run and their output is discarded; write the plain command and let the hang threshold manage it]`;
      }
      resolve({
        kind: 'exit',
        exitCode,
        output,
        truncated,
        totalLines,
        outputLines,
        timedOut,
        aborted,
        ms: Date.now() - t0,
        orphans,
        ...(spawnError ? { spawnError: true } : {}),
      });
    };

    // 'close' waits for EVERY inherited write end; a bare "cmd &" leaves
    // the pipe open in grandchildren forever. After the direct child
    // exits, give buffered output a short grace, then proceed with what
    // we have — unix semantics: "&" meant fire-and-forget.
    child.on('exit', () => {
      setTimeout(() => {
        if (settled) return;
        orphans = true;
        const combined = [stdout, stderr]
          .filter((s) => s.trim().length > 0)
          .join('\n')
          .trimEnd();
        const trunc = truncateTail(combined, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });
        finishExit(child.exitCode, trunc.content, trunc.truncated, trunc.totalLines, trunc.outputLines);
      }, 250).unref?.();
    });

    const detach = (): void => {
      if (settled || job) return;
      // Register the running child (id, log file with the `pid <P> cmd <cmd>`
      // index line, footer segment) — the shared core owns the registry;
      // the pipes stay ours and stream to job.logPath from now on.
      const soFarBuf = [stdout, stderr].filter((s) => s.length > 0).join('\n');
      job = registerBgJob(child.pid, opts.cmd, t0, soFarBuf);
      const seconds = Math.max(1, Math.round((Date.now() - t0) / 1_000));
      const soFar = [stdout, stderr].filter((s) => s.trim().length > 0).join('\n').trimEnd();
      const trunc = truncateTail(bgTail(soFar), {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      settled = true; // the outcome is a handle now; finishExit must never fire
      clearTimeout(killTimer);
      clearTimeout(detachTimer);
      if (elapsedTimer) clearInterval(elapsedTimer);
      resolve({
        kind: 'background',
        id: job.id,
        cmd: opts.cmd,
        logPath: job.logPath,
        pid: child.pid,
        ms: Date.now() - t0,
        seconds,
        output: trunc.content,
      });
    };

    // the race: `# bg` detaches at once (even with the PI_SHELL_BG=off kill
    // switch — the marker is the hidden hook); otherwise the hang timer
    // (none when bg is off). Same math as the pure detachPolicy/hangDetachMs.
    const detachTimer = opts.wantBg
      ? setTimeout(detach, 0)
      : BG_ENABLED
        ? setTimeout(detach, Math.max(1_000, Math.min(BG_HANG_MS, hardCapMs - 2_000)))
        : undefined;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, hardCapMs);

    opts.signal?.addEventListener(
      'abort',
      () => {
        if (job !== undefined) return; // already detached: the job outlives the call
        aborted = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
      },
      { once: true },
    );

    child.stdout.on('data', (d: Buffer) => {
      stdout += d;
      if (job) appendFile(job.logPath, d).catch(() => undefined);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d;
      if (job) appendFile(job.logPath, d).catch(() => undefined);
    });
    child.on('error', (e) => {
      if (job) {
        wakeSession(job, null, false, `spawn error: ${e.message}`);
        return;
      }
      finishExit(null, `spawn error: ${e.message}`, false, 1, 1, true);
    });
    child.on('close', (code) => {
      if (job) {
        clearTimeout(killTimer);
        wakeSession(job, code, timedOut, bgTail([stdout, stderr].filter((s) => s.trim().length > 0).join('\n').trimEnd()));
        return;
      }
      const combined = [stdout, stderr]
        .filter((s) => s.trim().length > 0)
        .join('\n')
        .trimEnd();
      const trunc = truncateTail(combined, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      finishExit(code, trunc.content, trunc.truncated, trunc.totalLines, trunc.outputLines);
    });
  });
}

// pi loads EVERY .ts under .pi/extensions/ as an extension and requires a
// default factory. This module is a shared library consumed by shell.ts and
// shell-prose.ts via named imports — the default export exists only so the
// scanner accepts the file; it registers nothing on purpose.
export default function (_pi: unknown) {
  /* shared module, not an extension */
}
