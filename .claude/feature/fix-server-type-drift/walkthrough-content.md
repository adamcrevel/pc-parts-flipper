# Overview
`apps/server`'s build was broken by ~40 `tsc` errors, all rooted in one cause: `apps/server/src/db/types.ts` hand-maintained a second, stale copy of 8 entity types and 6 enums that already lived, correctly, in `packages/shared` — and the two copies had drifted apart. The fix deletes the duplicates and re-exports the real `packages/shared` types instead, fixes two small real code gaps the drift was hiding, and adds a `typecheck` script so a broken build like this fails loudly next time instead of going unnoticed.

## Collapsing the duplicate types
Summary: Of `db/types.ts`'s 12 entity types, 8 (plus 6 backing enums) were exact, correctable duplicates of `packages/shared`'s own types with no remaining reason to exist twice — deleted from the server and re-exported from the shared package through the existing barrel instead, so no importer needed its own source edited.
Tasks: T1
Flow:
- Local duplicate: `db/types.ts` declared its own Source, Listing, Purchase, etc.
- Delete: 8 interfaces + 6 enums removed entirely
- Re-export: `db/index.ts` barrel sources them from `@pc-parts-flipper/shared`
- Importers unchanged: 23 files keep importing from `../db/index.js`
Files:
- apps/server/src/db/types.ts: Deletes the 8 duplicated entity interfaces and 6 enums, keeping only the 4 entities (plus 1 enum) that genuinely have no `packages/shared` counterpart because they never cross the HTTP boundary.
- apps/server/src/db/index.ts: Adds the re-export statement that sources the 15 collapsed names from `@pc-parts-flipper/shared` instead of a local declaration, so the barrel's public surface is unchanged even though its source moved.
- apps/server/src/db/queries/listings.ts, apps/server/src/db/queries/parts.ts, apps/server/src/db/queries/profit.ts, apps/server/src/db/queries/purchases.ts, apps/server/src/db/queries/saleListings.ts, apps/server/src/db/queries/sales.ts, apps/server/src/db/queries/sources.ts, apps/server/src/db/queries/teardownResults.ts, apps/server/src/db/queries/expectedParts.ts: Each query module's import of a collapsed name switches from the local `'../types.js'` to `@pc-parts-flipper/shared`, with no other change — every `mapRow` already built the shared shape.
- apps/server/src/db/queries/catalogSourcingAttempts.ts, apps/server/src/db/queries/sourcingAttempts.ts, apps/server/src/db/queries/referencePhotos.ts, apps/server/src/db/queries/referencePhotoLookup.ts, apps/server/src/db/queries/partPriceCache.ts, apps/server/src/db/queries/pricePartsJobs.ts, apps/server/src/db/seedReferencePhotosData.ts: Only these files' `ComponentCategory` import moves to shared; their other imports (`ReferencePhoto`, `PartPriceCacheEntry`, `PricePartsJob`, `PricePartsJobStage`) correctly stay pointed at the local `types.ts`, since those entities have no shared counterpart.
- apps/server/src/jobs/identifyPartsWorkerPool.ts: A 19th file, found only via a broader grep, whose `Listing` import is merged into its existing `@pc-parts-flipper/shared` import line rather than left pointing at the now-deleted local declaration.

## Fixing the real gaps the drift was hiding
Summary: Lining up the two copies surfaced two places where the stale type had been quietly masking real code gaps — a dropped column on read, and a missing field on a connector-staging type — both fixed directly rather than just re-typed.
Tasks: T1
Files:
- apps/server/src/db/queries/pricePartsJobs.ts: `mapRow` now reads `updated_at` into the returned `PricePartsJob.updatedAt` — the column already existed and was already written on every update, but silently dropped on read until now.
- apps/server/src/db/types.ts: The 4 remaining local entities (`ReferencePhoto`, `PartPriceCacheEntry`, `PricePartsJob`, plus the unchanged `SourcingAttempt`) get their fields renamed/added to match the real schema (`partCategory`→`category`, `partBrand`→`brand`, `cachedPrice`→`estimatedResaleValue`, plus `source`, `listingId`, `lastResearchedAt`, `errorMessage`, `startedAt`, `completedAt`, `updatedAt`), removing fabricated fields that had no backing column.
- apps/server/src/connectors/types.ts: `CandidateListing` gains `listingDate: string`, a field every producer already built and every consumer already read.
- apps/server/src/routes/listings.ts: `promoteReferencesForExpectedParts`'s parameter type is narrowed to just the three fields it actually reads, a pure type-signature correction so it also accepts already-persisted `ExpectedPart` rows whose optional AI-provenance fields don't satisfy the stricter `ExpectedPartInput` shape.

## Guarding against this drifting back
Summary: A routinely-runnable `typecheck` script is added at both the server and root level so a future type error — of any kind, not just a repeat of this duplication — fails loudly instead of going unnoticed the way this one did for multiple features.
Tasks: T2
Files:
- apps/server/package.json: Adds a `"typecheck": "tsc -p tsconfig.json --noEmit"` script, independent of `build` (which still emits output); verified to exit 0 on the fixed codebase and non-zero against a deliberately reintroduced type error.
- package.json: Adds a matching root-level `typecheck` script wired alongside the existing `lint` script, so a human can run one command to type-check the whole repo the way `lint` is already run.
