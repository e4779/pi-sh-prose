/**
 * Falsifier for the wave-3 gate adoption (gap-table rows 2-3 ADOPTION,
 * synthesis re-scope step 1): the shell tool routes its pre-exec gate and
 * postProcess through the fork's shell policy facade over pi.events
 * (pi-fabric:shell-policy:{gate,post,config}:v1) when the config channel
 * answers available:true, and falls back to the minimal standalone parse
 * check / pass-through when it does not. The local PI_SHELL_GATE switch and
 * the duplicated lint/offload machinery are retired — one kill-switch name
 * (PI_FABRIC_SHELL_GATE) lives host-side now.
 *
 * Fully offline: the facade is a mock over a fake EventBus that mirrors
 * registerFabricShellPolicyService (synchronous respond callbacks during
 * emit — pi's EventBus invokes handlers synchronously). No host, no LLM,
 * no UI; the fallback path's bash -n spawns are real.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// Resolution scaffolding only (shell-lab has no node_modules offline) —
// the SAME union shape the other suites register: when the whole suite runs
// in one process, the last registration must still feed every importer.
mock.module('@earendil-works/pi-coding-agent', () => ({
  truncateTail: (content: string) => ({ content, truncated: false, outputLines: 0, totalLines: 0 }),
  DEFAULT_MAX_LINES: 2000,
  DEFAULT_MAX_BYTES: 50_000,
  highlightCode: (code: string) => code.split('\n'),
}));
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
mock.module('@earendil-works/pi-tui', () => ({
  Text: class {
    text: string;
    bgFn: ((line: string) => string) | undefined;
    constructor(text?: string, _paddingX?: number, _paddingY?: number, bgFn?: (line: string) => string) {
      this.text = text ?? '';
      this.bgFn = bgFn;
    }
    render(width = 80): string[] {
      return this.text.split('\n').map((l) => {
        const padded = l + ' '.repeat(Math.max(0, width - stripAnsi(l).length));
        return this.bgFn ? this.bgFn(padded) : padded;
      });
    }
  },
  styleText: (text: string) => text,
  matchesKey: (data: string, key: string): boolean => {
    const KEYS: Record<string, string> = { escape: '\x1b', up: '\x1b[A', down: '\x1b[B', enter: '\r', 'ctrl+o': '\x0f' };
    return data !== undefined && KEYS[key] === data;
  },
  truncateToWidth: (s: string, w: number): string => (s.length > w ? s.slice(0, Math.max(0, w)) : s),
  visibleWidth: (s: string): number => stripAnsi(s).length,
}));
mock.module('typebox', () => ({
  Type: new Proxy({}, { get: () => () => ({}) }),
}));

const {
  default: registerShellTool,
  gateRoute,
  gateCheck,
  postRoute,
  postProcess,
  bindShellPolicyBus,
  probeShellPolicyConfig,
  shellPolicyConfig,
  SHELL_POLICY_GATE_CHANNEL,
  SHELL_POLICY_POST_CHANNEL,
  SHELL_POLICY_CONFIG_CHANNEL,
  SHELL_POLICY_KILL_SWITCH_ENV,
  MAX_SHELL_POLICY_OUTCOME_OUTPUT,
} = await import('../extensions/shell.ts');

// ---- offline scaffolding ---------------------------------------------------

type Handler = (data: unknown) => void;

/** Fake pi EventBus: synchronous dispatch, exactly like createEventBus(). */
function makeBus(): {
  emit: (channel: string, data: unknown) => void;
  on: (channel: string, handler: Handler) => () => void;
  count: (channel: string) => number;
} {
  const listeners = new Map<string, Handler[]>();
  return {
    emit: (channel, data) => {
      for (const h of [...(listeners.get(channel) ?? [])]) h(data);
    },
    on: (channel, handler) => {
      const arr = listeners.get(channel) ?? [];
      arr.push(handler);
      listeners.set(channel, arr);
      return () => {
        listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== handler));
      };
    },
    count: (channel) => (listeners.get(channel) ?? []).length,
  };
}

type Bus = ReturnType<typeof makeBus>;

/** A mock of pi-fabric's registerFabricShellPolicyService: config answers
 * the availability knob; gate/post delegate to injectable policy halves
 * (the kill-switch rule replicates the middleware: env `off` → null). */
