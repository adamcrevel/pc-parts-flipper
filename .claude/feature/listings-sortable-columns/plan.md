# Feature: listings-sortable-columns

Status: building
Cycle: 0 / 3
FeatureStarted: 2026-10-10T06:31:12Z
OrchestrationTokensActual: 86310
OrchestrationTokensBreakdown: input 0 + output 10,471 + cache-write 23,169 + cache-read 52,670, across 46 turns
Prototype: https://gist.githack.com/adamcrevel/867fced113ae376421e9e58a1bbdf6f7/raw/prototype.html
BaselineTests: 878
BaselineSuite: pass

## Goal

The Listings page's table (`ListingList`/`listings-page.tsx`) gains click-to-sort column headers.
Clicking a column header's label sorts the table by that field; clicking the same header again
reverses direction; clicking a different header replaces the active sort field entirely (never
combines two fields). Confirmed with the user: sorting applies across the **whole filtered
dataset**, not just the 20 rows on the current page — the table is server-paginated, so a correct
"cheapest first" or "oldest first" sort has to reorder every matching Listing, not just whichever
page happens to be open, the same way the existing status/Source filters already operate across
the whole dataset rather than the current page.

Of the table's 9 columns, 7 carry a real, comparable value and become sortable: Title, Source,
Status, Asking Price, Expected Resale, Difference, Identify Parts. The leading checkbox-selection
column and the trailing Accept/Reject actions column carry no comparable field and stay unsortable.
Two of the seven (Expected Resale, Difference) are values computed server-side per Listing (a sum
over that Listing's Expected Parts, confirmed by reading `routes/listings.ts`'s `computeComparison`)
rather than plain stored columns, and Source's displayed value is its *name*, looked up from
`sourceId` — all three need their real resolved value as the sort key, not a raw id or an
unrelated proxy (Requirement 6).

## Requirements

1. Each of the 7 data-bearing column headers (Title, Source, Status, Asking Price, Expected
   Resale, Difference, Identify Parts) is clickable and sorts the table by that field.
2. Clicking a column header that is not the currently active sort field makes it the active sort
   field, ascending.
3. Clicking the currently active sort column's header again reverses its direction (ascending ->
   descending, descending -> ascending).
4. Only one field is ever sorted by at a time. Clicking a different column replaces the active
   sort field outright (starting ascending, per Requirement 2) — it never combines with whatever
   was active before.
5. The currently active sort column and its direction are visually indicated on that column's own
   header (e.g. a directional arrow), distinct from every other header.
6. Sorting a column whose displayed value is derived, not a raw stored field, sorts by that real
   displayed value: Source sorts by the Source's name (not its internal id); Expected Resale and
   Difference sort by their actual computed numeric values (not, e.g., Asking Price as a stand-in).
7. Changing the active sort field or its direction resets the current page back to 1, the same
   way changing a status/Source filter already does today.
8. Sorting composes with the existing status/Source filters and with pagination: the sorted,
   filtered dataset is what gets paginated. Changing a filter does not silently clear or reset
   whichever sort is currently active.
9. With no sort ever applied (a fresh page load, before any header has been clicked), the table's
   row order is unchanged from today's default (newest `listingDate` first) — this feature adds a
   new ordering option, it does not change the existing default.
10. The leading checkbox-selection column and the trailing Accept/Reject actions column are not
    sortable — neither carries a value that could be compared.

## Standing Checks

- The whole test suite passes, and the test count stays at or above `BaselineTests` (878).
- `npm run lint` runs clean with no new violation.
- Any new public function or component this feature adds carries the same kind of header/block
  comment documentation already used elsewhere in the codebase, explaining its purpose and flow,
  not just a one-line label.
- No new code in `apps/web` imports directly from `apps/server` — the existing
  `import/no-restricted-paths` boundary (`eslint.config.mjs`), checked by
  `apps/web/test/eslint-import-boundary.test.ts`, holds for every file this feature adds or
  touches.
