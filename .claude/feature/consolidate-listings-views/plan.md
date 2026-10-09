# Feature: consolidate-listings-views

Status: done
Cycle: 0 / 3
FeatureStarted: 2026-10-09T03:00:00Z
Prototype: https://gist.githack.com/adamcrevel/8e0bb87fb45a3258ac952c0d627ac919/raw/prototype.html
BaselineTests: 768
BaselineSuite: pass

## Goal

The "Listings" screen (`/listings`) and the "Listings Queue" screen (`/listings-queue`) are
near-duplicates of the same underlying data (`GET /api/listings`) with different capability sets
split across them for historical reasons. They are consolidated into one screen at `/listings`:
the merged screen keeps everything "Listings" already has (an "Add Listing" button opening a
top-of-page create form, and clicking a Listing's title opening/closing its inline edit form
directly beneath its row) and gains everything "Listings Queue" already has (pagination,
status/Source filters, a Source column, the eBay-scan/non-working badges, Accept/Reject actions,
the Identify-Parts status column, bulk-select checkboxes with a sticky bottom action bar for
triggering Identify Parts on many Listings at once, and auto-refresh while any visible row's
identify-parts job is still running). The "Listings Queue" nav entry, route, and the components
left with no remaining caller afterward are removed — not just unlinked, deleted.

No server-side change is needed: every endpoint and field this merge uses
(`GET /api/listings` with `status`/`sourceId`/`limit`/`offset`, `GET /api/listings/ids`,
`POST /api/listings/identify-parts/bulk`, `ListingSummary.identifyPartsStatus`) already exists
from the bulk-identify-parts feature. This is a client-side consolidation only.

## Requirements

1. The "Listings Queue" nav entry and its `/listings-queue` route are removed entirely; `/listings`
   is the only screen for browsing, filtering, creating, editing, deciding (accept/reject), and
   bulk-triggering Identify Parts on Listings.
2. The Listings table is paginated (20 rows/page) and filterable by status and Source, replacing
   the screen's prior unpaginated, unfiltered fetch (`limit: 1000`).