function installFacade(
  bus: Bus,
  opts: {
    available?: boolean;
    gate?: (cmd: string) => { version: 1; message: string } | null;
    post?: (cmd: string, outcome: { ok: boolean; exitCode: number | null; output: string }) => {
      notes: string[];
      output: string;
    };
  } = {},
): { gateCalls: string[]; postRequests: Array<{ version: number; command: string; outcome: { ok: boolean; exitCode: number | null; output: string } }> } {
  const available = opts.available ?? true;
  const gateCalls: string[] = [];
  const postRequests: Array<{ version: number; command: string; outcome: { ok: boolean; exitCode: number | null; output: string } }> = [];
  bus.on(SHELL_POLICY_CONFIG_CHANNEL, (value: unknown) => {
    const req = value as { version: number; respond?: (c: unknown) => void };
    req.respond?.({
      version: 1,
      available,
      gate: available,
      outputBudget: available,
      killSwitchEnv: 'PI_FABRIC_SHELL_GATE',
      offloadBytes: 4_000,
      offloadOneLineBytes: 1_500,
      dumpDir: '/tmp/pi-fabric-shell-policy/adopt-test',
    });
  });
  bus.on(SHELL_POLICY_GATE_CHANNEL, (value: unknown) => {
    const req = value as { version: number; command: string; respond?: (b: unknown) => void };
    gateCalls.push(req.command);
    // The middleware's per-call kill switch, replicated host-side.
    if (process.env.PI_FABRIC_SHELL_GATE === 'off') {
      req.respond?.(null);
      return;
    }
    req.respond?.(opts.gate ? opts.gate(req.command) : null);
  });
  bus.on(SHELL_POLICY_POST_CHANNEL, (value: unknown) => {
    const req = value as {
      version: number;
      command: string;
      outcome: { ok: boolean; exitCode: number | null; output: string };
      respond?: (r: unknown) => void;
    };
    postRequests.push({ version: req.version, command: req.command, outcome: req.outcome });
    req.respond?.(opts.post ? opts.post(req.command, req.outcome) : { notes: [], output: req.outcome.output });
  });
  return { gateCalls, postRequests };
}

/** Minimal ExtensionAPI stand-in: events bus + handler capture. */
function makePi(bus: Bus): { pi: Parameters<typeof registerShellTool>[0]; registered: { toolName?: string; sessionStart?: unknown } } {
  const registered: { toolName?: string; sessionStart?: unknown } = {};
  const pi = {
    events: bus,
    on: (event: string, handler: unknown) => {
      if (event === 'session_start') registered.sessionStart = handler;
      return () => {};
    },
    registerTool: (tool: { name: string }) => {
      registered.toolName = tool.name;
    },
  };
  return { pi: pi as unknown as Parameters<typeof registerShellTool>[0], registered };
}

const PARSE_ERROR_CMD = 'if then fi'; // bash -n rejects it

// ---- tests -----------------------------------------------------------------

describe('gate adoption: facade path', () => {
  test('facade block verdict passes through verbatim, route facade', () => {
    const bus = makeBus();
    const msg = 'shell-gate: blocked — 1 shellcheck finding(s). Fix and retry.';
    const { gateCalls } = installFacade(bus, {
      gate: (cmd) => ({ version: 1, message: `${msg}\ncmd was: ${cmd}` }),
    });
    bindShellPolicyBus(bus);
    const r = gateRoute('rm -rf /tmp/x');
    expect(r.route).toBe('facade');
    expect(r.block).toContain(msg);
    expect(gateCheck('rm -rf /tmp/x')).toBe(r.block);
    expect(gateCalls).toEqual(['rm -rf /tmp/x', 'rm -rf /tmp/x']); // config probe is not a gate call; two gateRoute calls = two gate asks
  });

  test('facade null verdict means the command runs; no local lint runs', () => {
    const bus = makeBus();
    installFacade(bus, { gate: () => null });
    bindShellPolicyBus(bus);
    expect(gateRoute('echo HELLO')).toEqual({ block: null, route: 'facade' });
    // even a syntax error passes when the HOST gate says null (host owns the verdict)
    expect(gateRoute(PARSE_ERROR_CMD)).toEqual({ block: null, route: 'facade' });
  });

  test('registration subscribes the config channel and wires the tool', () => {
    const bus = makeBus();
    installFacade(bus, { available: true });
    bindShellPolicyBus(null);
    const { pi, registered } = makePi(bus);
    // The factory must actually run: a live operator env may hold
    // PI_SHELL_PROSE=hard (the tool arm dissolves there — nothing to wire).
    const savedProse = process.env.PI_SHELL_PROSE;
    delete process.env.PI_SHELL_PROSE;
    try {
      registerShellTool(pi);
    } finally {
      if (savedProse === undefined) delete process.env.PI_SHELL_PROSE;
      else process.env.PI_SHELL_PROSE = savedProse;
    }
    expect(registered.toolName).toBe('shell');
    expect(typeof registered.sessionStart).toBe('function');
    const snapshot = shellPolicyConfig();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.version).toBe(1);
    expect(snapshot?.available).toBe(true);
    expect(snapshot?.killSwitchEnv).toBe('PI_FABRIC_SHELL_GATE');
    expect(snapshot?.offloadBytes).toBe(4_000);
    expect(snapshot?.offloadOneLineBytes).toBe(1_500);
    expect(snapshot?.dumpDir).toBe('/tmp/pi-fabric-shell-policy/adopt-test');
    // and the tool arm routes through the facade from here on
    expect(gateRoute('echo HI').route).toBe('facade');
  });
});

