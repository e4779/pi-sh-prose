/**
 * Offline falsifier for the bg card/footer tidy (PLAN «Workers dock»):
 * the bg marker card is TWO lines — `● bg <id> · <bgLabel>` + dim
 * `log <path>`, with the full command only in the expanded view; labels and
 * the footer carry NO UUID chains and NO ids.
 *
 * Real renderer contract only insofar as the recording fake theme goes:
 * ANSI shapes are asserted via the fake, the live canary covers the rest.
 */
import { describe, test, expect, afterAll, afterEach } from 'bun:test';

const {
  bgLabel,
  bgCardLines,
  bgFooterText,
  BG_CARD_EXPAND_MAX_LINES,
  BG_CARD_LINE_MAX_CHARS,
  BG_FOOTER_MAX,
} = await import('../extensions/shell-bg.ts');

const fakeTheme = { fg: (c: string, t: string) => `[${c}]${t}` };

describe('bgLabel (uuid chains and env prefixes are gone)', () => {
  test('env-assignment prefixes drop out of the label', () => {
    expect(bgLabel('A=4027cdde-1a2b-4c3d sweep-filter p0 --all')).toBe('sweep-filter p0 --all');
    expect(bgLabel('FOO=bar BAZ=qux echo hi')).toBe('echo hi');
  });
  test('uuid/hex chains drop out', () => {
    expect(bgLabel('fab agent 550e8400e29b41d4 run')).toBe('fab agent run');
    expect(bgLabel('DEADBEEF-CAFE-BABE write')).toBe('write');
  });
  test('opaque long tokens (>32 chars) drop out', () => {
    expect(bgLabel('run /tmp/shell-lab/very-long-opaque-token-path-that-nobody-reads --flag')).toBe('run --flag');
  });
  test('first three real words, capped at 24 with ellipsis', () => {
    expect(bgLabel('sleep 95 && echo SLOW\necho more')).toBe('sleep 95 echo');
    expect(bgLabel('one two three four five')).toBe('one two three');
    expect(bgLabel(' compress this particularly long label here')).toBe('compress this particula…');
  });
  test('an all-filtered command falls back to the raw head, never empty', () => {
    expect(bgLabel('A=1')).toBe('A=1');
    expect(bgLabel('   ')).toBe('');
  });
});

describe('bgCardLines (the two-line marker card)', () => {
  const details = { kind: 'bg', id: 'bg-7', cmd: 'A=4027cdde sleep 95 && echo SLOW', logPath: '/tmp/shell-lab/bg/bg-7.log', pid: 123 };

  test('collapsed: line 1 label, line 2 dim log path — no cmd, no uuid chain', () => {
    expect(bgCardLines(details, { expanded: false }, fakeTheme)).toEqual([
      '[dim]● bg bg-7 · sleep 95 echo',
      '[dim]log /tmp/shell-lab/bg/bg-7.log',
    ]);
  });
  test('expanded: the WHOLE command after a blank line', () => {
    const lines = bgCardLines({ ...details, cmd: 'tar -xzf a.tgz\nmkdir out' }, { expanded: true }, fakeTheme);
    expect(lines).toEqual([
      '[dim]● bg bg-7 · tar -xzf a.tgz',
      '[dim]log /tmp/shell-lab/bg/bg-7.log',
      '',
      'tar -xzf a.tgz',
      'mkdir out',
    ]);
  });
  test('expansion bounds runaway commands (line count + per-line chars)', () => {
    const many = Array.from({ length: BG_CARD_EXPAND_MAX_LINES + 5 }, (_, i) => `echo ${i}`).join('\n');
    const lines = bgCardLines({ ...details, cmd: many }, { expanded: true }, fakeTheme);
    expect(lines.at(-1)).toBe('[dim]… +5 lines');
    const long = `x=${'y'.repeat(500)}`; // a giant single command line
    const one = bgCardLines({ ...details, cmd: long }, { expanded: true }, fakeTheme);
    expect(one.at(-1)!.length).toBeLessThanOrEqual(BG_CARD_LINE_MAX_CHARS);
    expect(one.at(-1)!.endsWith('…')).toBeTrue();
  });
  test('malformed details → [] (the caller falls back to legacy rendering)', () => {
    expect(bgCardLines(undefined, {}, fakeTheme)).toEqual([]);
    expect(bgCardLines(null, {}, fakeTheme)).toEqual([]);
    expect(bgCardLines('nope', {}, fakeTheme)).toEqual([]);
    expect(bgCardLines({ kind: 'bg', id: 'x', cmd: 'a' }, {}, fakeTheme)).toEqual([]); // no logPath
    expect(bgCardLines({ kind: 'bg', id: 'x', logPath: '/l' }, {}, fakeTheme)).toEqual([]); // no cmd
    expect(bgCardLines({ kind: 'bg', cmd: 'a', logPath: '/l' }, {}, fakeTheme)).toEqual([]); // no id
    expect(bgCardLines({ kind: 'sh', cmd: 'a', logPath: '/l' }, {}, fakeTheme)).toEqual([]); // wrong kind
  });
});

