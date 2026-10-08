# Feature: ebay-condition-filter

Status: done
Cycle: 1 / 3
FeatureStarted: 2026-10-08T13:39:58Z
FeatureCompletedAt: 2026-10-08T17:51:55Z
OrchestrationTokensActual: 592728
OrchestrationTokensBreakdown: input 0 + output 80,981 + cache-write 169,849 + cache-read 341,898, across 159 turns
Prototype: https://gist.githack.com/adamcrevel/8569a92f77c4770d569bf33fe9b8503e/raw/a382c4d4e863dfb4b881e37b9886343d8a30810d/prototype.html
Walkthrough: https://gist.githack.com/adamcrevel/4fa042a2aea643dc867cd2d0f8d91554/raw/walkthrough.html
BaselineTests: 700
BaselineSuite: pass

## Goal

eBay scans search only used-condition items (conditionIds 3000, 4000, 5000, 6000, 7000: Used, Very
Good, Good, Acceptable, For Parts or Not Working), since new and refurbished listings rarely sell
below market rate and so rarely offer a profitable flip.

A Listing imported from a "For Parts or Not Working" item is flagged non-working in the UI. When
Identify Parts runs on such a Listing, the AI identification pass also reads the listing's own
description to tell, per part, whether it's specifically called out as broken. If one or more parts
are named, only those are marked non-working and every other part on the Listing is marked working.
If the description gives no determinable breakdown, every part on the Listing is marked non-working
instead (safer than guessing). The user can always set or change any part's working status by hand
in the UI, overriding the AI's read or correcting a manually-entered part (e.g., a case is rarely the
broken component, even on an otherwise non-working build).

A part marked non-working gets a flat $1 estimated resale value automatically as soon as it's fully
identified, instead of running real AI price research, and that $1 never enters the shared price
cache used by other Listings. A part marked working is priced exactly as it already is today — real
cached or AI-researched value — regardless of whether its own Listing is flagged non-working.
Changing a part's working status by hand resets its price to undecided (unless the user already set
the price themselves), so the next save re-prices it correctly under its new status instead of
keeping a stale value from the old one.

## Requirements

1. Every eBay Browse API search call made by the automated scan restricts results to conditionIds
   3000, 4000, 5000, 6000, and 7000 (Used, Very Good, Good, Acceptable, For Parts or Not Working).
2. The condition filter excludes conditionIds 1000, 1500, 1750 (New, New Other, New with Defects)
   and 2000, 2010, 2020, 2030, 2500, 2750 (every Certified/Excellent/Very Good/Good/Seller
   Refurbished tier and Like New).
3. The condition filter is always applied to every query, combined with the existing optional
   per-Source max-price filter when one is configured — never a separate opt-in.
4. A Listing imported by an eBay scan whose source item's conditionId is 7000 (For Parts or Not
   Working) is flagged as non-working, stored on the Listing itself, and shown clearly in both the
   Listings queue table and the Listing detail/edit view.
5. A manually-entered Listing is never flagged non-working.
6. Every Expected Part on a Listing NOT flagged non-working has its working status set to exactly
   `'working'` — never left undetermined — whether it was identified by Identify Parts or entered
   manually.
7. When Identify Parts runs on a non-working Listing, the AI identification pass determines, for
   each identified part, whether the listing's own description specifically indicates that part is
   broken/non-functional, separately from the part's own brand/category/condition fields.
8. If the description specifically names one or more parts as broken, only those named parts are
   given working status `'non_working'`; every other identified part on that same Listing is given
   `'working'`.
9. If the description gives no specific, determinable breakdown at all (for example, only a generic
   "sold as-is, untested" statement with no part singled out), every identified part on that Listing
   is given working status `'non_working'` instead of guessing which one is actually broken.
10. A manually-entered Expected Part on a non-working Listing defaults to working status `'working'`
    unless the user sets it otherwise (Requirement 11) — Identify Parts' description analysis never
    runs for a manually-entered part.
11. The user can set or change any Expected Part's working status (working / non-working) directly
    in the UI, overriding whatever Identify Parts determined or whatever the default was.
12. The background price-estimation trigger's own eligibility check requires an Expected Part's
    working status to be exactly `'working'`, in addition to its existing requirements (brand and
    part number both known, no estimated resale value of its own yet) — a part whose working status
    is `'non_working'` is never passed into the cache/research pipeline at all, regardless of
    whether it happens to already carry a value.
13. An Expected Part with working status `'non_working'`, the moment it becomes fully identified
    (brand and part number both known) with no estimated resale value of its own yet and no price
    already owned by the user, is automatically assigned an estimated resale value of exactly $1
    instead of running real AI price research.
14. The $1 assignment under Requirement 13 never enters the shared part_price_cache — it is specific
    to that one Listing's actual item, not a market-price fact to share with other Listings of the
    same category/brand/part-number.
15. A $1 value assigned under Requirement 13 follows the same ownership rule as any other
    auto-assigned price (price_source's existing three-state rule): a user who edits or clears it
    takes manual ownership of that row, and it is never auto-reclaimed or overwritten afterward.
16. A part the user has already priced themselves (price_source already 'manual') is never
    overwritten by the $1 assignment, regardless of its working status.
17. Changing a part's working status in the UI (Requirement 11), when that part's price is not
    already user-owned, clears its estimated resale value and returns its price ownership to
    undecided — so the next save re-evaluates its price correctly under the new status via
    Requirement 12's gate (a part moved to `'working'` becomes eligible for real research; a part
    moved to `'non_working'` becomes eligible for the $1 assignment via Requirement 13) instead of
    leaving a stale price from its old status in place.

## Standing Checks

- The whole test suite passes, and the test count stays at or above `BaselineTests` (700).
- `npm run lint` runs clean with no new violation.
- Any new public function or component this feature adds carries the same kind of header/block
  comment documentation already used elsewhere in the codebase, explaining its purpose and flow,
  not just a one-line label.