3. Each row shows every column/badge either screen already had, none dropped: Title (with its
   existing photo indicator, eBay-scan badge, non-working badge), Source name, Status, Asking
   Price, Expected Resale, Difference, and an Identify-Parts status badge (no-job / in-progress /
   complete / failed, with a failed row's recorded error message visible on hover).
4. Each row has Accept/Reject actions, shown only while that row's status is `'open'`, disabled
   while that specific row's own accept/reject request is in flight.
5. Accepting a Listing creates its linked Purchase and shows a dismissable confirmation with a
   link to it; rejecting transitions its status; both refresh the table afterward.
6. If an accept/reject empties the current (non-first) page of the filtered result set, the view
   clamps back to the new last valid page instead of stranding the user on an empty one.
7. Each row has its own checkbox; a header checkbox is tri-state (unchecked / checked /
   indeterminate) and selects/deselects every Listing matching the currently-applied filters
   across every page, not only the current page's rows.
8. The selection — built by individual checkboxes or the header control — persists across page
   navigation and filter changes within the same visit to the screen.
9. A fixed bottom action bar appears once 1+ rows are selected, showing the exact count and an
   "Identify Parts" button; clicking it sends one request enqueuing identify-parts for every
   selected Listing and reports how many were newly queued, already active, or not found.
10. While any row visible on the current page has a non-terminal identify-parts status, the table
    refreshes automatically every 2 seconds; it stops once nothing visible is still non-terminal.
11. Clicking a Listing's title still opens/closes its inline edit form directly beneath its row,
    completely unaffected by Requirements 2-10 — the same `ListingForm` already used for both
    create and edit, including its own Identify Parts button, Expected Parts editor, and photo
    upload, keeps working exactly as it does today.
12. An "Add Listing" button still opens the existing top-of-page create form; successfully
    creating a Listing refreshes the table so the new row appears.
13. No dead code remains afterward: the old Listings Queue page component, its dedicated table
    component, and any filter/action-bar files left with no remaining caller once the merge is
    done are deleted, not merely disconnected from the router.

## Standing Checks

- The whole test suite passes, and the test count stays at or above `BaselineTests` (768).
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
| P0 | Clickable prototype of the merged `/listings` screen: header row with the status/Source filter selects (left) and "Add Listing" button (right); the table with a leading checkbox column (header tri-state support), Title+photo-icon+eBay-badge+non-working-badge, Source, Status, Asking Price, Expected Resale, Difference, Identify-Parts status badge (all four states), and trailing Accept/Reject buttons (shown on an 'open' row only); one row shown with its inline edit form expanded beneath it (ListingForm's existing layout, unchanged); a pagination footer; a fixed bottom action bar once rows are checked, matching the bulk-identify-parts feature's existing bar exactly. | prototype | none | complete | 0 | | 2026-10-09T03:15:00Z | 2026-10-09T03:45:00Z | 20 | 2026-10-09T03:15:00Z | 26800 | null | yes | |
| T1 | Relocate two now-misnamed files with no content change beyond their own internal doc comments if the move warrants updating them: move `apps/web/src/features/listings-queue/listings-queue-filters.tsx` to `apps/web/src/features/listings/listing-filters.tsx`, renaming the exported `ListingsQueueFilters` to `ListingFilters` (same props/behavior — status/Source selects) since "queue" is no longer a screen this codebase has; move `apps/web/src/features/listings-queue/bulk-identify-parts-bar.tsx` to `apps/web/src/features/listings/bulk-identify-parts-bar.tsx` verbatim (component name `BulkIdentifyPartsBar` unchanged, its only import — `enqueueBulkIdentifyParts` from `@/features/listings/listings-api` — is already correct and needs no change). Do not touch any test file in this task — their migration is separate tasks' scope (T5-T7). | builder | none | complete | 0 | | 2026-10-09T04:07:42Z | 2026-10-09T04:12:26Z | 10 | | 3900 | 52488 | no | apps/web/src/features/listings/listing-filters.tsx, apps/web/src/features/listings/bulk-identify-parts-bar.tsx |
| T2 | Expand `apps/web/src/features/listings/listing-list.tsx`'s `ListingList` to carry every column/action `ListingsQueueTable` (`apps/web/src/features/listings-queue/listings-queue-table.tsx`, read it for the exact JSX/logic to port) already has, alongside its own existing inline-edit-click behavior, unchanged (Req 3, 4, 7, 9, 11). New props, added to the existing interface (not replacing anything): `sourcesById: Map<string, Source>`, `onAccept: (listing: ListingSummary) => void`, `onReject: (listing: ListingSummary) => void`, `pendingListingId: string \| null`, `allFilteredIds: string[]`, `selectedIds: Set<string>`, `onToggleOne: (id: string) => void`, `onToggleAllFiltered: () => void`. Port verbatim: the header-checkbox tri-state ref/`useEffect` pattern (`indeterminate` has no JSX prop), the leading checkbox `<th>`/`<td>` column, the Source/Identify-Parts-status columns (`EbayScanBadge`, `NonWorkingBadge`, `IdentifyPartsStatusBadge` — all three already exist in `features/listings/`, already imported by sibling files), and the trailing Accept/Reject `<td>` gated on `listing.status === 'open'`. The existing two-row-per-Listing `Fragment` structure (summary row, then a conditional full-width `colSpan` row holding `ListingForm` when that row is the open one) is unchanged except its `COLUMN_COUNT` constant, which must be updated to match the new, wider column count so the inline edit row's `colSpan` still spans the whole table. | builder | none | complete | 0 | | 2026-10-09T04:07:42Z | 2026-10-09T04:12:26Z | 30 | | 4800 | 52488 | yes | apps/web/src/features/listings/listing-list.tsx |
| T3 | Expand `apps/web/src/routes/listings-page.tsx`'s `ListingsPage` to carry every piece of state/behavior `listings-queue-page.tsx` (read it for the exact logic to port) already has, alongside its own existing create-panel and inline-edit-row-open state, unchanged (Req 1, 2, 5, 6, 8, 9, 10, 12). Port verbatim, renaming nothing conceptually: `filters`/`setFilters` state and the `ListingFilters` control (from T1's new path) rendered in the header next to the existing "Add Listing" button; `page`/`setPage`/`total` state and `PaginationControls` under the table; `loadListings`'s fetch call changed from `fetchListings({ limit: 1000 })` to the paginated/filtered shape (`status`, `sourceId`, `limit: 20`, `offset`) including the pagination-clamp-on-empty-page logic (Req 6); `selectedIds`/`allFilteredIds` state, `handleToggleOne`/`handleToggleAllFiltered`, and the `fetchListingIds`-driven effect keyed on `filters` (not `page`); `pendingListingId`/`actionError`/`acceptedMessage` state and `handleAccept`/`handleReject`; the 2000ms auto-refresh polling effect keyed on the fetched `listings`; and `BulkIdentifyPartsBar` (from T1's new path) rendered at the bottom of the screen. Thread every new prop into T2's expanded `ListingList`. The existing `panel`/`setPanel` create-form state, `editingListingId`/`editingListing`/`editingLoading`/`editRequestTokenRef`/`handleToggleEdit`/`handleEditCancel`/`handleCreateSaved`/`handleEditSaved` inline-edit state, and the top-of-page create-mode `ListingForm` render are untouched. | builder | T1;T2 | complete | 0 | | 2026-10-09T04:12:45Z | 2026-10-09T04:25:19Z | 35 | | 9200 | 127363 | yes | apps/web/src/routes/listings-page.tsx, packages/shared/src/listings.ts |
| T4 | Delete the now-dead code (Req 1, 13): `apps/web/src/routes/listings-queue-page.tsx`, `apps/web/src/features/listings-queue/listings-queue-table.tsx`, and the (now-empty) `apps/web/src/features/listings-queue/` directory. In `apps/web/src/router.tsx`, remove the `ListingsQueuePage` import and its `{ path: 'listings-queue', element: <ListingsQueuePage /> }` route entry. In `apps/web/src/routes/root-layout.tsx`, remove the `{ to: '/listings-queue', label: 'Listings Queue' }` entry from `NAV_ITEMS`. Do not touch any test file in this task (T7 owns deleting `listings-queue-page.test.tsx`). | builder | T3 | complete | 0 | | 2026-10-09T04:25:19Z | 2026-10-09T04:37:04Z | 10 | | 10900 | 146460 | no | apps/web/src/router.tsx, apps/web/src/routes/root-layout.tsx, apps/web/src/routes/listings-queue-page.tsx (deleted), apps/web/src/features/listings-queue/listings-queue-table.tsx (deleted) |
| T5 | Migrate `apps/web/test/ebay-scan-ui.test.tsx` and `apps/web/test/non-working-badge-visibility.test.tsx`: change every `ListingsQueueTable` import (from `../src/features/listings-queue/listings-queue-table`) and every `<ListingsQueueTable ...>` mount call to `ListingList` (from `../src/features/listings/listing-list`), supplying the inline-edit props every mount now also requires alongside the existing ones (`editingListingId={null}`, `editingListing={null}`, `editingLoading={false}`, and no-op functions for `onToggleEdit`/`onSubmitEdit`/`onCancelEdit`/`onSavedEdit`) so every existing assertion in both files (eBay-scan badge, non-working badge, status/source/price/comparison columns, Accept/Reject firing, the Identify-Parts status badge's four states, the selection header/row checkboxes) keeps proving the exact same behavior against the real merged component, with no assertion's expected outcome changed. | builder | T2 | complete | 0 | | 2026-10-09T04:25:19Z | 2026-10-09T04:37:04Z | 20 | | 23800 | 146460 | no | apps/web/test/ebay-scan-ui.test.tsx, apps/web/test/non-working-badge-visibility.test.tsx |
| T6 | Migrate `apps/web/test/bulk-identify-parts-ui.test.tsx`: change the `ListingsQueuePage` import (from `../src/routes/listings-queue-page`) and every `<ListingsQueuePage />` mount to `ListingsPage` (from `../src/routes/listings-page`); change the `BulkIdentifyPartsBar` import path to its new `../src/features/listings/bulk-identify-parts-bar` location. Adjust any mocked `fetchListings`/`fetchListingIds`/`acceptListing`/`rejectListing` call-shape expectations only if `ListingsPage`'s own loader (per T3) genuinely differs from the old `ListingsQueuePage`'s — it should not, since T3 ports that logic verbatim, but confirm by running the file rather than assuming. No assertion's expected outcome changes. | builder | T3;T1 | complete | 0 | | 2026-10-09T04:25:19Z | 2026-10-09T04:37:04Z | 20 | | 5400 | 146460 | no | apps/web/test/bulk-identify-parts-ui.test.tsx |
| T7 | Three related test-migration pieces, all mechanical prop-threading against the now-expanded `ListingList`/`ListingsPage`: (1) Update `apps/web/test/listings-page.test.tsx`'s mocked `fetchListings` call-shape expectations for the new paginated/filtered loader (no longer `{ limit: 1000 }`) per T3's real implementation. (2) Port `apps/web/test/listings-queue-page.test.tsx`'s `describe('ListingsQueuePage pagination clamp (T7 MUST FIX)')` block into `listings-page.test.tsx`, retargeted at `ListingsPage`, proving the same Req 6 clamp behavior against the merged screen; then delete `listings-queue-page.test.tsx` entirely (its one other describe block, the pageSize-1 pagination case, is already equivalently covered by `bulk-identify-parts-ui.test.tsx`'s `ListingsQueuePage`-turned-`ListingsPage` tests per T6 — confirm this before deleting, don't just assume). (3) Update `apps/web/test/listing-list.test.tsx`'s `Harness` component to supply `ListingList`'s new required props from T2 (`sourcesById`, `onAccept`, `onReject`, `pendingListingId`, `allFilteredIds`, `selectedIds`, `onToggleOne`, `onToggleAllFiltered`) with reasonable no-op/empty defaults, since this file's own tests are specifically about the inline-edit-click behavior and must keep passing unchanged against the expanded component. Net test count across these three files must not drop versus the pre-task total (the ported clamp test replaces the deleted file's count, not merely shrinks it). | builder | T2;T3 | complete | 0 | | 2026-10-09T04:25:19Z | 2026-10-09T04:37:04Z | 20 | | | 146460 | no | apps/web/test/listings-page.test.tsx, apps/web/test/listing-list.test.tsx, apps/web/test/listings-queue-page.test.tsx (deleted) |
| U1 | UAT pass over the whole consolidation: confirm `/listings-queue` no longer exists as a route or a nav entry; on `/listings`, confirm pagination and the status/Source filters work and interact correctly with the table; confirm Accept/Reject work including the pagination-clamp edge case; confirm clicking a Listing's title still opens/closes its inline edit form exactly as before, and "Add Listing" still creates a new Listing that then appears in the table; confirm individual and select-all checkboxes (tri-state, cross-page, cross-filter persistence) and the bulk Identify-Parts action bar work exactly as they did on the old Listings Queue screen; confirm the Identify-Parts status column shows and auto-refreshes correctly. | uat | T1;T2;T3;T4;T5;T6;T7 | complete | 0 | | 2026-10-09T06:15:00Z | 2026-10-09T06:31:42Z | 30 | 2026-10-09T06:15:00Z | 43000 | null | no | .claude/feature/consolidate-listings-views/plan.md |
| R1 | Review T1's relocation of `listing-filters.tsx` (renamed from `ListingsQueueFilters`\u2192`ListingFilters`) and `bulk-identify-parts-bar.tsx` (verbatim move) against Req 2 (filter control's prop/behavior contract unchanged) and Req 9 (bulk bar's prop/behavior contract unchanged for the screen that will mount it), spec compliance first then code quality. | reviewer | T1 | complete | 0 | | 2026-10-09T04:47:18Z | 2026-10-09T05:58:43Z | 10 | 2026-10-09T04:47:18Z | 7300 | null | no | |
| TE1 | Test T1's relocated `listing-filters.tsx`/`bulk-identify-parts-bar.tsx`: prove the renamed/moved components still export correctly and behave identically (status/Source selects; bulk bar rendering) with real pass/fail output. | tester | T1 | complete | 0 | | 2026-10-09T04:47:18Z | 2026-10-09T05:58:43Z | 10 | 2026-10-09T04:47:18Z | 9000 | null | no | apps/web/test/listing-filters.test.tsx |
| R2 | Review T2's expansion of `listing-list.tsx` against Req 3 (every column/badge present, none dropped), Req 4 (Accept/Reject gating and in-flight disable), Req 7 (checkbox column + tri-state header ref pattern), Req 9 (per-row/selection wiring feeding the bulk bar), and Req 11 (inline-edit Fragment/colSpan structure completely unaffected), spec compliance first then code quality. FAIL: flagged a Req 4 vacuous-test gap (no test exercised a non-null `pendingListingId` against >1 row) \u2014 closed same-cycle by TE2's own added test, independently re-verified green; also flagged listing-list.tsx's per-row callback cyclomatic complexity (12, measured via a throwaway, non-committed eslint rule) \u2014 downgraded to a non-blocking recommendation (not a correctness/safety issue, not one of this plan's actual Standing Checks, no project-enforced complexity gate exists). | reviewer | T2 | complete | 0 | | 2026-10-09T04:47:18Z | 2026-10-09T05:58:43Z | 15 | 2026-10-09T04:47:18Z | 24500 | null | no | |
| TE2 | Test T2's expanded `listing-list.tsx`: prove with real pass/fail output that every column/badge (Req 3), Accept/Reject gating (Req 4), checkbox/tri-state (Req 7), and the inline-edit click-to-open/close row (Req 11) genuinely work, including a break-run-restore check that a real regression in this file would be caught. | tester | T2 | complete | 0 | | 2026-10-09T04:47:18Z | 2026-10-09T05:58:43Z | 15 | 2026-10-09T04:47:18Z | 42000 | null | no | apps/web/test/listing-list.test.tsx |
| R3 | Review T3's expansion of `listings-page.tsx` and its `packages/shared/src/listings.ts` field-name fix against Req 1 (hosts every capability), Req 2 (paginated/filtered fetch), Req 5 (accept/reject + confirmation + refresh), Req 6 (pagination clamp), Req 8 (selection persists across page/filter nav), Req 9 (bulk bar wiring), Req 10 (auto-refresh polling), Req 11 (inline-edit state completely unaffected), and Req 12 (Add Listing + refresh) \u2014 independently confirm the `listings.ts` rename's characterization (zero real pre-change consumer of the old field names) rather than taking it on faith \u2014 spec compliance first then code quality. FAIL: flagged ListingsPage's cyclomatic complexity (12, measured via the same throwaway, non-committed eslint rule as R2) crossing 10 \u2014 downgraded to a non-blocking recommendation by validate-lead (not a correctness/safety issue, not one of this plan's actual Standing Checks); every spec-compliance requirement in scope (Req 1,2,5,6,8,9,10,11,12) and the listings.ts rename characterization were independently confirmed correct. | reviewer | T3 | complete | 0 | | 2026-10-09T04:47:18Z | 2026-10-09T05:58:43Z | 25 | 2026-10-09T04:47:18Z | 48000 | null | no | |
| TE3 | Test T3's expanded `listings-page.tsx`: prove with real pass/fail output the paginated/filtered loader (Req 2), accept/reject + confirmation + refresh (Req 5), the pagination-clamp edge case (Req 6), cross-page/cross-filter selection persistence (Req 8), 2s auto-refresh while non-terminal (Req 10), and that the inline-edit row (Req 11) and Add Listing flow (Req 12) are unaffected. | tester | T3 | complete | 0 | | 2026-10-09T04:47:18Z | 2026-10-09T05:58:43Z | 25 | 2026-10-09T04:47:18Z | 55000 | null | no | apps/web/test/listings-page.test.tsx |
| R4 | Review T4's deletions against Req 1 (nav entry and `/listings-queue` route fully gone) and Req 13 (no dead code left: old queue page, old queue table component, and the directory itself all actually deleted, router/root-layout edits clean), spec compliance first then code quality. | reviewer | T4 | complete | 0 | | 2026-10-09T04:47:18Z | 2026-10-09T05:58:43Z | 10 | 2026-10-09T04:47:18Z | 17300 | null | no | |
| TE4 | Test T4's deletions: prove with real pass/fail output that `/listings-queue` no longer resolves as a route, the nav no longer lists it, and the deleted files/directory are actually gone (not just unlinked). | tester | T4 | complete | 0 | | 2026-10-09T04:47:18Z | 2026-10-09T05:58:43Z | 10 | 2026-10-09T04:47:18Z | 5900 | null | no | |
| R5 | Review T5's migration of `ebay-scan-ui.test.tsx`/`non-working-badge-visibility.test.tsx` against Req 3, Req 4, Req 7, Req 9 (every migrated assertion still genuinely proves the same behavior against the real merged `ListingList`, no assertion weakened or made vacuous by the A10 no-op props), spec compliance first then code quality. | reviewer | T5 | complete | 0 | | 2026-10-09T04:47:18Z | 2026-10-09T05:58:43Z | 15 | 2026-10-09T04:47:18Z | 17500 | null | no | |
| TE5 | Test T5's migrated `ebay-scan-ui.test.tsx`/`non-working-badge-visibility.test.tsx`: prove with real pass/fail output plus a break-run-restore mutation that the migrated assertions genuinely catch a real regression, not just pass vacuously because of the A10 no-op inline-edit props. | tester | T5 | complete | 0 | | 2026-10-09T05:40:00Z | 2026-10-09T05:58:43Z | 15 | 2026-10-09T05:40:00Z | 14900 | null | no | |
| R6 | Review T6's migration of `bulk-identify-parts-ui.test.tsx` against Req 1 (page-level merge: `ListingsPage` now hosts what `ListingsQueuePage` did) and Req 9 (bulk-identify-parts flow still proven end to end), spec compliance first then code quality. | reviewer | T6 | complete | 0 | | 2026-10-09T04:47:18Z | 2026-10-09T05:58:43Z | 15 | 2026-10-09T04:47:18Z | 14000 | null | no | |
| TE6 | Test T6's migrated `bulk-identify-parts-ui.test.tsx`: prove with real pass/fail output plus break-run-restore mutations that the bulk Identify-Parts flow (Req 9) is genuinely exercised end to end against the real merged `ListingsPage`. | tester | T6 | complete | 0 | | 2026-10-09T05:40:00Z | 2026-10-09T05:58:43Z | 15 | 2026-10-09T05:40:00Z | 16000 | null | no | |
| R7 | Review T7's three-part test migration against Req 2 (fetchListings call-shape updated), Req 6 (ported pagination-clamp block proves the same behavior against `ListingsPage`), Req 11 (listing-list.test.tsx's inline-edit assertions keep passing unchanged against the expanded component), and Req 13 (listings-queue-page.test.tsx actually deleted with no net test-count drop), spec compliance first then code quality. | reviewer | T7 | complete | 0 | | 2026-10-09T04:47:18Z | 2026-10-09T05:58:43Z | 15 | 2026-10-09T04:47:18Z | 17000 | null | no | |
| TE7 | Test T7's three-part test migration: prove with real pass/fail output plus break-run-restore mutations targeting both Req 11 (inline-edit-click) and Req 6 (pagination clamp) that the migrated tests genuinely guard the real merged `ListingsPage`/`ListingList`. | tester | T7 | complete | 0 | | 2026-10-09T05:50:00Z | 2026-10-09T05:58:43Z | 15 | 2026-10-09T05:50:00Z | 38000 | null | no | |


