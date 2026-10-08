# Overview
eBay scans now search only used-condition inventory, and anything imported as "For Parts or Not
Working" is flagged on the Listing. Identify Parts reads that flagged listing's own description to
tell which specific parts are actually broken — those get a flat $1 instead of real price research,
everything else prices normally — and the user can always correct that per-part call by hand, which
resets the part's price so it re-evaluates correctly. One build cycle shipped this; a second cycle
fixed six issues validation found (a type mismatch, a cache-overwrite hole, a deleted export, two
missing test fixtures, and a missing same-status guard) before the feature passed review.

## eBay scan: condition filter
Summary: Every Browse API search call now restricts results to the five used-condition tiers and
captures whether the source item is itself "For Parts or Not Working".
Tasks: T2, T3
Flow:
- Search request: build `filter` param
- Condition filter: `conditionIds:{3000|4000|5000|6000|7000}`, always present
- Price filter: comma-joined in when a Source's maxPrice is set
- Map result: `conditionId === '7000'` → `nonWorking`
- Import: `nonWorking` carried onto the new Listing row
Files:
- apps/server/src/connectors/ebayConnector.ts: `searchOneQuery` now always sets the condition-id filter (comma-joined with the optional price filter rather than only present when a price cap is set); `mapItemSummary` reads the Browse API's `conditionId` field and sets `nonWorking` on an exact `'7000'` match.
- apps/server/src/connectors/types.ts: `CandidateListing` gains `nonWorking: boolean`, carrying the computed flag out of the connector.
- apps/server/src/scan/scanService.ts: `importCandidateIfNew` passes `candidate.nonWorking` straight into `createListing(...)`.
- apps/server/test/ebayConnector.test.ts, apps/server/test/scanService.test.ts: cover the rewritten filter assertion, the comma-combined-with-maxPrice case, `mapItemSummary`'s conditionId→nonWorking mapping, and a scanned candidate's `nonWorking` landing on the stored Listing in both directions.

## Non-working flag: schema, types, validation
Summary: Two new columns carry the feature's two core facts — a Listing-level `non_working` flag
and a per-Expected-Part `working_status` — plumbed through every layer from DDL to the shared HTTP
types, with a compile-time bug (a missing `| null`) caught and fixed in the second cycle.
Tasks: T1, T7
Files:
- apps/server/src/db/schema.ts: `ALTER_STATEMENTS` adds `listings.non_working BOOLEAN DEFAULT false` and `expected_parts.working_status VARCHAR DEFAULT 'working'` — the default backfills every pre-existing row and makes `'working'` the value any future insert gets when the field is omitted.
- apps/server/src/db/migrate.ts: the pre-existing `expected_parts` rebuild migration (which hardcodes its own column lists, independent of `ALTER_STATEMENTS`) gets `working_status` added to both its `CREATE TABLE` and `INSERT...SELECT` lists — missing this was a found-and-fixed bug (A9): it silently dropped the column on every fresh database.
- apps/server/src/db/types.ts, packages/shared/src/listings.ts: `Listing` gains `nonWorking: boolean`; `ExpectedPart` gains `workingStatus: 'working' | 'non_working'`; `ExpectedPartInput.workingStatus` is typed `'working' | 'non_working' | null` (the `| null` was the cycle-1 fix — `validateOptionalEnum` returns `T | null`, the same pattern `priceSource` already uses, and the type omitted it at first, a real `TS2322` build error).
- packages/shared/src/aiIdentification.ts: adds `AiPartWorkingStatus` ('working' | 'non_working' | 'unclear') and `AiIdentifiedPart.workingStatus?`, the shared shape the AI parser and prompt both key off of.
- apps/server/src/db/queries/listings.ts, apps/server/src/db/queries/expectedParts.ts: `createListing`/`createExpectedPart` and their `mapRow`s read/write the two new columns, both defaulting safely (`false`, `'working'`) when omitted.
- apps/server/src/routes/listingValidation.ts: accepts `workingStatus` on the per-part request body via a new `VALID_WORKING_STATUSES` enum check; `nonWorking` is deliberately absent from the Listing-level accepted fields — it's server-computed only, never client-supplied.
- apps/server/test/db.test.ts, apps/server/test/listings.test.ts: round-trip and default-backfill coverage for both new columns, plus the out-of-enum `workingStatus` rejection.

## AI per-part working-status inference
Summary: When a flagged Listing runs Identify Parts, the prompt asks the model to judge each part's
own working status from the listing text, and a resolver turns those per-part signals into the
final "only the named parts are non-working, or everything is if nothing's determinable" rule.
Tasks: T4
Files:
- apps/server/src/ai/identificationPrompt.ts: `buildIdentificationPrompt` appends rule 9 and an extra `workingStatus` field in its JSON example — only when `listing.nonWorking` is true; the prompt is byte-for-byte unchanged for any other Listing.
- apps/server/src/ai/identificationParser.ts: parses each part's raw `workingStatus` against a new `VALID_WORKING_STATUSES` allow-list (falling back to `'unclear'` for anything unrecognized or missing), and adds `resolveWorkingStatuses(parts)` — if every part came back `'unclear'`, all resolve `'non_working'`; otherwise only parts the model specifically called `'non_working'` do, everything else resolves `'working'`.
- apps/server/test/partIdentification.test.ts: unit-tests `resolveWorkingStatuses` against all-unclear, one-named-broken, and mixed-signal fixtures, and confirms the prompt differs only when the listing is flagged.

