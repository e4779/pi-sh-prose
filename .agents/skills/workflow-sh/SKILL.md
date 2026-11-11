---
name: workflow-sh
description: "Shell-tier workflow discipline (ported from the lab's fabric-workflow port): dynamic multi-item workflows (audits, migrations, parallel research) as ONE checked sh script driving bounded `pbus agents spawn` workers. Discover -> batched fan-out (xargs -P) -> adversarial verify; strict JSON out of workers, files as state, all-failed batch aborts. Use when a task fans out over many items or asks for a workflow/parallel agents."
---

# Workflow, shell tier

The whole loop — phases, batches, branches — lives in ONE shell script, checked
before it runs (the contour's gate already runs `bash -n`; a script is the
shell-tier twin of a type-checked program). Workers are the only LLM calls;
the loop itself is plain sh. Run the script, aggregate its files, return a
digest — never per-item transcripts.

## Worker primitives

    pbus agents list                                   # pick a persona before anything
    pbus agents spawn <persona> [task | -] [--timeout=120] [--bg]
    pbus agents steer|status|stop|resume <runId> [msg] # mid-run guidance, lifecycle

- One blocking spawn = one bounded worker. Task as an argument, or pipe a
  spec on stdin with `-` (`cat spec.md | pbus agents spawn researcher -`).
- Exit codes carry the verdict: 0 complete · 1 failed/stopped · 3 timeout —
  gate every spawn on `$?`; the persona's reply goes to stdout, progress
  notes to stderr, so pipes stay clean.
- There is no `--json` flag on this bus: strict-JSON replies are a
  PROMPT-side contract — ask for exactly the keys, then fail closed with
  `jq -e` before trusting the file (see Verifier below).
- Concurrency = N parallel `pbus` processes (xargs -P or background jobs);
  each holds its own socket connection. Budget: `-P 4..8`, `--timeout`
  always set.
- Workers need `PI_BUS_SOCK` in env — any child of a live pi session has
  it. Outside a session there is no bus: don't fan out, work directly.
- Read-only by charter: the persona's prompt is the widening lever — for a
  digest pass, instruct reading only; keep mutation to the orchestrator
  script or a deliberately-widened worker.

## The reliable shape

    run=/tmp/pi-sh/wf-$$; mkdir -p "$run/out"         # one dir per run, files are the state

1. **Discover** — one spawn with a capped inventory instruction ("list items
   as JSON, max 32"), or plain `fd`/`rg` when the inventory is mechanical.
   Dedupe, cap, and CHECK the cap; an inventory over the cap is a stop, not
   a truncation.
2. **Analyze** — batches of 4-8 via `xargs -P`; each worker gets the
   objective plus its item; results land as one file per item
   (`$run/out/NN.json`), failures as `NN.err`. After each batch: an
   all-failed batch stops the run (systemic cause — diagnose, don't
   grind); partial failures continue.
3. **Verify** — one adversarial spawn over ONLY the completed findings:
   strip unsupported claims, never infer for failed items. Output: compact
   verdict + the kept findings. (The Verifier contract below is the HARD
   form of this step.)
4. **Return** — counts, failures with one-line causes, the verified digest;
   raw findings stay in `$run/` with a pointer, not in the conversation.

Partial is a valid outcome: retry only the failed items whose coverage
matters; never auto-rerun the whole workflow. Retry a JSON-parse failure
once with a stricter prompt before treating the item as failed.

## Verifier contract (HARD rule)

Every fan-out ends with a SEPARATE verifier step — load-bearing, not style.
Workers never grade their own homework: the worker that wrote
`$run/out/NN.json` is not the process that judges it. The verifier is one
more bounded worker with its own charter — RE-DERIVE the evidence (files,
commands, tests), never trust the report — and a strict JSON reply (unquoted
EOF on purpose: `$run` must expand into the prompt):

    pbus agents spawn auditor --timeout=180 > "$run/verdict.json" <<EOF
    You are the verifier, not the author. Re-derive every claim yourself:
    open the files, run the commands, rerun the tests. Confidence in the
    report is not evidence. Reading files is enough; mutate nothing.
    Objective: <one line>.  Claims to check: $run/out/*.json
    Reply ONLY with strict JSON, exactly these keys:
      {"passed": <boolean>, "reason": "<one line>", "nextAction": "<one line>"}
    Evidence only: the reason cites files, commands, or test output. A claim
    you cannot re-derive fails. In doubt: passed=false.
    EOF

The verdict lands in exactly one place — `$run/verdict.json` — and everything
downstream reads that file, never worker transcripts. No `--json` flag guards
the wire here, so the schema check is yours and it fails closed:

    jq -e '.passed | type == "boolean"' "$run/verdict.json" >/dev/null \
      || printf '{"passed":false,"reason":"verdict missing or malformed","nextAction":"re-run verifier"}' > "$run/verdict.json"

Gate on it: a coerced `passed=false` means the run's result is unproven —
report that and act on `nextAction`; never ship the digest as fact. A
verifier that may need to re-run commands gets a persona/charter that allows
it — that is the one deliberate widening; budgets hold (`--timeout` set, one
call = one worker).

## Concurrency canon

    # worker fn exported for xargs; one line in, files out
    worker() { … pbus agents spawn "$PERSONA" - --timeout=120 < "$2" > "$run/out/$1.json" 2> "$run/out/$1.err" || echo "$1" >> "$run/failed"; }
    export -f worker   # bash; on pure sh use a subshell loop or env-carrying wrapper
    printf '%s\n' "${items[@]}" | xargs -n1 -P6 bash -c 'worker "$1"' _

Never let two workers write the same file; partition by item id. Sequential
dependency between stages is fine (pipeline = stage scripts over the same
`$run/out` dir). Long observable workers that need mid-run steering:
`--bg` (handle: runId + asyncDir) + `pbus agents steer <runId> <text>` +
`pbus agents status <runId>` — a checked script drives them the same way.

## Differences from the fabric original

- No in-guest `parallel`/`pipeline` primitives: the SCRIPT is the program,
  xargs/background jobs are the scheduler, `$run/` files are the state.
- No `workflow.item` dashboard: progress = `$run/status.log` lines
  (`date item phase rc`), aggregated at the end.
- No `--json` wire contract or per-call tool selection: replies are
  prompt-disciplined and jq-gated; capabilities come from the persona
  charter, not a `--tools` flag.
- Budgets are positional: `-P` bounds workers, `--timeout` bounds each run,
  the inventory cap bounds the fan-out.