describe('gate adoption: fallback path (facade absent / not yet available)', () => {
  test('no bus at all: minimal bash -n parse check, no lint', () => {
    bindShellPolicyBus(null);
    expect(shellPolicyConfig()).toBeNull();
    expect(gateRoute('echo HELLO')).toEqual({ block: null, route: 'fallback' });
    const blocked = gateRoute(PARSE_ERROR_CMD);
    expect(blocked.route).toBe('fallback');
    expect(blocked.block).toContain('shell-gate: bash cannot parse this');
    expect(blocked.block).not.toContain('SC'); // no shellcheck diagnostics exist on the fallback
  });

  test('bus bound but no facade listening: fallback, fail-open', () => {
    bindShellPolicyBus(makeBus()); // zero listeners
    expect(gateRoute('echo HELLO')).toEqual({ block: null, route: 'fallback' });
    expect(gateRoute(PARSE_ERROR_CMD).block).toContain('bash cannot parse this');
  });

  test('config available:false (pre-bootstrap session): fallback even with listeners present', () => {
    const bus = makeBus();
    const { gateCalls } = installFacade(bus, { available: false });
    bindShellPolicyBus(bus);
    const r = gateRoute('echo HELLO');
    expect(r.route).toBe('fallback');
    expect(r.block).toBeNull();
    expect(gateCalls).toEqual([]); // the gate channel was never asked
  });

  test('malformed facade gate answer is not guessed into a verdict: fallback', () => {
    const bus = makeBus();
    installFacade(bus, { available: true, gate: () => ({ version: 1, message: '' }) as never });
    bindShellPolicyBus(bus);
    expect(gateRoute('echo HELLO')).toEqual({ block: null, route: 'fallback' });
  });

  test('postProcess fallback: output passes through untouched (no offload, no hints)', () => {
    bindShellPolicyBus(null);
    const big = 'line\n'.repeat(5_000);
    const result = { ok: true, exitCode: 0, output: big, timedOut: false, aborted: false };
    expect(postRoute('seq 5000', result)).toEqual({ notes: [], output: big, route: 'fallback' });
    expect(postProcess('seq 5000', result)).toEqual({ notes: [], output: big });
    expect(postProcess('seq 5000', result).output).toBe(big); // no dump pointer note
  });
});

describe('kill-switch pass-through (one name: PI_FABRIC_SHELL_GATE)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved[SHELL_POLICY_KILL_SWITCH_ENV] = process.env[SHELL_POLICY_KILL_SWITCH_ENV];
    saved.PI_SHELL_GATE = process.env.PI_SHELL_GATE;
  });
  afterEach(() => {
    if (saved[SHELL_POLICY_KILL_SWITCH_ENV] === undefined) delete process.env[SHELL_POLICY_KILL_SWITCH_ENV];
    else process.env[SHELL_POLICY_KILL_SWITCH_ENV] = saved[SHELL_POLICY_KILL_SWITCH_ENV];
    if (saved.PI_SHELL_GATE === undefined) delete process.env.PI_SHELL_GATE;
    else process.env.PI_SHELL_GATE = saved.PI_SHELL_GATE;
  });

  test('PI_FABRIC_SHELL_GATE=off: the HOST switch wins, tool arm passes, route facade', () => {
    const bus = makeBus();
    const blocked = { version: 1, message: 'shell-gate: blocked — would-block marker' };
    installFacade(bus, { gate: () => blocked }); // would block without the switch
    bindShellPolicyBus(bus);
    process.env[SHELL_POLICY_KILL_SWITCH_ENV] = 'off';
    expect(gateRoute('rm -rf / # would-block')).toEqual({ block: null, route: 'facade' });
  });

  test('legacy PI_SHELL_GATE=off does NOT silence the adopted gate (facade blocks anyway)', () => {
    const bus = makeBus();
    installFacade(bus, { gate: () => ({ version: 1, message: 'shell-gate: blocked — 1 finding(s)' }) });
    bindShellPolicyBus(bus);
    process.env.PI_SHELL_GATE = 'off';
    expect(gateRoute('rm -rf /').block).toContain('blocked');
    expect(gateRoute('rm -rf /').route).toBe('facade');
  });

  test('legacy PI_SHELL_GATE=off does NOT disable the fallback parse check either', () => {
    bindShellPolicyBus(null); // no facade: standalone path
    process.env.PI_SHELL_GATE = 'off';
    expect(gateRoute(PARSE_ERROR_CMD).block).toContain('bash cannot parse this');
    expect(gateRoute(PARSE_ERROR_CMD).route).toBe('fallback');
  });
});

