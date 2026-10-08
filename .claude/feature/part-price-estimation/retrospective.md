# Retrospective

## What happened

- **Cycle 0 → Cycle 1.** Cycle 0's validate pass FAILed on 6 findings across 5 tasks: T1 (stale
  `db.test.ts` `EXPECTED_COLUMNS` fixture, 2 real test failures), T2 (a Req-11 guard test that
  asserted two independently-satisfiable substrings instead of the actual no-guess sentence, so it
  couldn't catch its own regression), T4 twice over — a proven concurrent-writer race in
  `hasNonTerminalPriceJob`+`createQueuedPriceJob` producing duplicate `price_parts_jobs` rows, and
  a proven Req 14/15 violation where clearing an auto-priced value got silently re-populated from
  the cache on the next save — T6 (nightly refresh sweep had no per-entry isolation), and T9 (a
  doc comment claiming cyclomatic complexity 10 when a real `eslint --rule complexity` run
  measured 14). Because more than one task was named, this opened Cycle 1 (6 fix tasks, T10–T15)
  rather than an in-place retry. Summed `expected_minutes` for T10–T15: 10+15+25+45+20+10 = 125
  minutes. Real wall-clock from Cycle 1's first dispatch (T10's `estimated_start`,
  2026-10-07T23:55:07Z) to Cycle 1's validate PASS (U1 completing 2026-10-08T03:28:11Z) was
  roughly 3h33m — well beyond the 125-minute sum, though that gap also absorbed the 6 paired
  review/test tasks (R10/TE10…R15/TE15) and T13's own in-place retry below, none of which were
  counted in the 125-minute figure. `actual_tokens` is `null` for every task in the table (A18:
  the host's `child-cost --tag` measurement tool returned `null` for all 18 Cycle-0 children and
  the same held through Cycle 1), so no real token total can be cited — only `estimated_tokens`
  exists, and the plan itself is explicit that this is never substituted for a measured figure.

- **T13's in-place retry (within Cycle 1, not a new cycle).** T13 — the fix for T4's priceSource
  semantics bug — was itself escalated to the large model (`albert-einstein`), matching the same
  escalation T4-review/T4-test got in Cycle 0 (10 files touched, the feature's largest
  cross-cutting task). Cycle 1's validate pass still FAILed T13 on its first attempt: MF1 (HIGH —
  `updateRow` only flipped an already-`'auto'` row to `'manual'`; a row that was never `'auto'`,
  typed into and then cleared, stayed `undecided` and was silently re-claimed — the same
  null-conflation bug A21 named, entered from the other direction) and MF2 (MED — two doc comments
  in `partPriceCache.ts` and `schema.ts` still described the superseded two-state `price_source`
  semantics). Both were fixed and re-verified (R13/TE13) without opening a further cycle, per the
  "group by task" routing rule. T13's `expected_minutes` was 45; its `estimated_start` was
  2026-10-08T00:45:07Z and its final `completed_at` (after the retry) was 02:00:53Z — roughly 75
  minutes real elapsed against a 45-minute estimate, a ~67% overrun, driven entirely by needing a
  second pass on the same task rather than by the first pass being slow.

