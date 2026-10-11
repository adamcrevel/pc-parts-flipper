# Feature: pricing-status-not-priced-state

Status: proposed
Cycle: 0 / 3
FeatureStarted: 2026-10-11T21:21:19Z
OrchestrationTokensActual: 32923
OrchestrationTokensBreakdown: input 0 + output 6,681 + cache-write 10,416 + cache-read 15,826, across 14 turns
Prototype: https://gist.githack.com/adamcrevel/29cd8c945244f4f18168d8742f539eb6/raw/prototype.html
BaselineTests: 943
BaselineSuite: fail

## Goal

The Listings table's "Pricing Status" column currently shows only two values, computed from a
boolean `hasUnpricedParts` (`true` if at least one fetched Expected Part has a null
`estimatedResaleValue`, `false` otherwise — including, by `.some`'s own semantics on an empty
array, a listing with **zero** Expected Parts at all). User-reported bug: a listing that has not
yet had its parts identified (zero Expected Parts) — or one whose parts exist but are *all*
unpriced — is shown as "Fully Priced", which is wrong: neither listing has actually had any
pricing work done on it at all.

This feature replaces the two-value model with three, computed from the same Expected Parts data
already fetched, no new stored column:

- **"Not Priced"** — zero Expected Parts (not yet identified), or at least one Expected Part exists
  but every one of them is unpriced (zero priced out of however many exist).
- **"Partially Priced"** — at least one Expected Part is priced AND at least one is unpriced (a
  genuine mix).
- **"Fully Priced"** — at least one Expected Part exists and every one of them is priced.

Ascending sort keeps the existing "most work still needed sorts first" direction, extended to the
third state: Not Priced, then Partially Priced, then Fully Priced.

## Requirements

1. A Listing's Pricing Status is computed as exactly one of three values — `not_priced`,
   `partially_priced`, `fully_priced` — replacing the current two-value `hasUnpricedParts` boolean
   entirely (not added alongside it).
2. "Not Priced" is the result when the Listing has zero Expected Parts.
3. "Not Priced" is also the result when the Listing has one or more Expected Parts but every one of
   them has a null `estimatedResaleValue` (none priced at all) — the specific gap the user reported.
4. "Partially Priced" is the result only when the Listing has at least one priced Expected Part and
   at least one unpriced Expected Part, both true at once.
5. "Fully Priced" is the result when the Listing has at least one Expected Part and every one of
   them has a non-null `estimatedResaleValue`.
6. The Listings table's Pricing Status column renders the correct one of three distinct labels —
   "Not Priced", "Partially Priced", "Fully Priced" — for every row, never blank and never a
   two-value result.
7. Ascending sort on the Pricing Status column lists every "Not Priced" listing first, then every
   "Partially Priced" listing, then every "Fully Priced" listing — extending the existing
   unpriced-first convention to the new third bucket, not just preserving it for the old two.
8. Descending sort on the Pricing Status column is the exact reverse of Requirement 7's order.
9. Sorting by Pricing Status still composes correctly with pagination across the whole filtered
   dataset (a bucket boundary that falls mid-page is not re-sorted independently per page), matching
   the existing proof already established for every other sortable column.

## Standing Checks

- The whole test suite passes, and the test count holds at or above `BaselineTests` (943: 23 shared
  + 248 web + 672 server). `BaselineSuite` is recorded `fail`: the same single pre-existing,
  reproducible, unrelated failure already documented in the two most recent features
  (`apps/server/test/listingPhotos.test.ts`'s "stores an uploaded photo..." case, an `ENOENT` on a
  temp-dir photo path) — confirmed failing again in this fresh worktree before any change, same
  symptom, third consecutive confirmation. Out of scope for this feature.
- `npm run lint` runs clean with no new violation.
- Any new/changed public type, function, or component carries the same kind of header/block comment
  documentation already used elsewhere in the codebase.
- No new code in `apps/web` imports directly from `apps/server` — the existing
  `import/no-restricted-paths` boundary (`eslint.config.mjs`), checked by
  `apps/web/test/eslint-import-boundary.test.ts`, holds for every file this feature touches.
