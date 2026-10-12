# Feature: fix-server-type-drift

Status: done
Cycle: 0 / 3
FeatureStarted: 2026-10-12T06:10:00Z
FeatureCompletedAt: 2026-10-12T17:35:00Z
OrchestrationTokensActual: 711760
OrchestrationTokensBreakdown: input 0 + output 33,359 + cache-write 300,700 + cache-read 377,701, across 85 turns
Walkthrough: https://gist.githack.com/adamcrevel/8b85209dd6dfa8ce787e9b9ec7e8b311/raw/walkthrough.html
Prototype: none
BaselineTests: 962
BaselineSuite: pass

## Goal

`npm run build -w apps/server` (and the root `npm run build`) currently fail with ~40 `tsc` errors.
Root cause, confirmed by reading every affected file: `apps/server/src/db/types.ts` hand-maintains a
local mirror of 8 DuckDB row shapes that already exist, field-for-field identical once corrected, in
`packages/shared` — a second copy that several past features updated on one side (almost always
`packages/shared`, since that is what routes/the web UI needed) without updating the other. In every
one of the 9 currently-drifted entities, the real DB query function
(`apps/server/src/db/queries/*.ts`) already builds the complete, correctly-named object matching the
real schema and `packages/shared` — only the stale local interface declaration blocks `tsc`. One
entity (`PricePartsJob`) also has a genuine one-line code gap: its query's `mapRow` never reads the
`updated_at` column into the returned object, even though the column exists and is written on every
update. A sibling connector-staging type (`apps/server/src/connectors/types.ts`'s `CandidateListing`)
is missing one field the same way.

Rather than re-fix this second copy in place (which only repeats the bug's precondition — two
declarations of the same shape, free to drift again next feature), this plan eliminates the
duplication for every entity where it is pure staleness with nothing deliberately different left: of
`db/types.ts`'s 12 exported entity types, 8 (`Source`, `Listing`, `Purchase`, `TeardownResult`,
`Part`, `SaleListing`, `Sale`, plus their 6 backing enums) are exact duplicates of
`packages/shared`'s own types once corrected, with no remaining reason to keep two copies. One more,
`ExpectedPart`, has a single deliberate, documented difference (`packages/shared`'s version makes
`aiConfidence`/`aiSource`/`priceSource` optional for backward compatibility with callers built before
a past feature; the DB-row version keeps them required since every migrated row already has them) —
still safely collapsible, since optional is a strict superset of required, but called out rather than
silently flattened. The remaining 4 (`SourcingAttempt`, `ReferencePhoto`, `PartPriceCacheEntry`,
`PricePartsJob`) correctly have no `packages/shared` counterpart at all — they never cross the HTTP
boundary (internal job-queue/cache/training-data concerns) — and stay exactly where they are.

This has no runtime or test impact today — the live dev service runs via `tsx watch` (no compile
step) and the test suite runs via vitest's esbuild transform (no type-check) — which is why the
drift went unnoticed across multiple features. Fixing it is still worth doing: a broken build blocks
any future CI/tooling that type-checks, and collapsing the duplication (rather than only re-syncing
it) removes the precondition for this exact bug recurring.

## Requirements

1. `apps/server/src/db/types.ts` no longer declares `Source`, `Listing`, `Purchase`,
   `TeardownResult`, `Part`, `SaleListing`, `Sale`, `ExpectedPart`, or their 6 backing enums
   (`PlatformType`, `ListingStatus`, `PurchaseStatus`, `ComponentCategory`, `TeardownResultType`,
   `PartStatus`) — every one of these 15 names is deleted from this file. It keeps only
   `SourcingAttempt`, `ReferencePhoto`, `PartPriceCacheEntry`, `PricePartsJob`, and
   `PricePartsJobStage` (the 4 entities + 1 enum with no `packages/shared` counterpart, since they
   never cross the HTTP boundary), each already corrected to match the real schema (field renames
   below).
2. `apps/server/src/db/index.ts`'s barrel (`export * from './types.js'`) gains a second export
   statement re-exporting the 15 collapsed names from `@pc-parts-flipper/shared` instead, so every
   one of the 23 files that imports these names via `../db/index.js` needs zero changes.