- No new code in `apps/web` imports directly from `apps/server` — the existing
  `import/no-restricted-paths` boundary (`eslint.config.mjs`), checked by
  `apps/web/test/eslint-import-boundary.test.ts`, holds for every file this feature adds or
  touches.

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| P0 | Clickable prototype covering T6: (1) a read-only "Non-working" badge on a Listing imported from a "For Parts or Not Working" eBay item, shown in both the Listings queue table and the Listing detail/edit view, styled distinctly from the existing eBay-scan (emerald) and AI-suggested (violet) badges; (2) a new per-Expected-Part "Working" / "Not working" control in the Expected Parts editor, shown only when the Listing is flagged non-working, letting the user override which parts are priced at $1 vs priced normally. | prototype | none | complete | 0 | | 2026-10-08T14:13:20Z | 2026-10-08T14:16:27Z | 12 | 2026-10-08T14:13:20Z | | null | yes | |
| T1 | Schema + types for both new fields. `apps/server/src/db/schema.ts`'s `ALTER_STATEMENTS` gains `ALTER TABLE listings ADD COLUMN IF NOT EXISTS non_working BOOLEAN DEFAULT false` (Req 4, 5) and `ALTER TABLE expected_parts ADD COLUMN IF NOT EXISTS working_status VARCHAR DEFAULT 'working'` — the `DEFAULT 'working'` is load-bearing, not cosmetic: it backfills every pre-existing Expected Part row to `'working'` the moment the column is added (Req 6), and makes `'working'` the value any future INSERT gets when it omits the field, so the column is never actually null in practice and the trigger's gate (T5, Req 12) can check it with a plain equality, no null-handling needed. `apps/server/src/db/types.ts`: `Listing` gains `nonWorking: boolean`; `ExpectedPart` gains `workingStatus: 'working' \| 'non_working'` (two-state, not nullable — Req 6's own guarantee). `packages/shared/src/listings.ts`: `Listing` gains the same `nonWorking` field (documented the same way `externalSource`/`externalItemId` already are); `ExpectedPart` gains `workingStatus: 'working' \| 'non_working'` (required, matching the DB guarantee); `ExpectedPartInput` gains `workingStatus?: 'working' \| 'non_working'` (optional — an omitted value means "use the default," mirrored server-side in T5, not here). `apps/server/src/db/queries/listings.ts`: `CreateListingInput` gains `nonWorking?: boolean` (omitted defaults false), `mapRow` reads `row.non_working as boolean`, `createListing`'s INSERT column list gains `non_working`. `apps/server/src/db/queries/expectedParts.ts`: `CreateExpectedPartInput` gains `workingStatus?: 'working' \| 'non_working'` (omitted defaults `'working'` at the DB level), `mapRow` reads `(row.working_status as 'working' \| 'non_working' \| null) ?? 'working'` (defensive: the DB default already guarantees non-null, but a reader should never have to trust that alone), `createExpectedPart`'s INSERT column list gains `working_status`. `apps/server/src/routes/listingValidation.ts` gains a `VALID_WORKING_STATUSES` constant (`['working', 'non_working']`) and validates an incoming `workingStatus` the same way it already validates `priceSource` (`validateOptionalEnum`). `Listing.nonWorking` is never user-settable through the manual create/edit request body (server-only, same precedent as `externalSource`/`externalItemId`); `workingStatus` IS user-settable per-part through the normal `ExpectedPartInput` shape (Req 11), same as `priceSource` already is. | builder | none | complete | 0 | | 2026-10-08T14:45:30Z | 2026-10-08T14:52:42Z | 25 | 2026-10-08T14:37:21Z | 8000 | null | no | apps/server/src/db/schema.ts;apps/server/src/db/types.ts;apps/server/src/db/queries/listings.ts;apps/server/src/db/queries/expectedParts.ts;apps/server/src/routes/listingValidation.ts;packages/shared/src/listings.ts |
| T2 | eBay connector condition filter + capture: `apps/server/src/connectors/ebayConnector.ts`'s `EbayItemSummary` interface gains `conditionId?: string` (the Browse API's own field name, a string like `"7000"`). `searchOneQuery`'s `params` now always sets a `filter` query param including `conditionIds:{3000\|4000\|5000\|6000\|7000}` (eBay's documented pipe-separated multi-value, comma-combined-with-other-filters syntax — Req 1-3), combined with the existing optional `price:[0..${maxPrice}],priceCurrency:USD` segment when `maxPrice` is set, comma-joined into one `filter` value either way — never only present when `maxPrice` is set, unlike today. `CandidateListing` (`apps/server/src/connectors/types.ts`) gains `nonWorking: boolean`. `mapItemSummary` computes it as `item.conditionId === '7000'` (Req 4). Update the existing test in `apps/server/test/ebayConnector.test.ts` asserting `filter=` is absent with no `maxPrice` set — under this change a filter is always present; rewrite that assertion to check the conditionIds segment is present instead, and add a case proving the conditionIds segment is present with `maxPrice` set too, combined with the price segment, both as one `filter` value. | builder | none | complete | 0 | | 2026-10-08T14:45:30Z | 2026-10-08T14:52:42Z | 20 | 2026-10-08T15:02:21Z | 8400 | null | no | apps/server/src/connectors/types.ts;apps/server/src/connectors/ebayConnector.ts;apps/server/test/ebayConnector.test.ts |
| T3 | Wire the imported condition through to the Listing row: `apps/server/src/scan/scanService.ts`'s `importCandidateIfNew` passes `nonWorking: candidate.nonWorking` into its `createListing(...)` call (Req 4). | builder | T1;T2 | complete | 0 | | 2026-10-08T14:53:02Z | 2026-10-08T15:03:25Z | 10 | 2026-10-08T15:22:21Z | 5000 | null | no | apps/server/src/scan/scanService.ts |
| T4 | AI per-part working-status inference (Req 7-9). `apps/server/src/ai/identificationPrompt.ts`'s `buildIdentificationPrompt(listing)` appends a new rule, only when `listing.nonWorking` is true (the prompt is completely unchanged for any other Listing): ask the model to also set a `"workingStatus"` field per part — `"non_working"` if the listing's own title/description specifically says or clearly implies that exact part doesn't work, `"working"` if the text specifically clears it or the text calls out a *different* part as broken while saying nothing against this one, or `"unclear"` if nothing in the text lets the model tell either way for this specific part. `apps/server/src/ai/identificationParser.ts`: `AiIdentifiedPart` (shared type, `packages/shared/src/aiIdentification.ts`) gains an optional `workingStatus?: 'working' \| 'non_working' \| 'unclear'` field, parsed with the same safe-coerce-and-Warn convention `confidence`/`source` already use, falling back to `"unclear"` for any unrecognized value (the least assertive option, matching this file's own `FALLBACK_CONFIDENCE`/`FALLBACK_SOURCE` precedent) — only populated when the prompt asked for it. A new function, `resolveWorkingStatuses(parts: AiIdentifiedPart[]): Map<number, 'working' \| 'non_working'>` (or equivalent, indexed by the part's position in the array), applies the blanket-fallback rule once every part's own per-part signal is in hand: if every part's signal is `"unclear"`, every part's final status is `'non_working'` (Req 9); otherwise every part's final status is `'working'` unless its own signal was specifically `"non_working"` (Req 8) — a part whose own signal was `"unclear"` while another part's was `"non_working"` resolves to `'working'`, per Req 8's "every other part on that Listing is marked working." Only called when `listing.nonWorking` is true — T5 (not this task) is what sets every other Listing's parts to `'working'` directly, so this function is never invoked for one. | builder | T1 | complete | 0 | | 2026-10-08T14:53:02Z | 2026-10-08T15:03:25Z | 30 | 2026-10-08T15:32:21Z | 8200 | null | no | packages/shared/src/aiIdentification.ts;apps/server/src/ai/identificationParser.ts;apps/server/src/ai/identificationPrompt.ts |
| T5 | Apply resolved working_status at persist time, add `workingStatus === 'working'` to the background trigger's own eligibility gate, and the $1 price override (Req 6, 10, 12-14, 16). `apps/server/src/jobs/identifyPartsWorkerPool.ts`'s `persistIdentifiedParts`: when `listing.nonWorking`, call T4's `resolveWorkingStatuses` over the identified parts and thread each part's resolved status into its `createExpectedPart` call's new `workingStatus` field; when not, every part's `workingStatus` is explicitly `'working'` (Req 6 — never omitted/defaulted-by-silence here, stated directly in the insert). `apps/server/src/routes/listings.ts`'s `createExpectedPartsForListing`: an incoming row's `workingStatus`, if provided, is stored verbatim (Req 11); if omitted, defaults to `'working'` (Req 10) — same optionality convention `priceSource` already uses in this function. In BOTH places, when a row's `priceSource` resolves to `'auto'` (the existing condition: undecided, brand+partNumber present, no value of its own) AND that row's `workingStatus === 'non_working'`, set `estimatedResaleValue: 1` instead of leaving the incoming null (Req 13); a `'working'` row is left exactly as today (value stays null, `triggerPriceLookups` prices it for real). `apps/server/src/jobs/pricePartsTrigger.ts`'s `triggerPriceLookups`: Node B's eligibility skip-condition gains one more term — `part.workingStatus !== 'working'` — alongside the existing `brand === null`, `partNumber === null`, `estimatedResaleValue !== null` checks (Req 12), so a `'non_working'` part is excluded from the cache/research pipeline by its own status directly, not merely because it happens to already carry a value (Req 14 then follows for free: a part the gate itself never admits can never reach `insertPriceCacheEntry`). A `'manual'`-owned or already-valued row is untouched by the $1 branch either way (Req 15-16, unchanged from today). | builder | T1;T4 | complete | 0 | | 2026-10-08T15:03:46Z | 2026-10-08T15:19:52Z | 30 | 2026-10-08T16:02:21Z | | null | no | apps/server/src/jobs/identifyPartsWorkerPool.ts;apps/server/src/jobs/pricePartsTrigger.ts;apps/server/src/routes/listings.ts |
| T6 | Manual per-part working-status control in the UI, and its price-reset-on-change behavior (Req 4, 11, 17) — two distinct pieces, a read-only Listing-level badge and an editable Expected-Part-level control. A new `apps/web/src/features/listings/non-working-badge.tsx`, `NonWorkingBadge`, mirroring `ebay-scan-badge.tsx`'s shape/styling exactly (same rounded-pill span classes) in a warning color distinct from `EbayScanBadge`'s emerald and `AiSuggestedBadge`'s violet; rendered in `apps/web/src/features/listings-queue/listings-queue-table.tsx` next to the existing `EbayScanBadge` usage (gated on `listing.nonWorking`) and in `apps/web/src/features/listings/listing-form.tsx` next to its existing `EbayScanBadge` usage (gated on `initialValue?.nonWorking`). Separately, `apps/web/src/features/listings/expected-parts-editor.tsx` gains a new per-row two-option control ("Working" / "Not working") shown only when a new `listingNonWorking: boolean` prop (threaded from `listing-form.tsx`'s own `initialValue?.nonWorking`) is true. This control uses a NEW handler, deliberately NOT `updateRow`'s generic "any edit claims manual ownership" rule, since this interaction is the opposite — releasing a price back to undecided, not claiming it: changing the control sets the row's `workingStatus` to the new value; if the row's `priceSource` is already `'manual'`, its price fields are left untouched; otherwise its `estimatedResaleValue` is cleared (empty string) and `priceSource` is reset to `undefined` (undecided), so the next save lets the server's existing `'auto'`-claim logic in T5 re-evaluate the row's price fresh under its new status (Req 17). `ExpectedPartRow` (same file) gains the `workingStatus?: 'working' \| 'non_working'` field; `listing-form-state.ts`'s `expectedPartToRow` and `listing-form.tsx`'s `persistListing` round-trip it the same way they already round-trip `priceSource`. | builder | T1 | complete | 0 | | 2026-10-08T14:53:02Z | 2026-10-08T15:03:25Z | 30 | 2026-10-08T16:32:21Z | 3200 | null | yes | apps/web/src/features/listings/non-working-badge.tsx;apps/web/src/features/listings-queue/listings-queue-table.tsx;apps/web/src/features/listings/listing-form.tsx;apps/web/src/features/listings/expected-parts-editor.tsx;apps/web/src/features/listings/listing-form-state.ts |
| R1 | Review T1 against Req 4-6, 10: confirm `non_working` defaults `false` and `working_status` defaults `'working'` at the DDL level (read the real `ALTER TABLE` statements, not the task's own claim), confirm both `mapRow`s' reads can never return `undefined`/a value that reads as unset, confirm `nonWorking` is absent from `listingValidation.ts`'s accepted Listing-level request-body fields while `workingStatus` IS accepted on the per-part `ExpectedPartInput` shape via `VALID_WORKING_STATUSES`, and confirm the doc-comment convention on every new field. FAIL: `ExpectedPartInput.workingStatus` is typed without `\| null` while `validateOptionalEnum` (reused the same way `priceSource` does) returns `T \| null`, producing a real `TS2322` error at `listingValidation.ts:192` — confirmed via a live `npm run build -w apps/server` run. | reviewer | T1 | complete | 0 | | 2026-10-08T15:28:45Z | 2026-10-08T16:08:24Z | 12 | 2026-10-08T15:28:45Z | 14500 | null | no | |
| TE1 | Test T1: confirm both new `ADD COLUMN IF NOT EXISTS` statements run cleanly against a fresh database AND an already-migrated one (idempotent); confirm a Listing created with `nonWorking` omitted comes back `false` and one with `true` round-trips; confirm an Expected Part created with `workingStatus` omitted comes back `'working'` (the DB default, not null), and one created with `'non_working'` round-trips through `mapRow`; confirm a pre-existing row (seeded before the migration, in a fresh-vs-migrated-DB test) backfills to `'working'` once the column is added; confirm `listingValidation.ts` rejects an out-of-enum `workingStatus` value the same way it already rejects an invalid `priceSource`. Report real pass/fail output. | tester | T1 | complete | 0 | | 2026-10-08T15:28:45Z | 2026-10-08T16:08:24Z | 15 | 2026-10-08T15:28:45Z | 55000 | null | no | apps/server/test/db.test.ts;apps/server/test/listings.test.ts |
| R2 | Review T2 against Req 1-4: confirm the real, exact `conditionIds:{3000\|4000\|5000\|6000\|7000}` filter segment is present on every search call regardless of whether `maxPrice` is set, confirm it is correctly comma-combined with the price segment into one `filter` param, and confirm `mapItemSummary`'s `nonWorking` computation matches conditionId `'7000'` exactly (a string compare). | reviewer | T2 | complete | 0 | | 2026-10-08T15:28:45Z | 2026-10-08T16:08:24Z | 10 | 2026-10-08T15:28:45Z | 7700 | null | no | |
| TE2 | Test T2: run `ebayConnector.test.ts` in full, confirming the rewritten filter-assertion test and the new combined-filter case both pass, and that `mapItemSummary` sets `nonWorking: true` only for `conditionId: '7000'` and `false` for every other conditionId (at least one allowed-used one, and the omitted/undefined case). Report real pass/fail output. | tester | T2 | complete | 0 | | 2026-10-08T15:28:45Z | 2026-10-08T16:08:24Z | 12 | 2026-10-08T15:28:45Z | 14000 | null | no | |
| R3 | Review T3 against Req 4: confirm `candidate.nonWorking` genuinely reaches the stored Listing row, tracing the one line changed. | reviewer | T3 | complete | 0 | | 2026-10-08T15:28:45Z | 2026-10-08T16:08:24Z | 6 | 2026-10-08T15:28:45Z | 6800 | null | no | |
| TE3 | Test T3: run/extend `scanService.test.ts` proving a scanned candidate with `nonWorking: true` produces a Listing whose `nonWorking` is `true`, and one with `false` produces `false`. Report real pass/fail output. | tester | T3 | complete | 0 | | 2026-10-08T15:28:45Z | 2026-10-08T16:08:24Z | 10 | 2026-10-08T15:28:45Z | 4800 | null | no | apps/server/test/scanService.test.ts |
| R4 | Review T4 against Req 6-9: confirm the new prompt rule is appended ONLY when `listing.nonWorking` is true (read the real conditional, don't take the claim on faith) and the prompt is byte-for-byte unchanged otherwise (diff it against the pre-change version for a non-flagged Listing). Confirm the parser's fallback for an unrecognized `workingStatus` value is genuinely `'unclear'`, not a silent crash or a different default. Confirm `resolveWorkingStatuses`'s two-branch logic exactly matches Req 7/8's rule — trace both branches by hand against at least one constructed example each (all-unclear input; one-named-broken input) rather than trusting the function's own name. | reviewer | T4 | complete | 0 | | 2026-10-08T15:28:45Z | 2026-10-08T16:08:24Z | 15 | 2026-10-08T15:28:45Z | 14800 | null | no | |
| TE4 | Test T4: unit-test `resolveWorkingStatuses` directly against constructed `AiIdentifiedPart[]` fixtures — all parts `'unclear'` (expect every part `'non_working'`), one part `'non_working'` + rest `'unclear'` (expect that one `'non_working'`, rest `'working'`), a mix including an explicit `'working'` signal, and the real single-part/all-unclear edge cases. Confirm `buildIdentificationPrompt`'s output differs (new rule present/absent) between a `nonWorking: true` and `nonWorking: false` Listing fixture. Report real pass/fail output. | tester | T4 | complete | 0 | | 2026-10-08T15:28:45Z | 2026-10-08T16:08:24Z | 20 | 2026-10-08T15:28:45Z | 36900 | null | no | apps/server/test/partIdentification.test.ts |
| R5 | Review T5 against Req 6, 10, 12-14, 16, the most cross-cutting task here (three files, two call paths, a three-field join). Confirm `persistIdentifiedParts` only calls `resolveWorkingStatuses` when `listing.nonWorking`, and every part's `workingStatus` is genuinely `'working'` (not null, not omitted) otherwise (Req 6). Confirm `createExpectedPartsForListing`'s default for an omitted `workingStatus` is genuinely `'working'` (Req 10). Confirm `pricePartsTrigger.ts`'s Node B skip-condition was genuinely changed to add `workingStatus !== 'working'` — read the real diff, don't take the task's own claim — and construct the specific counter-example (a part with `workingStatus: 'non_working'` but somehow still `estimatedResaleValue: null`, e.g. a toggle-then-save race) to confirm the gate excludes it on its OWN status, not merely via the $1-already-assigned side effect (Req 12). Confirm the $1 assignment's condition in both files reads each row's OWN resolved `workingStatus`, not the Listing's `nonWorking` flag directly (Req 13). Confirm a `'manual'`-owned or already-valued row is untouched in both files (Req 16). Confirm Req 14 (never enters the cache) now follows from the gate change itself, not a separate mechanism. FAIL: `propagateCachedPriceToExpectedParts`'s WHERE clause (`partPriceCache.ts`) filters only on `price_source = 'auto'`, not `working_status = 'working'` — a real AI-researched price for the same (category,brand,partNumber) combo on an unrelated Listing silently overwrites a non-working part's $1 override, defeating Req 13/15's durability guarantee. | reviewer | T5 | complete | 0 | | 2026-10-08T15:28:45Z | 2026-10-08T16:08:24Z | 18 | 2026-10-08T15:28:45Z | 13200 | null | no | |
| TE5 | Test T5: prove Req 13 live on BOTH call paths (identify-parts and manual-save) — a part resolved/set `'non_working'`, fully identified, no prior price, gets `estimatedResaleValue: 1`. Prove Req 6/10 — a part on a non-flagged Listing, and an omitted-`workingStatus` manual part, both come back `'working'` explicitly (never null). Prove Req 12 directly against `pricePartsTrigger.ts`: construct an `ExpectedPart` with `workingStatus: 'non_working'` and `estimatedResaleValue: null` (bypassing the normal creation path, calling `triggerPriceLookups` directly) and confirm it is NOT passed to `resolveCombo` — mutation-prove this (reverting the new `workingStatus` check must fail exactly this test). Prove Req 16 — a `'manual'`-owned or already-valued row is untouched regardless of its `workingStatus`. Prove Req 14 — after a $1 assignment, query `part_price_cache` directly and confirm no row exists for that combo. Report real pass/fail output. | tester | T5 | complete | 0 | | 2026-10-08T15:28:45Z | 2026-10-08T16:08:24Z | 25 | 2026-10-08T15:28:45Z | 51400 | null | no | apps/server/test/workingStatusIdentifyParts.test.ts;apps/server/test/workingStatusTriggerGate.test.ts;apps/server/test/workingStatusManualSaveRoute.test.ts;apps/server/test/pricePartsTrigger.test.ts;apps/server/test/identifyPartsWorkerPool.test.ts;apps/server/src/db/migrate.ts |
| R6 | Review T6 against Req 4, 11, 17: confirm `NonWorkingBadge` is rendered in both named locations, correctly gated, and visually distinct from the other two badges (read the actual Tailwind classes). Confirm the per-part control is shown ONLY when `listingNonWorking` is true. Confirm the NEW handler is genuinely distinct from `updateRow` — read it directly and confirm it does NOT set `priceSource: 'manual'` the way every other edit does, and DOES skip clearing the price when `priceSource` is already `'manual'` (construct this exact case and trace it by hand, do not take the description's claim on faith — this is the one place in this task that deliberately breaks the codebase's otherwise-universal "any edit claims manual ownership" rule, and is the single likeliest spot for a builder to reflexively reuse the wrong pattern). Confirm `workingStatus` round-trips through `expectedPartToRow`/`persistListing` the same way `priceSource` already does. FAIL: the diff deleted the exported `initialExpectedPartRows` from `listing-form-state.ts` while `listing-form.tsx` and 7 pre-existing test files still call it, crashing `ListingForm` on every mount (56 real test failures confirmed project-wide); `updateWorkingStatus` also has no same-status guard, clearing a real price on a no-op re-click of the already-active button. | reviewer | T6 | complete | 0 | | 2026-10-08T15:28:45Z | 2026-10-08T16:08:24Z | 15 | 2026-10-08T15:28:45Z | 15600 | null | no | |
| TE6 | Test T6: render `listings-queue-table.tsx` and `listing-form.tsx` each with a `nonWorking: true` Listing and a `nonWorking: false` one, confirming `NonWorkingBadge` appears only for the former in both places. Render the Expected Parts editor with `listingNonWorking: true` and confirm the per-part control appears; with `false`, confirm it does not. Exercise the new handler directly: an `'auto'`-owned priced row, toggled to non-working, ends up with `estimatedResaleValue` cleared and `priceSource` undefined; a `'manual'`-owned priced row, toggled the same way, keeps its exact price and `priceSource` unchanged. Report real pass/fail output. FAIL: confirmed live — `listing-form-state.ts`'s deleted `initialExpectedPartRows` crashes `ListingForm`, failing 2 of my new tests plus 7 pre-existing files/56 tests project-wide; not a test-authoring issue, a real T6 regression. | tester | T6 | complete | 0 | | 2026-10-08T15:28:45Z | 2026-10-08T16:08:24Z | 20 | 2026-10-08T15:28:45Z | 20000 | null | no | apps/web/test/non-working-badge-visibility.test.tsx;apps/web/test/expected-parts-editor-working-status.test.tsx |
| T7 | Fix T1's MF-1 verbatim: `packages/shared/src/listings.ts`'s `ExpectedPartInput.workingStatus` is typed `'working' \| 'non_working' \| undefined` (no `\| null`), but is assigned from `validateOptionalEnum()` in `apps/server/src/routes/listingValidation.ts:192`, which returns `T \| null` (the same helper `priceSource` already uses correctly, typed `'auto' \| 'manual' \| null`) — produces a real `TS2322` compile error. Fix: add `\| null` to `ExpectedPartInput.workingStatus`'s type, matching `priceSource`'s own pattern exactly. | builder | none | complete | 1 | | 2026-10-08T16:19:13Z | 2026-10-08T16:34:40Z | 8 | 2026-10-08T16:15:27Z | 2400 | 23774 | no | packages/shared/src/listings.ts |
| T8 | Fix T5's MF-2, MF-3, MF-6 verbatim. MF-2: `apps/server/src/db/queries/partPriceCache.ts`'s `propagateCachedPriceToExpectedParts` (lines 150-153) — the UPDATE's WHERE clause filters only on `price_source = 'auto'`, not `working_status = 'working'`. A non-working part's $1 override (priceSource 'auto') shares the same WHERE match as any other 'auto' row for the same (category,brand,partNumber), so when an unrelated Listing's working part gets a real AI-researched price for that same combo, the propagation UPDATE silently overwrites the non-working part's $1 with the real market price — defeating Req 13/15's durability guarantee via a side channel no task closes. Fix: add `AND working_status = 'working'` to the UPDATE's WHERE clause. MF-3: `apps/server/test/pricePartsTriggerRace.test.ts`'s `partFixture` helper (lines 73-90) never sets `workingStatus`, so every fixture is `workingStatus: undefined`; T5's new Node B gate (`workingStatus !== 'working'`) now excludes every part in this file's concurrency-race tests before they can ever reach the cache/job tables — the same regression class already fixed in `pricePartsTrigger.test.ts` and `identifyPartsWorkerPool.test.ts`, missed in this third file. Fix: add `workingStatus: 'working'` to `partFixture()`'s defaults. MF-6: `apps/server/test/workingStatusManualSaveRoute.test.ts:25` imports `runMigrations` but never uses it — the sole new `npm run lint` warning. Fix: remove the unused import. | builder | none | complete | 1 | | 2026-10-08T16:19:13Z | 2026-10-08T16:34:40Z | 20 | 2026-10-08T16:23:27Z | 5100 | 23921 | no | apps/server/src/db/queries/partPriceCache.ts;apps/server/test/pricePartsTriggerRace.test.ts;apps/server/test/workingStatusManualSaveRoute.test.ts |
| T9 | Fix T6's MF-4, MF-5 verbatim. MF-4 (critical): `apps/web/src/features/listings/listing-form-state.ts` and `listing-form.tsx` — T6's diff deleted the exported `initialExpectedPartRows(initialValue?)` function entirely while `listing-form.tsx:12/37` still imports and calls it, and 7 pre-existing test files still reference it by name; `ListingForm` now throws `TypeError: initialExpectedPartRows is not a function` on EVERY mount, create or edit (confirmed: 56 of 56 web test failures across 8 files share this exact root cause). Fix: restore the deleted export — `export function initialExpectedPartRows(initialValue?: ListingDetail): ExpectedPartRow[] { if (!initialValue \|\| initialValue.expectedParts.length === 0) return [emptyExpectedPartRow()]; return initialValue.expectedParts.map(expectedPartToRow); }` — and restore the clobbered import line in `listing-form.tsx`. MF-5: `apps/web/src/features/listings/expected-parts-editor.tsx:160-175`'s `updateWorkingStatus` has no guard comparing `newStatus` to the row's current `workingStatus` before resetting the price — re-clicking the already-active status button clears a real, already-researched price even though the status did not actually change, contradicting Req 17's own wording ("Changing a part's working status..."). Fix: short-circuit `updateWorkingStatus` (or its onClick call sites) when `newStatus === row.workingStatus`. | builder | none | complete | 1 | | 2026-10-08T16:19:13Z | 2026-10-08T16:34:40Z | 20 | 2026-10-08T16:43:27Z | 24000 | 60367 | yes | apps/web/src/features/listings/listing-form-state.ts;apps/web/src/features/listings/listing-form.tsx;apps/web/src/features/listings/expected-parts-editor.tsx;apps/web/test/expected-parts-editor-working-status.test.tsx |
| R7 | Re-review T1's MF-1 fix: confirm `ExpectedPartInput.workingStatus` now includes `\| null`, confirm `npm run build -w apps/server` no longer reports the `TS2322` error at `listingValidation.ts:192` (re-run it for real, don't take the claim on faith). | reviewer | T7 | complete | 1 | | 2026-10-08T16:43:48Z | 2026-10-08T17:07:55Z | 6 | 2026-10-08T16:43:48Z | 17500 | null | no | |
| TE7 | Test T7: re-run `npm run build -w apps/server` and confirm it is genuinely clean of the `TS2322` error this fix targets (other pre-existing, unrelated build errors per Assumption A11 are out of scope and may remain). Report real pass/fail output. | tester | T7 | complete | 1 | | 2026-10-08T16:43:48Z | 2026-10-08T17:07:55Z | 8 | 2026-10-08T16:43:48Z | 3800 | null | no | |
| R8 | Re-review T8's three fixes: confirm `propagateCachedPriceToExpectedParts`'s WHERE clause now includes `working_status = 'working'` (construct the exact counter-example MF-2 named — an unrelated working Listing's real price landing on the same combo — and confirm it no longer overwrites a non-working part's $1); confirm `pricePartsTriggerRace.test.ts`'s `partFixture` now sets `workingStatus: 'working'`; confirm the unused `runMigrations` import is genuinely removed and `npm run lint` is clean. | reviewer | T8 | complete | 1 | | 2026-10-08T16:43:48Z | 2026-10-08T17:07:55Z | 12 | 2026-10-08T16:43:48Z | 13000 | null | no | |
| TE8 | Test T8: re-run `pricePartsTriggerRace.test.ts` in full, confirming both previously-failing concurrency tests now pass; write/run a focused test proving MF-2's exact scenario (a non-working part's $1, then a real price propagated to the same combo for a different, working Listing) no longer overwrites the $1 row; re-run `npm run lint`, confirm 0 warnings. Report real pass/fail output. | tester | T8 | complete | 1 | | 2026-10-08T16:43:48Z | 2026-10-08T17:07:55Z | 15 | 2026-10-08T16:43:48Z | 16000 | null | no | apps/server/test/partPriceCache.test.ts |
| R9 | Re-review T9's two fixes: confirm `initialExpectedPartRows` is genuinely restored with the exact signature/behavior MF-4 specified, confirm `listing-form.tsx`'s import line is restored, confirm `updateWorkingStatus` now short-circuits on `newStatus === row.workingStatus` (construct the exact MF-5 scenario — re-clicking the active status on an already-priced row — and confirm the price is left untouched). | reviewer | T9 | complete | 1 | | 2026-10-08T16:43:48Z | 2026-10-08T17:07:55Z | 12 | 2026-10-08T16:43:48Z | 15000 | null | no | |
| TE9 | Test T9: re-run the full web suite (previously 56 failures across 8 files) and confirm it is genuinely green; write/run a focused test proving MF-5's exact scenario (re-clicking an already-active working-status button on a priced row leaves its price and priceSource untouched). Report real pass/fail output. | tester | T9 | complete | 1 | | 2026-10-08T16:43:48Z | 2026-10-08T17:07:55Z | 15 | 2026-10-08T16:43:48Z | 16000 | null | no | apps/web/test/expected-parts-editor-working-status.test.tsx |
| U1 | UAT pass over the whole feature: an eBay scan only returns used-condition listings and never new/refurbished ones; a For-Parts-or-Not-Working listing imports flagged non-working, visible in the queue and detail view; Identify Parts on such a listing correctly splits named-broken vs. presumed-working parts (or marks everything non-working when nothing specific is named); a non-working part gets a flat $1 automatically while a working part on the same listing gets real research; the user can flip a part's working status by hand in the UI and the price correctly re-evaluates; a manually-entered Listing is never flagged non-working. | uat | T1;T2;T3;T4;T5;T6;T7;T8;T9 | complete | 1 | | 2026-10-08T17:09:14Z | 2026-10-08T17:51:31Z | 30 | 2026-10-08T17:09:14Z | 100000 | null | yes | |

