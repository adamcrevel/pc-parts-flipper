# Feature: listings-column-rename-and-loading-state

Status: building
Cycle: 0 / 3
FeatureStarted: 2026-10-11T17:02:05Z
OrchestrationTokensActual: 36898
OrchestrationTokensBreakdown: input 0 + output 7,900 + cache-write 10,207 + cache-read 18,791, across 17 turns
Prototype: https://gist.githack.com/adamcrevel/32e4a3d5b242d4763c4e7ba11118d89e/raw/prototype.html
BaselineTests: 938
BaselineSuite: fail

## Goal

Three small, user-requested tweaks to the Listings table (`listing-list.tsx`/`listings-page.tsx`):

1. Rename three column headers: "Difference" -> "Expected Profit", "Identify Parts" -> "Sourcing
   Status", "Unpriced" -> "Pricing Status". Every rename is a display-label change only — the
   underlying `ListingSortField` identifiers (`difference`, `identifyParts`, `unpriced`) sent to the
   server and the values each column actually shows are unchanged.
2. The renamed "Pricing Status" column's cell, previously a binary "Unpriced" pill-or-nothing, now
   always carries one of two named values: "Fully Priced" (no unpriced Expected Part) or "Partially
   Priced" (at least one unpriced Expected Part) — the same underlying `hasUnpricedParts` boolean,
   given both of its states an explicit label instead of only the `true` case.
3. Clicking a sortable column header to change sort order currently leaves the table showing the
   previous (stale) data, unchanged, until the new page arrives — confirmed by the user: this has led
   to an accidental second click while the first request is still in flight. The table now enters a
   visible loading state for the duration of any user-triggered refetch (sort change, filter change,
   page change), and every sortable header is disabled for that same duration, so a second click
   cannot queue a redundant request.

## Requirements

1. The "Difference" column header is renamed to "Expected Profit". Its sort field identifier
   (`difference`), its computed value (`comparison.difference`), and its $ formatting/color coding
   are all unchanged.