- **A8 was a wrong assumption, caught by validation, not a mistake.** Cycle 0's A8 declared
  `expected_parts.price_source` a two-value field (`'auto' | null`), reasoning that null
  unambiguously meant "not auto-managed." A21 (Cycle 1) corrected this: null actually conflated two
  distinct states — "never eligible yet" and "a user explicitly cleared a previously auto-priced
  value" — both producing an identical wire payload with no way for the server to tell them apart.
  This was the single root cause behind both of T4's Cycle-0 must_fix findings and T13's own MF1
  retry. The fix (A22) made `price_source` a proper three-state field (`'auto' | 'manual' | null`)
  sharing one existing nullable column — no schema change, just a semantics correction that took
  two attempts (T13's first pass, then MF1) to close both directions of the conflation.

- **A recurring fixture-maintenance gap.** T1 added two new tables and one new column to
  `schema.ts`, but `db.test.ts`'s hard-coded `EXPECTED_COLUMNS`/table-count fixture was left stale
  (T1-test's own finding, fixed in T10). A12 separately notes this is the same class of bug that
  already hit `ai_confidence`/`ai_source` in `migrate.ts` before this feature — i.e. this is the
  second documented occurrence of "a schema change leaves a hard-coded test fixture or rebuild list
  unmaintained until a reviewer/tester catches it."

- **A recurring stale-doc-comment-on-a-measured-claim pattern.** T9-review (Cycle 0) found
  `identify-parts-button.tsx`'s doc comment asserting a specific cyclomatic-complexity number that
  a real lint run no longer matched, after T9's own additions pushed it from 10 to 14. This is the
  same shape of defect MF2 hit again in T13 (a doc comment describing a semantics model the code
  had already moved past) — a comment stating a specific, checkable fact that isn't re-verified
  when the file it describes changes again.

- **Dispatch-parallelism collision on the same file, twice.** A19 (Cycle 0) documents
  `ReviewT8`/`TestT8` and `ReviewT4`/`TestT9` each reading a sibling's file mid-write and reporting
  a stale finding, resolved by re-reading after both returned. The same exposure recurred in Cycle
  1: R13 and TE13 both ran live break/restore mutation experiments against
  `expected-parts-editor.tsx` concurrently and interleaved mid-run, caught via IRC, serialized, and
  verified clean only after the fact. No damage resulted either time, but the underlying dispatch
  pattern (reviewer and tester working the same file in parallel) produced the same class of
  transient-collision risk twice across this one feature.

## Proposals

- For schema-adding tasks (this feature's T1): add "update `db.test.ts`'s `EXPECTED_COLUMNS`
  fixture and `migrate.ts`'s rebuild lists for every new table/column" as an explicit sub-item of
  the schema task itself, not something left for a reviewer/tester to discover after the fact —
  this is now the second feature in this codebase (after `ai_confidence`/`ai_source`, per A12) to
  hit exactly this gap.
- When a task's description cites a specific measured number in a doc comment (a cyclomatic
  complexity figure, a test count, a column count), add a review-checklist line requiring the
  reviewer to re-run the measurement live rather than trust the stated number — this caught T9's
  stale "10" and should be made a standing step rather than something each reviewer has to
  reinvent per task.
- When a task (like T4 here) is large enough to need the two-way null/undecided-vs-claimed
  semantics distinction A21 ended up specifying, write that three-state model into the task's own
  description up front rather than let it surface as a must_fix after the fact — concretely, any
  future task introducing a nullable "ownership" or "source" flag on a per-row field should be
  checked at spec time for exactly this conflation ("does null mean one thing or two?"), since this
  feature hit the same bug shape twice (T4's original finding, then T13's MF1) before it was fully
  closed.
- Do not dispatch a task's reviewer and its tester in parallel when the tester is expected to
  author or mutate the same file the reviewer reads live (true for both A19's Cycle-0 collisions
  and R13/TE13's Cycle-1 collision on `expected-parts-editor.tsx`) — serialize review-then-test (or
  test-then-review) for any task where the reviewer's own verification method is live mutation
  against a file the tester is also actively writing.
- Fix the `child-cost --tag` measurement gap (A18): every task in this plan shows
  `actual_tokens: null`, so this retrospective — and any future one for this worktree — cannot
  measure real token cost per task or per cycle, only `estimated_tokens`. Without a working
  measurement path, cycle-cost analysis in this process is permanently blind to its most basic
  question: how many tokens did a cycle actually cost versus Cycle 0.

---
This report cost approximately 21300 tokens (self-reported estimate) /
not available tokens (measured) — the measured figure is the caller's to report from the dispatch
tag, not mine to produce. Not counted in the feature's own total — this analysis happened after
the feature was already done.
