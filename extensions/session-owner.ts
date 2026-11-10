/**
 * session-owner — P0 double-open gate (docs/sessions-strip-design.md §1).
 *
 * The incident: a new window resumed a session that was LIVE in another
 * window and pi opened it SILENTLY — two live processes writing one session
 * file while an unfinished automation streamed into the wrong pane. There is
 * no lock anywhere in SessionManager (plain appendFileSync), so this gate
 * builds a sidecar registry of live owners and refuses a second silent open.
 *
 * Registry: ${XDG_RUNTIME_DIR:-/tmp}/pi-owners/<sessionId>.owner
 * Content:  pid=<pid>\nts=<iso>\n   (a forced second owner APPENDS pid= line)
 *
 * Contract (per /tmp/shell-lab/p0-resume-research.md §5):
 *   - session_start: claim the sidecar O_EXCL (wx). If it exists, liveness
 *     probe the recorded pid (process.kill(pid, 0)):
 *       alive, foreign  → LIVE ELSEWHERE → default-deny:
 *         stderr + ctx.shutdown() — the session exits LOUDLY, never
 *         silently continues (research §4: a hook throw cannot abort, only
 *         the sanctioned shutdown can);
 *         PI_ALLOW_LIVE_RESUME=1 → register as second owner and continue.
 *         CAVEAT (verified live): print/json modes bind NO shutdownHandler
 *         (print-mode.js has none; interactive:1619, rpc:256 do) — there
 *         ctx.shutdown() is a silent no-op and the turn would run anyway,
 *         so those modes additionally process.exit(1) after the message.
 *       dead (ESRCH) or own pid → stale → overwrite, take ownership.
 *   - session_before_switch: same probe for the TARGET file; live →
 *     { cancel: true } + the same message (sanctioned pre-open veto,
 *     covers /resume, /import, RPC switch_session).
 *   - session_shutdown: remove own sidecar (own pid lines only — a forced
 *     duplicate must not delete the original owner's record), then sweep:
 *     prune sidecars whose pid is dead AND ts older than 1h.
 *   - getOwners(): {sessionId, pid, ts, alive}[] for the future ⧉N/⚠ strip
 *     markers (design §1.4); tmux feed (@st=live|dup) is a stub behind
 *     PI_OWNER_TMUX=1 — the strip does the painting.
 *
 * SAFETY: this gate can kill a session. It never touches the real sessions
 * dir; tests run under PI_CODING_AGENT_SESSION_DIR=<tmp> + XDG_RUNTIME_DIR
 * overrides. Registry-infra errors fail OPEN with a loud stderr warning
 * (a broken gate must not kill every session); a DETECTED live foreign
 * owner fails CLOSED.
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const OWNER_EXT = '.owner';
/** Sweep TTL: a sidecar whose pid is dead and ts older than this is pruned. */
export const STALE_TTL_MS = 60 * 60 * 1000;
/** Registry never grows past this many sidecars (oldest pruned). */
export const REGISTRY_MAX_FILES = 100;

// ---- registry paths --------------------------------------------------------

/** `${XDG_RUNTIME_DIR:-/tmp}/pi-owners` — read per call so tests can retarget. */
export const ownersDir = (): string =>
  join(process.env.XDG_RUNTIME_DIR || '/tmp', 'pi-owners');

export const sidecarPath = (sessionId: string): string =>
  join(ownersDir(), `${sessionId}${OWNER_EXT}`);

/**
 * Session id from a session FILE path. pi names files
 * `<timestamp>_<uuid>.jsonl` (session-manager.js:714) and the uuid is always
 * the trailing 36 chars; bare `<uuid>.jsonl` (or a raw id) passes through.
 */
export const sidFromFile = (file: string): string => {
  const base = basename(file).replace(/\.jsonl$/, '');
  return base.length > 36 ? base.slice(-36) : base;
};

// ---- sidecar parsing (pure) ------------------------------------------------