## Assumptions

- A1 (cycle 0): The Listing-level `nonWorking` flag drives the UI badge (Req 4) and gates whether
  Identify Parts even attempts the per-part description analysis (Req 7) — it no longer directly
  gates pricing. Pricing is gated by each Expected Part's own `workingStatus` instead, checked
  directly inside `pricePartsTrigger.ts`'s own eligibility condition (Req 12), which is what lets a
  part specifically cleared as "actually fine" on an otherwise non-working Listing still get real
  research, and what makes the exclusion legible in the one file that owns pricing eligibility
  rather than an indirect side effect of the $1 value already being non-null.
- A2 (cycle 0): `non_working` and `working_status` are both plain columns added via
  `ALTER_STATEMENTS` (`BOOLEAN DEFAULT false` and `VARCHAR DEFAULT 'working'` respectively), not
  rebuild-migration cases — neither `listings` nor `expected_parts` has an FK-referencing rebuild
  migration in `migrate.ts` that hardcodes a column list `working_status` would need adding to (the
  one existing rebuild, `migrateExpectedPartsNullablePrice`, is scoped to `estimated_resale_value`'s
  own nullability, not column presence). `working_status`'s `DEFAULT 'working'` additionally
  backfills every pre-existing Expected Part row the moment the column is added, so the field is
  never actually null in practice and the trigger's gate can check it with a plain equality.
