/**
 * Falsifier for the session-owner P0 gate (docs/sessions-strip-design.md §1).
 *
 * SAFETY CONTRACT: this gate can ctx.shutdown() a session — a bug can kill
 * operator sessions. Every test runs against a per-test temp sandbox:
 * XDG_RUNTIME_DIR=<tmp> (the owner registry lives there) and
 * PI_CODING_AGENT_SESSION_DIR=<tmp>/sessions — the REAL ~/.pi/agent/sessions
 * and the REAL /tmp/pi-owners are never touched. Nothing here spawns pi;
 * gate logic runs through a fake `pi` bus with a mocked ctx.
 *
 * Live/dead pids are REAL child processes (`sleep`), so the default
 * kill(pid, 0) probe is exercised against real liveness, not a stub.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const {
  default: registerSessionOwner,
  ownersDir,
  sidecarPath,
  sidFromFile,
  parseSidecar,
  decideOwner,
  abortMessage,
  releaseSidecarText,
  getOwners,
  sweepStale,
  pruneOverflow,
  tmuxFeedArgs,
  REGISTRY_MAX_FILES,
} = await import('../extensions/session-owner.ts');

// ---- sandbox: temp registry + temp sessions dir, per test -------------------

const ENV_KEYS = ['XDG_RUNTIME_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_ALLOW_LIVE_RESUME', 'PI_OWNER_TMUX'] as const;
const SAVED: Record<string, string | undefined> = {};
let tmp = '';

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
  tmp = mkdtempSync(join(tmpdir(), 'pi-owner-test-'));
  // THE safety override: registry AND sessions both land in the sandbox.
  process.env.XDG_RUNTIME_DIR = tmp;
  process.env.PI_CODING_AGENT_SESSION_DIR = join(tmp, 'sessions');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

// ---- fake pi bus + ctx ------------------------------------------------------

const handlers: Record<string, (event: any, ctx: any) => any> = {};
registerSessionOwner({
  on: (evt: string, h: (event: any, ctx: any) => any) => {
    handlers[evt] = h;
    return () => {};
  },
} as never);

const SID = '11111111-2222-3333-4444-555555555555'; // 36 chars, uuid-shaped
const fileNameFor = (sid: string): string => `2026-11-08T10-00-00-000Z_${sid}.jsonl`;

const mkCtx = (sid: string, shutdown: () => void = mock(() => {})) => ({
  mode: 'print',
  cwd: tmp,
  ui: {},
  sessionManager: {
    getSessionId: () => sid,
    getSessionFile: () => join(tmp, 'sessions', fileNameFor(sid)),
  },
  shutdown,
});

const captureStderr = (fn: () => void): string => {
  const orig = process.stderr.write;
  let buf = '';
  process.stderr.write = ((s: unknown) => {
    buf += typeof s === 'string' ? s : '';
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return buf;
};

// ---- registry helpers (all inside the sandbox) ------------------------------

const writeSidecar = (sid: string, text: string): void => {
  mkdirSync(ownersDir(), { recursive: true });
  writeFileSync(sidecarPath(sid), text);
};
const readSidecar = (sid: string): string => readFileSync(sidecarPath(sid), 'utf8');
const sidecarExists = (sid: string): boolean => existsSync(sidecarPath(sid));
const registryCount = (): number => readdirSync(ownersDir()).length;

// ---- real live/dead pids ----------------------------------------------------

/** Capture process.exit calls (module exits hard in print/json modes). */
const withFakeExit = (fn: () => void): number[] => {
  const codes: number[] = [];
  const orig = process.exit;
  process.exit = ((code?: number) => {
    codes.push(code ?? 0);
    throw new Error(`__exit__${code ?? 0}`);
  }) as typeof process.exit;
  try {
    fn();
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('__exit__')) throw e;
  } finally {
    process.exit = orig;
  }
  return codes;
};

const waitUpTo = async (ms: number, check: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return check();
};

/** A pid that is guaranteed dead AND reaped (kill(pid,0) → ESRCH). */
const deadPid = async (): Promise<number> => {
  const c = spawn('/bin/sleep', ['0.05']);
  const pid = c.pid!;
  await new Promise<void>((res) => c.on('exit', () => res()));
  const gone = await waitUpTo(2000, () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
  });
  if (!gone) throw new Error('could not reap a dead pid');
  return pid;
};

