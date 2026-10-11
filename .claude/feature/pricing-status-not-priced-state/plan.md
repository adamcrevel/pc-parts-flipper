# Feature: pricing-status-not-priced-state

Status: done
Cycle: 0 / 3
FeatureStarted: 2026-10-11T21:21:19Z
FeatureCompletedAt: 2026-10-11T22:41:30Z
OrchestrationTokensActual: 111693
OrchestrationTokensBreakdown: input 0 + output 14,032 + cache-write 29,684 + cache-read 67,977, across 73 turns
Prototype: https://gist.githack.com/adamcrevel/29cd8c945244f4f18168d8742f539eb6/raw/prototype.html
BaselineTests: 943
BaselineSuite: fail
Walkthrough: https://gist.githack.com/adamcrevel/bd42c0b820931949f41547719d6b568b/raw/walkthrough.html

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
| T1 | Shared type (Req 1). `packages/shared/src/listings.ts`: add `export type PricingStatus = 'not_priced' \| 'partially_priced' \| 'fully_priced';` with a doc comment explaining each value's exact condition (Req 2-5, verbatim from this plan's Requirements, so the type's own comment is the single source of truth for the three rules). Replace `ListingSummary`'s `hasUnpricedParts: boolean;` field with `pricingStatus: PricingStatus;` (same required, non-optional treatment — no caller should read this as missing). Do not touch `ListingSortField`: its existing `'unpriced'` member is kept as the wire identifier for this column's sort (a display-only field rename, not a new sort field — avoids a second unrelated rename in the same change). | builder | | complete | 0 | | 2026-10-11T21:34:34Z | 2026-10-11T21:37:07Z | 20 | 2026-10-11T21:33:46Z | 4100 | null | no | packages/shared/src/listings.ts, packages/shared/src/partNotesAndUnpricedTypes.test.ts |
| T2 | Server computation and sort key (Req 2-5, 7-9), depends on T1. `apps/server/src/routes/listings.ts`: add a new `computePricingStatus(expectedParts: ExpectedPart[]): PricingStatus` helper (placed near `computeComparison`, same file) implementing exactly: zero parts -> `'not_priced'`; counts of priced vs. unpriced parts both > 0 -> `'partially_priced'`; every part priced (non-empty) -> `'fully_priced'`; every part unpriced (non-empty, zero priced) -> `'not_priced'`. Replace both `toSummary` and `toDetail`'s `hasUnpricedParts: expectedParts.some(...)` lines with `pricingStatus: computePricingStatus(expectedParts)`, calling the one shared helper from both places (not duplicating the logic a second time the way the old boolean computation was intentionally duplicated — this one is non-trivial enough that a single shared implementation is the right call, and a doc comment on the helper should say so explicitly). Update `SORT_KEYS.unpriced`'s extractor: replace the old `(listing) => (listing.hasUnpricedParts ? 0 : 1)` with an ordinal mapping `{ not_priced: 0, partially_priced: 1, fully_priced: 2 }[listing.pricingStatus]`, with a doc comment explaining the three-way ordinal (not just the old binary one) is what makes ascending sort read Not Priced, then Partially Priced, then Fully Priced (Req 7), and reusing the same `Number(keyA) - Number(keyB)` comparator already in place (no comparator change needed). | builder | T1 | complete | 0 | | 2026-10-11T21:37:07Z | 2026-10-11T21:40:20Z | 25 | 2026-10-11T21:53:46Z | 10200 | null | no | apps/server/src/routes/listings.ts |
| T3 | Client badge and wiring (Req 6), depends on T1. `apps/web/src/features/listings/pricing-status-badge.tsx`: change `PricingStatusBadgeProps` from `{ hasUnpricedParts: boolean }` to `{ pricingStatus: PricingStatus }` (import the type from `@pc-parts-flipper/shared`); render three pills instead of two — keep "Partially Priced" in its existing destructive/red styling, keep "Fully Priced" in its existing teal styling (matching `IdentifyPartsStatusBadge`'s "completed" pill), and add "Not Priced" in a neutral/muted pill (`border-muted-foreground/40 bg-muted text-muted-foreground`, or this project's closest equivalent muted-pill convention — grep for an existing muted pill, e.g. `IdentifyPartsStatusBadge`'s own "no job yet" state, and match its exact token names) to read as "nothing done yet," distinct from both the red (something needs attention mid-way) and teal (done) states. Update the component's doc comment to describe all three states and when each applies. `apps/web/src/features/listings/listing-list.tsx`: update the one call site from `<PricingStatusBadge hasUnpricedParts={listing.hasUnpricedParts} />` to `<PricingStatusBadge pricingStatus={listing.pricingStatus} />`. | builder | T1 | complete | 0 | | 2026-10-11T21:37:07Z | 2026-10-11T21:40:20Z | 20 | 2026-10-11T22:18:46Z | 10900 | null | yes | apps/web/src/features/listings/pricing-status-badge.tsx, apps/web/src/features/listings/listing-list.tsx |
| R1 | Review T1 against Req 1, scoped to `packages/shared/src/listings.ts`. Confirm `PricingStatus` is exactly the 3 literal members named, `ListingSummary.pricingStatus` is required/non-optional, `hasUnpricedParts` no longer exists anywhere in this file, and `ListingSortField`'s `'unpriced'` member is untouched (confirming T1 did not also rename the sort field, which was explicitly out of scope). PASS only if a grep for `hasUnpricedParts` across the whole file returns nothing. | reviewer | T1 | complete | 0 | | 2026-10-11T21:42:36Z | 2026-10-11T22:07:13Z | 10 | 2026-10-11T21:42:36Z | 9000 | null | no | |
| TE1 | Test T1. Update `packages/shared/src/partNotesAndUnpricedTypes.test.ts`'s `'ListingSummary.hasUnpricedParts'` describe block (and its two tests) to cover the new `pricingStatus: PricingStatus` field instead: all three literal values are valid, an invalid string literal is rejected (`@ts-expect-error`), and omitting the key entirely is rejected (required, not optional) — same rigor as the tests it replaces. PASS: updated/new cases pass, shared package builds clean, no regression in the other existing shared tests. | tester | T1 | complete | 0 | | 2026-10-11T21:42:36Z | 2026-10-11T22:07:13Z | 15 | 2026-10-11T21:42:36Z | 26500 | null | no | |
| R2 | Review T2 against Req 2-5, 7-9, scoped to `apps/server/src/routes/listings.ts`. Confirm `computePricingStatus`'s four-way logic exactly matches Req 2-5 (test it by hand against a zero-parts list, an all-unpriced non-empty list, a genuinely mixed list, and an all-priced list); confirm both `toSummary` and `toDetail` call the same one helper (not two separate reimplementations); confirm `SORT_KEYS.unpriced`'s new ordinal mapping is `0`/`1`/`2` for `not_priced`/`partially_priced`/`fully_priced` respectively, verified against the real `Number(keyA) - Number(keyB)` ascending comparator so Req 7's stated order is what actually results, not its apparent opposite. PASS only if the ordinal-to-order mapping is traced through the real comparator code, not merely read as plausible. | reviewer | T2 | complete | 0 | | 2026-10-11T21:42:36Z | 2026-10-11T22:07:13Z | 15 | 2026-10-11T21:42:36Z | 10300 | null | no | |
| TE2 | Test T2. Rewrite `apps/server/test/listings.test.ts`'s existing "groups unpriced listings..." sort test (search for `sortBy=unpriced` / "Unpriced Mix" in that file) for the new three-bucket model: seed at least 2 listings per bucket (not_priced via a zero-parts listing AND via a nonzero-all-unpriced listing; partially_priced via a genuine mix; fully_priced via all-priced), scrambled relative to both bucket and `listingDate`, and prove ascending order groups all not_priced listings first, then all partially_priced, then all fully_priced (index-based, not a single-row spot check); prove descending is the exact reverse; prove it composes with pagination across a bucket boundary that falls mid-page, the same rigor the test it replaces already used for the two-bucket model. PASS: rewritten test passes, no regression in the rest of `listings.test.ts`'s sort suite (the other 7 columns). | tester | T2 | complete | 0 | | 2026-10-11T21:42:36Z | 2026-10-11T22:07:13Z | 30 | 2026-10-11T21:42:36Z | 52000 | null | no | apps/server/test/listings.test.ts |
| R3 | Review T3 against Req 6, scoped to `pricing-status-badge.tsx` and `listing-list.tsx`. Confirm the badge renders exactly one of the three correct labels for each of the three `PricingStatus` values, never blank; confirm the three pills are visually distinct from each other (three different color tokens, not two colors reused for three labels); confirm `listing-list.tsx`'s one call site passes `pricingStatus`, not the old `hasUnpricedParts` prop name. PASS only if the "Not Priced" pill's styling is confirmed genuinely distinct from both of the other two, not just a label change on a reused class string. | reviewer | T3 | complete | 0 | | 2026-10-11T21:42:36Z | 2026-10-11T22:07:13Z | 10 | 2026-10-11T21:42:36Z | 10300 | null | no | |
| TE3 | Test T3. Update `apps/web/test/listing-list.test.tsx`'s Pricing Status badge test (currently asserting "Partially Priced"/"Fully Priced" for `hasUnpricedParts: true`/`false`) to pass `pricingStatus` instead and add the third case: a listing with `pricingStatus: 'not_priced'` renders "Not Priced", distinct from the other two cases' text and (if feasible via computed style/class) visually distinct styling. PASS: updated/new cases pass, no regression in the rest of `listing-list.test.tsx`. | tester | T3 | complete | 0 | | 2026-10-11T21:42:36Z | 2026-10-11T22:07:13Z | 15 | 2026-10-11T21:42:36Z | 46700 | null | no | apps/web/test/listing-list.test.tsx |
| U0 | UAT pass over the whole feature (Req 1-9): start apps/server+apps/web in the worktree on isolated ports against the worktree's own isolated DuckDB file. Confirm a listing with zero Expected Parts shows "Not Priced" (the originally reported bug), confirm a listing whose Expected Parts exist but are all unpriced also shows "Not Priced", confirm a genuinely mixed listing shows "Partially Priced" and an all-priced listing shows "Fully Priced", confirm ascending sort groups Not Priced, then Partially Priced, then Fully Priced, confirm descending is the exact reverse, confirm sort composes with pagination across a bucket boundary. | uat | T1;T2;T3 | complete | 0 | | 2026-10-11T22:26:33Z | 2026-10-11T22:41:30Z | 20 | 2026-10-11T22:26:33Z | | 26000 | yes | |

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
- A4 (cycle 0, T1): `packages/shared/src/partNotesAndUnpricedTypes.test.ts` (in-scope within
  packages/shared) referenced the old `hasUnpricedParts` field in its header comment, describe
  block, and `@ts-expect-error` assertions; updated in place to `pricingStatus`/`PricingStatus`
  following the file's own existing type-proof convention, since this file lives in
  packages/shared rather than apps/server or apps/web.
- A5 (cycle 0, T2): Traced the real comparator used by `SORT_KEYS.unpriced` (the shared
  `Number(keyA) - Number(keyB)` ascending comparator with a `.reverse()` for descending, same as
  every other sort field) against the new ordinal mapping `{ not_priced: 0, partially_priced: 1,
  fully_priced: 2 }` and confirmed it is not reversed for this key — ascending sort does produce
  Req 7's stated order (Not Priced, then Partially Priced, then Fully Priced) without any
  comparator change.
- A6 (cycle 0, T3): No existing muted *pill* (rounded-full + border + bg + text, matching the
  sibling badge family's shape) exists anywhere in `apps/web/src` for the "Not Priced" state —
  `IdentifyPartsStatusBadge`'s own "no job yet" state is a bare muted `<span>`, not a pill. The new
  "Not Priced" pill was built using the sibling pill shape (`inline-flex items-center rounded-full
  border ... px-2 py-0.5 text-xs font-medium`) with the already-existing tokens `border-border`,
  `bg-muted`, `text-muted-foreground` (each used elsewhere, e.g. `info-banner.tsx`,
  `source-row.tsx`), giving three visually distinct colors (neutral grey / red / teal) rather than
  inventing new ones.
- A7 (cycle 0, R1/TE1/R2/TE2/R3/TE3): `actual_tokens` is recorded `null` for all six reviewer/tester
  rows. `measure-child-cost.py child-cost --tag <id>` requires a literal `AGENT_TAG: <id>` line
  inside the dispatched child's own transcript; this environment's task-dispatch tool has no
  parameter that embeds such a line into a child's prompt, so a direct grep of each child's own
  persisted `.jsonl` (e.g. `SparklingSheep/SparklingSheep.R2.jsonl`) found zero `AGENT_TAG` matches
  for five of the six. The sixth (R1) initially returned a non-null figure, but it was traced to a
  false match against this orchestrator's own top-level transcript (which contains that literal
  substring only because an earlier diagnostic `grep` command in this very investigation typed it)
  — not R1's real usage — so it was discarded as unmeasurable rather than recorded as a guess, per
  the explicit "never substitute a guess" instruction. Each row's `estimated_tokens` (the figure the
  agent itself reported) is recorded instead.

