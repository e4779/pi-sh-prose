/**
 * Falsifier for the wave-4 call-row polish (PLAN TODO:314): the shell tool's
 * renderCall renders ONE compact row for the operator — an accent prompt
 * glyph (theme.fg('accent')), the bash-highlighted FIRST command line
 * (highlightCode with the preloaded 'bash' grammar, bold like the prose
 * cards' command line), and multi-line commands collapsed to a
 * `… +N lines` marker — with cheap updates: the previous row component is
 * reused (duck-typed setText on context.lastComponent) and the row is only
 * invalidated when the bytes actually changed (same body → no invalidate,
 * letting pi-tui keep its wrapped-line cache). A failing render THROWS —
 * pi 1.5.0 catches renderCall errors in tool-execution and swaps in its
 * default fallback row; returning undefined would skip that safety net.
 *
 * Fully offline: the pi module surface is mocked with the SAME union shape
 * the other suites register (when the whole suite runs in one process, the
 * last registration must still feed every importer — hence the Text mock
 * carries the recording render contract AND the setText/invalidate methods
 * the reuse path duck-types on). highlightCode is a recording fake: tests
 * assert routing and bytes, not colors.
 */
import { describe, test, expect, mock } from 'bun:test';

const highlightCalls: Array<{ code: string; lang: string | undefined }> = [];

mock.module('@earendil-works/pi-coding-agent', () => ({
  truncateTail: (content: string) => ({ content, truncated: false, outputLines: 0, totalLines: 0 }),
  DEFAULT_MAX_LINES: 2000,
  DEFAULT_MAX_BYTES: 50_000,
}));

// The highlighter is the package-local plain-text stub
// (extensions/highlight-stub.ts), not the host SDK. Same recording fake:
// per-line «» marks so assertions see highlight ROUTING (which bytes went
// through highlightCode) rather than any color choice.
mock.module('../extensions/highlight-stub.ts', () => ({
  highlightCode: (code: string, lang?: string) => {
    highlightCalls.push({ code, lang });
    return code.split('\n').map((l) => `«${l}»`);
  },
  observePiTheme: () => undefined,
}));

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

// Union Text shape: the other suites' recording Text (text/bgFn/render) PLUS
// setText/invalidate — the methods the call-row reuse path duck-types on.
class FakeText {
  text: string;
  bgFn: ((line: string) => string) | undefined;
  setTextCalls: string[] = [];
  invalidateCalls = 0;
  constructor(text?: string, _paddingX?: number, _paddingY?: number, bgFn?: (line: string) => string) {
    this.text = text ?? '';
    this.bgFn = bgFn;
  }
  setText(t: string): void {
    this.setTextCalls.push(t);
    this.text = t;
  }
  invalidate(): void {
    this.invalidateCalls++;
  }
  render(width = 80): string[] {
    return this.text.split('\n').map((l) => {
      const padded = l + ' '.repeat(Math.max(0, width - stripAnsi(l).length));
      return this.bgFn ? this.bgFn(padded) : padded;
    });
  }
}

