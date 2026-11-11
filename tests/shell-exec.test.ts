/**
 * Regression falsifier for the ONE execution core (council step 1):
 * the `shell` tool (shell.ts execute) and the prose block (shell-prose.ts
 * runBlock) both route through runShellExec (shell-exec.ts), and the SAME
 * command must yield the SAME exit/output on both surfaces.
 *
 * Real spawns, no LLM, no UI. pi-coding-agent / pi-tui are mocked offline
 * (same scaffolding as shell-prose.test.ts — the REAL truncateTail bound is
 * exercised by the live canary, not here); the truncation-note placement is
 * pinned via synthetic outcomes against toolResultFromOutcome instead.
 */
import { describe, test, expect, mock } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

mock.module('@earendil-works/pi-coding-agent', () => ({
  truncateTail: (content: string) => ({ content, truncated: false, outputLines: 0, totalLines: 0 }),
  DEFAULT_MAX_LINES: 2000,
  DEFAULT_MAX_BYTES: 50_000,
  highlightCode: (code: string) => code.split('\n'),
}));
mock.module('@earendil-works/pi-tui', () => ({
  Text: class {
    text: string;
    constructor(text?: string) {
      this.text = text ?? '';
    }
  },
  styleText: (text: string) => text,
  // workers-dock.ts also lives in this module registry when the whole suite
  // runs in one process: the pi-tui mock shape must be a UNION across test
  // files (whichever registration lands, every importer finds its exports).
  matchesKey: (data: string, key: string): boolean => {
    const KEYS: Record<string, string> = { escape: '\x1b', up: '\x1b[A', down: '\x1b[B', enter: '\r', 'ctrl+o': '\x0f' };
    return KEYS[key] === data;
  },
  truncateToWidth: (s: string, w: number): string => (s.length > w ? s.slice(0, Math.max(0, w)) : s),
  visibleWidth: (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, '').length,
}));
// shell.ts registers its tool parameters with typebox — any stub works: the
// factory never runs here (tests call the exported pure wrappers directly).
mock.module('typebox', () => ({
  Type: new Proxy({}, { get: () => () => ({}) }),
}));

const { runShellExec, detachPolicy, hangDetachMs } = await import('../extensions/shell-exec.ts');
const { runBlock } = await import('../extensions/shell-prose.ts');
const { toolResultFromOutcome, gateCheck, postProcess } = await import('../extensions/shell.ts');

type ProseBlockLike = { code: string; timeoutMs: number; timeoutExplicit?: boolean; bg: boolean };

/** Same command through both arms; returns {core, tool, prose}. */
async function bothArms(cmd: string, opts?: { timeoutMs?: number }) {
  const core = await runShellExec({ cmd, timeoutMs: opts?.timeoutMs, wantBg: false });
  const tool = toolResultFromOutcome(core);
  const prose = await runBlock(
    { code: cmd, timeoutMs: opts?.timeoutMs ?? 120_000, timeoutExplicit: opts?.timeoutMs !== undefined, bg: false },
    undefined,
  );
  return { core, tool, prose };
}