- No `ALTER COLUMN`/`DROP COLUMN`/`ADD CONSTRAINT`, and no new DB schema at all — this feature
  needs no new column or table; every sortable value is already present on each Listing's existing
  response shape.

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| P0 | Prototype for the sortable column headers (Req 1-6, 10): clickable header, direction toggle, single-active-field replacement, active-column arrow indicator. | prototype | | complete | 0 | | 2026-10-10T06:39:08Z | 2026-10-10T06:47:43Z | 15 | 2026-10-10T06:39:08Z | | null | yes | .claude/feature/listings-sortable-columns/prototype.html |
| T1 | Shared sort types (Req 1-4). `packages/shared/src/listings.ts`: new exported `export type ListingSortField = 'title' \| 'source' \| 'status' \| 'askingPrice' \| 'expectedResale' \| 'difference' \| 'identifyParts';` and `export type ListingSortDirection = 'asc' \| 'desc';` — the full allow-list of sortable fields (Req 10's two excluded columns are deliberately absent from this union) plus the two-value direction. No other shared type changes: `ListListingsResponse`/`ListingSummary`'s response shape is unchanged — only the request side (query params, added in T2/T3) is new. Both new types get doc comments explaining what each value maps to on the table and why the two non-comparable columns are excluded. | builder | | complete | 0 | | 2026-10-10T07:00:41Z | 2026-10-10T07:20:00Z | 15 | 2026-10-10T06:59:41Z | | null | no | packages/shared/src/listings.ts |
| T2 | Server-side sort support for `GET /api/listings` (Req 1, 6, 7, 8, 9). `apps/server/src/routes/listings.ts`: parse new optional `sortBy`/`sortDirection` query params, validated against T1's `ListingSortField`/`ListingSortDirection` unions (an unrecognized value is ignored — no sort applied — matching this handler's existing loose-GET-validation convention for `status`). When `sortBy` is absent, behavior is byte-for-byte unchanged from today (the existing `listListings`/`countListings` SQL-level `LIMIT`/`OFFSET` pagination path, default `ORDER BY listing_date DESC, id ASC`) — Req 9. When `sortBy` is present: fetch `total` via the existing `countListings` call, then fetch *every* matching Listing in one call via the existing `listListings({ status, sourceId, limit: total, offset: 0 })` (reusing it exactly as-is, no signature change — passing `total` as `limit` turns off real pagination for this one fetch), enrich every row via the existing, unchanged `toSummary`, resolve the Source id -> name map via the existing `listSources()` query only when `sortBy === 'source'` (skipped otherwise, no wasted query), sort the full enriched `ListingSummary[]` array with a comparator switched on `sortBy` (title: `localeCompare`; source: resolved name via the map, `localeCompare`; status: `localeCompare`; askingPrice/expectedResale/difference: numeric subtraction on `askingPrice`/`comparison.totalExpectedResaleValue`/`comparison.difference`; identifyParts: `localeCompare` on `identifyPartsStatus?.stage ?? ''`, so a Listing with no job at all sorts as if its stage were the empty string), reversed when `sortDirection === 'desc'` (default `'asc'` when `sortBy` is given without a direction), then slice `[offsetValue, offsetValue + limitValue]` for the actual page returned. JS's `Array.prototype.sort` is stable (ES2019+), so ties within one sort field keep their pre-sort relative order (`listListings`'s own `listing_date DESC, id ASC`) without needing an explicit secondary sort key — document this reasoning in a comment rather than leaving it implicit. Add tests to `apps/server/test/listings.test.ts` covering each of the 7 sort fields (including the Source-name and computed-comparison cases specifically, Req 6), direction reversal, an unrecognized `sortBy` being ignored, and that omitting `sortBy` entirely reproduces today's exact default-order response. | builder | T1 | complete | 0 | | 2026-10-10T07:14:41Z | 2026-10-10T08:01:59Z | 40 | 2026-10-10T07:14:41Z | | null | no | apps/server/src/routes/listings.ts, apps/server/test/listings.test.ts
| T3 | Client wiring and sortable header UI (Req 1-5, 7, 8, 10). `apps/web/src/features/listings/listings-api.ts`: `FetchListingsOptions` gains `sortBy?: ListingSortField` / `sortDirection?: ListingSortDirection`; `fetchListings` includes both in the query string when present, matching the existing `status`/`sourceId`/`limit`/`offset` pattern exactly. `apps/web/src/routes/listings-page.tsx`: new `sortBy`/`sortDirection` state (both start `undefined` — Req 9's unsorted default), included in `loadListings`'s `fetchListings` call and its dependency array (so the polling-while-pending effect and the filter-driven reload both carry the current sort); a new `handleSortChange(field: ListingSortField)` handler — if `field` is already the active `sortBy`, flips `sortDirection`; otherwise sets `sortBy` to `field` and `sortDirection` to `'asc'` (Req 2-4) — and resets `page` to 1 either way (Req 7), mirroring `handleFiltersChange`'s own existing `setPage(1)` call. Changing `filters` must not reset `sortBy`/`sortDirection` (Req 8) — confirm by reading `handleFiltersChange` doesn't touch them. `apps/web/src/features/listings/listing-list.tsx`: the 7 sortable `<th>` cells (Req 10's 2 excluded ones stay plain) become clickable buttons calling a new `onSortChange: (field: ListingSortField) => void` prop threaded down from the page, each rendering a small directional arrow (e.g. an existing lucide icon already imported elsewhere in this codebase, matching this table's own `Image` icon usage) only when that column is the active `sortBy`, pointing per the active `sortDirection` (Req 5). Add/extend tests in a `listing-list.test.tsx` (new, if one does not already exist — check first) or the page's own existing test file covering: clicking an inactive header sets it active+ascending; clicking the active header flips direction; clicking a different header replaces the field entirely rather than combining; the arrow indicator renders only on the active column; a filter change does not clear an active sort. | builder | T1 | complete | 0 | | 2026-10-10T07:54:41Z | 2026-10-10T08:01:59Z | 35 | 2026-10-10T07:54:41Z | | null | yes | apps/web/src/features/listings/listings-api.ts, apps/web/src/routes/listings-page.tsx, apps/web/src/features/listings/listing-list.tsx
| R1 | Review T1 (shared sort types in `packages/shared/src/listings.ts`) against Req 1, 4, 10 as scoped to this file: `ListingSortField`/`ListingSortDirection` name exactly the 7 sortable columns and no others, the union's scalar (non-array) shape is what makes "only one field ever sorted" structurally true, and the 2 non-comparable columns (checkbox-select, actions) are deliberately absent. Also check the Standing Checks' doc-comment requirement for both new exported types. PASS: `ListingSortField` is exactly the 7 data-bearing columns, `ListingSortDirection` is exactly `asc`/`desc`, neither excluded column appears, both types carry full doc comments, and no other shared type was touched by this commit. | reviewer | T1 | complete | 0 | | 2026-10-10T08:03:51Z | 2026-10-10T08:23:12Z | 10 | 2026-10-10T08:03:51Z | 5700 | null | no |  |
| TE1 | Test T1 (shared sort types in `packages/shared/src/listings.ts`). Confirm (via typecheck/compile-level checks, since this file is type-only) that `ListingSortField` contains exactly `title \| source \| status \| askingPrice \| expectedResale \| difference \| identifyParts`, that `ListingSortDirection` is exactly `asc \| desc`, and that downstream consumers (T2's `SORT_KEYS` Record, T3's `SORTABLE_COLUMNS`) fail to compile if a field is added to or removed from the union without a matching update — i.e. the exhaustiveness guarantee actually holds. PASS: shared package builds clean; both unions verified exact; mutation-proved removing a field breaks both T2's Record and T3's array (TS2353/TS2322); adding an unused field is only caught by T2's Record, not T3's plain array — a structural TS asymmetry, not a defect, since both are in sync today. | tester | T1 | complete | 0 | | 2026-10-10T08:03:51Z | 2026-10-10T08:23:12Z | 10 | 2026-10-10T08:03:51Z | 16000 | null | no |  |
| R2 | Review T2 (`apps/server/src/routes/listings.ts`, `apps/server/test/listings.test.ts`) against Req 1, 6, 8 (the filtered-dataset-is-what-gets-paginated clause), 9 as scoped to this file. Specifically confirm: the `sortBy`-absent path (lines ~296-306) is genuinely byte-for-byte identical in actual DB query/response shape to the pre-feature code (diff against commit f872984); `source` sorts by the resolved Source *name* via `listSources()`, never `sourceId`; `expectedResale`/`difference` sort by `comparison.totalExpectedResaleValue`/`comparison.difference`, never a raw stored field; direction reversal (`summaries.reverse()` for `'desc'`) is correct and keeps stability ties mirrored; sorting happens across the whole filtered dataset (via `limit: total`) before the page is sliced, never just the fetched page; an unrecognized `sortBy` falls through to the unsorted path unchanged. FAIL: all 7 behavioral checks (a)-(g) confirmed correct by direct diff/reading, including byte-for-byte unsorted-path equality and Source-name/computed-value sort keys. Sole finding: GET /api/listings' handler complexity measures 12 under a reviewer-invoked, non-project ESLint `complexity` rule (not wired into `eslint.config.mjs`, no Standing Check names one) — overruled by feature-validate-lead as a non-blocking style recommendation, not a must_fix, consistent with this project's repeated precedent (consolidate-listings-views, listing-open-link-source-readonly, part-price-estimation) that an unconfigured complexity metric is never must_fix without a concrete correctness/safety defect attached to it. | reviewer | T2 | complete | 0 | | 2026-10-10T08:03:51Z | 2026-10-10T08:23:12Z | 15 | 2026-10-10T08:03:51Z | 9600 | null | no |  |
| TE2 | Test T2 (`apps/server/src/routes/listings.ts`). Run the existing `apps/server/test/listings.test.ts` sort suite and confirm every case genuinely exercises its claimed behavior (not just passing by coincidence): the Source-name test's Source names must not share the id-based or creation-order order; the computed-column tests' values must disagree with every other column's order; the stable-tie test must land on a real tie. Add any case missing: in particular, confirm a request with `sortDirection` but no `sortBy` is still byte-for-byte the unsorted default response, and confirm `total` from a sorted request matches `total` from the equivalent unsorted request. PASS: 10/10 sort tests pass; independently re-ran the real Source/comparison seed data (not just trusted the comments) and confirmed genuinely distinct orderings; found and closed one real gap (direction reversal never tested against a genuine tie) with one new mutation-proven test. | tester | T2 | complete | 0 | | 2026-10-10T08:03:51Z | 2026-10-10T08:23:12Z | 15 | 2026-10-10T08:03:51Z | 62000 | null | no | apps/server/test/listings.test.ts
| R3 | Review T3 (`apps/web/src/features/listings/listings-api.ts`, `listings-page.tsx`, `listing-list.tsx`) against Req 1-5, 7, 8 (the filter-change-does-not-clear-sort clause), 9 (client sends no `sortBy`/`sortDirection` by default), 10 as scoped to this file. Specifically confirm: `handleSortChange` starts a newly-clicked field ascending and flips direction (asc<->desc) on a re-click of the active field, never combining two fields; `setPage(1)` fires on every sort change; `handleFiltersChange` never touches `sortBy`/`sortDirection`; `SortableHeader`'s arrow renders only on the active column, pointing per direction, with correct `aria-sort`; the checkbox and actions `<th>` cells are never wrapped in `SortableHeader`. Also confirm the `apps/web/test/bulk-identify-parts-ui.test.tsx` changes (scoping `queryButton` to exclude `thead`) are a correct, necessary consequence of the new header button sharing the "Identify Parts" label, and note that this file is a real consequence of T3 not listed in T3's `files_touched`. FAIL: all 5 behavioral checks (a)-(e) confirmed correct, and the bulk-identify-parts-ui.test.tsx thead-scoping fix confirmed correct and necessary. Sole blocking finding: ListingsPage's complexity measures 12 under the same non-project rule as R2, but — unlike T2 — unchanged from its pre-T3 value (confirmed by running the identical check against f872984), i.e. pre-existing debt T3 did not introduce; overruled by feature-validate-lead for the same reason as R2. Two minor, non-blocking notes: bulk-identify-parts-ui.test.tsx is a real T3 consequence missing from T3's `files_touched`; one new test assertion (the `options` sort-key-filter check) is structurally tautological given the production call site's static object shape. | reviewer | T3 | complete | 0 | | 2026-10-10T08:03:51Z | 2026-10-10T08:23:12Z | 15 | 2026-10-10T08:03:51Z | 24000 | null | no |  |
| TE3 | Test T3 (`apps/web/src/features/listings/listings-api.ts`, `listings-page.tsx`, `listing-list.tsx`). Run `apps/web/test/listing-list.test.tsx`, `apps/web/test/listings-page.test.tsx`, `apps/web/test/listings-api.test.ts`, and `apps/web/test/bulk-identify-parts-ui.test.tsx`, confirming each sort-related case genuinely exercises its claimed behavior: page-reset-on-sort-change actually reads `offset: 0` in the next fetch call, not just the visible page number; sort-survives-filter-change actually reads the unchanged `sortBy`/`sortDirection` in the post-filter-change fetch call, not just the header's arrow. Add any missing case. PASS: all 38 targeted tests (4 files) pass; confirmed both Req 7/Req 8 assertions already read the real fetch-call parameters, not just rendered text, and mutation-proved both by breaking each behavior in turn and confirming the right test — and only that test — failed; no gap found, nothing added. | tester | T3 | complete | 0 | | 2026-10-10T08:03:51Z | 2026-10-10T08:23:12Z | 15 | 2026-10-10T08:03:51Z | 20000 | null | no |  |

## Assumptions

- A1 (cycle 0): Confirmed directly with the user — sorting applies across the whole filtered
  dataset (server-side), not just the current page's visible rows.
- A2 (cycle 0): When `sortBy` is active, T2 fetches every matching Listing in one unpaginated
  query (`listListings` called with `limit: total`) rather than writing per-field SQL `ORDER BY`
  clauses (including correlated subqueries for the two computed columns and the Source-name join).
  At this project's current scale (185 Listings total, confirmed this session), fetching the full
  filtered set and sorting/paginating in application code is simpler and no less correct than
  database-level sorting, and reuses the existing, already-tested `toSummary`/`computeComparison`
  enrichment untouched rather than duplicating that logic into SQL. Revisit only if the real
  dataset size grows enough for this to matter, which is not the case today.
- A3 (cycle 0): A Listing with no identify-parts job at all (`identifyPartsStatus: null`) sorts,
  when sorting by Identify Parts, as if its stage were an empty string — placing every such row
  together at one end, ascending or descending, rather than scattering them. No other ordering
  within that group is specified beyond the stable-sort tie-breaking A4 already covers.
- A4 (cycle 0): Ties within one sort field (e.g. two Listings with the same Status) keep their
  relative order from `listListings`'s own existing default ordering (`listing_date DESC, id ASC`)
  rather than an explicit secondary sort key, relying on `Array.prototype.sort`'s ES2019+ stability
  guarantee — deterministic, but not a requirement the user asked for explicitly, so flagged here
  rather than assumed silently.
- A5 (cycle 0): R2 and R3 each flagged a FAIL on cyclomatic complexity (GET /api/listings'
  handler at 12, ListingsPage at 12) measured with a reviewer-invoked ESLint `complexity` rule
  that is not wired into this project's real `eslint.config.mjs` and is not named by any
  Requirement or Standing Check here. feature-validate-lead overruled both as non-blocking style
  recommendations rather than must_fix: neither names a correctness/safety defect with a concrete
  failure case (both reviewers independently confirmed every behavioral requirement correct), and
  this exact judgment — an un-configured complexity metric is never must_fix on its own — has been
  applied consistently across this project's prior features (consolidate-listings-views,
  listing-open-link-source-readonly, part-price-estimation), including one prior case scoring
  these same two files at the same complexity (12) under the same throwaway rule. T2's increase
  (7->12, caused by this diff) and T3's (12, confirmed unchanged from pre-T3) are both recorded as
  recommendations only, not actioned.

## Cycle Log

### Cycle 0
Trigger: initial
UAT: not_run
