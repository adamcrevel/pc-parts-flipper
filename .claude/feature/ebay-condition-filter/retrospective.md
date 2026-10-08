# Retrospective

## What happened

- **Cycle 1 opened** because `feature-validate-lead` FAILed Cycle 0 on 6 must_fix items across
  three tasks (T1, T5, T6) plus a standing-gate failure (58 new test failures, 1 new lint warning).
  Cycle 1 added three fix tasks (T7, T8, T9) plus their re-review/re-test pairs (R7/TE7, R8/TE8,
  R9/TE9) — 9 tasks total, expected_minutes summing to 8+12+15+6+8+12+15+12+15 = 103 minutes
  against a real elapsed wall-clock of roughly 16:15 to 17:08 (~53 minutes for T7-T9 plus
  R7/TE7-R9/TE9), so the fix cycle actually ran faster than its own estimate, not slower. Measured
  `actual_tokens` for the cycle's three builder tasks: T7 = 23,774 (only one of the nine rows with
  a real number — see below).

- **The single biggest cost driver was MF-4 (T6, critical)**: T6's diff deleted the exported
  `initialExpectedPartRows` function from `listing-form-state.ts` while `listing-form.tsx` and 7
  pre-existing test files still called it by name, throwing on every single mount of `ListingForm`
  — the root cause of all 56 of TE6's 56 web test failures across 8 files. T9's fix also had to
  correct A13: the actual break included `listing-form.tsx`'s `ExpectedPartsEditor` import being
  wholesale *replaced* by the new `NonWorkingBadge` import rather than added alongside it — a
  second, distinct breakage inside the same task that the original MF-4 description didn't name
  precisely.

- **MF-5 (T6)** was a correctness gap, not a crash: `updateWorkingStatus` had no same-status guard,
  so re-clicking an already-active working-status button cleared a real, already-researched price
  even though nothing had changed — a silent data-loss bug that TE6 caught before UAT.

- **MF-2 (T5)** was the most subtle finding: `propagateCachedPriceToExpectedParts`'s UPDATE WHERE
  clause filtered only on `price_source = 'auto'`, not `working_status = 'working'`, so a
  non-working part's $1 override could be silently overwritten by an unrelated *working* Listing's
  real researched price landing on the same (category, brand, part-number) combo later — a side
  channel that defeated Req 13/15's durability guarantee without any of T5's own code paths looking
  wrong in isolation. This is exactly the kind of cross-task interaction a single task's own review
  can't surface, since the bug only appears when T5's cache-propagation code and T5's $1-override
  code are read *together*.

- **MF-1 (T1)** was a straightforward type-narrowing miss: `ExpectedPartInput.workingStatus` was
  typed without `| null` while the existing `validateOptionalEnum()` helper returns `T | null` (the
  same pattern `priceSource` already used correctly) — a real `TS2322` compile error, caught by R1
  reading the actual DDL/types rather than trusting T1's own claim.

- **MF-3 and MF-6** were both fixture-regression misses of the same class already fixed elsewhere
  in T5: `pricePartsTriggerRace.test.ts`'s `partFixture` never set `workingStatus`, so the new Node
  B gate excluded every fixture before it reached the cache/job tables (2 failures), and T5's own
  new test file left an unused `runMigrations` import (1 lint warning) — both signs that the same
  fixture-shape fix was applied inconsistently across sibling test files within a single task.

- **Token measurement was broken for the entire feature.** Assumption A10 (Cycle 0) and A16 (Cycle
  1) both document that `actual_tokens` came back `null` for every R/TE row — 12 children in Cycle
  0, and for Cycle 1, `measure-child-cost.py child-cost --tag "<tag>"` returned the *identical*
  figure (250,761) for all six of R7/TE7/R8/TE8/R9/TE9 despite wall-clock durations ranging from
  1m36s to 11 minutes, indicating the tag-matching fell back to the orchestrator's own transcript
  rather than any child's. Only the three builder tasks in Cycle 1 (T7=23,774; T8 and T9 rows show
  `null` too in the table even though they're builders) — actually checking the table, only T7 has
  a non-null `actual_tokens` (23,774); T8 and T9 are also `null`. So across all 24 non-prototype
  tasks, exactly one (T7) has a real measured token figure.

## Proposals

- **Add an export/import-removal check to the builder's own self-review step for any task that
  edits a file already imported elsewhere**, since MF-4 was the most expensive single finding this
  feature produced (56 test failures, a critical-severity crash on every mount) and was entirely
  mechanical: grep every file the task's diff touches for `export function <name>` deletions and
  `import` line replacements before handing off, rather than relying on the next reviewer to catch
  it live. This would have caught both the deleted `initialExpectedPartRows` export and the
  clobbered `ExpectedPartsEditor` import in T6 itself, instead of needing a whole extra cycle (T9 +
  R9 + TE9) to fix.

- **Add a "same-value no-op" check to `feature-brief`/task specs for any new UI toggle/setter that
  can reset a derived field (like a price) as a side effect**, given MF-5's class of bug (re-click
  the active state, lose real data) is a recognizable pattern whenever a handler's reset logic
  isn't gated on an actual value change. Naming this explicitly in T6's own task spec next time
  would avoid relying on TE6 to find it by construction.

- **When a task touches a shared-cache propagation path (like `propagateCachedPriceToExpectedParts`)
  in the same diff as a new per-row exclusion field (like `working_status`), require the reviewer
  to explicitly trace every *other* write path into that same table, not just the task's own new
  code** — MF-2 was invisible from T5's own diff because the WHERE clause that needed the new
  column was in a function T5 didn't modify at all (it only added the column and the one trigger
  check). This is the one finding here that a single task's own review structurally cannot catch;
  R5 did catch it by being told to construct a specific counter-example, which is the right
  technique — formalize "trace every write-path into the touched table, not just the touched
  function" as a step for cross-cutting tasks like T5.

- **Fix the token-measurement tagging gap rather than keep reporting `null`.** Two separate cycles
  (A10, A16) hit the same root cause: whatever dispatch mechanism `measure-child-cost.py` expects
  (an `AGENT_TAG: <tag>` line inside the child's own transcript) isn't reachable through the `_task`
  tool this orchestrator used, which has no description/tagging parameter to embed that marker. 26
  of 27 task rows in this feature's own table carry `null` for `actual_tokens` as a result —
  essentially the entire cost-accounting column is unusable. This is worth fixing once, upstream
  (either give `_task` a tagging parameter or point the measurement script at whatever identifier
  `_task` does expose), rather than re-discovering and re-documenting the same gap on every future
  feature's plan.md.

---
This report cost approximately 15,100 tokens (self-reported estimate) /
not available (measured — the caller would need to measure this from the dispatch tag it gave this
run; no `AGENT_TAG` marker was provided to this run for self-measurement) tokens (measured). Not
counted in the feature's own total — this analysis happened after the feature was already done.