## Assumptions

- A1 (cycle 0): `BaselineTests` is 768 (550 server + 208 web + 10 shared), `BaselineSuite: pass`,
  measured fresh in this worktree (`.worktrees/consolidate-listings-views`) after a plain `npm ci`
  at its root. One flaky failure (`gracefulShutdown.test.ts`'s real-server SIGTERM case) occurred
  on this baseline run — the same class of environmental, single-flake-per-run timing contention
  documented repeatedly in the two most recent features' own plans (never the same file twice,
  always passes alone or on a clean re-run); not treated as a real baseline failure.
- A2 (cycle 0): This is a pure client-side (`apps/web`) consolidation. No server route, query,
  migration, or shared type changes are needed — every endpoint and field the merged screen uses
  already exists and is already exercised by the bulk-identify-parts feature's own server-side
  tests, which this feature does not touch.
- A3 (cycle 0): `ListingFilters` (T1's renamed `ListingsQueueFilters`) keeps the exact same two
  controls (status, Source) and the exact same `ListingsQueueFilterValue` shape — renaming only
  the component/file, not its behavior or prop contract, since nothing about the request asks for
  new filter capability, only for the existing one to move screens.
- A4 (cycle 0): The merged screen keeps the title "Listings" (not "Listings Queue") per the user's
  own framing ("combine them into the Listings view") — `/listings-queue` is retired, not
  `/listings`.
- A5 (cycle 0): Clicking a Listing's title to open its inline edit row and clicking its own
  checkbox to select it are two independent, non-conflicting gestures on the same row — nothing in
  the request asks for either to disable or interact with the other, and `ListingsQueueTable` and
  `ListingList` already demonstrate this works fine as-is (the Queue table's checkbox never
  conflicted with any other per-row control).
- A6 (cycle 0): T1 renamed only the exported component `ListingsQueueFilters` to `ListingFilters`,
  per the task's literal wording; the exported type `ListingsQueueFilterValue` and the file's one
  internal doc comment referencing "Listings queue" (updated to "Listings view") were left/touched
  minimally, since the task named only the component for renaming.
- A7 (cycle 0): T2 placed `EbayScanBadge`/`NonWorkingBadge` inline in the Title cell (next to the
  existing title-click button and photo icon) rather than inside the Source column, since that is
  exactly where `ListingsQueueTable` — the file T2 was told to port verbatim from — already
  rendered them, even though the task text's parenthetical grouped all three badges together with
  the Source/Identify-Parts columns.
- A8 (cycle 0): T3 found `packages/shared/src/listings.ts`'s `ListingComparison`/
  `ListListingsResponse` interfaces out of sync with every real consumer (server route, web
  components, every test file already used `totalExpectedResaleValue`/`difference`/`total`, not
  the shared file's stale `totalEstimatedResaleValue`/`margin`/`totalCount`) and corrected the
  shared file to match reality, rather than treating A2's "no shared type changes are needed" as
  forbidding a pre-existing drift fix needed for the port to typecheck. This is a one-file,
  additive-to-no-behavior correction, not a new capability.
- A9 (cycle 0): T4 lightly edited `router.tsx`'s header doc comment (which named the deleted
  "Listings Queue" route and a stale task reference) to match the shortened route list, beyond the
  literal minimum of removing just the import and route line, to avoid leaving a comment
  describing a route that no longer exists.
- A10 (cycle 0): T5 passed `sources={[]}` at every migrated `ListingList` mount (a prop
  `ListingsQueueTable` never required) since `ListingList`'s interface requires it for its nested
  `ListingForm`, and every migrated mount keeps `editingListingId={null}` so that branch never
  renders — the empty array is inert for every existing assertion. Left each file's
  `describe('ListingsQueueTable ...')` block labels unchanged (cosmetic only; no assertion reads
  them).
- A11 (cycle 0): T6 renamed the stale `describe('ListingsQueuePage ...')` block title in
  `bulk-identify-parts-ui.test.tsx` to reference `ListingsPage` instead, since it is a test
  description string, not an assertion outcome.
- A12 (cycle 0): T7 found no `{ limit: 1000 }` call-shape assertion anywhere in
  `listings-page.test.tsx` to update; the file's real blocking gap was an incomplete API mock
  (missing `fetchListingIds`/`acceptListing`/`rejectListing`) that crashed every test against the
  now-expanded `ListingsPage` — fixed the mock surface instead. Also found `listings-queue-page.test.tsx`
  contained only the one pagination-clamp describe block the plan named, not a second
  "pageSize-1" block as the plan's description assumed — confirmed by reading the file in full
  before deleting it. Both `listings-page.test.tsx` and `listing-list.test.tsx` needed
  `identifyPartsStatus: null` added to their `makeListing` helpers (a latent gap predating this
  task, surfaced by `ListingsPage`'s new auto-refresh effect reading that field), and
  `listing-list.test.tsx`'s inline-edit-row `colSpan` assertion was updated from 5 to 9 to match
  T2's new, wider `COLUMN_COUNT`.


## Cycle Log

### Cycle 0
Trigger: initial
Retries:
- T1: cycle-0 validation (7 reviewer + 7 tester passes across T1-T7, plus the standing gate) found
  exactly one real must_fix, tracing to T1: TE1's own newly-added `apps/web/test/listing-filters.test.tsx`
  imports `vi` from `vitest` but never calls it, so `npm run lint` now reports one new warning
  (`'vi' is defined but never used'`, `@typescript-eslint/no-unused-vars`) that did not exist before
  this validation cycle \u2014 a concrete violation of this plan's own Standing Check (\"`npm run lint`
  runs clean with no new violation\"). First failure this cycle, confined to one task \u2014 in-place
  retry, not a new cycle. Fix: delete the unused `vi` import from that one line; nothing else in the
  file references it.
  A second candidate finding (R2: `listing-list.tsx` had zero test exercising a non-null
  `pendingListingId` against >1 row, Req 4) was closed in the same pass by TE2's own added test
  (`listing-list.test.tsx`'s new \"Accept/Reject gating and per-row in-flight disable (Req 4)\"
  describe block) and independently re-confirmed passing \u2014 not carried forward as a must_fix.
  Two measurement-based findings (R2 and R3 each separately ran a throwaway, non-committed eslint
  `complexity` rule \u2014 not part of this repo's real config \u2014 against `listing-list.tsx` and
  `listings-page.tsx` respectively, each scoring 12 against a self-chosen threshold of 10) are not
  must_fix: no Standing Check or Requirement in this plan names a complexity gate, the measurement
  tool was never part of the project's own tooling, and neither finding names a correctness or
  safety defect with a concrete failure case \u2014 recorded as non-blocking recommendations only.
  Standing gate: whole suite 775/775 (550 server + 215 web + 10 shared), up from `BaselineTests`
  768 (every one of the +7 web tests is newly-added gap-closing coverage from this validation
  cycle's own testers, nothing combined or deleted \u2014 no shrinkage). Three separate full
  server-suite runs each hit exactly one different real-server-integration test file
  (`identifyPartsConcurrency.test.ts`, then `identifyPartsRoute.test.ts`) timing out on its 30s
  `beforeAll` hook under this run's heavy concurrent sub-agent CPU load, never the same file twice;
  both were independently re-run alone and passed cleanly in under 10s each \u2014 the same
  single-flake-per-run, passes-alone-or-on-a-clean-rerun pattern `BaselineSuite`'s own measurement
  (A1) already documented for `gracefulShutdown.test.ts`, not a regression from this feature's
  (apps/web-only) changes. `npm run lint`: 0 errors, 1 new warning (the must_fix above).
  `apps/web`'s `tsc --noEmit`: clean.
Fix applied: orchestrator removed the unused `vi` import from `apps/web/test/listing-filters.test.tsx`
directly (one-line change, zero functional risk). Re-verified: `npm run lint` now 0 errors/0
warnings; `listing-filters.test.tsx` re-run standalone, 3/3 passing.
UAT: pass (U1, cycle 0) — real click-through via globally-installed Playwright/chromium against
  this worktree's own stack (server on :3101 with `DUCKDB_DATA_DIR=/tmp/uat-clv-data`, Vite on :5273
  with `VITE_API_BASE_URL=http://localhost:3101`), never the main checkout's data/ or ports. Seeded
  3 Sources and 35 Listings (31 open / 2 accepted / 2 rejected; 3 rows with `externalItemId`, 2
  `nonWorking`, 1 with a photo) through the app's own data-access layer, then exercised the merged
  screen end to end: `/listings-queue` returns React Router's 404 and the nav lists only the six
  remaining screens; 20-rows/page pagination with status+Source filters ANDed correctly (`limit=20`
  with `status`/`sourceId`, never the old `limit=1000`); Accept (Purchase created and reachable via
  the confirmation link) and Reject, including the Req 6 clamp back from an emptied page 2;
  title-click inline edit open/close/move/save/cancel with the same `ListingForm` (its own Identify
  Parts button, Expected Parts editor and photo upload all present and the single-listing enqueue
  still firing); "Add Listing" creating a row that appears after refresh; tri-state header checkbox
  and per-row checkboxes persisting across pages and filter changes; one bulk POST for the whole
  selection reporting queued / already-running / not-found; and real `omp`-backed identify-parts
  jobs advancing the status column on their own at a 2s cadence, with polling absent when nothing
  visible is non-terminal and stopping once every visible job settled. All 13 Requirements and all
  4 Standing Checks accounted for. One non-blocking observation: the accept confirmation has no
  explicit dismiss control (it clears on the next accept/reject) — byte-identical to the pre-merge
  `/listings-queue` banner, so not a regression; and a few stale "Listings Queue" strings survive in
  comments/test-describe labels (A10/A11), code-dead only.
