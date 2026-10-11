# Overview
The Listings table's Pricing Status column used to show only two values, driven by a boolean
`hasUnpricedParts` that quietly mislabeled a listing with zero Expected Parts (or one whose parts
were all unpriced) as "Fully Priced." This feature replaces that boolean with a three-value
`PricingStatus` — Not Priced, Partially Priced, Fully Priced — computed from the same
already-fetched Expected Parts data, with no schema change, and extends ascending/descending sort
and pagination to the new third bucket.

## Shared type
Summary: Defines the new three-value `PricingStatus` union and swaps `ListingSummary`'s old
boolean field for it, with the type's own doc comment serving as the single source of truth for
each value's exact condition.
Tasks: T1
Files:
- packages/shared/src/listings.ts: adds `export type PricingStatus = 'not_priced' | 'partially_priced' | 'fully_priced'` and replaces `ListingSummary.hasUnpricedParts: boolean` with `pricingStatus: PricingStatus`.
- packages/shared/src/partNotesAndUnpricedTypes.test.ts: type-shape proof updated to cover the new field — all three literal values valid, an invalid literal rejected, and omitting the key rejected (still required, not optional).

## Server computation and sort
Summary: Adds one shared `computePricingStatus` helper used by both listing-shaping functions, and
remaps the sort key's ordinal so ascending order groups Not Priced, then Partially Priced, then
Fully Priced, proven against the real comparator and against pagination across a bucket boundary.
Tasks: T2
Flow:
- Expected Parts: fetched per listing, as before
- computePricingStatus: counts priced vs. unpriced to pick one of the three states
- toSummary / toDetail: attach `pricingStatus` to the response
- SORT_KEYS.unpriced: maps the status to ordinal 0/1/2 for the comparator
Files:
- apps/server/src/routes/listings.ts: new `computePricingStatus` helper (replacing the duplicated `.some(...)` boolean check in both `toSummary` and `toDetail` with one shared call), and `SORT_KEYS.unpriced`'s extractor remapped from a binary 0/1 to the three-way `{not_priced:0, partially_priced:1, fully_priced:2}` ordinal.
- apps/server/test/listings.test.ts: the existing two-bucket "unpriced mix" sort test rewritten into a six-listing, three-bucket test proving both routes to Not Priced (zero parts and all-unpriced parts), ascending grouping, exact-reverse descending, and pagination composing correctly across a boundary that falls mid-page.

## Client badge and wiring
Summary: Updates the Pricing Status pill to render one of three visually distinct states instead
of two, and rewires its one call site to pass the new field.
Tasks: T3
Files:
- apps/web/src/features/listings/pricing-status-badge.tsx: `PricingStatusBadgeProps` changed from `{ hasUnpricedParts: boolean }` to `{ pricingStatus: PricingStatus }`; now renders three pills — a new neutral/muted "Not Priced" pill alongside the existing red "Partially Priced" and teal "Fully Priced" pills — with an updated doc comment describing all three states.
- apps/web/src/features/listings/listing-list.tsx: the one `<PricingStatusBadge>` call site updated from `hasUnpricedParts={listing.hasUnpricedParts}` to `pricingStatus={listing.pricingStatus}`.
- apps/web/test/listing-list.test.tsx: the Pricing Status badge test extended from two cases to three (Not Priced, Partially Priced, Fully Priced), asserting each renders distinct text and a genuinely distinct className, not a shared style relabeled.