describe('bgFooterText (the counter, ids removed)', () => {
  test('running counter over labels, two shown, +N for the rest', () => {
    expect(bgFooterText(['sweep-filter', 'p0-research'], undefined)).toBe('⏿ 2 bg · sweep-filter · p0-research');
    expect(bgFooterText(['a', 'b', 'c', 'd'], undefined)).toBe('⏿ 4 bg · a · b +2');
  });
  test('last outcome without an id', () => {
    expect(bgFooterText([], { exitCode: 0, timedOut: false })).toBe('✓ exit 0');
    expect(bgFooterText([], { exitCode: null, timedOut: true })).toBe('✓ timeout');
    expect(bgFooterText(['one'], { exitCode: 3, timedOut: false })).toBe('⏿ 1 bg · one | ✓ exit 3');
  });
  test('nothing to show → undefined; hard cap holds', () => {
    expect(bgFooterText([], undefined)).toBeUndefined();
    expect(bgFooterText(['x'.repeat(200)], { exitCode: 0, timedOut: false })!.length).toBeLessThanOrEqual(BG_FOOTER_MAX);
  });
});

// ---- wave-3 A1/A3/A6 (council synthesis) ------------------------------------
//
// A1: job ids are randomUUIDs, one log per uuid — the old per-process bg-N
//     counter minted the SAME ids in every session process and, in the one
//     global BG_DIR, the second writer's log silently overwrote the first
//     job's output.
// A3: the sweep regex could not parse the `pid ?` stamp (child.pid undefined
//     on a spawn race); the fork's scratchOwnerDead fallback classifies a
//     pid-less job dead only when the process that detached it died.
// A6: a failing reap-mark write emits one writeProseCall-style telemetry
//     line instead of silence (the at-most-once window itself stays, D4).
const { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } = await import('node:fs');
const { join } = await import('node:path');

const {
  registerBgJob,
  bgJobs,
  setBgOwnerSession,
  findOrphans,
  sweepOrphans,
  bindBg,
  wakeSession,
  buildBgWakeEvent,
  bgWakeText,
  bgWakeContent,
  BG_SERVICE_REGISTER_CHANNEL,
  BG_SERVICE_NOTIFY_CHANNEL,
  BG_FACADE_NOTIFY_FALLBACK_MS,
  BG_DIR,
  BG_CALLS_LOG,
  bgCallLine,
} = await import('../extensions/shell-bg.ts');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEAD_PID = 999_999_999; // beyond any pid_max: kill(pid, 0) → ESRCH

/** One fresh bg registration in the REAL module state; returns the job. */
const register = (pid: number | undefined, cmd: string, soFar: string): ReturnType<typeof registerBgJob> => {
  const job = registerBgJob(pid, cmd, Date.now(), soFar);
  bgJobs.delete(job.id); // keep the shared registry clean between tests
  return job;
};