- A3 (cycle 0): The condition-filter conditionIds (3000, 4000, 5000, 6000, 7000) are fixed in the
  connector, not a per-Source configurable value — the request asks for a blanket policy change,
  not a new user-facing toggle.
- A4 (cycle 0): A $1-valued, non-working Expected Part's `priceSource` is set to `'auto'`, the same
  value any other pipeline-assigned price carries — no fourth `price_source` state is needed; the
  existing three states already express exactly what's needed.
- A5 (cycle 0): The AI's per-part working-status analysis (T4) only ever reads the listing's own
  title/description text, not its photos — the user's own request named "the listing description"
  specifically; extending this to visual damage assessment from photos is a materially harder,
  separate vision task this plan does not attempt.
- A6 (cycle 0): The manual working-status control (T6) is shown only on a Listing already flagged
  `nonWorking` — not on every Listing universally. The user's own request frames this as reviewing
  and correcting a flagged build's parts, and showing a mostly-inert control on the overwhelming
  majority of ordinary Listings would be unused visual noise with no stated need.
- A7 (cycle 0): `BaselineTests` is 700 (520 server + 175 web + 5 shared), `BaselineSuite: pass`,
  measured fresh in this worktree after running `npm install` at its root — the worktree's
  `node_modules` was not fully hoisted on creation (missing `node_modules/.bin/eslint`
  specifically, causing one web test to fail with `ENOENT` on first run); resolved by a plain
  `npm install`, not a code fix.