## Cycle Log

### Cycle 0
Trigger: initial
UAT: passed
UAT checks:
- Isolation: apps/server ran on isolated port 3101 against a fresh/empty DuckDB file; apps/web ran on isolated port 5273; confirmed no collision with the live main-checkout service on 3001/5173.
- Req 2 (zero Expected Parts -> Not Priced): created via the real browser form, confirmed live — the originally reported bug.
- Req 3 (non-empty but all unpriced -> Not Priced): created via the real browser form, confirmed live — the other reported gap.
- Req 4 (genuine mix -> Partially Priced): created via the real browser form, confirmed live.
- Req 5 (all priced -> Fully Priced): created via the real browser form, confirmed live.
- Req 6 (always exactly one of three labels, never blank): confirmed across 34 distinct listings total (4 primary + 30 bulk-seeded), both pages, both sort directions.
- Req 7 (ascending groups Not Priced, then Partially Priced, then Fully Priced): confirmed over the full 30-row concatenated ascending sequence across both pages — strictly non-decreasing by bucket.
- Req 8 (descending is the exact reverse): confirmed the full 30-row descending sequence is the byte-for-byte reverse of the ascending one.
- Req 9 (sort composes with pagination across a bucket boundary): confirmed a Partially Priced -> Fully Priced boundary fell strictly inside page 2 (its 5th row), proving the whole filtered set sorts before slicing.
- Req 1 (old field fully removed): grepped the whole apps/ and packages/ tree for hasUnpricedParts — zero matches.
- Standing check (suite + lint, cited from validate-lead's gate, not re-run): 944 vs baseline 943 (+1); one documented pre-existing failure plus confirmed-in-isolation environmental flakiness, neither a regression; lint clean.
- Standing check (doc comments): PricingStatus and PricingStatusBadgeProps both carry genuine explanatory comments.
- Standing check (import boundary): zero apps/web -> apps/server imports in any touched file.
- Standing check (no schema change): confirmed via direct read of migrate.ts — no new column or migration, pricingStatus computed at read time exactly as hasUnpricedParts was.
- Cleanup: both UAT dev servers stopped, temp DB and throwaway scripts removed, ports confirmed released, main-checkout live service never touched.