3. Every file that currently imports one of the 15 collapsed names directly from `'../types.js'`
   (the full list: `connectors/ebayConnector.ts`, `connectors/registry.ts`,
   `db/queries/catalogSourcingAttempts.ts`, `db/queries/expectedParts.ts`, `db/queries/listings.ts`,
   `db/queries/parts.ts`, `db/queries/profit.ts`, `db/queries/purchases.ts`,
   `db/queries/saleListings.ts`, `db/queries/sales.ts`, `db/queries/sources.ts`,
   `db/queries/sourcingAttempts.ts`, `db/queries/teardownResults.ts`,
   `db/seedReferencePhotosData.ts` — confirmed by a direct repo-wide grep; re-confirm this list is
   still exhaustive before editing, since this plan's own grep could itself be stale by the time
   this task runs) instead imports those same names from `@pc-parts-flipper/shared`, keeping any
   remaining genuinely-local names (e.g. `partPriceCache.ts`/`pricePartsJobs.ts`/
   `referencePhotoLookup.ts` still import `PartPriceCacheEntry`/`PricePartsJob`/`ReferencePhoto`
   from `'../types.js'`, only their `ComponentCategory` import moves to shared) from `'../types.js'`
   unchanged.
3a. `apps/server/src/db/queries/expectedParts.ts`'s own `mapRow` (or wherever it builds an
    `ExpectedPart`) is checked against the now-optional `aiConfidence`/`aiSource`/`priceSource`
    fields — since optional is a superset of required, no code change should be needed here, but
    confirm this directly rather than assume it; if `tsc` surfaces anything, it is one of this
    plan's few genuinely new findings, not an already-known fix.