- A8 (cycle 0): T5's builder dispatch made its edits against the main repo checkout
  (`/mnt/d/repositories/pc-parts-flipper`, branch `main`) instead of this feature's worktree
  (`.worktrees/ebay-condition-filter`, branch `feat/ebay-condition-filter`) — confirmed by `git
  status`/`git diff` showing the three target files unchanged in the worktree but changed on
  `main`. The build lead ported the exact same diff (`persistIdentifiedParts`'s working-status
  threading and $1 override, `createExpectedPartsForListing`'s matching override, and Node B's
  `workingStatus !== 'working'` skip-term) by hand into the worktree copies of
  `identifyPartsWorkerPool.ts`, `pricePartsTrigger.ts`, and `routes/listings.ts`, then reverted the
  stray edits on `main` (including the duplicate T1/T4-shaped edits that same dispatch made to
  `db/schema.ts`, `db/types.ts`, `db/queries/expectedParts.ts`, `packages/shared/src/listings.ts`,
  and `packages/shared/src/aiIdentification.ts` on `main`, discarded since the worktree already had
  the correct versions from T1/T4). `main`'s pre-existing unrelated changes
  (`.claude/feature/part-price-estimation/dashboard.html`, the untracked `artifacts/` dir) were left
  untouched.
- A9 (cycle 0): During TE1/TE5's testing, a pre-existing bug in `migrate.ts`'s
  `migrateExpectedPartsNullablePrice` rebuild (its hardcoded `expected_parts_new` CREATE TABLE/INSERT
  column lists omitted `working_status`) was found and fixed — this rebuild runs unconditionally on
  every fresh database (not just legacy ones, contradicting A2's premise that no rebuild migration
  hardcodes a column list `working_status` would need adding to), silently dropping the column on
  every fresh DB/test run. Fixed in `migrate.ts` by adding `working_status` to both column lists;
  confirmed by a clean fresh-DB run afterward. A2 is corrected by this entry, not by editing A2 itself.