export interface Sidecar {
  /** Every valid `pid=` line in file order (first owner first). */
  pids: number[];
  /** First parseable `ts=` value (ISO). */
  ts?: string;
  /** True when the file exists but carries NO valid pid line. */
  corrupt: boolean;
}

export const parseSidecar = (text: string): Sidecar => {
  const pids: number[] = [];
  let ts: string | undefined;
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (l.startsWith('pid=')) {
      const pid = Number(l.slice(4));
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    } else if (l.startsWith('ts=') && ts === undefined) {
      const raw = l.slice(3);
      if (!Number.isNaN(Date.parse(raw))) ts = raw;
    }
  }
  return { pids, ts, corrupt: pids.length === 0 };
};

const ownRecord = (): string => `pid=${process.pid}\nts=${new Date().toISOString()}\n`;

/** The exact stderr line from the spec (spec-b-owner.md contract §2). */
export const abortMessage = (sessionId: string, pid: number): string =>
  `session-owner: session ${sessionId} is LIVE in pid ${pid} — aborting (PI_ALLOW_LIVE_RESUME=1 to override)\n`;

// ---- liveness (pure decision, injectable probe) ----------------------------

/** True when the pid exists (kill(pid,0) ok or EPERM); false on ESRCH. */
const defaultProbe = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

export type Probe = (pid: number) => boolean;
export type OwnerVerdict =
  | { verdict: 'live'; pid: number }
  | { verdict: 'stale' }
  | { verdict: 'self' };

/**
 * Decide who owns the sidecar text:
 *   live  → some FOREIGN pid in the file is alive (gate);
 *   self  → only our own pid(s) recorded (same-process restart) → stale-like;
 *   stale → no valid pids or all dead (ESRCH) → safe to overwrite.
 */
export const decideOwner = (text: string, ownPid = process.pid, probe: Probe = defaultProbe): OwnerVerdict => {
  const { pids } = parseSidecar(text);
  for (const pid of pids) {
    if (pid === ownPid) continue;
    if (probe(pid)) return { verdict: 'live', pid };
  }
  // self ONLY when our own pid is actually recorded; dead foreign pids are
  // stale, not self.
  return pids.some((p) => p === ownPid) ? { verdict: 'self' } : { verdict: 'stale' };
};

// ---- acquisition + release -------------------------------------------------

export type AcquireResult = 'owner' | 'second-owner' | { live: number };

/**
 * session_start claim. O_EXCL (wx) for the clean path; on EEXIST liveness
 * decides: live foreign → { live } (caller gates), stale/self → overwrite
 * and take ownership (+ prune the registry past REGISTRY_MAX_FILES).
 * PI_ALLOW_LIVE_RESUME=1 turns a live hit into a second-owner APPEND.
 */
export const acquireOwnSidecar = (sessionId: string, probe: Probe = defaultProbe): AcquireResult => {
  const dir = ownersDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    process.stderr.write(`session-owner: registry ${dir} unavailable (${(e as Error).message}) — continuing WITHOUT double-open protection\n`);
    return 'owner';
  }
  const path = sidecarPath(sessionId);
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      process.stderr.write(`session-owner: cannot write ${path} (${(e as Error).message}) — continuing WITHOUT double-open protection\n`);
      return 'owner';
    }
    // Sidecar exists: who is in it?
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      /* unreadable = cannot prove a live owner; fall through to stale */
    }
    const d = decideOwner(text, process.pid, probe);
    if (d.verdict === 'live') {
      if (process.env.PI_ALLOW_LIVE_RESUME === '1') {
        // Explicit override: register as second owner (append our pid line).
        try {
          const f = openSync(path, 'a');
          writeFileSync(f, `pid=${process.pid}\n`);
          closeSync(f);
          return 'second-owner';
        } catch (err) {
          process.stderr.write(`session-owner: cannot append second-owner line (${(err as Error).message}) — aborting anyway\n`);
          return { live: d.pid };
        }
      }
      return { live: d.pid };
    }
    // stale / self: dead owner's leftover (or our own pid) — overwrite.
    try {
      writeFileSync(path, ownRecord());
      pruneOverflow();
      return 'owner';
    } catch (err) {
      process.stderr.write(`session-owner: cannot overwrite ${path} (${(err as Error).message}) — continuing WITHOUT double-open protection\n`);
      return 'owner';
    }
  }
  // Clean claim: sole owner.
  try {
    writeFileSync(fd, ownRecord());
  } finally {
    closeSync(fd);
  }
  pruneOverflow();
  return 'owner';
};