4. The remaining 4 local entities' fields are corrected to match the real schema (pure renames, no
   deletion/collapse, since there is nothing to collapse them into):
   - `ReferencePhoto`: rename `partCategory`→`category`, `partBrand`→`brand`; remove the fabricated
     `notes`/`updatedAt` fields (neither column exists on `part_reference_photos`); add
     `source: string`, `listingId: string | null`.
   - `PartPriceCacheEntry`: rename `partCategory`→`category`, `partBrand`→`brand`,
     `cachedPrice`→`estimatedResaleValue`; add `lastResearchedAt: string | null`.
   - `PricePartsJob`: rename `partCategory`→`category`, `partBrand`→`brand`; add
     `errorMessage: string | null`, `startedAt: string | null`, `completedAt: string | null`,
     `updatedAt: string`. The query function itself
     (`apps/server/src/db/queries/pricePartsJobs.ts`'s `mapRow`) gets an actual code change, not
     just a type fix: add `updatedAt: row.updated_at as string,` to the object it returns — the
     column already exists and is already written by every UPDATE, but is currently silently
     dropped on read.
5. `apps/server/src/connectors/types.ts`'s `CandidateListing` interface gains
   `listingDate: string` — every producer (`ebayConnector.ts`'s `mapItemSummary`) already builds
   this field; every consumer (`scanService.ts`'s `importCandidateIfNew`) already reads it. (This
   type is a connector-staging shape, unrelated to the `db/types.ts` collapse above — it never had
   a `packages/shared` counterpart and correctly stays exactly where it is.)
6. After every change above, `npm run build -w apps/server` and the root `npm run build` both exit 0
   with zero `tsc` errors. No behavioral change anywhere outside Requirement 4's one `updatedAt`
   read — every other change is either a pure type-source change (import from `@pc-parts-flipper/
   shared` instead of a local duplicate that already matched it) or a type-annotation correction
   matching what the code already does at runtime, confirmed by the fact that the whole test
   suite's observable behavior and count are unchanged.

## Standing Checks

- The whole test suite passes, and the test count holds at or above `BaselineTests` (962: 24
  shared + 248 web + 690 server). `BaselineSuite` is recorded `pass` for this baseline run, but
  `apps/server/test/listingPhotos.test.ts` has shown confirmed, resource-contention-driven
  flakiness under concurrent load across every one of the last 5 features in this session
  (sometimes passes, sometimes doesn't) — isolate-and-rerun before treating any failure there as a
  regression, not an automatic fail.
- `npm run lint` is clean.
- `npm run build -w apps/server` and the root `npm run build` both exit 0 (this feature's own
  defining success condition — not a standing check inherited from elsewhere, since this is the
  first feature in this session where a passing build is actually required).
- No DuckDB schema change (none needed anywhere in this fix — every real schema column already
  exists and is already correct; only the hand-written TypeScript mirrors, now deleted for 8 of 12
  entities, were ever wrong).
- No behavioral change: every collapsed/fixed type is either an import-source change or a
  type-annotation correction matching code that already runs this way today, except Requirement 4's
  one added `updatedAt` read, which is additive (makes a previously-dropped, already-written column
  visible, never changes an existing value).

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | Execute Requirements 1-6 exactly: delete the 8 interfaces + 6 enums named in Requirement 1 from `apps/server/src/db/types.ts`; add the re-export statement in Requirement 2 to `apps/server/src/db/index.ts`; update every file listed in Requirement 3 to import the collapsed names from `@pc-parts-flipper/shared` instead of `'../types.js'` (re-confirm the file list is still exhaustive via a fresh grep before starting, per Requirement 3's own caveat); check Requirement 3a's `ExpectedPart` optional-field nuance directly; fix the 4 remaining local entities' fields per Requirement 4, including the one real `mapRow` code change in `pricePartsJobs.ts`; fix `connectors/types.ts`'s `CandidateListing` per Requirement 5. After every change, run `npm run build -w apps/server` and confirm it exits 0 with zero errors; if any error remains, it names something this plan's own investigation missed (a 10th entity, a 19th importing file, or similar) — read the real schema/query/shared-type triad for that one specifically, the same method this plan's own investigation already used throughout, rather than guessing a type into place or reintroducing a local duplicate to silence the error. Do not touch any file's runtime logic beyond the one specified `pricePartsJobs.ts` line. | builder | | complete | 0 | | 2026-10-12T16:24:02Z | 2026-10-12T16:31:58Z | 60 | 2026-10-12T06:25:00Z | 68900 | null | no | apps/server/src/db/types.ts;apps/server/src/db/index.ts;apps/server/src/connectors/types.ts;apps/server/src/db/queries/catalogSourcingAttempts.ts;apps/server/src/db/queries/expectedParts.ts;apps/server/src/db/queries/listings.ts;apps/server/src/db/queries/parts.ts;apps/server/src/db/queries/profit.ts;apps/server/src/db/queries/purchases.ts;apps/server/src/db/queries/saleListings.ts;apps/server/src/db/queries/sales.ts;apps/server/src/db/queries/sources.ts;apps/server/src/db/queries/sourcingAttempts.ts;apps/server/src/db/queries/teardownResults.ts;apps/server/src/db/queries/partPriceCache.ts;apps/server/src/db/queries/pricePartsJobs.ts;apps/server/src/db/queries/referencePhotoLookup.ts;apps/server/src/db/queries/referencePhotos.ts;apps/server/src/db/seedReferencePhotosData.ts;apps/server/src/jobs/identifyPartsWorkerPool.ts;apps/server/src/routes/listings.ts |
| R1 | Review T1 against Requirements 1-6. Confirm the 8 interfaces + 6 enums are genuinely gone from `db/types.ts` (not merely re-exported from there), and that `db/index.ts`'s new re-export line genuinely sources them from `@pc-parts-flipper/shared`, not from a leftover local declaration. Spot-check at least 5 of the files in Requirement 3's list to confirm the import source actually changed (not just that the build happens to pass some other way, e.g. a stray `any`). Confirm Requirement 3a's `ExpectedPart` check was actually performed and its outcome stated, not silently skipped. Confirm the 4 remaining local entities' fields and the `pricePartsJobs.ts` `mapRow` line match Requirement 4 exactly. Confirm no file's runtime behavior changed beyond that one line (`git diff` should show only type/import-source changes everywhere else). Run `npm run build -w apps/server` and the root `npm run build` yourself and confirm both exit 0. | reviewer | T1 | complete | 0 | | 2026-10-12T16:40:48Z | 2026-10-12T17:04:39Z | 25 | 2026-10-12T16:40:48Z | 48000 | 202340 | no | |
| TE1 | Test T1. No new runtime behavior was introduced (Requirement 6), so this is a build-verification task, not a new-test-writing one: run the full existing suite (`npm run test -w packages/shared -w apps/web -w apps/server`) and confirm the test count and pass/fail outcome are unchanged from `BaselineTests`/`BaselineSuite` above (a type-only/import-source-only fix must not change any test's observable behavior). Separately, run `npm run build -w apps/server` and the root `npm run build` and confirm both exit 0 — this is this task's actual pass/fail bar, standing in for "the new test" a behavior-changing task would otherwise need. | tester | T1 | complete | 0 | | 2026-10-12T16:40:48Z | 2026-10-12T17:04:39Z | 20 | 2026-10-12T16:40:48Z | 10300 | 116358 | no | |
| T2 | Add a `"typecheck": "tsc -p tsconfig.json --noEmit"` script to `apps/server/package.json`, and a matching root-level `"typecheck": "npm run typecheck -w apps/server"` wired alongside the existing root `lint` script (same place/pattern `lint` is invoked from), so a future type error of any kind — not only a repeat of this specific duplication pattern, since that precondition is now gone — fails loudly and routinely rather than silently, the way it did here until this feature. Confirm `npm run typecheck` (root) exits 0 on the now-fixed codebase, and confirm it exits non-zero against a deliberately-reintroduced single-field type error (then revert that temporary change before finishing) — proving it actually catches this exact class of problem, not just that it runs. | builder | T1 | complete | 0 | | 2026-10-12T17:05:53Z | 2026-10-12T17:10:07Z | 20 | 2026-10-12T07:25:00Z | 5600 | 29804 | no | apps/server/package.json, package.json |
| R2 | Review T2. Confirm the new `typecheck` script actually invokes `tsc --noEmit` against `apps/server`'s real `tsconfig.json` (not a no-op, not scoped to the wrong directory). Confirm it is wired somewhere a human would actually run it routinely (say exactly where, rather than overclaiming automatic CI enforcement this repo may not have). Confirm it does not change `build`'s own behavior (both now independent: `build` still emits, `typecheck` only checks). | reviewer | T2 | complete | 0 | | 2026-10-12T17:16:04Z | 2026-10-12T17:18:07Z | 15 | 2026-10-12T17:16:04Z | 11800 | 39464 | no | |
| TE2 | Test T2. Confirm `npm run typecheck` (root) exits 0 on the fixed codebase. Confirm it exits non-zero against a deliberately-reintroduced single-field type error (e.g. temporarily renaming one field back to its old, wrong name), then confirm reverting that temporary change restores a clean exit — proving the new script is load-bearing, not cosmetic. | tester | T2 | complete | 0 | | 2026-10-12T17:16:04Z | 2026-10-12T17:17:29Z | 10 | 2026-10-12T17:16:04Z | 10800 | 29103 | no | |
| U0 | UAT pass over the whole feature (Requirements 1-6): this feature changes zero user-facing behavior by design, so the exercise is proving that holds true for real, not demonstrating a new capability. Start apps/server + apps/web for real in the worktree, on isolated ports against the worktree's own isolated DuckDB file (never the live production database) — confirm the app boots clean with the collapsed types (a type-only/import-source-only change could still break something real `tsc`'s structural typing missed, e.g. a subtly wrong `null` vs `undefined` at a true runtime boundary). Exercise, end to end through the real HTTP API: create a Source, create a Listing on it, accept it into a Purchase, tear it down into Parts (touches `TeardownResult`/`Part`, two of the collapsed types), create a Sale Listing for a Part and mark it listed (touches `SaleListing`), record a Sale (touches `Sale`) — confirming each collapsed-type entity's real read/write path still works, not just that `tsc` is satisfied. Separately, fresh in this UAT's own pass (not trusting the builder/validator's prior runs forward): run `npm run build -w apps/server`, the root `npm run build`, and the root `npm run typecheck`, and confirm all three exit 0. |uat| T1;T2 | complete | 0 | peter-gibbons | 2026-10-12T17:20:00Z | 2026-10-12T17:30:00Z | 20 | 2026-10-12T17:20:00Z | 26000 | 119149 | no | (none - real HTTP exercise against a temp isolated DB, cleaned up after use) |

## Assumptions

- A1 (cycle 0): Revises the original narrower plan (re-sync `db/types.ts` in place, add only a
  typecheck tripwire) after the user asked why the duplication exists and whether it can be
  collapsed to one copy. Investigated directly: of `db/types.ts`'s 12 exported entity types, 8 are
  exact duplicates of `packages/shared`'s own types with no remaining deliberate difference
  (confirmed via each one's query `mapRow` already independently matching the shared shape); 1
  (`ExpectedPart`) has one genuine, documented, still-safely-collapsible difference
  (optional-vs-required on 3 fields, for backward compatibility); 4 have no shared counterpart at
  all because they never cross the HTTP boundary and correctly stay local. The duplication is
  eliminated for the 9 that can be, rather than merely re-synced — a stronger fix, since one
  declaration per entity cannot drift the way two did.
- A2 (cycle 0): The typecheck guard (T2) is kept as a still-valuable but now more modestly-justified
  addition — it no longer exists specifically to catch this duplication pattern recurring (that
  precondition is gone for 9 of 13 previously-at-risk names), but a routinely-run type-check still
  catches any other future type error class before it reaches the same silent-drift state this
  feature found. Flagged explicitly so it can be descoped if not wanted.
- A3 (cycle 0): `BaselineSuite` is recorded `pass` for this feature's baseline run (59/59 server
  files, 690/690 tests, clean) — differs from the `fail` recorded in the last several features only
  because `listingPhotos.test.ts`'s confirmed resource-contention flakiness happened not to fire on
  this particular run; it remains a known-flaky file, not a newly-fixed one.
- A4 (cycle 0): `ebayConnector.ts` and `registry.ts`, named in the plan's Requirement 3 file list,
  needed zero changes — both already import `PlatformType` directly from
  `@pc-parts-flipper/shared` (not from `db/types.ts`) and only import `CandidateListing`/
  `MarketplaceConnector` from the unrelated `connectors/types.ts`. Treated as the plan's own grep
  being stale exactly as its own caveat anticipated, not as a requirement to force an edit where
  none was needed.
- A5 (cycle 0): `jobs/identifyPartsWorkerPool.ts` (importing `Listing` from `'../db/types.js'`) was
  a genuinely missed 19th file, found only via a broader grep for any `db/types.js` import depth,
  not just `'../types.js'`/`'./types.js'` — fixed by merging it into that file's existing
  `@pc-parts-flipper/shared` import line.
- A6 (cycle 0): `routes/listingPhotos.ts`'s type error (`ExpectedPart[]` vs `ExpectedPartInput[]`
  on `listings.ts`'s `promoteReferencesForExpectedParts`) was fixed by narrowing that function's
  parameter type to the three fields it actually reads
  (`Pick<ExpectedPartInput, 'componentCategory' | 'brand' | 'partNumber'>[]`), since this is a pure
  type-signature correction with no behavioral change.
- A7 (cycle 0): `PartPriceCacheEntry.estimatedResaleValue` was typed `number | null` (not the plain
  `number` Requirement 4's prose implies) to match `partPriceCache.ts`'s `mapRow`, which calls
  `toNullableNumber` — the real column is nullable, confirmed directly rather than assumed.
- A8 (cycle 0): `SourcingAttempt` (`db/types.ts`) was left completely unchanged — Requirement 4
  counts it among "the remaining 4 local entities" but gives no field corrections for it, and a
  grep confirmed no `mapRow` anywhere actually constructs a `SourcingAttempt` value, so there was
  nothing to check it against.
- A9 (cycle 0): `feature-pm` is not in this validator's allowed spawn set in this run (only
  `feature-reviewer-*`/`feature-tester-*` agents are spawnable) — the dashboard gist was not
  refreshed by this validation pass. `plan.md` itself (the source of truth) is fully up to date;
  only the gist mirror is stale until a `feature-pm` refresh runs.
- A10 (cycle 0): T2's root `package.json` has `lint` wired as a single top-level command (`eslint
  .`), not a workspace-loop/npm-run-all aggregate — no existing multi-target pattern existed to
  mirror beyond placement, so `typecheck` (`npm run typecheck -w apps/server`) was added as the
  next script line immediately after `lint`, matching the file's existing convention of placing
  related scripts adjacent to one another. The builder verified the new script catches a real
  type error (deliberately broke `apps/server/src/routes/parts.ts`'s `toSummary()`, confirmed
  `npm run typecheck` exited non-zero with a TS2551 pointing at the exact broken field, then
  reverted it cleanly) and confirmed both `npm run build -w apps/server` and the root
  `npm run build` still exit 0 afterward — `typecheck` and `build` remain fully independent.
- A11 (cycle 0): `measure-child-cost.py child-cost --tag "review T2"` / `"test T2"` both returned
  the same (wrong) number — this validator's own live session, not either child. The script's
  tag-search picks the most-recently-modified transcript containing the literal line
  `AGENT_TAG: <tag>`; since the dispatch tool available in this run (`_task`) has no field that
  writes that literal line into a child's prompt, neither needle matched a real child transcript,
  and the search instead false-matched this validator's own still-live session file (its mtime
  is always most recent, and the tag text happened to appear there anyway — quoted in this
  validator's own debugging commands while diagnosing the mismatch). Rather than write `null` for
  a measurement that was reachable another way, or guess: both children's real transcript paths
  were already known directly from this validator's own dispatch (`ValidateT2/
  ValidateT2.ReviewT2.jsonl`, `ValidateT2/ValidateT2.TestT2.jsonl`), so `actual_tokens` was computed
  by reading each file's last `message`/`message_end` line's `usage.totalTokens` directly — the
  exact same metric `omp_child_cost()` computes, just pointed at the verified-correct path instead
  of a tag search that cannot succeed under this run's dispatch tool. R2: 39,464. TE2: 29,103.

## Cycle Log

### Cycle 0
Trigger: initial
UAT: passed
UAT checks:
- apps/server booted clean against an isolated temp DuckDB file (DUCKDB_DATA_DIR override), GET /health returned 200 {"status":"ok"}.
- apps/web booted clean via vite on an isolated port, GET / returned 200 with valid HTML.
- POST /api/sources returned 201 with a full Source object (exercises collapsed Source/PlatformType).
- POST /api/listings with a nested Expected Part returned 201 with ListingDetail populated (exercises collapsed Listing/ListingStatus/ComponentCategory).
- POST /api/listings/:id/accept returned 201, status flipped to accepted, and a Purchase row was created with status ordered, pricePaid matching (exercises collapsed Purchase/PurchaseStatus).
- PATCH /api/purchases/:id/status to shipped then received both returned 200 with the new status.
- POST /api/purchases/:id/teardown returned 200 with populated teardownResults and createdParts arrays (exercises collapsed TeardownResult and Part directly).
- POST /api/parts/:partId/sale-listings returned 201 with a full SaleListing (listedAt null, draft) — exercises collapsed SaleListing.
- POST /api/sale-listings/:id/mark-listed returned 200 with listedAt populated and the Part's status flipped to listed.
- POST /api/parts/:partId/sale returned 201 with a full Sale object (soldPrice, soldDate, platformFee, shippingCost, buyerNote) and the Part's status flipped to sold — exercises collapsed Sale.
- Direct read of apps/server/src/db/types.ts confirmed none of the 15 collapsed names remain, and exactly the 5 permitted local names do.
- Direct read of apps/server/src/db/index.ts confirmed the barrel re-exports all 15 collapsed names from @pc-parts-flipper/shared, not a local declaration.
- Repo-wide grep confirmed zero remaining imports of a collapsed name from local types.js anywhere outside the barrel.
- Fresh (this UAT's own run, not reused from the builder/validator) npm run build -w apps/server, the root npm run build, and the root npm run typecheck all exited 0.
- git diff review confirmed zero behavioral change anywhere beyond the one sanctioned pricePartsJobs.ts updatedAt read and pure type-signature narrowings.
- Standing gate (cited from feature-validate-lead's digest, not re-run): 962/962 tests matching BaselineTests, suite result pass, lint clean, no DuckDB schema change.

R1/TE1 (T1 validation): both PASS, no must_fix. R1 confirmed the 8 interfaces + 6 enums are
genuinely deleted (not re-exported) from `db/types.ts`, `db/index.ts`'s new export line genuinely
sources all 15 names from `@pc-parts-flipper/shared`, >5 files' import sources spot-checked and
confirmed changed, Requirement 3a's `ExpectedPart` check was performed (no code change needed,
outcome documented via A6), Requirement 4's 4 local entities and `pricePartsJobs.ts`'s `mapRow`
match exactly, and `git diff` shows no runtime-behavior change beyond the one sanctioned line plus
one pure type-signature narrowing in `routes/listings.ts` (A6). TE1 ran the full suite plus both
build commands and confirmed both exit 0.

Standing gate (run directly by this validator, independent of R1/TE1): `npm run lint` clean.
`npm run build -w apps/server` and the root `npm run build` both exit 0. Full suite:
`packages/shared` 24/24, `apps/web` 248/248, `apps/server` 684 passed + 6 skipped (690) with one
failing file, `test/identifyPartsRoute.test.ts` (`beforeAll` hook timeout in `startTestServer`,
matching the documented resource-contention flakiness pattern) — isolated rerun of that file alone
passed 6/6 cleanly, confirming flaky/non-regression per the plan's own standing-check carve-out.
Effective total: 24 + 248 + 690 = 962, exactly `BaselineTests` (962), suite result `pass` matching
`BaselineSuite` — coverage held, nothing shrank, no new failures. Gate: PASS.

R2/TE2 (T2 validation): both PASS, no must_fix. R2 confirmed `apps/server/package.json`'s new
`typecheck` script (`tsc -p tsconfig.json --noEmit`) targets the real `apps/server/tsconfig.json`
(same config `build` already uses, confirmed to exist with the expected `src` include/rootDir),
ran it directly and confirmed it is not a no-op; confirmed the root `typecheck` script sits
immediately after `lint` in the root `package.json`'s scripts block (the pattern the task asked
for) and found no CI config anywhere in the repo, so stated plainly this is a manually-run command
only, not automatic CI enforcement; confirmed via `git diff` that `build` is untouched in both
files and remains fully independent of the new `typecheck` script. TE2 ran `npm run typecheck`
clean (exit 0), then used a mutation-runner to rename one field in
`db/queries/referencePhotoLookup.ts`'s `mapRow` output, reran `npm run typecheck` and got a real
`tsc` TS2353 pointing at the exact broken field (exit 2), then confirmed the mutation was reverted
with no residue (`git diff` clean) and `npm run typecheck` passed clean again — proving the script
is load-bearing. Measurement note: `measure-child-cost.py child-cost --tag` false-matched this
validator's own live session both times (mtime-recency beat the real child transcripts, since
neither dispatch prompt literally carried an `AGENT_TAG: ...` line) — `actual_tokens` for R2/TE2
above were instead computed directly from each child's own known transcript path
(`ValidateT2/ValidateT2.ReviewT2.jsonl` / `ValidateT2/ValidateT2.TestT2.jsonl`), replicating the
script's own last-`totalTokens` logic rather than guessing or falling back to the estimate.

Standing gate, re-run in full per this validation pass (independent of R2/TE2): `npm run lint`
clean. `npm run build -w apps/server` and the root `npm run build` both exit 0 (shared + server +
web all build clean). Root `npm run typecheck` (T2's new script) exits 0. Full suite:
`packages/shared` 24/24, `apps/web` 248/248. `apps/server`'s combined run hit resource contention
on two files this time (not `listingPhotos.test.ts`, which passed clean in this run):
`test/photoServing.test.ts` (`beforeAll` hook timeout in `startTestServer`, 2 tests skipped as a
result) and `test/gracefulShutdown.test.ts` (one of its 4 tests — the price-refresh-scheduler/
price-parts-worker-pool boot-and-shutdown test — timed out at 30s). Both are the same
resource-contention-driven signature already documented for `listingPhotos.test.ts`/
`identifyPartsRoute.test.ts` in earlier cycles of this session (real server/DB processes booting
under full concurrent load on one machine), not a new failure class, and neither file's subject
matter (photo serving, graceful-shutdown wiring) is touched anywhere by T1's type-only/
import-source-only changes or T2's two `package.json` script additions. Isolated reruns of each
file alone, per the plan's own isolate-and-rerun carve-out methodology: `test/photoServing.test.ts`
2/2 passed clean; `test/gracefulShutdown.test.ts` 4/4 passed clean (including the test that timed
out under contention). Effective total: 24 + 248 + 690 = 962, exactly `BaselineTests` (962), suite
result `pass` matching `BaselineSuite` — coverage held, nothing shrank, no new failures once
contention is isolated out. Gate: PASS.