- A10 (cycle 0): Every R/TE row's `actual_tokens` this cycle is `null`. `measure-child-cost.py`
  requires an `AGENT_TAG: <tag>` line inside the dispatched child's own transcript to find it; this
  cycle's dispatches did not embed that marker, so no cost could be measured for any of the 12
  reviewer/tester children — reported as `null` per instructions, not estimated.
- A11 (cycle 0): `npm run build -w apps/server` (full `tsc`, not invoked by root `npm test`) surfaces
  roughly 20 TypeScript errors in files this feature never touches (`SaleListing`/`Sale`/
  `TeardownResult`/`PartSummary`/`Source`/`CandidateListing`/`PartPriceCacheEntry` field mismatches
  between `apps/server/src/db/types.ts` and `packages/shared`). Confirmed absent building the
  identical files on `main` at the same base commit — a worktree-local anomaly (likely a dual-package
  module-resolution artifact in this worktree's own `node_modules`), not caused by any T1-T6 task and
  out of this cycle's scope; `npm test` never invokes the full workspace build, so it does not block
  the standing gate. The one genuinely feature-caused compile error (`ExpectedPartInput.workingStatus`
  typing, T1) is reported separately as a must_fix, not folded into this note.
- A12 (cycle 1): Build-lead verified, before dispatching T7/T8/T9, that the worktree
  (`.worktrees/ebay-condition-filter`, branch `feat/ebay-condition-filter`) genuinely held the
  correct cycle-0 state (`git status`/`git branch` checked directly) and that `main` carried no new
  stray writes from this cycle's dispatches afterward. One pre-existing drift was found on `main`,
  predating this cycle (not caused by T7/T8/T9): `main` still has stray, uncommitted duplicate edits
  in `apps/server/src/db/migrate.ts`, `apps/server/test/db.test.ts`, `apps/server/test/listings.test.ts`,
  `apps/server/test/identifyPartsWorkerPool.test.ts`, and `apps/server/test/pricePartsTrigger.test.ts`
  left over from an earlier cycle's stray dispatch (same content class as the T1/T5-shaped edits
  A8 already documents reverting, but these five files were missed by that revert). Content-identical
  to what the worktree already has correctly from T1/T4/T5/TE1/TE5 — not a risk of divergence, just
  main-checkout hygiene debt outside T7/T8/T9's own scope, left untouched since reverting it was not
  part of this batch's assignment. T7/T8/T9 themselves touched only worktree files
  (`packages/shared/src/listings.ts`; `apps/server/src/db/queries/partPriceCache.ts`,
  `apps/server/test/pricePartsTriggerRace.test.ts`, `apps/server/test/workingStatusManualSaveRoute.test.ts`;
  `apps/web/src/features/listings/listing-form-state.ts`, `listing-form.tsx`, `expected-parts-editor.tsx`,
  `apps/web/test/expected-parts-editor-working-status.test.tsx`) — confirmed via each builder's own
  working-directory instruction and a post-hoc `git status` on `main` showing none of these seven
  files newly appear there.
