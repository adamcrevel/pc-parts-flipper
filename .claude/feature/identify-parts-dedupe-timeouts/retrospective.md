# Retrospective

## What happened

This was a clean, single-cycle run: Cycle 0 only, no cycle increment, 2 builder tasks (T1, T2),
their paired reviewer/tester rows (R1/TE1, R2/TE2), and one UAT pass (U0) — all PASS on the first
dispatch of each, no must_fix routed back to a builder, no second cycle triggered.

- **T2's first build attempt used 300\_000ms, not the 240\_000ms that shipped — corrected before
  R2/TE2 were ever dispatched.** `plan-cycle0.md` (the plan as frozen before any task ran) sized
  Requirement 3 at `300_000` — matching `DEFAULT_OMP_SOURCING_TIMEOUT_MS` exactly. Assumption A3
  records that this was "caught during this orchestrator's own pre-handoff check of T2's first
  build attempt," because an equal (not strictly-greater) sourcing/identification timeout breaks
  `ompSourcingRunner.test.ts`'s existing `toBeGreaterThan` invariant. The requirement and T2's row
  were rewritten to `240_000` (double the original 120s, still strictly below sourcing's 300s)
  before T2 was handed to review/test. The final plan.md shows only the corrected value; the
  300\_000 attempt is visible solely by diffing it against `plan-cycle0.md`.
- **Two further mid-run self-corrections are named in this feature's assignment but left no trace
  in `plan.md` or `plan-cycle0.md` to independently verify from the record alone**: an
  orchestrator-side mistake of creating R1/TE1/R2/TE2 rows prematurely (before T1/T2 were actually
  done), fixed before the plan was frozen; and a builder sub-agent fabrication caught during an
  integration-style check. Neither shows up in either snapshot because both snapshots only capture
  state *after* each correction — `plan-cycle0.md` (before any task ran) has no R/TE rows at all,
  and `plan.md` (final) shows only clean PASS rows with no must_fix language attached to either T1
  or T2's own builder row. This is a traceability gap: the written record preserves post-freeze
  corrections (A3) but not every pre-freeze one.
- **T1's fix broke pre-existing tests via a shared mock barrel, and a second file sharing that same
  barrel had the identical latent gap.** TE1 found T1's new, previously-unmocked
  `listExpectedPartsByListing`/`deleteExpectedPart`/`createExpectedPart`/`triggerPriceLookups` calls
  broke 5/8 existing tests in `identifyPartsWorkerPool.test.ts`; fixed by extending that file's mock
  barrel, then adding two new tests through the real `processJob` path. The Cycle Log separately
  records that `test/identifyPartsPriceTrigger.test.ts` — a second file using the same `db/index.js`
  mock barrel and exercising the same code path — had the identical missing-mock gap, "found and
  fixed directly (same two-line mock addition pattern as TE1's fix)" only once the full suite was
  run, outside TE1's own named scope (T1 only).
- **One real must_fix surfaced and was closed in the same cycle**: R2 found a stale cross-file doc
  comment in `ompSourcingRunner.ts:14` ("2.5x ompRunner.ts's 120s") left inaccurate by T2's
  240\_000 change; TE2 fixed it to "1.25x ompRunner.ts's 240s" alongside updating the two
  `partIdentification.test.ts` tests that pinned the old 120\_000 value/message.
- **Model-alias dispatch failed reactively, not up front**: T2's planned model, `derek-zoolander`,
  could not be resolved for its own reviewer (R2) and tester (TE2) dispatches; both rows record
  "unavailable; ran as feature-reviewer-small/feature-tester-small per Main's correction — role/size
  is the real dispatch signal, not a literal model string." This cost a failed dispatch attempt and
  a correction round-trip on both R2 and TE2, not a cycle, but it is the one place this run's task
  table shows friction that wasn't about the code itself.
- **No `context_split` and no reactive model escalation** otherwise: every task's real scope stayed
  on its own row (T1→R1/TE1, T2→R2/TE2, no task spilling into a second id), and the only
  non-default model (`derek-zoolander`, sized for T2's "single mechanical constant-and-comment
  edit") was assigned up front, not escalated after the fact — it simply couldn't be resolved as
  named.
- **Both builder tasks ran well under their token estimates** (T1: 8000 estimated → 5300 actual;
  T2: 3000 estimated → 2200 actual) and under/at their expected_minutes (T1: 10 expected, ~12
  actual; T2: 5 expected, ~6 actual) — no task overran in either dimension. U0 (UAT) is the one row
  that ran well past its expected_minutes: 20 expected vs. ~44 real minutes
  (`2026-10-08T07:13:27Z`→`07:57:16Z`), driven by two real, unstubbed `omp` CLI runs — one
  ~23-minute success-path job and a second failure-path job — exercised live rather than mocked.

## Proposals

- **Check cross-constant invariant tests at plan-authoring time, not after a build attempt.** T2's
  300\_000→240\_000 correction (A3) was only caught by the orchestrator's own pre-handoff check
  after a builder had already implemented the original, wrong-by-invariant value. The break was
  knowable by reading `ompSourcingRunner.test.ts`'s existing `toBeGreaterThan` relationship before
  writing Requirement 3's number into the plan at all. Add to planning: when a requirement changes
  a numeric constant that another file's test asserts a relationship against (greater-than,
  ratio, etc.), read that test first and size the new value to satisfy it, rather than discovering
  the violation during or after the build.
- **Record pre-freeze self-corrections the same way A3 records a post-freeze one.** The premature
  reviewer/tester-row creation and the builder fabrication this feature's own assignment names both
  happened but left nothing in `plan.md`/`plan-cycle0.md` for a retrospective to verify directly —
  only A3-style corrections that happen to straddle a snapshot boundary get preserved. Add a
  one-line Cycle Log or Assumption note at the moment any self-correction is made, even if it's
  reversed before the next frozen snapshot, so retrospectives don't have to rely on out-of-band
  testimony for process-level findings.
- **When a task's fix touches a shared test mock barrel, grep all files importing that barrel for
  the same gap in the same pass, not just the one named in the task.** T1's db-call changes broke
  `identifyPartsWorkerPool.test.ts` (caught by TE1, in-scope) and separately broke
  `identifyPartsPriceTrigger.test.ts` (caught later, only when the full suite ran, out of TE1's
  named scope). A single `grep -l` for the shared barrel's import across `apps/server/test/` at the
  point TE1 extends the mock would have caught both in one pass instead of two.
- **Resolve role-aliased model dispatch (`feature-reviewer-small`/`feature-tester-small`, not a
  literal model string) before the first attempt, not after a failure.** `derek-zoolander` failed
  for both R2 and TE2 and had to be corrected by Main mid-run to the role/size-based dispatch. Since
  this is now a known-working substitution pattern (recorded directly in both rows), default new
  dispatches straight to the role-and-size form and skip the literal-model-string attempt entirely.

---
This report cost approximately 8000 tokens (self-reported estimate) / not available (measured;
the measured figure comes from whoever dispatched this retrospective) tokens. Not counted in the
feature's own total — this analysis happened after the feature was already done.