- No DuckDB schema change of any kind — Pricing Status is computed entirely from each Listing's
  already-fetched Expected Parts at read time, the same way `hasUnpricedParts` was; no new column,
  no migration.

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| P0 | Prototype covering T3 (ui: yes): three-state Pricing Status badge (Not Priced/Partially Priced/Fully Priced) with correct 3-way ascending/descending sort, including the two reported edge cases (zero Expected Parts, all-unpriced Expected Parts). | prototype | | complete | 0 | | 2026-10-11T21:21:40Z | 2026-10-11T21:31:32Z | 10 | 2026-10-11T21:21:40Z | | 7500 | yes | .claude/feature/pricing-status-not-priced-state/prototype-url.txt |
| T1 | Shared type (Req 1). `packages/shared/src/listings.ts`: add `export type PricingStatus = 'not_priced' \| 'partially_priced' \| 'fully_priced';` with a doc comment explaining each value's exact condition (Req 2-5, verbatim from this plan's Requirements, so the type's own comment is the single source of truth for the three rules). Replace `ListingSummary`'s `hasUnpricedParts: boolean;` field with `pricingStatus: PricingStatus;` (same required, non-optional treatment — no caller should read this as missing). Do not touch `ListingSortField`: its existing `'unpriced'` member is kept as the wire identifier for this column's sort (a display-only field rename, not a new sort field — avoids a second unrelated rename in the same change). | builder | | not_started | 0 | | | | 20 | | | | no | |
| T2 | Server computation and sort key (Req 2-5, 7-9), depends on T1. `apps/server/src/routes/listings.ts`: add a new `computePricingStatus(expectedParts: ExpectedPart[]): PricingStatus` helper (placed near `computeComparison`, same file) implementing exactly: zero parts -> `'not_priced'`; counts of priced vs. unpriced parts both > 0 -> `'partially_priced'`; every part priced (non-empty) -> `'fully_priced'`; every part unpriced (non-empty, zero priced) -> `'not_priced'`. Replace both `toSummary` and `toDetail`'s `hasUnpricedParts: expectedParts.some(...)` lines with `pricingStatus: computePricingStatus(expectedParts)`, calling the one shared helper from both places (not duplicating the logic a second time the way the old boolean computation was intentionally duplicated — this one is non-trivial enough that a single shared implementation is the right call, and a doc comment on the helper should say so explicitly). Update `SORT_KEYS.unpriced`'s extractor: replace the old `(listing) => (listing.hasUnpricedParts ? 0 : 1)` with an ordinal mapping `{ not_priced: 0, partially_priced: 1, fully_priced: 2 }[listing.pricingStatus]`, with a doc comment explaining the three-way ordinal (not just the old binary one) is what makes ascending sort read Not Priced, then Partially Priced, then Fully Priced (Req 7), and reusing the same `Number(keyA) - Number(keyB)` comparator already in place (no comparator change needed). | builder | T1 | not_started | 0 | | | | 25 | | | | no | |
| T3 | Client badge and wiring (Req 6), depends on T1. `apps/web/src/features/listings/pricing-status-badge.tsx`: change `PricingStatusBadgeProps` from `{ hasUnpricedParts: boolean }` to `{ pricingStatus: PricingStatus }` (import the type from `@pc-parts-flipper/shared`); render three pills instead of two — keep "Partially Priced" in its existing destructive/red styling, keep "Fully Priced" in its existing teal styling (matching `IdentifyPartsStatusBadge`'s "completed" pill), and add "Not Priced" in a neutral/muted pill (`border-muted-foreground/40 bg-muted text-muted-foreground`, or this project's closest equivalent muted-pill convention — grep for an existing muted pill, e.g. `IdentifyPartsStatusBadge`'s own "no job yet" state, and match its exact token names) to read as "nothing done yet," distinct from both the red (something needs attention mid-way) and teal (done) states. Update the component's doc comment to describe all three states and when each applies. `apps/web/src/features/listings/listing-list.tsx`: update the one call site from `<PricingStatusBadge hasUnpricedParts={listing.hasUnpricedParts} />` to `<PricingStatusBadge pricingStatus={listing.pricingStatus} />`. | builder | T1 | not_started | 0 | | | | 20 | | | | yes | |
| R1 | Review T1 against Req 1, scoped to `packages/shared/src/listings.ts`. Confirm `PricingStatus` is exactly the 3 literal members named, `ListingSummary.pricingStatus` is required/non-optional, `hasUnpricedParts` no longer exists anywhere in this file, and `ListingSortField`'s `'unpriced'` member is untouched (confirming T1 did not also rename the sort field, which was explicitly out of scope). PASS only if a grep for `hasUnpricedParts` across the whole file returns nothing. | reviewer | T1 | not_started | 0 | | | | 10 | | | | no | |
| TE1 | Test T1. Update `packages/shared/src/partNotesAndUnpricedTypes.test.ts`'s `'ListingSummary.hasUnpricedParts'` describe block (and its two tests) to cover the new `pricingStatus: PricingStatus` field instead: all three literal values are valid, an invalid string literal is rejected (`@ts-expect-error`), and omitting the key entirely is rejected (required, not optional) — same rigor as the tests it replaces. PASS: updated/new cases pass, shared package builds clean, no regression in the other existing shared tests. | tester | T1 | not_started | 0 | | | | 15 | | | | no | |
| R2 | Review T2 against Req 2-5, 7-9, scoped to `apps/server/src/routes/listings.ts`. Confirm `computePricingStatus`'s four-way logic exactly matches Req 2-5 (test it by hand against a zero-parts list, an all-unpriced non-empty list, a genuinely mixed list, and an all-priced list); confirm both `toSummary` and `toDetail` call the same one helper (not two separate reimplementations); confirm `SORT_KEYS.unpriced`'s new ordinal mapping is `0`/`1`/`2` for `not_priced`/`partially_priced`/`fully_priced` respectively, verified against the real `Number(keyA) - Number(keyB)` ascending comparator so Req 7's stated order is what actually results, not its apparent opposite. PASS only if the ordinal-to-order mapping is traced through the real comparator code, not merely read as plausible. | reviewer | T2 | not_started | 0 | | | | 15 | | | | no | |
| TE2 | Test T2. Rewrite `apps/server/test/listings.test.ts`'s existing "groups unpriced listings..." sort test (search for `sortBy=unpriced` / "Unpriced Mix" in that file) for the new three-bucket model: seed at least 2 listings per bucket (not_priced via a zero-parts listing AND via a nonzero-all-unpriced listing; partially_priced via a genuine mix; fully_priced via all-priced), scrambled relative to both bucket and `listingDate`, and prove ascending order groups all not_priced listings first, then all partially_priced, then all fully_priced (index-based, not a single-row spot check); prove descending is the exact reverse; prove it composes with pagination across a bucket boundary that falls mid-page, the same rigor the test it replaces already used for the two-bucket model. PASS: rewritten test passes, no regression in the rest of `listings.test.ts`'s sort suite (the other 7 columns). | tester | T2 | not_started | 0 | | | | 30 | | | | no | |
| R3 | Review T3 against Req 6, scoped to `pricing-status-badge.tsx` and `listing-list.tsx`. Confirm the badge renders exactly one of the three correct labels for each of the three `PricingStatus` values, never blank; confirm the three pills are visually distinct from each other (three different color tokens, not two colors reused for three labels); confirm `listing-list.tsx`'s one call site passes `pricingStatus`, not the old `hasUnpricedParts` prop name. PASS only if the "Not Priced" pill's styling is confirmed genuinely distinct from both of the other two, not just a label change on a reused class string. | reviewer | T3 | not_started | 0 | | | | 10 | | | | no | |
| TE3 | Test T3. Update `apps/web/test/listing-list.test.tsx`'s Pricing Status badge test (currently asserting "Partially Priced"/"Fully Priced" for `hasUnpricedParts: true`/`false`) to pass `pricingStatus` instead and add the third case: a listing with `pricingStatus: 'not_priced'` renders "Not Priced", distinct from the other two cases' text and (if feasible via computed style/class) visually distinct styling. PASS: updated/new cases pass, no regression in the rest of `listing-list.test.tsx`. | tester | T3 | not_started | 0 | | | | 15 | | | | no | |

## Assumptions

- A1 (cycle 0): `ListingSortField`'s wire identifier for this column stays `'unpriced'` — only the
  shared-type field name (`hasUnpricedParts` -> `pricingStatus`) and its value shape change. The
  sort-field identifier is an internal HTTP query-param detail the user never sees (they only see
  the "Pricing Status" column label, already renamed in a prior feature); renaming it again here
  would touch more files for zero user-visible benefit.
- A2 (cycle 0): Ascending order for the three buckets is Not Priced, then Partially Priced, then
  Fully Priced — extending the existing "most work needed sorts first" convention the user
  previously confirmed for the two-value model. Not explicitly re-confirmed with the user for the
  three-value case, but a direct, consistent extension of a decision they already made, not a new
  judgment call invented from nothing.
- A3 (cycle 0): `BaselineSuite` is recorded `fail` for the same single inherited, unrelated,
  reproducible test (`listingPhotos.test.ts`) already documented in the two most recent features —
  confirmed failing again, in isolation, in this fresh worktree before any change. Out of scope.

## Cycle Log

### Cycle 0
Trigger: initial
UAT: not_run
