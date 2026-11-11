---
name: rlm-sh
description: "Shell-tier recursive context decomposition for oversized corpora (ported from the lab's fabric-rlm port). Measure the gate first (fd/du: >100 files, >10MB, or an 'all/every/whole-repo' ask), then orient -> disjoint partitions as file lists under $run/parts/ -> one `pbus agents spawn` worker per partition (digest-only charter) -> combine digests, dedupe, one verify pass. The orchestrator holds stats and digests only, never raw corpus. Use when the corpus itself cannot fit one context."
---

# RLM, shell tier

Recursion is for context size, not difficulty. The corpus stays on disk as
the external variable; workers cross the boundary per partition; the
orchestrator's context holds only stats and digests. The loop itself is ONE
checked sh script (workflow-sh's canon), and the batch mechanics — xargs -P,
all-failed-batch abort, status.log, retry-once-on-parse-failure — are
workflow-sh's, not repeated here.

## The gate: measure, never feel

Invoke on the corpus gate, not on a vibe. If the relevant material fits one
context, work directly; "all / every / whole-repo" in the ask is the third
trigger, but the numbers are the judge:

    fd -t f -E .git | wc -l      # > 100 files
    du -sm .                     # > 10 MB total

The ask saying "everything" over 12 files is a fan-out (workflow-sh), not RLM.

## The loop

    run=/tmp/pi-sh/rlm-$$; mkdir -p "$run/parts" "$run/digests"

1. **Orient** — one cheap listing pass; this is the only corpus data the
   orchestrator ever holds:

       fd -t f -E .git > "$run/all-files"
       wc -l < "$run/all-files"; du -sm .    # corpus stats + partition plan

2. **Partition** — non-overlapping file lists under `$run/parts/`. Mechanical
   (`split -l … -d` over the listing) or by top-level dir — disjoint by
   construction, then CHECKED before dispatch (overlap or loss = stop):

       split -l 200 -d "$run/all-files" "$run/parts/part-"
       [ "$(sort -u "$run"/parts/part-* | wc -l)" -eq "$(wc -l < "$run/all-files")" ] || exit 9

3. **Delegate** — one worker per partition: a digest-only charter (read the
   listed files, nothing else; ≤1KB per partition, evidence-backed), the
   partition's file list on stdin, result into `$run/digests/`:

       pbus agents spawn "$PERSONA" - --timeout=600 > "$run/digests/${part##*/}.json" <<EOF
       Digest ONLY the files listed below for the objective. Read-only:
       open the files, touch nothing. <=1KB, evidence-backed.
       Objective: <one line>
       EOF
       [ $? -eq 0 ] || echo "${part##*/}" >> "$run/failed"

   A partition still oversized after the split recurses: rerun this loop
   scoped to that subtree, at most two recursive roots (the original cap).
4. **Combine** — merge the per-partition digests (N × ≤1KB is bounded
   context), dedupe repeats and contradictions — then ONE verify pass under
   workflow-sh's Verifier contract: a separate verifier spawn, strict
   `{"passed", "reason", "nextAction"}` verdict into `$run/verdict.json`
   (jq -e fail-closed), in doubt → passed=false. The final digest ships only
   behind a verdict.

## Rules that make it RLM

- The orchestrator never reads raw corpus into context — only stats and
  digests. Content is touched by workers, addressed by path.
- Partitions own disjoint file sets: one file, one owner. Overlap means
  double-counted findings and racing edits; the step-2 check is the gate.
- Partial coverage is reported, not hidden: failed or unstarted partitions
  are named with their paths in the final digest. `partial` is usable
  evidence with named gaps — retry only partitions whose coverage matters,
  never the whole tree.

Original: fabric-rlm via the lab's shell-tier port. Batch mechanics and the
verifier invocation shape: `../workflow-sh/SKILL.md`.
