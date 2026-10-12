# Feature: fix-server-type-drift

Status: proposed
Cycle: 0 / 3
FeatureStarted: 2026-10-12T06:10:00Z
OrchestrationTokensActual: null
OrchestrationTokensBreakdown: null
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
| T1 | Execute Requirements 1-6 exactly: delete the 8 interfaces + 6 enums named in Requirement 1 from `apps/server/src/db/types.ts`; add the re-export statement in Requirement 2 to `apps/server/src/db/index.ts`; update every file listed in Requirement 3 to import the collapsed names from `@pc-parts-flipper/shared` instead of `'../types.js'` (re-confirm the file list is still exhaustive via a fresh grep before starting, per Requirement 3's own caveat); check Requirement 3a's `ExpectedPart` optional-field nuance directly; fix the 4 remaining local entities' fields per Requirement 4, including the one real `mapRow` code change in `pricePartsJobs.ts`; fix `connectors/types.ts`'s `CandidateListing` per Requirement 5. After every change, run `npm run build -w apps/server` and confirm it exits 0 with zero errors; if any error remains, it names something this plan's own investigation missed (a 10th entity, a 19th importing file, or similar) — read the real schema/query/shared-type triad for that one specifically, the same method this plan's own investigation already used throughout, rather than guessing a type into place or reintroducing a local duplicate to silence the error. Do not touch any file's runtime logic beyond the one specified `pricePartsJobs.ts` line. | builder | | not_started | 0 | | | | 60 | | | | no | |
| R1 | Review T1 against Requirements 1-6. Confirm the 8 interfaces + 6 enums are genuinely gone from `db/types.ts` (not merely re-exported from there), and that `db/index.ts`'s new re-export line genuinely sources them from `@pc-parts-flipper/shared`, not from a leftover local declaration. Spot-check at least 5 of the files in Requirement 3's list to confirm the import source actually changed (not just that the build happens to pass some other way, e.g. a stray `any`). Confirm Requirement 3a's `ExpectedPart` check was actually performed and its outcome stated, not silently skipped. Confirm the 4 remaining local entities' fields and the `pricePartsJobs.ts` `mapRow` line match Requirement 4 exactly. Confirm no file's runtime behavior changed beyond that one line (`git diff` should show only type/import-source changes everywhere else). Run `npm run build -w apps/server` and the root `npm run build` yourself and confirm both exit 0. | reviewer | T1 | not_started | 0 | | | | 25 | | | | no | |
| TE1 | Test T1. No new runtime behavior was introduced (Requirement 6), so this is a build-verification task, not a new-test-writing one: run the full existing suite (`npm run test -w packages/shared -w apps/web -w apps/server`) and confirm the test count and pass/fail outcome are unchanged from `BaselineTests`/`BaselineSuite` above (a type-only/import-source-only fix must not change any test's observable behavior). Separately, run `npm run build -w apps/server` and the root `npm run build` and confirm both exit 0 — this is this task's actual pass/fail bar, standing in for "the new test" a behavior-changing task would otherwise need. | tester | T1 | not_started | 0 | | | | 20 | | | | no | |
| T2 | Add a `"typecheck": "tsc -p tsconfig.json --noEmit"` script to `apps/server/package.json`, and a matching root-level `"typecheck": "npm run typecheck -w apps/server"` wired alongside the existing root `lint` script (same place/pattern `lint` is invoked from), so a future type error of any kind — not only a repeat of this specific duplication pattern, since that precondition is now gone — fails loudly and routinely rather than silently, the way it did here until this feature. Confirm `npm run typecheck` (root) exits 0 on the now-fixed codebase, and confirm it exits non-zero against a deliberately-reintroduced single-field type error (then revert that temporary change before finishing) — proving it actually catches this exact class of problem, not just that it runs. | builder | T1 | not_started | 0 | | | | 20 | | | | no | |
| R2 | Review T2. Confirm the new `typecheck` script actually invokes `tsc --noEmit` against `apps/server`'s real `tsconfig.json` (not a no-op, not scoped to the wrong directory). Confirm it is wired somewhere a human would actually run it routinely (say exactly where, rather than overclaiming automatic CI enforcement this repo may not have). Confirm it does not change `build`'s own behavior (both now independent: `build` still emits, `typecheck` only checks). | reviewer | T2 | not_started | 0 | | | | 15 | | | | no | |
| TE2 | Test T2. Confirm `npm run typecheck` (root) exits 0 on the fixed codebase. Confirm it exits non-zero against a deliberately-reintroduced single-field type error (e.g. temporarily renaming one field back to its old, wrong name), then confirm reverting that temporary change restores a clean exit — proving the new script is load-bearing, not cosmetic. | tester | T2 | not_started | 0 | | | | 10 | | | | no | |

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

## Cycle Log

### Cycle 0
Trigger: initial
UAT: not_run
