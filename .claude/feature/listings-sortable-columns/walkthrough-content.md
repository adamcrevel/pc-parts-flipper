# Overview
The Listings table's 7 data-bearing column headers (Title, Source, Status, Asking Price, Expected
Resale, Difference, Identify Parts) are now click-to-sort: a click makes that column the single
active sort field (ascending), a second click on it flips to descending, and clicking a different
header replaces the field outright. Because the table is server-paginated, sorting had to reorder
the *whole filtered dataset* before the page is sliced — not just the 20 visible rows — so the
server fetches every matching Listing once, resolves each column's real displayed value (a
Source's name, not its id; the computed Expected Resale/Difference totals, not a stored price),
sorts, then slices the requested page. With no header ever clicked, the table's row order is
byte-for-byte unchanged from today.

## Shared sort vocabulary
Summary: One new pair of types defines the allow-list of sortable fields and directions, shared by
the server and the client so neither can drift from the other.
Tasks: T1
Files:
- packages/shared/src/listings.ts: adds `ListingSortField` (exactly the 7 sortable columns) and
  `ListingSortDirection` (`asc`/`desc`); the two excluded columns (checkbox-select, actions) are
  deliberately absent from the union, which is what makes "only one field, chosen from this list"
  a compile-time fact rather than a convention.

## Server-side sort across the whole filtered dataset
Summary: `GET /api/listings` gains optional `sortBy`/`sortDirection` query params. When absent,
the response is identical to today's; when present, the server fetches every filtered Listing in
one unpaginated call, resolves each column's real value (Source name, computed comparison totals),
sorts the full set, then slices out the requested page — so sorting and pagination compose
correctly across page boundaries.
Tasks: T2
Flow:
- Query params: `sortBy`/`sortDirection` parsed, unrecognized values ignored
- Fetch all filtered rows: one unpaginated `listListings` call via `limit: total`
- Resolve real values: Source name lookup, computed Expected Resale/Difference
- Sort & slice: stable sort, reverse for desc, slice the requested page
Files:
- apps/server/src/routes/listings.ts: adds the `SORT_KEYS` per-column extractor map and
  `listSortedListingsPage`, and wires the route handler to call it only when a valid `sortBy` is
  given, otherwise falling through to the original unsorted path untouched.
- apps/server/test/listings.test.ts: new `describe` block seeding Listings whose seven sortable
  values deliberately disagree with each other, proving each column sorts by its own real value
  (not another column as a stand-in), that direction reversal mirrors stable ties correctly, that
  an unrecognized `sortBy` reproduces the exact unsorted response, and that sorting is correct
  across a page boundary.

## Client wiring and sortable header UI
Summary: The Listings page tracks the active sort field/direction as its own state, threads it
through to the fetch call, and the table renders each sortable header as a button with a direction
arrow on whichever column is active.
Tasks: T3
Flow:
- Click a header: `onSortChange(field)` fires from `ListingList`
- Page decides: same field flips direction; a different field replaces it ascending, page resets to 1
- Refetch: `sortBy`/`sortDirection` included in the next `fetchListings` call
- Render: `SortableHeader` shows an arrow and `aria-sort` only on the active column
Files:
- apps/web/src/features/listings/listings-api.ts: `FetchListingsOptions` gains `sortBy`/
  `sortDirection`, included in the query string exactly like the existing filter/pagination params.
- apps/web/src/routes/listings-page.tsx: new `sortBy`/`sortDirection` state (both start
  `undefined`, preserving today's default order), a `handleSortChange` handler implementing the
  toggle/replace/reset-to-page-1 rule, and `filters` left untouched by it so a filter change never
  clears an active sort.
- apps/web/src/features/listings/listing-list.tsx: the 7 sortable `<th>` cells become
  `SortableHeader` buttons (via the new `SORTABLE_COLUMNS` list) that call `onSortChange` and show
  a lucide arrow only on the active column; the checkbox and actions columns are left as plain
  `<th>`s, never wrapped.
- apps/web/test/listing-list.test.tsx: exercises the header click/flip/replace behavior and the
  arrow/`aria-sort` indicator directly on `ListingList`.
- apps/web/test/listings-page.test.tsx: exercises the page-level behavior — sort change resets to
  page 1, a filter change leaves an active sort alone, and the fetch call actually carries the
  current sort params.
- apps/web/test/listings-api.test.ts: confirms `fetchListings` includes `sortBy`/`sortDirection` in
  the query string when set, and omits them when not.
- apps/web/test/bulk-identify-parts-ui.test.tsx: a necessary side effect of T3 — the "Identify
  Parts" column header is now itself a button carrying that same label, so this file's button
  lookup helper is rescoped to exclude the table header, otherwise it would match the always-present
  header button instead of the bulk-action bar's own, selection-gated one.