describe('one execution core: same command -> same exit/output on both arms', () => {
  const parity: Array<[string, string]> = [
    ['echo HELLO-FROM-CORE', 'HELLO-FROM-CORE'],
    ['printf "out\\n"; echo err-line >&2; exit 7', 'out\n\nerr-line'], // streams keep their trailing newlines; the join only inserts one BETWEEN segments
    ['for i in 1 2 3; do echo "line-$i"; done', 'line-1\nline-2\nline-3'],
    ['printf \'quoted "args" and $vars\'', 'quoted "args" and $vars'],
    ['exit 1', ''],
  ];

  for (const [cmd, expected] of parity) {
    test(`parity: ${cmd.slice(0, 40)}`, async () => {
      const { core, tool, prose } = await bothArms(cmd);
      expect(core.kind).toBe('exit');
      expect(tool.exitCode).toBe(prose.exitCode);
      expect(tool.output).toBe(prose.output);
      expect(tool.timedOut).toBe(prose.timedOut);
      expect(tool.aborted).toBe(prose.aborted);
      if (core.kind === 'exit') expect(core.exitCode).toBe(tool.exitCode);
      expect(tool.output).toBe(expected);
    });
  }

  test('parity: the shared env contract (BASH_ENV) reaches both arms', async () => {
    const cmd = 'printf \'BASH_ENV=%s\\n\' "${BASH_ENV-}"';
    const { tool, prose } = await bothArms(cmd);
    expect(tool.exitCode).toBe(prose.exitCode);
    expect(tool.output).toBe(prose.output); // identical env → identical bytes
    if (existsSync('.pi/agent-env.sh')) {
      expect(tool.output.endsWith('.pi/agent-env.sh')).toBe(true);
    }
  });

  test('parity: explicit timeout kill (timedOut, no output)', async () => {
    const { core, tool, prose } = await bothArms('sleep 5', { timeoutMs: 300 });
    expect(tool.exitCode).toBe(prose.exitCode);
    expect(tool.exitCode).toBeNull(); // killed by signal
    expect(tool.output).toBe(prose.output);
    expect(core.kind === 'exit' && core.timedOut).toBe(true);
    expect(prose.timedOut).toBe(true);
    expect(tool.ok).toBe(false);
  }, 5_000);

  test('parity: abort via AbortSignal (both arms report aborted identically)', async () => {
    const ctrl = new AbortController();
    const coreP = runShellExec({ cmd: 'sleep 2 & echo ABORT-ARM', wantBg: false, signal: ctrl.signal });
    const proseP = runBlock(
      { code: 'sleep 2 & echo ABORT-ARM', timeoutMs: 120_000, timeoutExplicit: false, bg: false },
      ctrl.signal,
    );
    setTimeout(() => ctrl.abort(), 100);
    const [core, prose] = await Promise.all([coreP, proseP]);
    const tool = toolResultFromOutcome(core);
    expect(prose.aborted).toBe(true);
    expect(tool.aborted).toBe(true);
    expect(tool.exitCode).toBe(prose.exitCode);
    expect(tool.output).toBe(prose.output); // orphan grace is core-level: identical bytes
    expect(tool.output).toContain('ABORT-ARM');
  }, 5_000);

  test('parity: bare `cmd &` — orphan grace, one note, identical bytes', async () => {
    const { tool, prose } = await bothArms('sleep 2 & echo ORPHAN-PARENT-OK');
    expect(tool.exitCode).toBe(prose.exitCode);
    expect(tool.exitCode).toBe(0);
    expect(tool.output).toBe(prose.output);
    expect(tool.output).toContain('ORPHAN-PARENT-OK');
    expect(tool.output).toContain('[note: background descendants still run');
    expect(tool.output.match(/\[note: background descendants/g)?.length).toBe(1);
  }, 5_000);

  test('parity: `# bg` / wantBg — both arms detach to the same bg registry shape', async () => {
    const coreBg = await runShellExec({ cmd: 'sleep 2', wantBg: true });
    const proseBg = await runBlock(
      { code: 'sleep 2', timeoutMs: 120_000, timeoutExplicit: false, bg: true },
      undefined,
    );
    expect(coreBg.kind).toBe('background');
    expect(proseBg.backgrounded).toBe(true);
    if (coreBg.kind === 'background' && proseBg.backgrounded) {
      // A1 (council wave-3): job ids are randomUUIDs, not per-process bg-N counters
      expect(coreBg.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(proseBg.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(coreBg.logPath.startsWith('/tmp/shell-lab/bg/') && coreBg.logPath.endsWith('.log')).toBe(true);
      expect(proseBg.logPath.startsWith('/tmp/shell-lab/bg/')).toBe(true);
      expect(typeof coreBg.pid).toBe('number');
      expect(typeof proseBg.pid).toBe('number');
      const toolBg = toolResultFromOutcome(coreBg);
      expect(toolBg.backgrounded).toBe(true);
      expect(toolBg.taskId).toBe(coreBg.id);
      expect(toolBg.exitCode).toBeNull();
      expect(toolBg.ok).toBe(true);
      expect(toolBg.output).toContain(`[moved to background after 1s as task ${coreBg.id} (pid ${coreBg.pid})`);
      expect(toolBg.output).toContain(`log: ${coreBg.logPath}`);
      // cleanup: kill the detached sleeps; wake is harmless without a session
      process.kill(coreBg.pid!, 'SIGKILL');
      process.kill(proseBg.pid!, 'SIGKILL');
    }
  }, 5_000);
});

describe('toolResultFromOutcome: the tool surface bytes (synthetic outcomes)', () => {
  test('clean exit maps 1:1, no extra keys', () => {
    const r = toolResultFromOutcome({
      kind: 'exit', exitCode: 0, output: 'hi', truncated: false,
      totalLines: 1, outputLines: 1, timedOut: false, aborted: false, ms: 3, orphans: false,
    });
    expect(r).toEqual({ ok: true, exitCode: 0, output: 'hi', timedOut: false, aborted: false });
  });

  test('nonzero exit still runs to completion: ok stays true (today\'s contract)', () => {
    const r = toolResultFromOutcome({
      kind: 'exit', exitCode: 3, output: 'boom', truncated: false,
      totalLines: 1, outputLines: 1, timedOut: false, aborted: false, ms: 3, orphans: false,
    });
    expect(r.ok).toBe(true); // ok = ran to completion (not killed), NOT exit 0
    expect(r.output).toBe('boom');
  });

  test('truncation note placement: tool appends exactly the one line', () => {
    const r = toolResultFromOutcome({
      kind: 'exit', exitCode: 0, output: 'x', truncated: true,
      totalLines: 3000, outputLines: 2000, timedOut: false, aborted: false, ms: 3, orphans: false,
    });
    expect(r.output).toBe('x\n[output truncated, kept last 2000 of 3000 lines]');
  });

  test('orphans: the core already carries the note; no truncation note on top', () => {
    const r = toolResultFromOutcome({
      kind: 'exit', exitCode: 0, output: 'x\n[note: background descendants still run', truncated: true,
      totalLines: 99, outputLines: 50, timedOut: false, aborted: false, ms: 3, orphans: true,
    });
    expect(r.output).toBe('x\n[note: background descendants still run');
  });

  test('spawn error keeps the tool contract ok:false, exit null', () => {
    const r = toolResultFromOutcome({
      kind: 'exit', exitCode: null, output: 'spawn error: no such file',
      truncated: false, totalLines: 1, outputLines: 1, timedOut: false, aborted: false, ms: 0,
      orphans: false, spawnError: true,
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.output).toBe('spawn error: no such file');
  });

  test('background handle message is byte-stable', () => {
    const r = toolResultFromOutcome({
      kind: 'background', id: 'bg-9', cmd: 'sleep 9', logPath: '/tmp/x.log',
      pid: 4242, ms: 4200, seconds: 4, output: 'so far',
    });
    expect(r.output).toBe(
      '[moved to background after 4s as task bg-9 (pid 4242), completion steers this session]\n' +
      'log: /tmp/x.log\nPoll: tail /tmp/x.log; stop: kill 4242\nOutput so far:\nso far',
    );
    expect(r).toMatchObject({ ok: true, exitCode: null, timedOut: false, aborted: false, backgrounded: true, taskId: 'bg-9', logPath: '/tmp/x.log', pid: 4242 });
  });
});

describe('detach-decision pure functions live in the core (parity surface)', () => {
  test('detachPolicy / hangDetachMs same contract as before the move', () => {
    expect(detachPolicy({ bg: true }, true)).toBe('immediate');
    expect(detachPolicy({ bg: false }, true)).toBe('hang');
    expect(detachPolicy({ bg: true }, false)).toBe('never');
    expect(hangDetachMs({ timeoutMs: 120_000, timeoutExplicit: true })).toBeGreaterThan(0);
  });
});

// Incident 2026-11-10 (session 01a1c3b1): a resumed session after a repo
// rename carried a DEAD cwd — process.cwd() throws, the bash spawn died on
// getcwd BEFORE execution and the rejection surfaced as NOTHING (no result,
// no error card; the prose arm then degenerated for five turns). The core
// must validate the cwd first and resolve the SAME structured error shape
// both arms already render as a visible card.
describe('dead cwd: loud structured error, never a silent death', () => {
  test('cwd deleted before the spawn resolves the spawn-error shape with the expected path + restart instruction', async () => {
    const home = process.cwd();
    const dead = `/tmp/shell-exec-deadcwd-${process.pid}-${Date.now()}`;
    mkdirSync(dead, { recursive: true });
    process.chdir(dead);
    try {
      // one LIVE call from the soon-to-die directory: the core records it as
      // the last known-good path (the session-start path in the real incident)
      const alive = await runShellExec({ cmd: 'echo ALIVE' });
      expect(alive.kind).toBe('exit');
      if (alive.kind === 'exit') expect(alive.exitCode).toBe(0);

      rmSync(dead, { recursive: true, force: true }); // the rename: cwd is gone, process.cwd() now throws
      const r = await runShellExec({ cmd: 'echo SHOULD-NEVER-RUN' });
      expect(r.kind).toBe('exit'); // resolved — never a rejection, never a hang
      if (r.kind === 'exit') {
        expect(r.spawnError).toBe(true); // the structured failure shape both arms know
        expect(r.exitCode).toBeNull();
        expect(r.aborted).toBe(false);
        expect(r.output).toContain('session working directory is gone');
        expect(r.output).toContain(dead); // the EXPECTED path is stated
        expect(r.output).toMatch(/restart the session/i); // the operator instruction
        expect(r.output).not.toContain('SHOULD-NEVER-RUN'); // nothing was executed
      }
    } finally {
      process.chdir(home); // restore the harness cwd even if an expect fired
      rmSync(dead, { recursive: true, force: true });
    }
  });
});

// The wrappers around the core stay policy layers: gate in the tool, parse
// check + limits in prose. Guarded here so a future "unification" cannot
// silently drop them.
describe('policy layers stay in their arms', () => {
  test('tool arm still gates (shellcheck diagnostics, not the core)', () => {
    expect(typeof gateCheck).toBe('function');
    expect(typeof postProcess).toBe('function');
  });
});