/** A pid alive for the duration of the test; stop() reaps it. */
const livePid = async (): Promise<{ pid: number; stop: () => void }> => {
  const c = spawn('/bin/sleep', ['5']);
  const pid = c.pid!;
  const up = await waitUpTo(2000, () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  if (!up) {
    c.kill('SIGKILL');
    throw new Error('could not start a live pid');
  }
  return { pid, stop: () => c.kill('SIGKILL') };
};

const tsOld = (): string => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
const tsNow = (): string => new Date().toISOString();

// ---- 1. registry paths ------------------------------------------------------

describe('registry paths', () => {
  test('ownersDir honors XDG_RUNTIME_DIR (sandbox, never /tmp/pi-owners)', () => {
    expect(ownersDir()).toBe(join(tmp, 'pi-owners'));
  });

  test('sidecarPath = <dir>/<sessionId>.owner', () => {
    expect(sidecarPath('abc')).toBe(join(tmp, 'pi-owners', 'abc.owner'));
  });

  test('sidFromFile: pi names files <timestamp>_<uuid>.jsonl → trailing uuid', () => {
    expect(sidFromFile(`/x/y/${fileNameFor(SID)}`)).toBe(SID);
    expect(sidFromFile(`/x/y/${SID}.jsonl`)).toBe(SID);
    expect(sidFromFile('/x/y/short.jsonl')).toBe('short');
  });
});

// ---- 2. sidecar parse (pure) ------------------------------------------------

describe('sidecar parse', () => {
  test('pid=<pid>\\nts=<iso> → one pid + ts', () => {
    const s = parseSidecar('pid=4242\nts=2026-11-08T10:00:00.000Z');
    expect(s.pids).toEqual([4242]);
    expect(s.ts).toBe('2026-11-08T10:00:00.000Z');
    expect(s.corrupt).toBe(false);
  });

  test('second-owner append: several pid lines, first ts wins', () => {
    const s = parseSidecar('pid=4242\nts=2026-11-08T10:00:00.000Z\npid=4243\n');
    expect(s.pids).toEqual([4242, 4243]);
    expect(s.ts).toBe('2026-11-08T10:00:00.000Z');
  });

  test('garbage → corrupt, no pids', () => {
    const s = parseSidecar('nonsense\npid=zero\nts=not-a-date\n');
    expect(s.pids).toEqual([]);
    expect(s.ts).toBeUndefined();
    expect(s.corrupt).toBe(true);
  });
});

// ---- 3. liveness decision (pure + real pids) ---------------------------------

describe('liveness decision (alive / stale / foreign-pid)', () => {
  test('only OUR pid recorded → self (no gate on same-process restart)', async () => {
    const d = decideOwner(`pid=${process.pid}\nts=${tsNow()}`);
    expect(d.verdict).toBe('self');
  });

  test('foreign DEAD pid (real ESRCH) → stale', async () => {
    const pid = await deadPid();
    expect(decideOwner(`pid=${pid}\nts=${tsNow()}`).verdict).toBe('stale');
  });

  test('foreign LIVE pid (real child) → live with that pid', async () => {
    const { pid, stop } = await livePid();
    try {
      const d = decideOwner(`pid=${pid}\nts=${tsNow()}`);
      expect(d).toEqual({ verdict: 'live', pid });
    } finally {
      stop();
    }
  });

  test('multi-pid: any alive foreign pid wins (probe-injected)', () => {
    const text = 'pid=101\nts=2026-11-08T10:00:00.000Z\npid=202\n';
    const probe = mock((pid: number) => pid === 202);
    expect(decideOwner(text, process.pid, probe)).toEqual({ verdict: 'live', pid: 202 });
    expect(decideOwner(text, process.pid, () => false).verdict).toBe('stale');
  });

  test('own pid ignored even when probe says alive; no pids → stale', () => {
    expect(decideOwner(`pid=${process.pid}`, process.pid, () => true).verdict).toBe('self');
    expect(decideOwner('', process.pid, () => true).verdict).toBe('stale');
  });
});

// ---- 4. gate: session_start (mocked ctx — shutdown called / not called) ------

describe('gate session_start', () => {
  test('fresh session: sidecar created with own pid, shutdown NOT called', () => {
    const shutdown = mock(() => {});
    handlers.session_start({}, mkCtx(SID, shutdown));
    expect(shutdown).toHaveBeenCalledTimes(0);
    const s = parseSidecar(readSidecar(SID));
    expect(s.pids).toEqual([process.pid]);
    expect(s.ts).toBeDefined();
    expect(getOwners()).toEqual([{ sessionId: SID, pid: process.pid, ts: s.ts, alive: true }]);
    handlers.session_shutdown({}, mkCtx(SID)); // cleanup
  });

  test('LIVE elsewhere → exact stderr message + ctx.shutdown() + exit(1) in print mode, sidecar untouched', async () => {
    const { pid, stop } = await livePid();
    try {
      const foreign = `pid=${pid}\nts=${tsNow()}\n`;
      writeSidecar(SID, foreign);
      const shutdown = mock(() => {});
      let stderr = '';
      let codes: number[] = [];
      stderr = captureStderr(() => {
        codes = withFakeExit(() => handlers.session_start({}, mkCtx(SID, shutdown)));
      });
      expect(stderr).toBe(abortMessage(SID, pid));
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(codes).toEqual([1]);
      expect(readSidecar(SID)).toBe(foreign); // no silent second owner
    } finally {
      stop();
    }
  });

  test('LIVE elsewhere in tui mode → ctx.shutdown() only, NO process.exit', async () => {
    const { pid, stop } = await livePid();
    try {
      writeSidecar(SID, `pid=${pid}\nts=${tsNow()}\n`);
      const shutdown = mock(() => {});
      const ctx = { ...mkCtx(SID, shutdown), mode: 'tui' };
      let codes: number[] = [];
      captureStderr(() => {
        codes = withFakeExit(() => handlers.session_start({}, ctx));
      });
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(codes).toEqual([]); // tui/rpc bind a real shutdownHandler
    } finally {
      stop();
    }
  });

  test('LIVE elsewhere in json mode → exit(1) (json binds no shutdownHandler either)', async () => {
    const { pid, stop } = await livePid();
    try {
      writeSidecar(SID, `pid=${pid}\nts=${tsNow()}\n`);
      const shutdown = mock(() => {});
      const ctx = { ...mkCtx(SID, shutdown), mode: 'json' };
      let codes: number[] = [];
      captureStderr(() => {
        codes = withFakeExit(() => handlers.session_start({}, ctx));
      });
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(codes).toEqual([1]);
    } finally {
      stop();
    }
  });

  test('PI_ALLOW_LIVE_RESUME=1 → NO shutdown, second-owner pid appended', async () => {
    process.env.PI_ALLOW_LIVE_RESUME = '1';
    const { pid, stop } = await livePid();
    try {
      writeSidecar(SID, `pid=${pid}\nts=${tsNow()}\n`);
      const shutdown = mock(() => {});
      handlers.session_start({}, mkCtx(SID, shutdown));
      expect(shutdown).toHaveBeenCalledTimes(0);
      expect(parseSidecar(readSidecar(SID)).pids).toEqual([pid, process.pid]);
      const owners = getOwners();
      expect(owners).toHaveLength(2);
      expect(owners.every((o) => o.alive)).toBe(true);
    } finally {
      stop();
    }
  });

  test('stale sidecar (dead pid) → silently overwritten with ownership', async () => {
    const pid = await deadPid();
    writeSidecar(SID, `pid=${pid}\nts=${tsOld()}\n`);
    const shutdown = mock(() => {});
    handlers.session_start({}, mkCtx(SID, shutdown));
    expect(shutdown).toHaveBeenCalledTimes(0);
    expect(parseSidecar(readSidecar(SID)).pids).toEqual([process.pid]);
    handlers.session_shutdown({}, mkCtx(SID)); // cleanup
  });

  test('registry unusable (dir is a file) → LOUD warning, gate fails OPEN, no shutdown', () => {
    writeFileSync(ownersDir(), 'not a dir\n');
    const shutdown = mock(() => {});
    let stderr = '';
    stderr = captureStderr(() => handlers.session_start({}, mkCtx(SID, shutdown)));
    expect(stderr).toContain('continuing WITHOUT double-open protection');
    expect(shutdown).toHaveBeenCalledTimes(0);
    expect(sidecarExists(SID)).toBe(false);
  });
});

// ---- 5. gate: session_before_switch (sanctioned pre-open veto) ---------------

describe('session_before_switch', () => {
  const targetFile = () => join(tmp, 'sessions', fileNameFor(SID));

  test('target LIVE elsewhere → {cancel:true} + the same stderr message', async () => {
    const { pid, stop } = await livePid();
    try {
      writeSidecar(SID, `pid=${pid}\nts=${tsNow()}\n`);
      let stderr = '';
      let result: unknown;
      stderr = captureStderr(() => {
        result = handlers.session_before_switch({ targetSessionFile: targetFile() }, mkCtx(SID));
      });
      expect(result).toEqual({ cancel: true });
      expect(stderr).toBe(abortMessage(SID, pid));
    } finally {
      stop();
    }
  });

  test('target free (no sidecar) → no cancel', () => {
    expect(handlers.session_before_switch({ targetSessionFile: targetFile() }, mkCtx(SID))).toBeUndefined();
  });

  test('target stale (dead pid) → no cancel', async () => {
    const pid = await deadPid();
    writeSidecar(SID, `pid=${pid}\nts=${tsOld()}\n`);
    expect(handlers.session_before_switch({ targetSessionFile: targetFile() }, mkCtx(SID))).toBeUndefined();
  });

  test('no targetSessionFile → no cancel', () => {
    expect(handlers.session_before_switch({}, mkCtx(SID))).toBeUndefined();
  });

  test('second-owner target (original alive + our stale pid) stays live → cancel', async () => {
    const { pid, stop } = await livePid();
    try {
      writeSidecar(SID, `pid=${pid}\nts=${tsNow()}\npid=${process.pid}\n`);
      expect(handlers.session_before_switch({ targetSessionFile: targetFile() }, mkCtx(SID))).toEqual({ cancel: true });
    } finally {
      stop();
    }
  });
});

// ---- 6. session_shutdown: own sidecar removal + sweep ------------------------

describe('session_shutdown cleanup', () => {
  test('single owner: sidecar removed', () => {
    handlers.session_start({}, mkCtx(SID));
    expect(sidecarExists(SID)).toBe(true);
    handlers.session_shutdown({}, mkCtx(SID));
    expect(sidecarExists(SID)).toBe(false);
  });

  test('forced second owner full cycle: OUR pid line removed, original record kept', async () => {
    process.env.PI_ALLOW_LIVE_RESUME = '1';
    const { pid, stop } = await livePid();
    try {
      writeSidecar(SID, `pid=${pid}\nts=${tsNow()}\n`);
      handlers.session_start({}, mkCtx(SID)); // appends our pid as second owner
      handlers.session_shutdown({}, mkCtx(SID)); // removes OUR line only
      expect(sidecarExists(SID)).toBe(true);
      expect(parseSidecar(readSidecar(SID)).pids).toEqual([pid]);
    } finally {
      stop();
    }
  });

  test('sweep: dead pid + ts older than 1h → pruned; fresh kept', async () => {
    const pid = await deadPid();
    writeSidecar('old-dead', `pid=${pid}\nts=${tsOld()}\n`);
    writeSidecar('fresh-dead', `pid=${pid}\nts=${tsNow()}\n`);
    expect(sweepStale()).toEqual(['old-dead']);
    expect(sidecarExists('fresh-dead')).toBe(true);
  });

  test('sweep: old ts but ALIVE pid → kept (liveness beats age)', async () => {
    const { pid, stop } = await livePid();
    try {
      writeSidecar('old-alive', `pid=${pid}\nts=${tsOld()}\n`);
      expect(sweepStale()).toEqual([]);
      expect(sidecarExists('old-alive')).toBe(true);
    } finally {
      stop();
    }
  });
});

// ---- 7. registry overflow ----------------------------------------------------

describe('registry prune (>100 files)', () => {
  test(`pruneOverflow keeps ${REGISTRY_MAX_FILES}, removes the OLDEST`, () => {
    mkdirSync(ownersDir(), { recursive: true });
    for (let i = 0; i <= REGISTRY_MAX_FILES + 2; i++) {
      const ts = new Date(Date.now() - i * 60 * 1000).toISOString(); // i minutes old
      writeFileSync(sidecarPath(`s${String(i).padStart(3, '0')}`), `pid=${40000 + i}\nts=${ts}\n`);
    }
    expect(pruneOverflow()).toBe(3);
    expect(registryCount()).toBe(REGISTRY_MAX_FILES);
    expect(sidecarExists('s000')).toBe(true); // youngest survives
    expect(sidecarExists('s102')).toBe(false); // oldest pruned
  });
});

// ---- 8. tmux feed stub (strip does the painting) ------------------------------

describe('tmux feed stub', () => {
  test('off by default (PI_OWNER_TMUX unset) → null, nothing spawned', () => {
    expect(tmuxFeedArgs('live')).toBeNull();
    expect(tmuxFeedArgs('dup')).toBeNull();
  });

  test('PI_OWNER_TMUX=1 → @st window-option argv only', () => {
    process.env.PI_OWNER_TMUX = '1';
    expect(tmuxFeedArgs('live')).toEqual(['tmux', 'set-option', '-p', '@st', 'live']);
    expect(tmuxFeedArgs('dup')).toEqual(['tmux', 'set-option', '-p', '@st', 'dup']);
  });
});

// ---- 9. wiring ----------------------------------------------------------------

describe('extension factory wiring', () => {
  test('registers exactly the three session hooks (start, before_switch, shutdown)', () => {
    const seen: Record<string, unknown> = {};
    registerSessionOwner({
      on: (evt: never, h: never) => {
        seen[evt as unknown as string] = h;
        return () => {};
      },
    } as never);
    expect(Object.keys(seen).sort()).toEqual(['session_before_switch', 'session_shutdown', 'session_start']);
    expect(typeof seen.session_start).toBe('function');
    expect(typeof seen.session_before_switch).toBe('function');
    expect(typeof seen.session_shutdown).toBe('function');
  });

  test('releaseSidecarText: pure second-owner removal', () => {
    expect(releaseSidecarText('pid=7\nts=T\npid=8\n', 8)).toBe('pid=7\nts=T\n');
    expect(releaseSidecarText('pid=8\nts=T\n', 8)).toBeNull();
    expect(releaseSidecarText('', 8)).toBeNull();
  });
});
