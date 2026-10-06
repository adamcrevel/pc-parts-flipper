# Retrospective

Feature `ai-visual-identification`. `FeatureStarted` 2026-10-05T16:46:02Z → `FeatureCompletedAt`
2026-10-05T23:48:00Z = **7h02m wall**, 3 cycles (0, 1, 2), 10 build tasks (T1–T10), 20
reviewer/tester dispatches, 2 UAT passes. All `actual_tokens` are `null` (see the measurement bullet
below); every token figure quoted here is a sub-agent self-reported `estimated_tokens`, advisory only.

## What happened

- **Cycle 0 shipped 5 tasks and all 5 failed their first review.** The cycle-0 initial validation
  verdict lists must_fix items for T1 (x2: DuckDB NULL-distinctness defeats the `(category, brand,
  part_number, photo_path)` unique index, so Requirement 4 dedup never fires for a brand-only
  reference; and Requirement 6's lookup ordering was alphabetical-by-brand instead of
  lead-preference), T2 (Requirement 2 was dead code — `POST /api/listings` always sends
  `photoPaths: []`, so a new Listing's first photos never promote), T3 (x2: 288-line new file over
  the ~200-line Standing Check; stale `SEED_SCRIPT_NOTES.md`), T4 (`visualComparison.test.ts`
  referenced an unimported `PromptModule` — a real `tsc` error vitest never surfaces) and T5 (the
  second-pass merge loop applied any `partIndex` the model returned with no validation — exactly the
  thing Requirement 5 promises can't happen). 5 tasks, 7 items, 0 clean passes.
- **Cycle 0's retry round found 4 *new* must_fix items, 3 of them created by the retry fixes
  themselves.** All 10 retry-1 items were genuinely resolved, but: T1's new app-level
  SELECT-then-INSERT existence check introduced a TOCTOU race (→ T6); T3's rewritten script bypassed
  T1's query module with its own raw `INSERT INTO part_reference_photos`, reopening the
  just-fixed null-partNumber dedup bug in a second, unreviewed path (→ T8); T4's annotation fix
  covered 3 of 5 `eligibleParts` declarations and missed lines 87/97 (→ T9). Only T2's new item
  (`listingPhotos.test.ts` and `teardown.test.ts` both hardcoding port `34_632`, reproduced 3/3 per
  A15) was not self-inflicted by a fix. **11 defects total across cycle 0's two rounds.**
- **Cycle 1 (trigger: four tasks failing a second time in cycle 0) cost 4 tasks and then failed
  again on T8.** T6/T7/T9 passed clean. T8's own extraction pushed `referencePhotos.ts` to 217
  lines (over this feature's own ~200-line Standing Check), and T8-TST's *new* test inserted a
  `category: 'Motherboard'` row into the file's shared per-suite temp DB, deterministically breaking
  the pre-existing `'returns empty array for category with no photos'` test — a verification artifact
  becoming a standing-gate must_fix. T8 retried in place: build 21:41:36→21:46:05 (4m29s vs 15
  expected), re-validation 21:48:40→22:01:07 (12m).
- **Cycle 2 existed for exactly one bug, and only UAT could have found it.** U1 (22:02:30→23:10:00,
  **67m30s against a 30-minute estimate, 2.25x**, ~52,000 est. tokens — the single most expensive row
  in the plan) confirmed Requirements 1–7 live, then hit a hard 502 on every real second pass:
  `partIdentification.ts` resolved reference photos through `resolvePhotoPaths`, which strips to
  basename under `PHOTOS_DIR`, so every `reference-photos/seed/<file>` path resolved to a nonexistent
  `data/photos/<file>`. T10 fixed it in 5m39s (vs 15 expected, ~10,400 est. tokens), T10-REV/T10-TST
  took 14m13s, U2 took 27m14s. The whole cycle — the feature's actual core capability being broken
  end to end — was one line of path resolution plus one missing real-filesystem assertion.
- **The three most expensive bugs were all "invisible to this project's own verification by
  construction."** T4/T9's implicit-any errors only appear when `tsc` includes `test/` (the project's
  own invocation is scoped to `src`); T10's path bug only appears when `omp` is *not* stubbed (the
  Standing Checks require stubbing it, correctly, for determinism); T1's dedup bug only appears
  because DuckDB treats NULLs as distinct, which the unique index silently tolerates. None of these
  is a careless-builder story — the verification surface genuinely did not cover them.