/**
 * Pure release: remove OUR pid lines from the sidecar text.
 * Returns the remaining text, or null when nothing remains → unlink.
 * A forced second owner leaves the original owner's record intact.
 */
export const releaseSidecarText = (text: string, ownPid = process.pid): string | null => {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const kept = lines.filter((l) => !(l.startsWith('pid=') && Number(l.slice(4)) === ownPid));
  if (kept.some((l) => l.startsWith('pid='))) return `${kept.join('\n')}\n`;
  return null;
};

/** session_shutdown: remove own sidecar (or just our pid lines). Fail-open. */
export const releaseOwnSidecar = (sessionId: string, ownPid = process.pid): void => {
  const path = sidecarPath(sessionId);
  try {
    if (!existsSync(path)) return;
    const rest = releaseSidecarText(readFileSync(path, 'utf8'), ownPid);
    if (rest === null) unlinkSync(path);
    else writeFileSync(path, rest);
  } catch {
    /* cleanup is best effort */
  }
};

// ---- registry views (for getOwners + sweeps) -------------------------------

export interface OwnerRecord {
  sessionId: string;
  pid: number;
  ts?: string;
  alive: boolean;
}

const sidecarFiles = (): string[] => {
  try {
    return readdirSync(ownersDir()).filter((f) => f.endsWith(OWNER_EXT));
  } catch {
    return [];
  }
};

const readSidecar = (file: string): string => {
  try {
    return readFileSync(join(ownersDir(), file), 'utf8');
  } catch {
    return '';
  }
};

const sidecarAgeMs = (file: string, text: string, now: number): number => {
  const { ts } = parseSidecar(text);
  if (ts) {
    const t = Date.parse(ts);
    if (!Number.isNaN(t)) return now - t;
  }
  try {
    return now - statSync(join(ownersDir(), file)).mtimeMs;
  } catch {
    return 0;
  }
};

/** All owners in the registry: one record per pid line, with liveness. */
export const getOwners = (probe: Probe = defaultProbe): OwnerRecord[] => {
  const out: OwnerRecord[] = [];
  for (const file of sidecarFiles()) {
    const sessionId = file.slice(0, -OWNER_EXT.length);
    const { pids, ts } = parseSidecar(readSidecar(file));
    for (const pid of pids) out.push({ sessionId, pid, ts, alive: probe(pid) });
  }
  return out;
};

/**
 * Sweep: unlink sidecars whose pids are ALL dead AND ts older than TTL.
 * Conservative: corrupt/unparseable ts and live owners are always kept.
 * Returns removed session ids.
 */
export const sweepStale = (now = Date.now(), probe: Probe = defaultProbe): string[] => {
  const removed: string[] = [];
  for (const file of sidecarFiles()) {
    const text = readSidecar(file);
    const { pids } = parseSidecar(text);
    if (sidecarAgeMs(file, text, now) < STALE_TTL_MS) continue;
    if (pids.some((pid) => probe(pid))) continue;
    try {
      unlinkSync(join(ownersDir(), file));
      removed.push(file.slice(0, -OWNER_EXT.length));
    } catch {
      /* best effort */
    }
  }
  return removed;
};

