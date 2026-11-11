/**
 * pure-contour — the package's own surface policy: the model gets ZERO
 * declared tools and works in plain prose, terminating each message with
 * ONE executable four-backtick `sh` block. The working convention travels
 * as a `sh-prose-contract` system prompt section (the shell tool's
 * description is the carrier in mixed contours — with no declarations it
 * needs its own channel).
 *
 * Tools stay REGISTERED and the active set is untouched: the pit bridge
 * serves the registry (`pit list`, `pit describe` work without arming),
 * deferred/callable tools stay reachable where a tool context exists.
 *
 * Modes:
 * - default          — zero declared tools; contract section injected.
 * - PI_SH_PIT_ARM=1  — declare exactly one anchor, `tools_call`: pi 1.5.0
 *                      exposes executeTool ONLY inside a tool execute, so a
 *                      contour whose model never makes tool calls cannot arm
 *                      the bridge at all. With the anchor, one tools_call
 *                      execute per session arms `pit call` for every tool.
 * - PI_SH_TOOL_KEEP_SURFACE=1 — no reduction; surface stays whatever
 *                      settings/CLI selected (mixed contour).
 *
 * The before_agent_start handler is bound DURING session_start — after all
 * extensions finished loading — so re-declarers bound at load time
 * (pi-subagents' tool-activation pushes its tools into selectedTools) run
 * first and this reduction is the last word on every turn.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

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
  '- pit list — every registered tool, one line each',
  '- pit describe <tool> — full parameters (names, types, enums, descriptions)',
].join('\n');

export default function (pi: ExtensionAPI): void {
  const keep = process.env.PI_SH_TOOL_KEEP_SURFACE === '1';
  const arm = process.env.PI_SH_PIT_ARM === '1';
  if (keep) return;
  pi.on('session_start', () => {
    pi.on('before_agent_start', (event: AgentStartEvent) => {
      const o = event.systemPromptOptions;
      if (!o) return;
      o.selectedTools = arm ? ['tools_call'] : [];
      if (!o.sections) o.sections = {};
      o.sections['sh-prose-contract'] = CONTRACT;
    });
  });
}