## Persisting status and the $1 price override
Summary: Wherever an Expected Part's working status is set — Identify Parts or a manual save — it's
threaded into the stored row, the background pricing trigger's own eligibility gate now excludes
non-working parts outright, and a non-working part gets an automatic $1 instead of real research
the moment it's fully identified, without ever touching the shared price cache.
Tasks: T5, T8
Flow:
- Resolve status: `resolveWorkingStatuses` (Identify Parts) or request body (manual save)
- Persist: `createExpectedPart` stores `workingStatus`, and `'non_working'` + fully-identified + unpriced → `$1`
- Trigger gate: `pricePartsTrigger.ts` skips any part whose `workingStatus !== 'working'`
- Cache guard: `propagateCachedPriceToExpectedParts`'s UPDATE excludes non-working rows
Files:
- apps/server/src/jobs/identifyPartsWorkerPool.ts: `persistIdentifiedParts` now takes the `Listing`, resolves per-part status via `resolveWorkingStatuses` when `listing.nonWorking`, and sets `estimatedResaleValue: 1` for any part that resolves `'non_working'`, is fully identified, and carries no price yet.
- apps/server/src/routes/listings.ts: `createExpectedPartsForListing` applies the same $1 override on a manual save, and defaults an omitted `workingStatus` to `'working'`.
- apps/server/src/jobs/pricePartsTrigger.ts: Node B's skip-condition gains `part.workingStatus !== 'working'`, so a non-working part is never passed into the cache/research pipeline regardless of whether it happens to already carry a value.
- apps/server/src/db/queries/partPriceCache.ts: `propagateCachedPriceToExpectedParts`'s UPDATE WHERE clause gains `AND working_status = 'working'` — the cycle-1 fix for a real hole where an unrelated Listing's genuine researched price for the same (category, brand, partNumber) combo could silently overwrite a non-working part's $1.
- apps/server/test/workingStatusIdentifyParts.test.ts, apps/server/test/workingStatusManualSaveRoute.test.ts, apps/server/test/workingStatusTriggerGate.test.ts, apps/server/test/partPriceCache.test.ts, apps/server/test/pricePartsTriggerRace.test.ts: prove the $1 override live on both call paths, mutation-prove the trigger gate directly against `pricePartsTrigger.ts`, and regression-test the cache-overwrite hole closed by the WHERE-clause fix.

## UI: non-working badge and per-part override
Summary: A read-only badge marks a flagged Listing in both the queue and the detail view; a flagged
Listing's Expected Parts editor additionally shows a per-part Working / Not working toggle that
resets that part's price so it's correctly re-evaluated under its new status — unless the user has
already manually priced it, and a second click on an already-active status changes nothing.
Tasks: T6, T9
Flow:
- Listing flagged: `listing.nonWorking` set on import
- Badge shown: queue table and detail view, amber, distinct from eBay-scan/AI-suggested badges
- Per-part control shown: only inside a flagged Listing's editor
- Toggle status: `updateWorkingStatus` — no-op on re-click of the active status
- Price reset: clears price/priceSource unless already user-owned (`'manual'`)
Files:
- apps/web/src/features/listings/non-working-badge.tsx: `NonWorkingBadge`, mirroring `EbayScanBadge`'s shape in amber styling, visually distinct from the emerald eBay-scan and violet AI-suggested badges.
- apps/web/src/features/listings-queue/listings-queue-table.tsx, apps/web/src/features/listings/listing-form.tsx: render `NonWorkingBadge` next to the existing `EbayScanBadge`, gated on `listing.nonWorking` / `initialValue?.nonWorking` respectively; `listing-form.tsx`'s cycle-1 fix restored an `ExpectedPartsEditor` import T6 had accidentally replaced wholesale with the new badge import instead of adding alongside it.
- apps/web/src/features/listings/expected-parts-editor.tsx: a new per-row Working/Not working control, shown only when `listingNonWorking`; its `updateWorkingStatus` handler is deliberately distinct from every other row edit — it does not claim manual price ownership, it resets the price only when the row isn't already `'manual'`-owned, and (cycle-1 fix) now short-circuits when the clicked status is already active, so re-clicking it never clears an already-researched price.
- apps/web/src/features/listings/listing-form-state.ts: `expectedPartToRow` round-trips `workingStatus`; cycle-1 restored the `initialExpectedPartRows` export T6's diff had deleted outright while `listing-form.tsx` and 7 test files still called it, crashing every mount.
- apps/web/test/expected-parts-editor-working-status.test.tsx, apps/web/test/non-working-badge-visibility.test.tsx: render both badge locations gated on `nonWorking`, the per-part control gated on `listingNonWorking`, and the exact MF-5 re-click scenario (an already-active status button, priced row, price and priceSource untouched after the click).