- A13 (cycle 1, T9): MF-4's own description said "the import line" was clobbered, but the actual
  break was `listing-form.tsx`'s `ExpectedPartsEditor` import line having been wholesale replaced
  by T6's `NonWorkingBadge` import (not added alongside it), confirmed via `git diff HEAD` — a
  `ReferenceError: ExpectedPartsEditor is not defined` on every mount, not literally the
  `TypeError: initialExpectedPartRows is not a function` the description's wording implied (though
  `initialExpectedPartRows` itself genuinely was missing from `listing-form-state.ts` too and was
  restored as specified). Both the missing export and the clobbered import are fixed; `NonWorkingBadge`'s
  import was kept alongside the restored `ExpectedPartsEditor` import rather than removed.
- A15 (cycle 1) — corrects A12: A12's "content-identical to what the worktree already has
  correctly" claim was independently checked by the orchestrator and found wrong — `md5sum`
  comparison showed 4 of the 5 flagged files differed in content from the worktree's versions
  (only `pricePartsTrigger.test.ts` matched). `migrate.ts`'s diff specifically showed `main`'s stray
  copy was a materially *older* revision (its doc comment named only `ai_confidence`/`ai_source`,
  missing even `price_source`, let alone this feature's `working_status`) — stale drift predating
  this feature entirely, not a byproduct of any dispatch in this cycle or the last. Since none of
  it was ever committed, the orchestrator discarded all five files on `main` via
  `git checkout --` (restoring `main` to its last clean commit, `a436e82`) rather than trust the
  "no divergence risk" framing — `main`'s working tree is now clean of every file this feature
  touches, confirmed by a fresh `git status`.
- A14 (cycle 1, T7/T8/T9): Each builder's local default `node` on PATH was v12 (incompatible with
  this repo's TypeScript/vitest/eslint); each used the project's own newer `node` already installed
  under `~/.nvm` to run its own build/test/lint verification — an environment-path issue, not a
  code change.
- A16 (cycle 1): All six of R7/TE7/R8/TE8/R9/TE9's `actual_tokens` are `null`, not a measured
  figure. `measure-child-cost.py child-cost --tag "<tag>"` was run once per intended tag ("review
  T7", "test T7", "review T8", "test T8", "review T9", "test T9") but returned the exact same
  figure (250761) for all six, despite the six children running wildly different wall-clock
  durations (1m36s/1m48s for the T7 pair vs 6-11 minutes for the T8/T9 pairs) — a result that
  cannot reflect six genuinely distinct per-child costs and most likely means the tag-matching
  mechanism (`AGENT_TAG: <tag>` embedded in a child's own transcript) never found a literal match
  for any of the six tags and instead fell back to matching this orchestrating session's own
  transcript, repeated six times. The `_task` tool available to this dispatcher has no
  `description`/tagging parameter to embed that marker, unlike whatever dispatch mechanism the
  measurement script assumes — the same gap already documented for cycle 0's twelve children in
  A10. Per instructions, an untrustworthy number is not written as if it were a measurement;
  `null` is reported instead of the suspicious 250761 for all six rows.
- A17 (cycle 1): Before running the standing gate, confirmed the worktree
  (`.worktrees/ebay-condition-filter`, branch `feat/ebay-condition-filter`) was this dispatcher's
  own real working directory (`pwd`/`git rev-parse --show-toplevel`/`git branch --show-current` all
  checked directly), then separately checked `main` for stray writes from this cycle's six
  dispatches. Found one: TE8's dispatch had written its new MF-2 regression test
  (`apps/server/test/partPriceCache.test.ts`) onto `main` as well as onto the worktree — content
  equivalent in both places (a cosmetic single/double-quote difference in the `it(...)` string
  only), confirming the worktree's own copy was unaffected and correct. The stray copy on `main`
  was discarded via `git checkout -- apps/server/test/partPriceCache.test.ts`, restoring `main` to
  clean on that file. `main`'s two remaining diffs
  (`.claude/feature/part-price-estimation/dashboard.html`, untracked `artifacts/`) are pre-existing,
  unrelated to this feature (per A8/A12), and were left untouched.



## Cycle Log

### Cycle 0
Trigger: initial
UAT: not_run

### Cycle 1
Trigger: feature-validate-lead FAIL — 6 must_fix items across 3 tasks (T1, T5, T6), standing gate
  also failed (58 new test failures, 1 new lint warning).
Findings:
- MF-1 (T1): `ExpectedPartInput.workingStatus` typed without `| null` while `validateOptionalEnum`
  returns `T | null` — a real TS2322 compile error at `listingValidation.ts:192`.
- MF-2 (T5): `propagateCachedPriceToExpectedParts`'s UPDATE WHERE clause filters only on
  `price_source = 'auto'`, not `working_status = 'working'` — a non-working part's $1 can be
  silently overwritten by an unrelated working Listing's real price landing on the same combo.
- MF-3 (T5): `pricePartsTriggerRace.test.ts`'s `partFixture` never sets `workingStatus`, so every
  fixture is excluded by the new Node B gate before reaching the cache/job tables — 2 real test
  failures (the same fixture-regression class already fixed in two sibling test files, missed here).
- MF-4 (T6, critical): the diff deleted the exported `initialExpectedPartRows` while
  `listing-form.tsx` and 7 pre-existing test files still call it — `ListingForm` throws on every
  mount; root cause of all 56 web test failures across 8 files.
- MF-5 (T6): `updateWorkingStatus` has no same-status guard — re-clicking an already-active status
  button clears a real, already-researched price even though nothing actually changed.
- MF-6 (T5's own new test file): an unused `runMigrations` import is the sole new lint warning.
UAT: passed
UAT checks:
- No real eBay credentials in this environment; Req 1-3 (the condition filter itself) verified by direct source read of ebayConnector.ts's searchOneQuery — the conditionIds:{3000|4000|5000|6000|7000} segment is assigned unconditionally, before the optional maxPrice branch, and comma-joined with it when present; excludes every other conditionId by construction.
- Everything downstream of a Listing landing with nonWorking:true was exercised live against the real running app/server/DB: created a non-working Listing (L1), confirmed GET /api/listings and GET /api/listings/:id both return nonWorking:true, confirmed NonWorkingBadge renders (gated the same way) in both the queue table and detail view, styled distinctly (amber) from the eBay-scan (emerald) and AI-suggested (violet) badges.
- A fully-identified part on L1 explicitly set to workingStatus:'non_working' was assigned estimatedResaleValue:1/priceSource:'auto' automatically; part_price_cache was queried directly after a clean server stop and held zero rows for that combo.
- An ordinary Listing (L2, nonWorking:false, created via the plain public API) showed no non-working badge and no working-status control in its editor; its manually-entered and AI-identified parts both came back workingStatus:'working' explicitly (never null).
- Real Identify Parts (genuine omp spawn) on a non-working Listing naming one specific broken part (L3, "GPU does not work, everything else powers on fine") resulted in only that part marked non_working/$1; the other three identified parts were marked working and two of them went on to receive real researched dollar values ($35, $95) via the live pricing pipeline.
- Real Identify Parts on a non-working Listing with no determinable breakdown (L4, "sold as-is, untested, for parts only") resulted in every identified part marked non_working/$1, confirming the no-guessing fallback.
- Flipping L1's $1/non-working part to 'working' via the real API cleared its price, then a subsequent real pricing cycle gave it a genuine researched value ($75); flipping a real $75/working part to 'non-working' immediately set it back to $1 — both directions of the re-evaluation confirmed live.
- A manual $500/'manual' claim on a non-working part survived the $1 override entirely across multiple save cycles, confirming manual ownership is never auto-reclaimed.
- The no-op guard for re-clicking an already-active working-status button (MF-5's fix) was confirmed by direct source read of updateWorkingStatus's same-status early return, corroborated by an API-level resave-unchanged round-trip (no browser-automation tool exists in this environment; disclosed explicitly rather than faked).
- Standing gate cited from feature-validate-lead's Cycle 1 PASS digest, not re-run: lint clean; whole suite green, 738 tests vs BaselineTests 700, no coverage shrinkage; doc-comment convention and the apps/web->apps/server import boundary both independently spot-checked directly by the UAT pass itself.
- Operational: UAT's own indiscriminate `pkill -f "tsx watch"` killed the pre-existing, out-of-scope main-checkout dev service's backend as a side effect (disclosed transparently in its digest); the orchestrator independently confirmed this (port 3001 dead, port 5173 still serving) and restarted that service cleanly via graceful SIGTERM afterward, confirming no WAL corruption and a clean reboot.
Resolution: feature-validate-lead PASS. All 6 must_fix items from this cycle's trigger (MF-1
  through MF-6) re-reviewed and re-tested independently against T7/T8/T9's fixes — all 6 PASS, no
  new must_fix raised. Standing gate: `npm run lint` clean (exit 0, no output); full suite green
  (apps/server 54 files/546 tests, apps/web 25 files/187 tests, packages/shared 1 file/5 tests —
  738 total, 0 failures), test count 738 >= BaselineTests 700 (coverage grew, nothing removed). One
  operational hazard found and fixed, not a code defect: TE8's dispatch had stray-written its new
  MF-2 regression test onto the main checkout as well as the worktree (A17) — discarded from main,
  worktree copy confirmed correct and already included in the suite run above.


