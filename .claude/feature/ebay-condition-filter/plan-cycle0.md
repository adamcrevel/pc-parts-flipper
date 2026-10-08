# Feature: ebay-condition-filter

Status: proposed
Cycle: 0 / 3
FeatureStarted: 2026-10-08T13:39:58Z
OrchestrationTokensActual: null
OrchestrationTokensBreakdown: null
Prototype: https://gist.githack.com/adamcrevel/8569a92f77c4770d569bf33fe9b8503e/raw/a382c4d4e863dfb4b881e37b9886343d8a30810d/prototype.html
Walkthrough: none
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
| T1 | Schema + types for both new fields. `apps/server/src/db/schema.ts`'s `ALTER_STATEMENTS` gains `ALTER TABLE listings ADD COLUMN IF NOT EXISTS non_working BOOLEAN DEFAULT false` (Req 4, 5) and `ALTER TABLE expected_parts ADD COLUMN IF NOT EXISTS working_status VARCHAR DEFAULT 'working'` — the `DEFAULT 'working'` is load-bearing, not cosmetic: it backfills every pre-existing Expected Part row to `'working'` the moment the column is added (Req 6), and makes `'working'` the value any future INSERT gets when it omits the field, so the column is never actually null in practice and the trigger's gate (T5, Req 12) can check it with a plain equality, no null-handling needed. `apps/server/src/db/types.ts`: `Listing` gains `nonWorking: boolean`; `ExpectedPart` gains `workingStatus: 'working' \| 'non_working'` (two-state, not nullable — Req 6's own guarantee). `packages/shared/src/listings.ts`: `Listing` gains the same `nonWorking` field (documented the same way `externalSource`/`externalItemId` already are); `ExpectedPart` gains `workingStatus: 'working' \| 'non_working'` (required, matching the DB guarantee); `ExpectedPartInput` gains `workingStatus?: 'working' \| 'non_working'` (optional — an omitted value means "use the default," mirrored server-side in T5, not here). `apps/server/src/db/queries/listings.ts`: `CreateListingInput` gains `nonWorking?: boolean` (omitted defaults false), `mapRow` reads `row.non_working as boolean`, `createListing`'s INSERT column list gains `non_working`. `apps/server/src/db/queries/expectedParts.ts`: `CreateExpectedPartInput` gains `workingStatus?: 'working' \| 'non_working'` (omitted defaults `'working'` at the DB level), `mapRow` reads `(row.working_status as 'working' \| 'non_working' \| null) ?? 'working'` (defensive: the DB default already guarantees non-null, but a reader should never have to trust that alone), `createExpectedPart`'s INSERT column list gains `working_status`. `apps/server/src/routes/listingValidation.ts` gains a `VALID_WORKING_STATUSES` constant (`['working', 'non_working']`) and validates an incoming `workingStatus` the same way it already validates `priceSource` (`validateOptionalEnum`). `Listing.nonWorking` is never user-settable through the manual create/edit request body (server-only, same precedent as `externalSource`/`externalItemId`); `workingStatus` IS user-settable per-part through the normal `ExpectedPartInput` shape (Req 11), same as `priceSource` already is. | builder | none | not_started | 0 | | | | 25 | | | | no | |
| T2 | eBay connector condition filter + capture: `apps/server/src/connectors/ebayConnector.ts`'s `EbayItemSummary` interface gains `conditionId?: string` (the Browse API's own field name, a string like `"7000"`). `searchOneQuery`'s `params` now always sets a `filter` query param including `conditionIds:{3000\|4000\|5000\|6000\|7000}` (eBay's documented pipe-separated multi-value, comma-combined-with-other-filters syntax — Req 1-3), combined with the existing optional `price:[0..${maxPrice}],priceCurrency:USD` segment when `maxPrice` is set, comma-joined into one `filter` value either way — never only present when `maxPrice` is set, unlike today. `CandidateListing` (`apps/server/src/connectors/types.ts`) gains `nonWorking: boolean`. `mapItemSummary` computes it as `item.conditionId === '7000'` (Req 4). Update the existing test in `apps/server/test/ebayConnector.test.ts` asserting `filter=` is absent with no `maxPrice` set — under this change a filter is always present; rewrite that assertion to check the conditionIds segment is present instead, and add a case proving the conditionIds segment is present with `maxPrice` set too, combined with the price segment, both as one `filter` value. | builder | none | not_started | 0 | | | | 20 | | | | no | |
| T3 | Wire the imported condition through to the Listing row: `apps/server/src/scan/scanService.ts`'s `importCandidateIfNew` passes `nonWorking: candidate.nonWorking` into its `createListing(...)` call (Req 4). | builder | T1;T2 | not_started | 0 | | | | 10 | | | | no | |
| T4 | AI per-part working-status inference (Req 7-9). `apps/server/src/ai/identificationPrompt.ts`'s `buildIdentificationPrompt(listing)` appends a new rule, only when `listing.nonWorking` is true (the prompt is completely unchanged for any other Listing): ask the model to also set a `"workingStatus"` field per part — `"non_working"` if the listing's own title/description specifically says or clearly implies that exact part doesn't work, `"working"` if the text specifically clears it or the text calls out a *different* part as broken while saying nothing against this one, or `"unclear"` if nothing in the text lets the model tell either way for this specific part. `apps/server/src/ai/identificationParser.ts`: `AiIdentifiedPart` (shared type, `packages/shared/src/aiIdentification.ts`) gains an optional `workingStatus?: 'working' \| 'non_working' \| 'unclear'` field, parsed with the same safe-coerce-and-Warn convention `confidence`/`source` already use, falling back to `"unclear"` for any unrecognized value (the least assertive option, matching this file's own `FALLBACK_CONFIDENCE`/`FALLBACK_SOURCE` precedent) — only populated when the prompt asked for it. A new function, `resolveWorkingStatuses(parts: AiIdentifiedPart[]): Map<number, 'working' \| 'non_working'>` (or equivalent, indexed by the part's position in the array), applies the blanket-fallback rule once every part's own per-part signal is in hand: if every part's signal is `"unclear"`, every part's final status is `'non_working'` (Req 9); otherwise every part's final status is `'working'` unless its own signal was specifically `"non_working"` (Req 8) — a part whose own signal was `"unclear"` while another part's was `"non_working"` resolves to `'working'`, per Req 8's "every other part on that Listing is marked working." Only called when `listing.nonWorking` is true — T5 (not this task) is what sets every other Listing's parts to `'working'` directly, so this function is never invoked for one. | builder | T1 | not_started | 0 | | | | 30 | | | | no | |
| T5 | Apply resolved working_status at persist time, add `workingStatus === 'working'` to the background trigger's own eligibility gate, and the $1 price override (Req 6, 10, 12-14, 16). `apps/server/src/jobs/identifyPartsWorkerPool.ts`'s `persistIdentifiedParts`: when `listing.nonWorking`, call T4's `resolveWorkingStatuses` over the identified parts and thread each part's resolved status into its `createExpectedPart` call's new `workingStatus` field; when not, every part's `workingStatus` is explicitly `'working'` (Req 6 — never omitted/defaulted-by-silence here, stated directly in the insert). `apps/server/src/routes/listings.ts`'s `createExpectedPartsForListing`: an incoming row's `workingStatus`, if provided, is stored verbatim (Req 11); if omitted, defaults to `'working'` (Req 10) — same optionality convention `priceSource` already uses in this function. In BOTH places, when a row's `priceSource` resolves to `'auto'` (the existing condition: undecided, brand+partNumber present, no value of its own) AND that row's `workingStatus === 'non_working'`, set `estimatedResaleValue: 1` instead of leaving the incoming null (Req 13); a `'working'` row is left exactly as today (value stays null, `triggerPriceLookups` prices it for real). `apps/server/src/jobs/pricePartsTrigger.ts`'s `triggerPriceLookups`: Node B's eligibility skip-condition gains one more term — `part.workingStatus !== 'working'` — alongside the existing `brand === null`, `partNumber === null`, `estimatedResaleValue !== null` checks (Req 12), so a `'non_working'` part is excluded from the cache/research pipeline by its own status directly, not merely because it happens to already carry a value (Req 14 then follows for free: a part the gate itself never admits can never reach `insertPriceCacheEntry`). A `'manual'`-owned or already-valued row is untouched by the $1 branch either way (Req 15-16, unchanged from today). | builder | T1;T4 | not_started | 0 | | | | 30 | | | | no | |
| T6 | Manual per-part working-status control in the UI, and its price-reset-on-change behavior (Req 4, 11, 17) — two distinct pieces, a read-only Listing-level badge and an editable Expected-Part-level control. A new `apps/web/src/features/listings/non-working-badge.tsx`, `NonWorkingBadge`, mirroring `ebay-scan-badge.tsx`'s shape/styling exactly (same rounded-pill span classes) in a warning color distinct from `EbayScanBadge`'s emerald and `AiSuggestedBadge`'s violet; rendered in `apps/web/src/features/listings-queue/listings-queue-table.tsx` next to the existing `EbayScanBadge` usage (gated on `listing.nonWorking`) and in `apps/web/src/features/listings/listing-form.tsx` next to its existing `EbayScanBadge` usage (gated on `initialValue?.nonWorking`). Separately, `apps/web/src/features/listings/expected-parts-editor.tsx` gains a new per-row two-option control ("Working" / "Not working") shown only when a new `listingNonWorking: boolean` prop (threaded from `listing-form.tsx`'s own `initialValue?.nonWorking`) is true. This control uses a NEW handler, deliberately NOT `updateRow`'s generic "any edit claims manual ownership" rule, since this interaction is the opposite — releasing a price back to undecided, not claiming it: changing the control sets the row's `workingStatus` to the new value; if the row's `priceSource` is already `'manual'`, its price fields are left untouched; otherwise its `estimatedResaleValue` is cleared (empty string) and `priceSource` is reset to `undefined` (undecided), so the next save lets the server's existing `'auto'`-claim logic in T5 re-evaluate the row's price fresh under its new status (Req 17). `ExpectedPartRow` (same file) gains the `workingStatus?: 'working' \| 'non_working'` field; `listing-form-state.ts`'s `expectedPartToRow` and `listing-form.tsx`'s `persistListing` round-trip it the same way they already round-trip `priceSource`. | builder | T1 | not_started | 0 | | | | 30 | | | | yes | |
| R1 | Review T1 against Req 4-6, 10: confirm `non_working` defaults `false` and `working_status` defaults `'working'` at the DDL level (read the real `ALTER TABLE` statements, not the task's own claim), confirm both `mapRow`s' reads can never return `undefined`/a value that reads as unset, confirm `nonWorking` is absent from `listingValidation.ts`'s accepted Listing-level request-body fields while `workingStatus` IS accepted on the per-part `ExpectedPartInput` shape via `VALID_WORKING_STATUSES`, and confirm the doc-comment convention on every new field. | reviewer | T1 | not_started | 0 | | | | 12 | | | | no | |
| TE1 | Test T1: confirm both new `ADD COLUMN IF NOT EXISTS` statements run cleanly against a fresh database AND an already-migrated one (idempotent); confirm a Listing created with `nonWorking` omitted comes back `false` and one with `true` round-trips; confirm an Expected Part created with `workingStatus` omitted comes back `'working'` (the DB default, not null), and one created with `'non_working'` round-trips through `mapRow`; confirm a pre-existing row (seeded before the migration, in a fresh-vs-migrated-DB test) backfills to `'working'` once the column is added; confirm `listingValidation.ts` rejects an out-of-enum `workingStatus` value the same way it already rejects an invalid `priceSource`. Report real pass/fail output. | tester | T1 | not_started | 0 | | | | 15 | | | | no | |
| R2 | Review T2 against Req 1-4: confirm the real, exact `conditionIds:{3000\|4000\|5000\|6000\|7000}` filter segment is present on every search call regardless of whether `maxPrice` is set, confirm it is correctly comma-combined with the price segment into one `filter` param, and confirm `mapItemSummary`'s `nonWorking` computation matches conditionId `'7000'` exactly (a string compare). | reviewer | T2 | not_started | 0 | | | | 10 | | | | no | |
| TE2 | Test T2: run `ebayConnector.test.ts` in full, confirming the rewritten filter-assertion test and the new combined-filter case both pass, and that `mapItemSummary` sets `nonWorking: true` only for `conditionId: '7000'` and `false` for every other conditionId (at least one allowed-used one, and the omitted/undefined case). Report real pass/fail output. | tester | T2 | not_started | 0 | | | | 12 | | | | no | |
| R3 | Review T3 against Req 4: confirm `candidate.nonWorking` genuinely reaches the stored Listing row, tracing the one line changed. | reviewer | T3 | not_started | 0 | | | | 6 | | | | no | |
| TE3 | Test T3: run/extend `scanService.test.ts` proving a scanned candidate with `nonWorking: true` produces a Listing whose `nonWorking` is `true`, and one with `false` produces `false`. Report real pass/fail output. | tester | T3 | not_started | 0 | | | | 10 | | | | no | |
| R4 | Review T4 against Req 6-9: confirm the new prompt rule is appended ONLY when `listing.nonWorking` is true (read the real conditional, don't take the claim on faith) and the prompt is byte-for-byte unchanged otherwise (diff it against the pre-change version for a non-flagged Listing). Confirm the parser's fallback for an unrecognized `workingStatus` value is genuinely `'unclear'`, not a silent crash or a different default. Confirm `resolveWorkingStatuses`'s two-branch logic exactly matches Req 7/8's rule — trace both branches by hand against at least one constructed example each (all-unclear input; one-named-broken input) rather than trusting the function's own name. | reviewer | T4 | not_started | 0 | | | | 15 | | | | no | |
| TE4 | Test T4: unit-test `resolveWorkingStatuses` directly against constructed `AiIdentifiedPart[]` fixtures — all parts `'unclear'` (expect every part `'non_working'`), one part `'non_working'` + rest `'unclear'` (expect that one `'non_working'`, rest `'working'`), a mix including an explicit `'working'` signal, and the real single-part/all-unclear edge cases. Confirm `buildIdentificationPrompt`'s output differs (new rule present/absent) between a `nonWorking: true` and `nonWorking: false` Listing fixture. Report real pass/fail output. | tester | T4 | not_started | 0 | | | | 20 | | | | no | |
| R5 | Review T5 against Req 6, 10, 12-14, 16, the most cross-cutting task here (three files, two call paths, a three-field join). Confirm `persistIdentifiedParts` only calls `resolveWorkingStatuses` when `listing.nonWorking`, and every part's `workingStatus` is genuinely `'working'` (not null, not omitted) otherwise (Req 6). Confirm `createExpectedPartsForListing`'s default for an omitted `workingStatus` is genuinely `'working'` (Req 10). Confirm `pricePartsTrigger.ts`'s Node B skip-condition was genuinely changed to add `workingStatus !== 'working'` — read the real diff, don't take the task's own claim — and construct the specific counter-example (a part with `workingStatus: 'non_working'` but somehow still `estimatedResaleValue: null`, e.g. a toggle-then-save race) to confirm the gate excludes it on its OWN status, not merely via the $1-already-assigned side effect (Req 12). Confirm the $1 assignment's condition in both files reads each row's OWN resolved `workingStatus`, not the Listing's `nonWorking` flag directly (Req 13). Confirm a `'manual'`-owned or already-valued row is untouched in both files (Req 16). Confirm Req 14 (never enters the cache) now follows from the gate change itself, not a separate mechanism. | reviewer | T5 | not_started | 0 | | | | 18 | | | | no | |
| TE5 | Test T5: prove Req 13 live on BOTH call paths (identify-parts and manual-save) — a part resolved/set `'non_working'`, fully identified, no prior price, gets `estimatedResaleValue: 1`. Prove Req 6/10 — a part on a non-flagged Listing, and an omitted-`workingStatus` manual part, both come back `'working'` explicitly (never null). Prove Req 12 directly against `pricePartsTrigger.ts`: construct an `ExpectedPart` with `workingStatus: 'non_working'` and `estimatedResaleValue: null` (bypassing the normal creation path, calling `triggerPriceLookups` directly) and confirm it is NOT passed to `resolveCombo` — mutation-prove this (reverting the new `workingStatus` check must fail exactly this test). Prove Req 16 — a `'manual'`-owned or already-valued row is untouched regardless of its `workingStatus`. Prove Req 14 — after a $1 assignment, query `part_price_cache` directly and confirm no row exists for that combo. Report real pass/fail output. | tester | T5 | not_started | 0 | | | | 25 | | | | no | |
| R6 | Review T6 against Req 4, 11, 17: confirm `NonWorkingBadge` is rendered in both named locations, correctly gated, and visually distinct from the other two badges (read the actual Tailwind classes). Confirm the per-part control is shown ONLY when `listingNonWorking` is true. Confirm the NEW handler is genuinely distinct from `updateRow` — read it directly and confirm it does NOT set `priceSource: 'manual'` the way every other edit does, and DOES skip clearing the price when `priceSource` is already `'manual'` (construct this exact case and trace it by hand, do not take the description's claim on faith — this is the one place in this task that deliberately breaks the codebase's otherwise-universal "any edit claims manual ownership" rule, and is the single likeliest spot for a builder to reflexively reuse the wrong pattern). Confirm `workingStatus` round-trips through `expectedPartToRow`/`persistListing` the same way `priceSource` already does. | reviewer | T6 | not_started | 0 | | | | 15 | | | | no | |
| TE6 | Test T6: render `listings-queue-table.tsx` and `listing-form.tsx` each with a `nonWorking: true` Listing and a `nonWorking: false` one, confirming `NonWorkingBadge` appears only for the former in both places. Render the Expected Parts editor with `listingNonWorking: true` and confirm the per-part control appears; with `false`, confirm it does not. Exercise the new handler directly: an `'auto'`-owned priced row, toggled to non-working, ends up with `estimatedResaleValue` cleared and `priceSource` undefined; a `'manual'`-owned priced row, toggled the same way, keeps its exact price and `priceSource` unchanged. Report real pass/fail output. | tester | T6 | not_started | 0 | | | | 20 | | | | no | |

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