- **No model escalation ever happened, reactively or otherwise.** Every cycle-0 row is `sonnet`;
  cycle-1/cycle-2 build rows carry no `model` value at all. Despite a 5/5 first-review failure rate
  on T1–T5 at `sonnet`, nothing was re-sized.
- **Three tasks' real scope ended up split across more files than planned, two of them mid-flight
  under review pressure.** T4 → `visualComparisonParser.ts` as a new sibling file (A7, to keep
  `identificationParser.ts` under the cap); T3 → `seedReferencePhotosData.ts` + `scripts/seed-reference-photos.ts`;
  T8 → `referencePhotoLookup.ts`, forced by the cycle-1 line-count must_fix. The ~200-line Standing
  Check cost a review round twice (T3 in cycle 0, T8 in cycle 1).
- **T3 was dispatched to a sandbox that structurally could not do the task.** A8 reports it `blocked`
  for lack of outbound network; A10 reports the orchestrator finishing it directly and finding **all
  10 of the builder's seed URLs 404 — fabricated** — then re-sourcing from Wikimedia Commons (also a
  licensing correction over the plan's "manufacturers'/retailers' own public product pages"), and
  fixing two further real bugs in the script while running it (missing `User-Agent`, `SEED_DIR` not
  honoring `DUCKDB_DATA_DIR`). This is the plan's clearest assumption correction: A8 → A10.
- **Six assumptions were spent re-litigating one unavailable tool.** A11, A16, A17, A18, A19, A20 and
  A21 all re-attempt or re-confirm `measure-child-cost.py` / `feature-pm`: A11 (no tag mechanism; a
  probe returned a false-positive 177712 from an unrelated transcript), A16 (three different children
  all returned the identical 79629), A17/A19/A20/A21 (the script does not exist in this repo at all).
  Every row's `actual_tokens` is correctly `null`, and `OrchestrationTokensActual` is `null` too — so
  this feature has no measured cost figure whatsoever.
- **Test-infrastructure contention triage recurred in five separate passes** (A9, A12, A15, A19, A21):
  EADDRINUSE / `beforeAll` hook timeouts in `purchases`, `saleListings`, `listingPhotos`,
  `gracefulShutdown`, `parts`, `sales`, `profit`. Each pass independently re-ran files in isolation to
  prove contention rather than regression. Buried inside that noise were two genuine port collisions:
  the new `34_632` duplicate (fixed by T7) and the still-live pre-existing `34_613` shared by
  `gracefulShutdown.test.ts`/`identifyPartsRoute.test.ts`, flagged by T7-REV and left untouched.
- **Cost shape: verification dominated.** Cycle-0 builders self-report ~25,700 est. tokens for T1–T5;
  cycle-0's reviewer/tester dispatches self-report ~195,300 — **7.6x the build cost** — and the two
  UAT passes ~98,600 more. Across all rows the self-reported total is roughly **510,000 est. tokens**,
  of which build tasks (T1–T10) are ~93,000 (~18%).
- **Bookkeeping artifacts worth one line each:** T10's `started_at` (23:02:41Z) precedes U1's
  `completed_at` (23:10:00Z), and `FeatureCompletedAt` (23:48:00Z) precedes U2's `completed_at`
  (23:55:00Z) — the row timestamps and the header are not consistent with each other. Cycle-0 rows
  also carry only one started/completed window (20:06:33→20:53:33) despite two distinct validation
  passes, so retry-1's cost is unmeasurable from the table. T1–T5's `estimated_start` values
  (17:01:40–18:01:40) run ~2h40m ahead of the actual build start (19:41:20) — the plan's own schedule
  was never close.
- Worktree commit history adds no signal: `git log` shows no commit for this feature at all (HEAD is
  `b39c496`, the previous feature), and every file listed above is still uncommitted working-tree
  state — so there is no fixup-commit pattern to read.

## Proposals

- **Add a real-filesystem assertion to the identification suite as a cycle-0 task, not a cycle-2
  fix.** Concretely: any test that builds a model-call argument list containing file paths must assert
  `existsSync` on every resolved path, even with the `omp` runner stubbed. T10's own regression test
  is exactly this, and it cost a 67-minute UAT, a whole extra cycle, and ~31,100 est. tokens to
  discover; as a cycle-0 Standing Check line it costs minutes.
