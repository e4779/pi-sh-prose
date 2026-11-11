/**
 * pure-contour — the package's own surface policy: the model gets ZERO
 * declared tools and works in plain prose, terminating each message with
 * ONE executable four-backtick `sh` block. The working convention travels
 * as a `sh-prose-contract` system prompt section (the shell tool's
 * description is the carrier in mixed contours — with no declarations it
 * needs its own channel).
 *
 * Tools stay REGISTERED and the active set is untouched: the bus bridge
 * serves the registry (`pbus list`, `pbus describe` work without arming),
 * deferred/callable tools stay reachable where a tool context exists.
 *
 * Modes:
 * - default (bare)   — zero declared tools from the FIRST run: no anchor,
 *                      no warmup; the bridge stays cold (memory is shell-side
 *                      via pi-recall; nothing in this contour needs pbus).
 * - PI_SH_WARM=1     — cold-start anchor + one-line warmup riding the first
 *                      turn, then strict zero again (sessions that need pit).
 * - PI_SH_BUS_ARM=1  — declare `tools_call` on every run (always-callable pit).
 * - PI_SH_TOOL_KEEP_SURFACE=1 — no reduction; surface stays whatever
 *                      settings/CLI selected (mixed contour).
 *
 * The before_agent_start handler is bound DURING session_start — after all
 * extensions finished loading — so re-declarers bound at load time
 * (pi-subagents' tool-activation pushes its tools into selectedTools) run
 * first and this reduction is the last word on every turn.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isArmed } from './bus.ts';

interface AgentStartEvent {
  systemPromptOptions?: {
    selectedTools?: string[];
    sections?: Record<string, string>;
  };
}

const CONTRACT = [
  'Working method: reply in plain prose, terminating the message with ONE executable block — a four-backtick fence tagged sh (````sh … ````), first content line = the command, closing fence ends the message. Everything is commands there: reading, searching, editing, agents, MCP, memory.',
  'Long commands need NO special handling: past ~90s the call detaches automatically (log + handle returned; completion steers this session) — write the plain command, never "&" and never polling loops. Keep output small: pipe through head/jq/toonq.',
  'Registered tools are reachable from the shell side:',
  '- pbus list — every registered tool, one line each',
  '- pbus describe <tool> — full parameters (names, types, enums, descriptions)',
].join('\n');

/** Rides the always-cold first turn: pi 1.5.0 exposes executeTool only inside a tool execute, so until some tools_call runs, the bridge cannot serve pit call. */
const WARMUP =
  'Bridge warmup (disappears once armed): before anything else in this run, call the tools_call tool once with ' +
  JSON.stringify({ tool: 'bash', args: { command: 'echo bus-warm' } }) +
  ' — it arms shell-side tool execution (pit call). Then continue normally.';

export default function (pi: ExtensionAPI): void {
  const keep = process.env.PI_SH_TOOL_KEEP_SURFACE === '1';
  const arm = process.env.PI_SH_BUS_ARM === '1';
  const warm = process.env.PI_SH_WARM === '1'; // opt-in: cold-start anchor + pit bridge
  if (keep) return;
  pi.on('session_start', () => {
    pi.on('before_agent_start', (event: AgentStartEvent) => {
      const o = event.systemPromptOptions;
      if (!o) return;
      const cold = !isArmed();
      o.selectedTools = arm || (cold && warm) ? ['tools_call'] : [];
      if (!o.sections) o.sections = {};
      o.sections['sh-prose-contract'] = CONTRACT;
      if (cold && warm && !arm) o.sections['bus-warmup'] = WARMUP;
    });
  });
}
