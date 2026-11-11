# agent-env.sh — sourced via $BASH_ENV by every non-interactive bash the
# shell contour spawns (extensions/shell-exec.ts owns the contract). Project
# + machine context for the agent. Runs on EVERY call — keep it tiny. No
# aliases: they don't expand non-interactively and only blur semantics.
#
# PATH order matters: ~/.bun/bin and ~/bin may shadow safely (distinct
# names), but $PLAN9/bin goes LAST — plan9 ls/sed/grep/awk would shadow
# BSD/GNU userland and break tool flags (live scar: 'ls -la', grep usage).
PATH="$HOME/bin:$PATH"
PATH="$HOME/.bun/bin:$PATH"              # mcporter and friends
if [ -d /usr/local/plan9 ]; then
    PLAN9=/usr/local/plan9
    export PLAN9
    PATH="$PATH:$PLAN9/bin"              # sam/ssam/9 resolve, base tools keep their flags
fi
export PATH
