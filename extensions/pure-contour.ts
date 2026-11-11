/**
 * pure-contour — the package's own surface policy: the model gets exactly
 * one declared tool, `shell`, so the four-backtick prose block at the end
 * of a message is the single way of working. Everything else stays
 * REGISTERED — the sh-bridge socket serves pit, deferred tools stay
 * callable — but is not declared to the model.
 *
 * Why here and not in settings: the package IS the contour. defaultTools
 * cannot express this (it governs built-ins; package tools self-activate),
 * and `pi --tools shell` is per-invocation only.
 *
 * Why late binding: some packages re-declare their tools on
 * before_agent_start (pi-subagents' tool-activation re-adds subagent,
 * supervisors and bg_wait after any earlier reduction). Handlers run in
 * registration order, so a handler bound DURING session_start — after all
 * extensions finished loading — always runs after every load-time-bound
 * competitor and gets the last word on every turn. The same handler also
 * rewrites event.systemPromptOptions.selectedTools, the structure those
 * competitors mutate, so the outgoing prompt for THIS run is already clean.
 *
 * Escape hatch for mixed experiments: PI_SH_TOOL_KEEP_SURFACE=1 skips the
 * reduction entirely — the surface stays whatever settings/CLI selected.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

interface AgentStartEvent {
  systemPromptOptions?: { selectedTools?: string[] };
}

export default function (pi: ExtensionAPI): void {
  const reduce = (event?: AgentStartEvent): void => {
    if (process.env.PI_SH_TOOL_KEEP_SURFACE === '1') return;
    pi.setActiveTools(['shell']);
    if (event?.systemPromptOptions) event.systemPromptOptions.selectedTools = ['shell'];
  };

  pi.on('session_start', () => {
    reduce();
    pi.on('before_agent_start', (event: AgentStartEvent) => reduce(event));
  });
}