/** Keep the registry at REGISTRY_MAX_FILES: unlink the oldest by ts/mtime. */
export const pruneOverflow = (max = REGISTRY_MAX_FILES): number => {
  const files = sidecarFiles();
  if (files.length <= max) return 0;
  const now = Date.now();
  const entries = files
    .map((f) => ({ f, age: sidecarAgeMs(f, readSidecar(f), now) }))
    .sort((a, b) => b.age - a.age); // oldest first
  let removed = 0;
  for (const { f } of entries) {
    if (files.length - removed <= max) break;
    try {
      unlinkSync(join(ownersDir(), f));
      removed += 1;
    } catch {
      break;
    }
  }
  return removed;
};

// ---- tmux feed stub (strip does the painting) ------------------------------

/**
 * argv builder for the @st window-option feed. null = disabled
 * (PI_OWNER_TMUX !== '1'). Stub only — the sessions strip owns rendering.
 */
export const tmuxFeedArgs = (state: 'live' | 'dup'): string[] | null =>
  process.env.PI_OWNER_TMUX === '1' ? ['tmux', 'set-option', '-p', '@st', state] : null;

const feedTmux = (state: 'live' | 'dup'): void => {
  const argv = tmuxFeedArgs(state);
  if (!argv) return;
  try {
    spawnSync(argv[0], argv.slice(1), { timeout: 2000 });
  } catch {
    /* no tmux: the stub is best effort */
  }
};

// ---- the extension ---------------------------------------------------------

const dbg = (msg: string): void => {
  if (process.env.PI_OWNER_DEBUG === '1') process.stderr.write(`session-owner[dbg] ${msg}\n`);
};

/**
 * Default-deny abort: LOUD exit, never a silent second writer.
 * ctx.shutdown() is the graceful path where pi binds a shutdownHandler
 * (tui/rpc). In print/json it is provably a no-op (no shutdownHandler is
 * bound — print-mode.js binds none), so the abort ends with process.exit(1):
 * automation gets a non-zero exit and a clear message, never a run turn.
 * Safe to exit hard: the abort path has NOT acquired a sidecar.
 */
const gateAbort = (ctx: { mode: string; shutdown: () => void }, sid: string, pid: number): void => {
  process.stderr.write(abortMessage(sid, pid));
  try {
    ctx.shutdown();
  } catch (e) {
    process.stderr.write(`session-owner: shutdown failed (${(e as Error).message})\n`);
  }
  if (ctx.mode === 'print' || ctx.mode === 'json') process.exit(1);
};

export default function (pi: ExtensionAPI) {
  let ownSid: string | null = null;

  pi.on('session_start', (_event, ctx: ExtensionContext) => {
    const sid = ctx.sessionManager?.getSessionId?.();
    if (!sid) return;
    // Defensive: a start without a shutdown (reload edge) must not leak the
    // previous claim.
    if (ownSid && ownSid !== sid) releaseOwnSidecar(ownSid);
    ownSid = sid;
    const res = acquireOwnSidecar(sid);
    dbg(`session_start sid=${sid} res=${JSON.stringify(res)}`);
    const live = typeof res === 'object' ? res.live : undefined;
    if (typeof live === 'number') {
      gateAbort(ctx, sid, live);
      return;
    }
    feedTmux(res === 'second-owner' ? 'dup' : 'live');
  });

  pi.on('session_before_switch', (event: { targetSessionFile?: string }) => {
    const target = event.targetSessionFile;
    if (!target) return;
    const text = (() => {
      const p = sidecarPath(sidFromFile(target));
      try {
        return existsSync(p) ? readFileSync(p, 'utf8') : '';
      } catch {
        return '';
      }
    })();
    const d = decideOwner(text);
    dbg(`before_switch target=${target} decide=${JSON.stringify(d)}`);
    if (d.verdict !== 'live') return;
    process.stderr.write(abortMessage(sidFromFile(target), d.pid));
    return { cancel: true };
  });

  pi.on('session_shutdown', () => {
    const sid = ownSid;
    dbg(`session_shutdown sid=${sid}`);
    ownSid = null;
    if (sid) releaseOwnSidecar(sid);
    sweepStale();
  });
}
