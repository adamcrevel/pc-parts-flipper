# Retrospective

## What happened

This was a clean, single-cycle run: Cycle 0 only, no cycle increment. The four builders (T1-T4),
eight paired reviewer/tester rows (R1-TE4), and UAT (U0) all completed in one pass each. The
"four in-place retries" were not a second cycle — they were must_fix items from validate-lead's
*first* standing-gate pass, folded back into T1-T4's own rows and fixed without re-dispatching a
new task id. That folding is itself worth flagging (see Proposals): because the retry text was
merged into the original row rather than logged as a delta, the table's `actual_tokens` and
`started_at`/`completed_at` for T1-T4 cannot be cleanly split into "first pass" vs. "fix pass" —
this retrospective can only report the combined figure per task, not the retry's isolated cost.

- **The single biggest finding**: all four must_fix items were things no reviewer or tester caught,
  and all four were caught only by validate-lead's own standing-gate run, not by any task's R/TE
  pair. Two were cross-file breakage outside the task's own named scope: T1 added
  `identify_parts_jobs` to `schema.ts` but didn't update `apps/server/test/db.test.ts`'s hardcoded
  `EXPECTED_COLUMNS`/table-count fixture (A13); T4 deleted `identifyListingParts` from
  `listings-api.ts` but didn't update `apps/web/test/api-client.test.ts`, which still called it and
  failed with a deterministic `TypeError` (A13). The other two were logic bugs inside scope but of a
  kind `vitest` (what every tester ran) cannot see: T2's `Number(process.env.IDENTIFY_PARTS_POOL_SIZE
  ?? 1)` silently resolves to `0`/`NaN` on an empty-string or non-numeric env value, stalling the
  whole queue with no error logged; T4's build broke outright (`tsc` exit 2, TS18048) because the
  outer `if (listing === undefined) return;` guard in the mount effect didn't narrow into the nested
  async `resumeJob` closure (A14) — nobody ran `npm run build`/`tsc -b` before validate-lead did.

- **Token-cost pattern across T1-T4**: the two tasks whose Cycle-0 fix was a substantive logic/type
  change (T2: defensive env parsing; T4: TS-narrowing fix + unused-import removal + rewriting a
  whole stale test block) ran roughly 2x over their `estimated_tokens` (T2: 5,200 estimated → 10,900
  actual; T4: 12,500 estimated → 24,500 actual). The two tasks whose fix was a pure
  addition/deletion (T1: add one table name to a fixture list; T3: delete one unused, discarded
  `getActiveJobForListing` call) ran well *under* estimate (T1: 48,000 → 9,500; T3: 18,500 → 2,800).
  The size of the required fix tracked the token overrun almost exactly.

- **No reviewer/tester token cost is measurable from this run at all**: every one of the eight R/TE
  rows (R1, TE1, R2, TE2, R3, TE3, R4, TE4) shows `actual_tokens: null`. Per Assumption A19, this is
  a confirmed, systematic tooling failure — `measure-child-cost.py child-cost --tag <name>` found no
  `AGENT_TAG` marker for any of the 8 children when queried by their exact dispatch name, and a
  looser guessed tag returned numbers that are contamination from unrelated historical sessions
  elsewhere under `~/.omp/agent/sessions`. This isn't a finding about the feature's execution; it's
  a gap in the harness itself that halves what any retrospective on this feature's cost can see.

- **A process risk surfaced and was caught mid-cycle, not a cost**: A12 records a sub-agent's bare
  relative path silently resolving against the main repo checkout instead of this feature's
  worktree, leaking an uncommitted diff of T3's `identifyParts.ts` rewrite into the main repo. It was
  caught via `git status --short` and reverted before it could contaminate anything, and every
  subsequent dispatch in the cycle was told to set `cwd` to the worktree explicitly. No feature cost
  resulted, but it is a real failure mode worth closing at the source rather than relying on manual
  `git status` checks to catch it each time.

- No task overran its `expected_minutes` by a flake-free, attributable margin beyond what's already
  explained above; no `context_split` is visible in the digest history (each T1-T4/R/TE row maps to
  exactly one builder/reviewer/tester dispatch, one file set); no `model` escalation occurred (every
  row ran on the default model; the "peter-gibbons" value in several rows is a dispatch-session
  label, not a model field, and is consistent across the batch). Assumptions A1-A12 were plan
  choices made once up front and never contradicted or corrected later — only A13-A19 are
  validate-time findings, and all are accounted for above.

## Proposals

- **Make `npm run build` (or each workspace's own `tsc -b`) part of every reviewer's or tester's own
  checklist, not only validate-lead's final standing gate.** `vitest` does not type-check, so a
  build-breaking type error (T4, TS18048) reached the last gate in the pipeline before being caught.
  Running the one-line build command per task is cheap relative to the cost of a cross-cutting fix
  landing at validate time.

- **When a task deletes or renames an exported function/table/column, require its own reviewer or
  tester to grep the whole test tree for the old identifier before marking the task complete**, not
  just the files named in the task's own scope. Both deterministic Cycle-0 regressions (T1's
  `db.test.ts` fixture, T4's `api-client.test.ts`) were exactly this shape — a rename/add/delete
  whose blast radius crossed into a test file the task's reviewer/tester scope didn't name. A
  one-line `grep -r <old-identifier>` catches this class before it reaches validate-lead.

- **Log in-place retry cost as an explicit delta in the Cycle Log (tokens and minutes spent on the
  fix alone), rather than folding the fix description into the original task row and leaving
  `actual_tokens`/`started_at`/`completed_at` as the combined, unsplit figure.** As written, this
  plan.md makes it impossible to say how much of T1-T4's reported cost was the original build vs.
  the Cycle-0 fix — which is exactly the kind of number a retrospective exists to extract.

- **Fix `measure-child-cost.py`'s tag-matching so a sub-agent's own dispatch name reliably resolves
  to that sub-agent's transcript**, since it returned `null` for all 8 reviewer/tester children in
  this run (A19) and a looser guess returns contaminated numbers from unrelated sessions. Until
  fixed, no retrospective on any feature can measure reviewer/tester cost at all — only builder cost
  survives in the table.

- **Have the dispatcher set each sub-agent's shell `cwd` to the worktree path directly (not just
  mention it in the prompt), and have the sub-agent verify with `git status --short` in that `cwd`
  before its first edit.** A12 shows a bare relative path can silently resolve against the main repo
  checkout instead of the worktree; this time it was caught, but catching it relied on a human
  noticing a stray diff rather than on the dispatch mechanism preventing it.

---
This report cost approximately 12,300 tokens (self-reported estimate) /
not available tokens (measured). Not counted in the feature's own total —
this analysis happened after the feature was already done.