mock.module('@earendil-works/pi-tui', () => ({
  Text: FakeText,
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
  shellCallLine,
  callRowCmd,
} = await import('../extensions/shell.ts');

const theme = {
  fg: (color: string, text: string) => `[${color}]${text}`,
  bold: (text: string) => `**${text}**`,
};

/** Capture the registered tool definition (renderCall included). The bare
 * events bus answers nothing: the facade probe takes its null fallback. */
const registered: { tool?: { name: string; renderCall?: (...a: unknown[]) => unknown } } = {};
registerShellTool({
  events: { emit: () => {} },
  on: () => () => {},
  registerTool: (tool: { name: string; renderCall?: (...a: unknown[]) => unknown }) => {
    registered.tool = tool;
  },
} as never);

const renderCall = registered.tool?.renderCall as
  | (args: unknown, theme: unknown, context: unknown) => unknown
  | undefined;

const rowVia = (args: unknown, lastComponent?: FakeText): FakeText =>
  renderCall?.(args, theme, { lastComponent }) as FakeText;

// ---- pure normalization ------------------------------------------------------

describe('callRowCmd (cmd normalization mirrors execute)', () => {
  test('string passes through untouched', () => {
    expect(callRowCmd({ cmd: 'echo hi\nsecond' })).toBe('echo hi\nsecond');
  });

  test('array of lines joins with \\n; ONE trailing empty line is dropped', () => {
    expect(callRowCmd({ cmd: ['echo hi', ''] })).toBe('echo hi');
    expect(callRowCmd({ cmd: ['a', 'b', ''] })).toBe('a\nb');
    expect(callRowCmd({ cmd: ['a', '', ''] })).toBe('a\n'); // only ONE is dropped
  });

  test('non-string junk in the array is filtered, not crashing', () => {
    expect(callRowCmd({ cmd: ['echo hi', 42, null] })).toBe('echo hi');
  });

  test('missing cmd / garbage args normalize to empty', () => {
    expect(callRowCmd(undefined)).toBe('');
    expect(callRowCmd(null)).toBe('');
    expect(callRowCmd({})).toBe('');
    expect(callRowCmd({ cmd: 42 })).toBe('');
  });
});

// ---- the row bytes ------------------------------------------------------------

describe('shellCallLine (the compact row bytes)', () => {
  test('single-line command: accent glyph + bold highlighted first line, no fold marker', () => {
    const row = shellCallLine({ cmd: 'echo hi' }, theme);
    expect(row).toBe('[dim]$ **«echo hi»**');
  });

  test('the FIRST line only goes through highlightCode, with the bash grammar', () => {
    highlightCalls.length = 0;
    shellCallLine({ cmd: 'echo hi\nsecond --line\nthird' }, theme);
    expect(highlightCalls).toEqual([{ code: 'echo hi', lang: 'bash' }]);
  });

  test('multi-line command is folded: one marker carrying the hidden-line count', () => {
    const row = shellCallLine({ cmd: 'echo hi\nsecond\nthird' }, theme);
    expect(row).toBe('[dim]$ **«echo hi»**[muted] … +2 lines');
  });

  test('array form renders exactly what execute() will run: trailing blank adds no line', () => {
    expect(shellCallLine({ cmd: ['echo hi', ''] }, theme)).toBe('[dim]$ **«echo hi»**');
    expect(shellCallLine({ cmd: ['echo hi', 'second', ''] }, theme)).toBe(
      '[dim]$ **«echo hi»**[muted] … +1 lines',
    );
  });

  test('empty/absent cmd: accent glyph + the `...` placeholder, no marker', () => {
    expect(shellCallLine({ cmd: '' }, theme)).toBe('[dim]$ [toolOutput]...');
    expect(shellCallLine(undefined, theme)).toBe('[dim]$ [toolOutput]...');
    expect(shellCallLine({}, theme)).toBe('[dim]$ [toolOutput]...');
  });

  test('blank first line over a real second line still folds honestly', () => {
    const row = shellCallLine({ cmd: '\nreal' }, theme);
    expect(row).toBe('[dim]$ [toolOutput]...[muted] … +1 lines');
  });

  test('a theme without bold still renders (guarded bold, like buildCardLines)', () => {
    expect(shellCallLine({ cmd: 'echo hi' }, { fg: (c, t) => `[${c}]${t}` })).toBe(
      '[dim]$ «echo hi»',
    );
  });
});

// ---- the tool surface ----------------------------------------------------------

describe('renderCall (tool surface, cheap updates)', () => {
  test('the shell tool registers a renderCall', () => {
    expect(registered.tool?.name).toBe('shell');
    expect(typeof renderCall).toBe('function');
  });

  test('fresh render: a new row component carries the body', () => {
    const comp = rowVia({ cmd: 'echo hi' });
    expect(comp).toBeInstanceOf(FakeText);
    expect(comp.text).toBe('[dim]$ **«echo hi»**');
  });

  test('cheap update: the previous component is reused, not reallocated', () => {
    const prev = new FakeText();
    const comp = rowVia({ cmd: 'echo hi' }, prev);
    expect(comp).toBe(prev);
    expect(prev.setTextCalls).toEqual(['[dim]$ **«echo hi»**']);
  });

  test('same body again → setText but NO invalidate (pi-tui keeps its cache)', () => {
    const prev = new FakeText();
    rowVia({ cmd: 'echo hi' }, prev);
    rowVia({ cmd: 'echo hi' }, prev); // e.g. a redraw with unchanged args
    expect(prev.invalidateCalls).toBe(1); // first paint only; the repeat is free
    expect(prev.setTextCalls.length).toBe(2);
  });

  test('streaming partial args: invalidate fires exactly when the bytes change', () => {
    const prev = new FakeText();
    rowVia({ cmd: 'echo' }, prev); // first paint
    rowVia({ cmd: 'echo' }, prev); // re-render, unchanged
    rowVia({ cmd: 'echo hi' }, prev); // chunk arrived
    rowVia({ cmd: 'echo hi\nsecond' }, prev); // fold marker appears
    expect(prev.invalidateCalls).toBe(3);
    expect(prev.text).toBe('[dim]$ **«echo hi»**[muted] … +1 lines');
  });

  test('a foreign component without setText is not mutated; a fresh row is built', () => {
    const foreign = { notAText: true };
    const comp = renderCall?.({ cmd: 'echo hi' }, theme, { lastComponent: foreign }) as FakeText;
    expect(comp).toBeInstanceOf(FakeText);
    expect((foreign as { notAText: boolean }).notAText).toBe(true);
  });

  test('rendering failure THROWS: pi catches it and installs its default row', () => {
    // Verified against pi 1.5.0 tool-execution.js:226-243 — only a throw
    // routes into createCallFallback(); returning undefined would render an
    // empty region instead of the default renderer's `Shell cmd=...` row.
    const throwingTheme = { fg: () => { throw new Error('no theme'); } };
    expect(() => renderCall?.({ cmd: 'echo hi' }, throwingTheme, {})).toThrow('no theme');
    expect(() => renderCall?.(undefined, throwingTheme, {})).toThrow('no theme');
  });

  test('garbage args render the placeholder row instead of throwing', () => {
    const comp = rowVia(undefined);
    expect(comp.text).toBe('[dim]$ [toolOutput]...');
  });
});