describe('A1: uuid job ids — cross-process, one log per uuid', () => {
  // A REAL second process: fresh module instance, fresh counter (old bug) —
  // same session id, so the old bg-N ids collided and the second log
  // OVERWROTE the first job's output in the shared dir.
  const SUB = `
    const { registerBgJob, setBgOwnerSession } = await import(process.env.T_BG_MODULE);
    setBgOwnerSession(process.env.T_BG_SID);
    const job = registerBgJob(4242, 'sleep 95 && echo CROSS', Date.now(), process.env.T_BG_SOFAR);
    console.log(JSON.stringify({ id: job.id, pid: process.pid, logPath: job.logPath }));
  `;
  const runSecondProcess = (sid: string, soFar: string): { id: string; pid: number; logPath: string } => {
    const p = Bun.spawnSync([process.execPath, '-e', SUB], {
    env: { ...process.env, T_BG_MODULE: join(import.meta.dir, '..', 'extensions', 'shell-bg.ts'), T_BG_SID: sid, T_BG_SOFAR: soFar },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(p.exitCode).toBe(0);
    const line = p.stdout.toString().trim().split('\n').reverse().find((l) => l.startsWith('{'));
    expect(line).toBeDefined();
    return JSON.parse(line!);
  };

  test('a second process with the same session id and a restarted counter never reuses an id', () => {
    const sid = `bg-uuid-cross-${process.pid}`;
    const a = runSecondProcess(sid, 'CROSS-PROCESS-A-OUTPUT');
    const b = runSecondProcess(sid, 'CROSS-PROCESS-B-OUTPUT');
    try {
      expect(a.id).toMatch(UUID_RE); // uuid per job, not bg-N
      expect(b.id).toMatch(UUID_RE);
      expect(a.id).not.toBe(b.id); // the old per-process counters both minted bg-1 here
      expect(a.logPath).not.toBe(b.logPath); // one log per uuid
    } finally {
      rmSync(a.logPath, { force: true });
      rmSync(b.logPath, { force: true });
    }
  });

  test('log overwrite immunity: both processes keep their own bytes in the shared dir', () => {
    const sid = `bg-uuid-overwrite-${process.pid}`;
    const a = runSecondProcess(sid, 'OVERWRITE-IMMUNE-A-OUTPUT');
    const b = runSecondProcess(sid, 'OVERWRITE-IMMUNE-B-OUTPUT');
    try {
      const ta = readFileSync(a.logPath, 'utf8');
      const tb = readFileSync(b.logPath, 'utf8');
      expect(ta).toContain('OVERWRITE-IMMUNE-A-OUTPUT');
      expect(ta).not.toContain('OVERWRITE-IMMUNE-B-OUTPUT');
      expect(ta).toContain(`session ${sid}`); // the ownership stamp survives
      expect(ta).toContain(`proc ${a.pid}`); // stamped by the WRITING process (A3 evidence), not the parent
      expect(tb).toContain('OVERWRITE-IMMUNE-B-OUTPUT');
      expect(tb).not.toContain('OVERWRITE-IMMUNE-A-OUTPUT');
    } finally {
      rmSync(a.logPath, { force: true });
      rmSync(b.logPath, { force: true });
    }
  });

  test('in-process parallel registrations are equally disjoint (no counter, no shared log)', () => {
    const a = register(undefined, 'sleep 1 && echo P', 'PARALLEL-A-LOG');
    const b = register(undefined, 'sleep 1 && echo Q', 'PARALLEL-B-LOG');
    try {
      expect(a.id).toMatch(UUID_RE);
      expect(b.id).toMatch(UUID_RE);
      expect(a.id).not.toBe(b.id);
      expect(a.logPath).not.toBe(b.logPath);
      expect(readFileSync(a.logPath, 'utf8')).toContain('PARALLEL-A-LOG');
    } finally {
      rmSync(a.logPath, { force: true });
      rmSync(b.logPath, { force: true });
    }
  });
});

describe('A3: pid-? sweep — fork scratchOwnerDead fallback', () => {
  const SID = `sweep-pidless-${process.pid}`;
  const fixtures: string[] = [];
  const write = (name: string, head: string, body: string): string => {
    const logPath = join(BG_DIR, `${name}.log`);
    writeFileSync(logPath, `${head}\n${body}\n`);
    fixtures.push(logPath);
    return logPath;
  };

  afterAll(() => {
    for (const p of fixtures) rmSync(p, { force: true });
  });

  test('pid-? job whose detaching process died is reported (pid-less orphan)', () => {
    const p = write(`bg-pidless-dead-${process.pid}`, `pid ? session ${SID} proc ${DEAD_PID} cmd spawn-race-job`, 'SPAWN-RACE-OUTPUT');
    const mine = findOrphans(SID).filter((o) => o.logPath === p);
    expect(mine).toHaveLength(1);
    expect(mine[0].pid).toBeUndefined();
    expect(mine[0].cmd).toBe('spawn-race-job');
    expect(mine[0].tail).toContain('SPAWN-RACE-OUTPUT');
  });

  test('pid-? job owned by THIS process is never an orphan to it', () => {
    const p = write(`bg-pidless-self-${process.pid}`, `pid ? session ${SID} proc ${process.pid} cmd self-job`, 'SELF-OUTPUT');
    expect(findOrphans(SID).some((o) => o.logPath === p)).toBe(false);
  });

  test('pid-? job whose detaching process is alive is skipped', () => {
    const live = Bun.spawn(['sleep', '30']);
    try {
      const p = write(`bg-pidless-live-${process.pid}`, `pid ? session ${SID} proc ${live.pid} cmd live-owner-job`, 'LIVE-OWNER-OUTPUT');
      expect(findOrphans(SID).some((o) => o.logPath === p)).toBe(false);
    } finally {
      live.kill();
    }
  });

  test('legacy pid-? log without a proc stamp is skipped (no owner evidence)', () => {
    const p = write(`bg-pidless-legacy-${process.pid}`, `pid ? session ${SID} cmd old-style-job`, 'LEGACY-PIDLESS-OUTPUT');
    expect(findOrphans(SID).some((o) => o.logPath === p)).toBe(false);
  });

  test('numeric-pid heads keep parsing after the regex generalization', () => {
    const p = write(`bg-pid-num-${process.pid}`, `pid ${DEAD_PID} session ${SID} proc ${process.pid} cmd plain-job`, 'NUMERIC-OUTPUT');
    const mine = findOrphans(SID).filter((o) => o.logPath === p);
    expect(mine).toHaveLength(1);
    expect(mine[0].pid).toBe(DEAD_PID);
    expect(mine[0].cmd).toBe('plain-job');
  });

  test('sweep message classifies a pid-less orphan as owner-dead', () => {
    const logPath = write(`bg-pidless-msg-${process.pid}`, `pid ? session ${SID} proc ${DEAD_PID} cmd msg-job`, 'MSG-OUTPUT');
    const sent: Array<{ content: string }> = [];
    bindBg({ sendMessage: (m: { content: string }) => sent.push(m) } as unknown as Parameters<typeof bindBg>[0]);
    try {
      sweepOrphans(SID);
      const hit = sent.find((m) => m.content.includes(logPath));
      expect(hit).toBeDefined();
      expect(hit!.content).toContain('pid ?, owner-dead');
      expect(hit!.content).toContain('untrusted task data');
    } finally {
      rmSync(`${logPath}.reported`, { force: true });
      bindBg(undefined as unknown as Parameters<typeof bindBg>[0]); // do not leak the fake pi into other files
    }
  });
});

describe('A6: reap-mark failure telemetry (the at-most-once window stays)', () => {
  const SID = `sweep-mark-${process.pid}`;
  const cleanup: string[] = [];
  const writeOrphan = (name: string): string => {
    const logPath = join(BG_DIR, `${name}.log`);
    writeFileSync(logPath, `pid ? session ${SID} proc ${DEAD_PID} cmd mark-job\ndead-before-mark\n`);
    cleanup.push(logPath, `${logPath}.reported`);
    return logPath;
  };

  afterAll(() => {
    for (const p of cleanup) rmSync(p, { force: true, recursive: true });
  });

  const telemetryChunk = (before: number): string =>
    existsSync(BG_CALLS_LOG) ? readFileSync(BG_CALLS_LOG, 'utf8').slice(before) : '';

  test('a failed mark write emits exactly one telemetry line; the log stays unmarked', () => {
    const logPath = writeOrphan(`bg-mark-fail-${process.pid}`);
    mkdirSync(`${logPath}.reported`); // a DIRECTORY at the mark path: writeFileSync fails EISDIR
    const before = existsSync(BG_CALLS_LOG) ? statSync(BG_CALLS_LOG).size : 0;
    const sent: Array<{ content: string }> = [];
    bindBg({ sendMessage: (m: { content: string }) => sent.push(m) } as unknown as Parameters<typeof bindBg>[0]);
    try {
      sweepOrphans(SID);
      expect(sent).toHaveLength(1); // the report itself was delivered…
      const lines = telemetryChunk(before).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
      const fails = lines.filter((l) => l.kind === 'reap_mark_failed' && l.log === logPath);
      expect(fails).toHaveLength(1); // …and the mark failure is LOUD, not silent
      expect(fails[0].error).toBeTruthy();
      expect(typeof fails[0].ts).toBe('string');
      expect(fails[0].cwd).toBe(process.cwd());
      expect(existsSync(`${logPath}.reported`)).toBeTrue(); // never converted into a mark file
    } finally {
      bindBg(undefined as unknown as Parameters<typeof bindBg>[0]);
    }
  });

  test('a successful mark write emits no telemetry (failure-only channel)', () => {
    const logPath = writeOrphan(`bg-mark-ok-${process.pid}`);
    const before = existsSync(BG_CALLS_LOG) ? statSync(BG_CALLS_LOG).size : 0;
    bindBg({ sendMessage: () => undefined } as unknown as Parameters<typeof bindBg>[0]);
    try {
      sweepOrphans(SID);
      const lines = telemetryChunk(before).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
      expect(lines.filter((l) => l.kind === 'reap_mark_failed' && l.log === logPath)).toHaveLength(0);
      expect(existsSync(`${logPath}.reported`)).toBeTrue(); // marked: reported exactly once
    } finally {
      bindBg(undefined as unknown as Parameters<typeof bindBg>[0]);
    }
  });

  test('bgCallLine shape (pure builder, proseCallLine family)', () => {
    const line = JSON.parse(bgCallLine({ kind: 'reap_mark_failed', log: '/l/x.log', error: 'E'.repeat(400) }));
    expect(line.kind).toBe('reap_mark_failed');
    expect(line.log).toBe('/l/x.log');
    expect(line.error).toHaveLength(300); // bounded detail, like proseCallLine
    expect(typeof line.ts).toBe('string');
    expect(line.cwd).toBe(process.cwd());
  });
});

// ---- typed wake channel: facade route + local fallback ---------------------
//
// The wake emitter is STRUCTURED DATA first: a typed event (structural mirror
// of the fork's FabricShellWakeEvent) is derived into prose AND attached as
// message details; when the host publishes the PR2 bg-service facade the
// completion routes through it (registerJob at detach, notifyCompletion at
// exit — typed stopReason end to end), else the local BG_EVENT_TYPE message
// stays the channel. One route per completion: never both, never neither.

describe('typed wake channel (facade route + local fallback)', () => {
  const SID = `wake-facade-${process.pid}`;

  /** Fake pi EventBus: synchronous dispatch, exactly like pi's createEventBus. */
  const makeBus = (): {
    events: { emit: (channel: string, data: never) => void; on: (channel: string, h: (data: never) => void) => () => void };
    handlers: Map<string, (data: Record<string, unknown> & { respond?: (r: unknown) => void }) => void>;
    emitted: Array<{ channel: string; data: Record<string, unknown> }>;
  } => {
    const handlers = new Map();
    const emitted: Array<{ channel: string; data: Record<string, unknown> }> = [];
    return {
      events: {
        emit: (channel: string, data: never) => {
          emitted.push({ channel, data: data as Record<string, unknown> });
          handlers.get(channel)?.(data as never);
        },
        on: (channel: string, h: (data: never) => void) => {
          handlers.set(channel, h as never);
          return () => handlers.delete(channel);
        },
      },
      handlers,
      emitted,
    };
  };

  /** bindBg with a recording fake pi carrying the fake bus. */
  const bindFake = (bus: ReturnType<typeof makeBus>) => {
    const sent: Array<{ customType: string; content: string; details?: unknown }> = [];
    bindBg({ sendMessage: (m: never) => sent.push(m), events: bus.events } as unknown as Parameters<typeof bindBg>[0]);
    return sent;
  };

  afterEach(() => {
    bindBg(undefined as unknown as Parameters<typeof bindBg>[0]); // never leak the fake pi/bus
    bgJobs.clear();
  });

  test('the prose is DERIVED from the typed event: bgWakeContent === bgWakeText(buildBgWakeEvent(...))', () => {
    const job = { id: 'bg-1', pid: 42, cmd: 'sleep 95 && echo SLOW', logPath: '/tmp/shell-lab/bg/bg-1.log', startedAt: 1_000 };
    const event = buildBgWakeEvent(job, 0, false, 'SLOW', 91_000);
    expect(event).toMatchObject({ schemaVersion: 1, kind: 'wake', id: 'bg-1', tool: 'bash', status: 'exited', exitCode: 0, stopReason: 'completed', seconds: 90 });
    expect(bgWakeContent(job, 0, false, 'SLOW', 91_000)).toBe(bgWakeText(event)); // single source, no drift
    const killed = buildBgWakeEvent(job, null, true, 'partial', 96_000);
    expect(killed.status).toBe('timed_out');
    expect(killed.stopReason).toBe('timed_out');
    expect('exitCode' in killed).toBe(false); // a kill leaves no exit code; none is invented
    const crashed = buildBgWakeEvent(job, 3, false, 'boom', 2_000);
    expect(crashed).toMatchObject({ status: 'failed', stopReason: 'runtime_error' });
  });

  test('registerBgJob hands the job to the host facade; the completion routes through notifyCompletion', () => {
    const bus = makeBus();
    const sent = bindFake(bus);
    setBgOwnerSession(SID);
    bus.handlers.set(BG_SERVICE_REGISTER_CHANNEL, (data) => data.respond?.({ ok: true, jobId: (data.options as { id: string }).id }));
    let notifyRespond: ((r: unknown) => void) | undefined;
    bus.handlers.set(BG_SERVICE_NOTIFY_CHANNEL, (data) => { notifyRespond = data.respond; });

    const job = registerBgJob(4242, 'sleep 95 && echo WAKE', Date.now(), '');
    const reg = bus.emitted.find((e) => e.channel === BG_SERVICE_REGISTER_CHANNEL);
    expect(reg).toBeDefined();
    expect(reg!.data).toMatchObject({ version: 1, tool: 'bash', command: 'sleep 95 && echo WAKE' });
    expect(reg!.data.options).toMatchObject({ id: job.id, ownerId: SID }); // stable id + session stamp
    expect(sent).toHaveLength(0); // registration is not a delivery

    wakeSession(job, 0, false, 'DONE');
    const notify = bus.emitted.find((e) => e.channel === BG_SERVICE_NOTIFY_CHANNEL);
    expect(notify).toBeDefined();
    expect(notify!.data).toMatchObject({ version: 1, jobId: job.id, payload: 'DONE', exitCode: 0, stopReason: 'completed' });
    expect(sent).toHaveLength(0); // the host owns this delivery: no local wake
    notifyRespond?.({ ok: true }); // host accepted
    expect(sent).toHaveLength(0); // and never both channels for one completion
    expect(bgJobs.has(job.id)).toBe(false); // registry bookkeeping ran either way
  });

  test('a refused notifyCompletion falls back to the local typed message exactly once', () => {
    const bus = makeBus();
    const sent = bindFake(bus);
    setBgOwnerSession(SID);
    bus.handlers.set(BG_SERVICE_REGISTER_CHANNEL, (data) => data.respond?.({ ok: true }));
    bus.handlers.set(BG_SERVICE_NOTIFY_CHANNEL, (data) => data.respond?.({ ok: false, error: 'Background job already finished' }));

    const job = registerBgJob(4242, 'bun run build', Date.now(), '');
    wakeSession(job, 3, false, 'boom');
    expect(sent).toHaveLength(1); // refused: the local channel keeps the truth
    expect(sent[0].customType).toBe('pi-shell-bg-event');
    expect(sent[0].content).toContain(`Task ${job.id}: failed after`);
    expect((sent[0].details as { wake: Array<Record<string, unknown>> }).wake[0]).toMatchObject({
      schemaVersion: 1, kind: 'wake', id: job.id, status: 'failed', exitCode: 3, stopReason: 'runtime_error',
    });
    expect(sent).toHaveLength(1); // the armed fallback never fires twice
  });

  test('a silent notify channel (dead facade) falls back after the bound, and a late ok:true stays single-delivery', async () => {
    const bus = makeBus();
    const sent = bindFake(bus);
    setBgOwnerSession(SID);
    let notifyRespond: ((r: unknown) => void) | undefined;
    bus.handlers.set(BG_SERVICE_REGISTER_CHANNEL, (data) => data.respond?.({ ok: true }));
    bus.handlers.set(BG_SERVICE_NOTIFY_CHANNEL, (data) => { notifyRespond = data.respond; }); // never answers

    const job = registerBgJob(4242, 'sleep 95', Date.now(), '');
    wakeSession(job, null, true, 'partial');
    expect(sent).toHaveLength(0); // armed, not delivered
    await new Promise((r) => setTimeout(r, BG_FACADE_NOTIFY_FALLBACK_MS + 150));
    expect(sent).toHaveLength(1); // silence past the bound = dead channel: local delivery
    expect((sent[0].details as { wake: Array<Record<string, unknown>> }).wake[0]).toMatchObject({ status: 'timed_out', stopReason: 'timed_out' });
    notifyRespond?.({ ok: true }); // a late host answer must not double-deliver
    expect(sent).toHaveLength(1);
  });

  test('no facade at all (plain pi host, no bus): the local typed message is the channel', () => {
    const sent: Array<{ customType: string; content: string; details?: unknown }> = [];
    bindBg({ sendMessage: (m: never) => sent.push(m) } as unknown as Parameters<typeof bindBg>[0]);
    const job = registerBgJob(4242, 'sleep 95', Date.now(), '');
    wakeSession(job, null, true, 'partial');
    expect(sent).toHaveLength(1);
    const wake = (sent[0].details as { wake: Array<Record<string, unknown>> }).wake[0];
    expect(wake).toMatchObject({ kind: 'wake', id: job.id, status: 'timed_out', stopReason: 'timed_out' });
    expect('exitCode' in wake).toBe(false);
    expect(sent[0].content).toContain('timed_out after');
    expect(sent[0].content).toContain('untrusted task data'); // the preamble still leads
  });

  test('a woken job is marked reported: the next resume sweep stays silent', () => {
    const sent: Array<{ content: string }> = [];
    bindBg({ sendMessage: (m: { content: string }) => sent.push(m) } as unknown as Parameters<typeof bindBg>[0]);
    setBgOwnerSession(SID);
    const job = registerBgJob(4242, 'echo done-then-restart', Date.now(), '');
    wakeSession(job, 0, false, 'DONE');
    expect(existsSync(`${job.logPath}.reported`)).toBeTrue(); // woke = reported
    expect(findOrphans(SID).some((o) => o.logPath === job.logPath)).toBe(false);
  });
});
