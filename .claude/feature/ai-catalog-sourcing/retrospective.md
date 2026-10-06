# Retrospective — ai-catalog-sourcing

Written by the orchestrator directly (`feature-retrospective-medium` dispatch failed — same
model-selection outage documented in Assumption A6/A22 across this session's features), reading the
full `plan.md` (Goal, Requirements, Standing Checks, Tasks, Assumptions, Cycle Log) as source material.

## What actually happened

One cycle, zero must_fix retries, zero new worktree setup friction (Node 22 PATH prefix, DuckDB
single-writer discipline — all already-known quirks, no new surprises). Three small tasks (T1 table +
queries, T2 prompt + parser, T3 orchestration) built directly by the orchestrator end to end — every
specialist-agent dispatch attempted first (`feature-pm`, `feature-build-lead`, `feature-validate-lead`,
`feature-uat-tester-medium`, `feature-retrospective-medium`) and every one failed with the same
"No model selected" error that has now persisted across three consecutive features this session,
including `feature-build-lead`'s `@medium` alias, which had worked reliably in the immediately prior
feature. The outage is not improving; every future feature in this environment should expect to budget
for fully manual build+validate+UAT+retrospective until it is fixed upstream.

The one genuine mid-cycle complication was **user steering, not technical difficulty**: after T1-T3
were built and fully tested against an `MAX_CATALOG_PRODUCTS_PER_CALL = 8` cap (a reasonable default,
explicitly named in the plan as "engineering judgment" per Assumption A2), the user corrected course —
the cap should not exist at all, since the manufacturer's real catalog size is the only meaningful
limit. This required: removing a constant and its two call sites (prompt builder, parser), removing the
corresponding prompt wording and parser truncation logic, and updating/removing three tests that had
pinned the capped behavior. The edit itself was small; what made it slower was one real **self-inflicted
mistake** — a batched multi-range `PUT` edit (two non-adjacent line ranges in one call) silently dropped
the real `for` loop body from `catalogSourcingOrchestrator.ts`'s `sourceCatalogIfNeeded`, replacing it
with only its surrounding comment. `npx tsc --noEmit` did NOT catch this (the function still typechecked
— `candidates` was unused-but-declared, no type error), and it was only caught because the very next
step was re-reading the file to continue editing, not because of a test failure. Had a test run happened
first without a fresh read, the regression (silently zero-inserting every candidate) could have shipped.

A second real regression, this one a genuine and expected consequence of the feature working correctly:
an existing, unrelated route test (`identifyPartsRoute.test.ts`) had a fixture part shaped exactly like
this feature's new trigger condition (`brand: 'NVIDIA', partNumber: null`) and had never needed to stub
the sourcing runner, because the *old* behavior did nothing for that shape. The new behavior correctly
attempts catalog sourcing for it — reaching the real, test-forbidden `omp` binary and timing out. This
was only caught by running the **full** monorepo suite, not just the new feature's own test files; it
would have shipped silently if validation had been scoped to "do the new tests pass" rather than "does
the whole suite still pass."

UAT was unusually decisive for this feature specifically because catalog-mode sourcing is naturally,
directly, synchronously callable and observable (no need to coax a non-deterministic first identification
pass into a specific shape) — a real `omp` call against `montechpc.com` found 32 real products (all
rejected on download per a pre-existing, documented CDN quirk, correctly handled) and a second real call
against `apevia.com` found and verified 63 real products, all inserted. A third call to the completely
unmodified `findReferencePhotosForLeads` closed the loop, proving the feature's stated Goal
("the already-existing brand-only lookup... can match against several real candidates of that brand")
true in practice, not just by code inspection. Separately, a UAT-script hygiene bug (`process.exit(0)`
before closing the DuckDB connection, corrupting the WAL) cost one throwaway-data-dir reset and a rerun —
noted in the Cycle Log so a future UAT script uses `closeConnection()` from the start.

## Proposals for next time

1. **Never trust `tsc --noEmit` alone to catch a lost code block from a multi-range edit.** This
   feature's near-miss (the dropped `for` loop) would have been caught immediately by running the
   relevant test file right after the edit, before moving on to the next file. The established practice
   of "run the directly-affected tests after each meaningful edit" should be treated as a hard rule for
   multi-range `PUT` edits specifically (single-range edits are much lower risk), not just a good habit.
2. **"The whole suite passes" must mean the literal whole suite, every time, not just the new/changed
   test files.** This feature's second genuine regression (the unrelated route test reaching the real
   `omp` binary) was invisible to any test scoped to this feature's own new files — it only existed in
   a test file this feature never touched, whose fixture happened to collide with the new trigger
   condition. This is a general risk for any feature that *widens* an existing trigger condition (as
   opposed to adding a brand-new, previously-unreachable one): every existing test fixture that happens
   to match the newly-widened shape is a candidate for exactly this kind of accidental new assertion.
   Worth explicitly grepping for fixtures matching the new condition's shape (here: `partNumber: null`
   alongside a non-null `brand`) across the whole test directory as a dedicated pre-validation step for
   this specific category of change, rather than discovering it via a slow full-suite run.
3. **The WSL spawn()-based-server test-contention pattern is now confirmed across three separate
   features this session** (6 distinct, never-repeating, always-isolation-clean files failed across 5
   full-suite runs in this feature alone). This is costing real wall-clock time (each full run is
   ~115-220s, and several had to be re-run or isolation-verified). If this pattern persists into future
   features, it may be worth a one-time investigation into whether `helpers.ts`'s `startTestServer`
   could use a fixed small pool of pre-allocated ports with retry-with-backoff built into the helper
   itself, rather than relying on every individual spawn succeeding first-try under system load — this
   would remove the need for the orchestrator to manually isolation-verify flaky files after every full
   run across every future feature.
4. **The specialist-agent outage should now be treated as "expected down" rather than "worth
   re-checking every single dispatch point."** This feature still dutifully re-tried `feature-pm`,
   `feature-build-lead`, and `feature-validate-lead` once each (all failed, consistent with the
   established pattern) — that is the right level of diligence for CONFIRMING the outage is still live,
   but each retry costs a real round-trip. A cheaper future pattern: one single health-check dispatch
   (to any one representative role-aliased agent) at the very start of a feature's build phase, and if
   it fails, proceed directly to manual execution for build/validate/UAT/retrospective without
   re-attempting each individual specialist along the way — only re-attempt the full set once, at the
   start of the *next* feature, to detect whether the outage has cleared.
5. **This feature's own practice of calling the orchestration function directly for UAT (bypassing the
   HTTP/first-pass layer) continues to be the right call for any feature whose new logic sits behind a
   non-deterministic AI first pass.** It was decisive here (two full real-manufacturer-site runs in
   under 10 minutes total, with unambiguous evidence) and was already the right call in the prior
   feature (the Seasonic UAT). Worth keeping as the default UAT strategy for any future AI-sourcing or
   AI-identification feature in this codebase, rather than trying to force a real end-to-end HTTP
   scenario to land on the exact trigger shape non-deterministically.