2. The "Identify Parts" column header is renamed to "Sourcing Status". Its sort field identifier
   (`identifyParts`) and its per-stage badge values are unchanged. This rename is scoped to the
   Listings table's column header only — the separate "Identify Parts" action buttons elsewhere on
   the page (the per-row `IdentifyPartsButton`, the bulk-action bar's button) keep their existing
   wording; they are a different control for a different purpose that happens to share the same
   words today.
3. The "Unpriced" column header is renamed to "Pricing Status". Its sort field identifier
   (`unpriced`) and its underlying `hasUnpricedParts` boolean are unchanged.
4. The Pricing Status column's cell always renders one of two values, replacing the previous
   badge-or-nothing rendering: "Partially Priced" when `hasUnpricedParts` is `true`, "Fully Priced"
   when it is `false`.
5. Ascending sort on the Pricing Status column still lists every "Partially Priced" listing before
   every "Fully Priced" one (the existing, deliberately-inverted sort direction is unchanged by this
   relabeling).
6. While a `GET /api/listings` request triggered by a sort-header click, a filter change, or a page
   change is in flight, the Listings table visibly enters a loading state: its existing rows stay on
   screen (never replaced by a blank/spinner-only view) but are visually marked as stale until the
   new result lands.
7. While that loading state is active, every sortable column header is disabled (not clickable) —
   a click during this window has no effect, which is what stops the double-request the user
   described.
8. The background 2-second polling reload (while a visible row's identify-parts job is still
   non-terminal) does not trigger the Requirement 6/7 loading state — that reload is intentionally
   silent today, and nothing about this feature changes it, so the table does not flicker every 2
   seconds while a job is running.

## Standing Checks

- The whole test suite passes, and the test count holds at or above `BaselineTests` (938: 23 shared
  + 243 web + 672 server). `BaselineSuite` is recorded as `fail`: one pre-existing, reproducible
  failure (`apps/server/test/listingPhotos.test.ts`'s "stores an uploaded photo..." case, an `ENOENT`
  on a temp-dir photo path) was confirmed in this worktree before any change was made, running the
  file alone, twice, with the same result both times — not flaky, but also entirely unrelated to
  this feature's scope (photo upload, never touched here). This feature owes leaving the suite no
  worse than this inherited state, not repairing it.
- `npm run lint` runs clean with no new violation.
- Any new public function or component this feature adds or changes carries the same kind of
  header/block comment documentation already used elsewhere in the codebase.
- No new code in `apps/web` imports directly from `apps/server` — the existing
  `import/no-restricted-paths` boundary (`eslint.config.mjs`), checked by
  `apps/web/test/eslint-import-boundary.test.ts`, holds for every file this feature touches.

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| P0 | Prototype covering T1 (ui: yes): three column-header renames, the Pricing Status two-value badge, and the sort/filter/page-triggered loading state (dimmed table + disabled headers + spinner, excluding the silent background poll). | prototype | | complete | 0 | | 2026-10-11T17:02:30Z | 2026-10-11T17:17:17Z | 10 | 2026-10-11T17:02:30Z | | 10900 | yes | .claude/feature/listings-column-rename-and-loading-state/prototype-url.txt |
| T1 | Column renames, Pricing Status 2-value badge, and table loading state (Req 1-8). All in one task since the loading-state and header-label changes land in the same small region of the same file. `apps/web/src/features/listings/listing-list.tsx`: update `SORTABLE_COLUMNS`'s three `label` strings (`'Difference'` -> `'Expected Profit'`, `'Identify Parts'` -> `'Sourcing Status'`, `'Unpriced'` -> `'Pricing Status'`) — the `field` identifiers (`difference`/`identifyParts`/`unpriced`) are untouched. Add a new `isLoading?: boolean` prop to `ListingListProps`; thread it into every `<SortableHeader>` call (`isLoading={isLoading}`); inside `SortableHeader`, add `disabled={isLoading}` to its `<button>` plus a `disabled:cursor-not-allowed disabled:opacity-50` class so a disabled header reads as inert, not just non-functional. Add a small inline loading indicator when `isLoading` is true, reusing `LoadingSpinner`'s own spinner-glyph markup (`<span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />`) plus a `role="status"` text label (e.g. "Loading…"), positioned above or beside the table (not replacing it) so the existing rows stay visible underneath; also apply a `pointer-events-none opacity-60` (or equivalent) wrapper around the `<table>` itself while `isLoading` is true, so the stale rows read as visually inert, not just the headers. Rename `apps/web/src/features/listings/unpriced-parts-badge.tsx` to `pricing-status-badge.tsx`, renaming its component `UnpricedPartsBadge` to `PricingStatusBadge`: it always renders a pill now (never `null`) — "Partially Priced" using the exact destructive/red styling the old "Unpriced" pill used, "Fully Priced" using teal styling matching `IdentifyPartsStatusBadge`'s existing "completed"-stage pill (same rounded-full/border/bg/text pattern, teal color tokens) — update its doc comment to describe both states and the import in `listing-list.tsx` accordingly. `apps/web/src/routes/listings-page.tsx`: add `const [isLoadingListings, setIsLoadingListings] = useState(false);`; change `loadListings` to accept `(options?: { silent?: boolean })`, setting `isLoadingListings` to `true` at its start and back to `false` in a `finally` block, both skipped when `options?.silent` is `true`; the Requirement 8 polling effect's own `loadListings()` call becomes `loadListings({ silent: true })` — every other call site (the main filters/page/sort-driven effect, `handleCreateSaved`, `handleEditSaved`, `handleAccept`, `handleReject`) keeps calling `loadListings()` with no options, so they do show the loading state; pass `isLoading={isLoadingListings}` into `<ListingList>`. | builder | | not_started | 0 | | | | 40 | 2026-10-11T17:17:17Z | | | yes | |
| R1 | Review T1 against Req 1-8, scoped to `listing-list.tsx`, `pricing-status-badge.tsx`, and `listings-page.tsx`. Confirm: the three `SORTABLE_COLUMNS` labels are renamed exactly as specified and nothing else in that array changed; `field` identifiers are untouched (grep the shared `ListingSortField` type and the server's `SORT_KEYS` to confirm neither was touched, since this is a label-only change); the Pricing Status cell always renders one of the two new labels, never blank and never the old "Unpriced" text; `isLoading` disables every sortable header's `<button>` (not just visually, the `disabled` attribute itself) and is NOT wired into the Requirement 8 silent polling path; `loadListings`'s `silent` option is honored exactly once, at exactly the one call site named in T1's description, and every other call site still shows the loading state. PASS only if the polling-silence behavior is confirmed by reading the actual polling effect's call, not inferred from the description. | reviewer | T1 | not_started | 0 | | | | 15 | | | | no | |
| TE1 | Test T1. Update `apps/web/test/listing-list.test.tsx`'s `SORTABLE_LABELS` array and every `headerButton(el, 'Difference'/'Identify Parts'/'Unpriced')` call to the new labels; update its "ListingList Unpriced column badge" describe block's two assertions (`'Unpriced'`/`''` text) to `'Partially Priced'`/`'Fully Priced'`. Update `apps/web/test/listings-page.test.tsx`'s `clickHeader(el, 'Difference')`/`findButton(el, 'Difference')` calls to `'Expected Profit'`. Add new cases: clicking a sortable header while `isLoading` is true does not fire `onSortChange` (button is disabled); the loading indicator renders when `isLoading` is true and not when `false`; the existing table rows remain present (not unmounted) while `isLoading` is true. In `listings-page.test.tsx`, add a case proving the table shows the loading state while a sort-triggered `fetchListings` call is pending and clears it once the call resolves, and a separate case proving the 2-second polling reload (Req 8) does NOT toggle it. Check `apps/web/test/bulk-identify-parts-ui.test.tsx` and `apps/web/test/ebay-scan-ui.test.tsx` still pass unmodified (both reference "Identify Parts" text, but for the unrelated action button/a test description, not the renamed column header) — update either only if an actual run shows it broke, not preemptively. PASS: every updated/new case passes, no regression in the existing suites. | tester | T1 | not_started | 0 | | | | 30 | | | | no | |

## Assumptions

- A1 (cycle 0): The three column renames are display-label changes only — the underlying
  `ListingSortField` wire identifiers (`difference`, `identifyParts`, `unpriced`) are unchanged,
  avoiding any server-side change, API change, or re-test of sort semantics already proven correct.
- A2 (cycle 0): "Identify Parts" -> "Sourcing Status" is scoped to the Listings table's column
  header alone. The per-row and bulk-action "Identify Parts" buttons elsewhere on the page are a
  different control (they trigger the action; the column describes its status) that happens to
  share the same two words today, and keep their existing wording — not mentioned by the user's
  request, which named "columns" specifically.
- A3 (cycle 0): "Pricing Status" replaces the previous single-state "Unpriced" badge with exactly
  two named values — "Fully Priced" and "Partially Priced" — mapped directly onto the existing
  `hasUnpricedParts` boolean (`true` -> Partially Priced, `false` -> Fully Priced). No third state is
  introduced (e.g. for "every part still unpriced" vs. "some priced, some not") since the user named
  exactly two new values and the existing data model is already binary; a listing with zero priced
  parts is labeled "Partially Priced" the same as a listing with some-but-not-all priced, consistent
  with the existing ascending-sort grouping (both are `hasUnpricedParts: true`).
- A4 (cycle 0): The Requirement 6/7 loading state applies to every user-triggered refetch (sort
  change, filter change, page change, create/edit save, accept/reject) but deliberately excludes the
  existing silent 2-second identify-parts-status polling reload, so as not to introduce a new
  flicker on an existing, already-working feature the user did not ask to change. The user's own
  request named sort clicks specifically; this reads it as the general "the table is fetching"
  state the request implies, while carving out the one case where flashing a loading state would be
  a new regression rather than the requested fix.
- A5 (cycle 0): `BaselineSuite` is recorded `fail` for one inherited, unrelated,
  reproducibly-failing test (`listingPhotos.test.ts`, confirmed failing in isolation twice before
  any change in this worktree) — out of scope for this feature, not something it owes a fix for.

## Cycle Log

### Cycle 0
Trigger: initial
UAT: not_run