- **Add "`tsc --noEmit` over a widened config that includes `test/`" to `feature-reviewer`'s standing
  verification.** Two of eleven defects (T4's original, T4's retry miss → T9) were implicit-any errors
  that the project's `src`-scoped `tsc` and vitest both ignore by construction. T9-TST already
  established the mechanism that works here (`tsconfig.testcheck.json`, since widening `include` with
  `rootDir: "./src"` produces TS6059 noise) — promote that one-off into a checked-in config and a
  documented reviewer step.
- **Size any task that writes DuckDB dedup/uniqueness logic or resolves on-disk paths at `opus`, and
  require the task text to name the NULL-semantics and atomicity question explicitly.** T1 produced 3
  of the 11 defects (NULL-distinctness, lookup ordering, then the TOCTOU race its own fix introduced,
  → T6), and T10 was a path-resolution one-liner. All were `sonnet` with no escalation.
- **Make "a fix must not introduce a new defect in the same file" a review checklist item with a named
  trigger: re-read the whole changed function, not the diff.** Three of cycle 0's four retry-round
  items (T1→T6, T3→T8, T4→T9) were created by the retry fix itself, which is what turned one retry
  round into cycle 1 under the one-free-retry rule.
- **State the ~200-line cap as a planning constraint, not just a review gate: when a task creates a
  new query module, pre-split it in the plan.** T1's `referencePhotos.ts` was always going to carry
  insert-side and lookup-side logic; planning `referencePhotos.ts` + `referencePhotoLookup.ts` as two
  files up front would have removed T8's cycle-1 must_fix entirely, and the same applies to T3's
  script/data/CLI split and T4's parser split (A7).
- **Require testers to use a category/port/fixture value registry instead of inventing one.** T8-TST's
  new test picked `'Motherboard'`, colliding with a pre-existing test in the same shared per-file DB —
  a must_fix created by verification itself. Pair this with a single
  `apps/server/test/ports.ts` exporting every hook-server port (T7-REV already inventoried 17 of
  them), which would have prevented T2's `34_632` duplicate and would still fix the live `34_613`
  collision nobody owns.
- **Default the `apps/server` suite to bounded parallelism (`--pool=forks --poolOptions.forks.maxForks=4`)
  in `package.json`.** A12 proved that exact invocation turns the whole EADDRINUSE/hook-timeout class
  green; five passes (A9/A12/A15/A19/A21) each re-paid the isolation-rerun triage cost to reach the
  same conclusion.
- **Never dispatch a task requiring network fetches to a builder sandbox; fetch the assets during
  planning or assign the task to the orchestrating session.** A8/A10: the sandboxed builder could not
  download anything and emitted 10 fabricated URLs that all 404'd. Add to the plan template: any task
  needing outbound network must name the role that has it, and any task producing external URLs must
  have them verified by real download (A10's own `curl`-then-decode check) before they are wired in.
- **Delete the per-dispatch `measure-child-cost.py` step from this host's agent instructions and record
  the unavailability once, at the top of the plan.** Seven assumptions (A11, A16–A21) re-derive the
  same conclusion; A16 even shows the false-positive shape (three distinct children, identical 79629).
  Replace it with a single header field: `TokenMeasurement: unavailable on this host (no tag-carrying
  dispatch, script absent) — all actual_tokens are null by design`.
- **Give every validation pass its own row window (or an explicit `retry` suffix) so retry cost is
  measurable.** Cycle-0's ten REV/TST rows share one 20:06:33→20:53:33 window across two distinct
  passes, which makes the single most important number in this retrospective — what cycle 0's retry
  round actually cost — unrecoverable from the plan.
- **Keep the UAT priority exactly as it was.** The plan named "a real, unstubbed `omp` second pass
  against real seed data" as the top UAT priority, and that is precisely what caught T10 when two full
  validation cycles could not. U2 then demonstrated Requirement 9(a) live (`Gigabyte` / `GeForce RTX
  3090 EAGLE OC` filled in from a real visual match, reproduced twice). This is the one part of the
  process that paid for itself.

---
This report cost approximately 31,800 tokens (self-reported estimate: ~118,000 characters read from
`plan.md` and its extracted table columns, plus ~9,000 characters written here, ÷ 4 — a rough proxy,
not a measurement) / not available (measured — a sub-agent inherits its parent's session id, so only
whoever dispatched this run can measure it from the tag it gave me). Not counted in the feature's own
total — this analysis happened after the feature was already done.
