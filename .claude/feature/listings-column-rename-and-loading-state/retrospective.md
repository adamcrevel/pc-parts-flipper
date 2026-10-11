# Retrospective

## What happened

- This was a clean, single-cycle feature: Cycle 0 only (header records `Cycle: 0 / 3`), every task
  (`P0`, `T1`, `R1`, `TE1`, `U0`) completed on its first attempt, no `must_fix` blocked the gate, and
  UAT (`U0`) passed outright. No cycle beyond 0 was ever triggered, so there is no rework cost to
  attribute.

- `T1`'s real build time was far under estimate: `started_at` 17:18:00Z, `completed_at` 17:22:23Z —
  about 4m23s elapsed against an `expected_minutes` of 40. Its `actual_tokens` (33,139) ran ~33%
  over its `estimated_tokens` (24,900), but the elapsed-time side of the estimate was generous by a
  factor of ~9, not tight.

- `R1` and `TE1` share identical `started_at`/`completed_at` timestamps (17:27:51Z → 18:12:54Z),
  confirming they ran in parallel as siblings off `T1` — but together they consumed about 45 minutes
  of wall clock against `expected_minutes` of 15 (`R1`) and 30 (`TE1`). That 45-minute stretch is the
  single largest real-time cost in the whole feature, roughly 44% of the feature's total 101-minute
  span (17:02:05Z → 18:43:57Z FeatureStarted/FeatureCompletedAt).

- `TE1`'s `estimated_tokens` was set at 185,000 — an order of magnitude above every other task in
  this plan (`P0` 10,900 actual, `T1` 24,900 estimated/33,139 actual, `R1` 17,500 estimated, `U0`
  30,800 actual). No `actual_tokens` was recorded for either `R1` or `TE1` to check that estimate
  against: Assumption A8 states `skills/feature/bin/measure-child-cost.py` does not exist anywhere in
  the repository (checked both the worktree and the main checkout), so both fields are `null` by
  protocol rather than a measured figure. The plan's single biggest declared cost is therefore also
  the one cost this run had no way to verify.

- `R1` flagged a real finding — `loadListings`'s cyclomatic complexity rising from 8 to 12
  (eslint-measured) because `T1` added two new `options?.silent` guard branches in one function
  (Assumption A6) — but validate-lead ruled it non-blocking because it is a maintainability metric,
  not a correctness/safety defect. This was the only friction point raised anywhere in review, and
  it did not require a second cycle.

- No `context_split` occurred (every task's `files_touched` maps to the single row that claimed it),
  no `model` escalation occurred (the `model` column is blank throughout — the default model handled
  the whole feature including the 185,000-token-estimated test task), and no Assumption was
  corrected after the fact through the dashboard — A1–A5 were set at Cycle 0 and held; A6–A8 are
  validate-lead's own judgment calls recorded at validate time, not corrections of a prior guess.

- The worktree's commit log (`git log --oneline`) has no commits yet for this feature's slug —
  the branch's tip commits belong to two earlier, unrelated features
  (`feat/part-notes-and-unpriced-indicator`, `feat/listings-sortable-columns`). This feature's own
  work is still uncommitted in the worktree, so the commit history adds no signal beyond what the
  task table already shows.

## Proposals

- Size `TE1`-class tasks (test-authoring tasks that touch multiple existing test files plus add new
  cases across two files, as this one did for `listing-list.test.tsx` and `listings-page.test.tsx`)
  with a token estimate grounded in the actual file sizes being touched, not a flat multiplier far
  above every sibling task — a 185,000-token estimate with no `actual_tokens` to check it against is
  unfalsifiable; either implement `skills/feature/bin/measure-child-cost.py` so this class of
  estimate can be validated post-hoc, or stop recording `estimated_tokens` for review/test tasks
  until it exists, since an unverifiable 10x-outlier estimate is worse than no estimate.
- Tighten `R1`/`TE1`'s `expected_minutes` for this plan's own next occurrence: both ran in parallel
  and together cost ~45 real minutes against expectations of 15 and 30 — since they share a
  dependency (`T1`) and run concurrently, size the pair's `expected_minutes` off whichever is
  expected to be the critical path (here, `TE1`'s 30) plus a buffer for review/test synchronization
  overhead, rather than treating each estimate as if it ran in isolation.
- When a task description deliberately merges two independent concerns into one builder task to
  keep them in the same file region (as `T1` did for the three renames plus the loading-state
  plumbing), flag the complexity-rise risk up front in the task description itself — e.g. "if
  `loadListings`'s complexity rises past the eslint threshold from the new `silent` guards, extract
  the silent/non-silent branches into a small helper" — so `R1`'s A6 finding becomes a instruction
  the builder already had, rather than a `must_fix` the validate-lead has to downgrade after the
  fact.

---
This report cost approximately 5,800 tokens (self-reported estimate) /
not available (measured) tokens. Not counted in the feature's own total —
this analysis happened after the feature was already done.