describe('postProcess budget via facade', () => {
  const shellResult = (output: string, exitCode = 0): {
    ok: boolean;
    exitCode: number | null;
    output: string;
    timedOut: boolean;
    aborted: boolean;
  } => ({ ok: exitCode === 0, exitCode, output, timedOut: false, aborted: false });

  test('oversized outcome rides the facade: notes + digested output replace the raw bytes', () => {
    const bus = makeBus();
    const raw = 'x'.repeat(9_000); // past offloadBytes (4000), one line
    const dumpNote = 'full output → /tmp/pi-fabric-shell-policy/adopt-test/deadbeef.out';
    installFacade(bus, {
      post: (_cmd, outcome) => ({
        notes: [`${dumpNote} · text · ${outcome.output.length}B — rg/sed it, don't rerun`],
        output: `[... digested by the host budget ...]`,
      }),
    });
    bindShellPolicyBus(bus);
    const r = postRoute('dump-big', shellResult(raw));
    expect(r.route).toBe('facade');
    expect(r.output).toBe('[... digested by the host budget ...]');
    expect(r.notes[0]).toContain(dumpNote);
    expect(postProcess('dump-big', shellResult(raw)).output).toBe(r.output);
  });

  test('the post request carries the versioned outcome (ok/exitCode/output mapped from ShellResult)', () => {
    const bus = makeBus();
    const { postRequests } = installFacade(bus); // pass-through answers
    bindShellPolicyBus(bus);
    postRoute('exit 3', shellResult('some output', 3));
    expect(postRequests).toHaveLength(1);
    expect(postRequests[0].version).toBe(1);
    expect(postRequests[0].command).toBe('exit 3');
    expect(postRequests[0].outcome).toEqual({ ok: false, exitCode: 3, output: 'some output' });
  });

  test('`# full` valve is honored host-side: unchanged output, empty notes, route facade', () => {
    const bus = makeBus();
    const raw = 'y'.repeat(9_000); // would offload without the valve
    installFacade(bus, {
      post: (_cmd, outcome) => ({ notes: [], output: outcome.output }), // middleware: FULL_MARKER → pass-through
    });
    bindShellPolicyBus(bus);
    expect(postRoute('dump-big # full', shellResult(raw))).toEqual({
      notes: [],
      output: raw,
      route: 'facade',
    });
  });

  test('outcome past the wire cap (MAX_FABRIC_SHELL_POLICY_OUTCOME_OUTPUT) skips the facade', () => {
    const bus = makeBus();
    const { postRequests } = installFacade(bus);
    bindShellPolicyBus(bus);
    const huge = 'z'.repeat(MAX_SHELL_POLICY_OUTCOME_OUTPUT + 1);
    const r = postRoute('too-big', shellResult(huge));
    expect(r.route).toBe('fallback');
    expect(r.notes).toEqual([]);
    expect(r.output).toBe(huge); // fail-open: nothing is transformed off-facade
    expect(postRequests).toHaveLength(0);
  });

  test('malformed facade post answer falls back to pass-through', () => {
    const bus = makeBus();
    installFacade(bus, { post: () => ({ notes: 'not-an-array', output: 42 } as never) });
    bindShellPolicyBus(bus);
    const r = postRoute('echo hi', shellResult('hello'));
    expect(r.route).toBe('fallback');
    expect(r).toEqual({ notes: [], output: 'hello', route: 'fallback' });
  });
});
