# Feature: bulk-identify-parts

Status: done
Cycle: 2 / 3
FeatureStarted: 2026-10-08T22:34:48Z
Prototype: https://gist.githack.com/adamcrevel/42e4dc85f3d3b9b84aff4adad8bff741/raw/prototype.html
BaselineTests: 738
BaselineSuite: pass

## Goal

The Listings Queue screen (apps/web/src/routes/listings-queue-page.tsx +
listings-queue-table.tsx) gains bulk identify-parts triggering. Each row gets its own checkbox;
a header control selects or deselects every Listing matching the currently-applied filters
across every page of results, not just the current page, and is tri-state (unchecked / checked /
indeterminate) to reflect partial selection. The selection persists across page navigation and
filter changes within the same visit — paging through results or changing the status/Source
filter never silently drops what was already selected.

Whenever one or more Listings are selected, a fixed action bar appears (bottom of the viewport)
showing the selected count and an "Identify Parts" button. Clicking it sends one request that
enqueues an identify-parts job for every selected Listing, reusing the exact same per-listing
concurrency rule the existing single-listing Identify Parts button already relies on (a Listing
with a job already in flight is skipped, never given a second one) and reports back a summary —
how many were newly queued, how many were already in progress, how many ids no longer existed.

Separately, every row in the queue table shows its own identify-parts job status at a glance —
no job yet, waiting/in progress, complete, or failed, with the failure reason visible on hover for
a failed row — without the user opening that Listing's detail view. While any row visible on the
current page is in a non-terminal state, the table refreshes automatically so progress is visible
without a manual reload, stopping once nothing visible is still in flight.

## Requirements

1. Each row in the Listings Queue table (listings-queue-table.tsx) has its own checkbox; checking
   it adds that Listing to the current selection, unchecking it removes that Listing from the
   selection.
2. A header checkbox control reflects and toggles selection of every Listing matching the
   currently-applied status/Source filters, across every page of results — not only the rows on
   the current page.
3. The header control is tri-state: unchecked when none of the filtered Listings are selected,
   checked when all of them are, indeterminate when some but not all are selected.
4. The selection set — however it was built, by individual checkboxes or by the header control —
   persists across page navigation and filter changes within the same visit to the screen; it is
   never silently cleared by paging or changing filters.
5. Whenever the selection is non-empty, a fixed action bar is shown (bottom of the viewport)
   displaying the exact count of currently selected Listings and an "Identify Parts" button.
6. Clicking the bulk "Identify Parts" button sends one request that enqueues an identify-parts
   job for every currently selected Listing.
7. The bulk request reuses the exact same per-listing concurrency rule the existing
   single-listing Identify Parts button (identify-parts-button.tsx) already relies on: a Listing
   that already has a non-terminal identify-parts job is left alone, never given a second,
   duplicate job.
8. After a bulk request completes, the user is shown a summary of its outcome: how many Listings
   were newly queued, and how many were skipped because a job was already active for them.
9. A selected id that no longer corresponds to any Listing (e.g. since deleted) is reported
   distinctly in the summary rather than silently dropped or causing the whole request to fail.
10. Each row in the Listings Queue table shows its own identify-parts job status without the user
    opening that Listing's detail view: visually distinguishable states for "no job yet",
    "waiting/in progress" (any non-terminal stage), "complete", and "failed".
11. A row whose latest identify-parts job failed lets the user see the recorded failure reason
    (e.g. on hover) directly from the queue table, without opening the Listing.
12. While any row visible on the current page has a non-terminal identify-parts job, the table's
    statuses refresh automatically on an interval, so progress (waiting -> in progress ->
    complete/failed) is visible without a manual page reload; refreshing stops once nothing
    visible on the current page is still non-terminal.
13. Triggering identify-parts in bulk never bypasses or weakens the existing single-listing
    trigger's own behavior — the Identify Parts button on a Listing's own detail view, and its
    polling/result-handling (identify-parts-button.tsx), are unchanged.

## Standing Checks

- The whole test suite passes, and the test count stays at or above `BaselineTests` (738).
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
| P0 | Clickable prototype covering T5/T6's UI: (1) a checkbox column in the Listings Queue table — a per-row checkbox plus a header checkbox that visually supports three states (unchecked/checked/indeterminate); (2) a new identify-parts-status column/badge per row with four distinct visual states ("—" for no job yet, an in-progress style for waiting/running, a success style for complete, an error style for failed with a hover tooltip showing a sample failure reason) styled distinctly from the existing EbayScanBadge (emerald) and NonWorkingBadge (amber) pills; (3) a fixed bottom action bar that appears once 1+ rows are selected, showing "`N selected`" and an "Identify Parts" button, with a loading state and a post-click result summary ("Queued 12, already in progress 3"). | prototype | none | complete | 0 | | 2026-10-08T22:45:00Z | 2026-10-08T22:58:14Z | 20 | 2026-10-08T22:45:00Z | 17300 | null | yes | |
| T1 | Shared types for the new fields/endpoints. `packages/shared/src/identifyPartsJob.ts`: add `IdentifyPartsBulkOutcome = 'queued' \| 'already_active' \| 'not_found'`, `IdentifyPartsBulkResult { listingId: string; outcome: IdentifyPartsBulkOutcome }`, `IdentifyPartsBulkResponse { results: IdentifyPartsBulkResult[] }` (Req 6, 8, 9). `packages/shared/src/listings.ts`: `ListingSummary` gains `identifyPartsStatus: { stage: IdentifyPartsJobStage; errorMessage: string \| null } \| null` (Req 10, 11 — null means no job has ever run for that Listing; import `IdentifyPartsJobStage` from `./identifyPartsJob.js`), and a new `ListListingIdsResponse { ids: string[] }` (backs T2's new endpoint, Req 2). Export every new type from `packages/shared/src/index.ts`'s barrel. | builder | none | complete | 0 | peter-gibbons | 2026-10-08T23:03:47Z | 2026-10-08T23:05:21Z | 10 | | 9300 | null | no | packages/shared/src/identifyPartsJob.ts, packages/shared/src/listings.ts |
| T2 | Server: `GET /api/listings/ids` endpoint (Req 2) + embed `identifyPartsStatus` into every Listing summary (Req 10, 11). `apps/server/src/db/queries/listings.ts`: new `listListingIds(options?: Pick<ListListingsOptions, 'status' \| 'sourceId'>): Promise<string[]>`, reusing the existing (private) `buildListingsWhere` the same way `listListings`/`countListings` already do, running `SELECT id FROM listings ${whereSql} ORDER BY listing_date DESC, id ASC` with no LIMIT/OFFSET — every matching id, not one page. `apps/server/src/routes/listings.ts`: new `server.get('/api/listings/ids', ...)` handler reading the same `status`/`sourceId` query params the existing `GET /api/listings` handler already reads, returning `{ ids: await listListingIds({ status, sourceId }) }`; registered as a plain static route (Fastify/find-my-way matches static segments before the existing `/api/listings/:id` parametric route regardless of registration order, so no route-ordering workaround is needed — confirm this with a real request in review, not by assertion alone). Also: `toSummary()` in the same file gains a call to the already-imported-elsewhere `getLatestJobForListing(listing.id)` (from `../db/index.js`, same function `routes/identifyParts.ts`'s poll endpoint already uses), mapping a found job to `{ stage: job.stage, errorMessage: job.errorMessage }` and no job to `null`, attached as the summary's `identifyPartsStatus` field. | builder | T1 | complete | 0 | peter-gibbons | 2026-10-08T23:05:21Z | 2026-10-08T23:16:39Z | 20 | | 46800 | null | no | apps/server/src/db/queries/listings.ts, apps/server/src/routes/listings.ts |
| T3 | Server: `POST /api/listings/identify-parts/bulk` endpoint (Req 6-9). New handler in `apps/server/src/routes/identifyParts.ts`, alongside the existing single-listing `POST /api/listings/:id/identify-parts` route, accepting `{ listingIds: string[] }` in the request body. For each id (via `Promise.all`, since each call touches a distinct Listing row with no intra-request shared state): look up the Listing with the already-imported `getListingById`; if not found, outcome `'not_found'`; otherwise call the already-imported `insertQueuedJobIfNoneActive(id)` (the exact same atomic check-and-insert the single-listing route already uses) — a returned job means outcome `'queued'`, a null return (already-active job) means outcome `'already_active'`. Returns `200` with `{ results: [{ listingId, outcome }, ...] }` (shared `IdentifyPartsBulkResponse` from T1), one entry per input id, in input order. An empty `listingIds` array returns `{ results: [] }` rather than erroring. | builder | T1 | complete | 0 | peter-gibbons | 2026-10-08T23:05:21Z | 2026-10-08T23:16:39Z | 20 | | 38000 | null | no | apps/server/src/routes/identifyParts.ts |
| T4 | Client API wrappers (Req 2, 6). `apps/web/src/features/listings/listings-api.ts`: new `fetchListingIds(options?: Pick<FetchListingsOptions, 'status' \| 'sourceId'>): Promise<string[]>` calling `GET /api/listings/ids` with the same query-param construction `fetchListings` already uses (status/sourceId only, no limit/offset), unwrapping `.ids`; new `enqueueBulkIdentifyParts(listingIds: string[]): Promise<IdentifyPartsBulkResult[]>` calling `POST /api/listings/identify-parts/bulk` with `{ listingIds }`, unwrapping `.results`. | builder | T2;T3 | complete | 0 | peter-gibbons | 2026-10-08T23:16:58Z | 2026-10-08T23:25:45Z | 10 | | 900 | null | no | apps/web/src/features/listings/listings-api.ts |
| T5 | Client: checkbox column + identify-parts-status column in the queue table (Req 1, 3, 10, 11), matching P0's approved prototype. `apps/web/src/features/listings-queue/listings-queue-table.tsx`'s props gain `allFilteredIds: string[]`, `selectedIds: Set<string>`, `onToggleOne: (id: string) => void`, `onToggleAllFiltered: () => void`. New leading `<th>`/`<td>` checkbox column: the header checkbox's `checked`/`indeterminate` DOM properties (set via a ref, same pattern any existing tri-state checkbox in the React ecosystem needs — `indeterminate` has no JSX prop) are computed from whether every/some/none of `allFilteredIds` is in `selectedIds`, `onChange` calls `onToggleAllFiltered`; each row's own checkbox reflects `selectedIds.has(listing.id)`, `onChange` calls `onToggleOne(listing.id)`. New trailing-before-actions `<th>`/`<td>` rendering a new `apps/web/src/features/listings/identify-parts-status-badge.tsx` component (`IdentifyPartsStatusBadge`, mirroring `non-working-badge.tsx`'s structure/doc-comment convention) fed `listing.identifyPartsStatus`: `null` renders an em-dash/muted "—"; `stage` one of queued/identifying/sourcing_references/comparing renders an in-progress-styled pill (reusing `getStageMessage`-equivalent short labels, e.g. "In progress"); `'completed'` renders a success-styled pill ("Complete"); `'failed'` renders an error-styled pill ("Failed") with a native `title` attribute set to `errorMessage` so it's visible on hover (Req 11) without any new tooltip component. | builder | T1 | complete | 0 | peter-gibbons | 2026-10-08T23:05:21Z | 2026-10-08T23:16:39Z | 25 | | 14000 | yes | yes | apps/web/src/features/listings-queue/listings-queue-table.tsx, apps/web/src/features/listings/identify-parts-status-badge.tsx |
| T6 | Client: selection state, the bulk action bar, auto-refresh polling, and the bulk-result summary (Req 2, 4-9, 12, matching P0's approved prototype). `apps/web/src/routes/listings-queue-page.tsx`: new `selectedIds` state (`Set<string>`), declared at the component's top level so it is untouched by `loadListings`'s own page/filter-triggered effect (Req 4); new `allFilteredIds` state (`string[]`), refetched via T4's `fetchListingIds` in its own effect keyed on `filters` only (not `page` — Req 2 is page-independent); `onToggleOne`/`onToggleAllFiltered` handlers mutate `selectedIds` via functional `setSelectedIds` updates (toggling all-filtered adds every id in `allFilteredIds` when not already fully selected, else removes exactly those ids — preserving any selection made under a different filter, per Req 4). New `apps/web/src/features/listings-queue/bulk-identify-parts-bar.tsx` (`BulkIdentifyPartsBar`), a fixed-position bottom bar rendered when `selectedIds.size > 0`, showing the count and an "Identify Parts" button; on click, calls T4's `enqueueBulkIdentifyParts([...selectedIds])`, shows a disabled/loading state meanwhile, then an `InfoBanner` summarizing counts by outcome (Req 8, 9) and clears `selectedIds` on success. New polling: a 2000ms `setInterval` (matching `identify-parts-button.tsx`'s own interval/cleanup convention exactly — started/cleared in a `useEffect`) that re-calls `loadListings` whenever any row in the current `listings` page has `identifyPartsStatus !== null && stage !== 'completed' && stage !== 'failed'`, and clears itself once none do (Req 12). Also updates `apps/web/test/ebay-scan-ui.test.tsx` and `apps/web/test/non-working-badge-visibility.test.tsx` to pass T5's four new required ListingsQueueTable props (these two tests mount the table directly and broke when T5 made the props required). | builder | T4;T5 | complete | 0 | peter-gibbons | 2026-10-08T23:25:45Z | 2026-10-08T23:44:58Z | 30 | | 17000 | null | yes | apps/web/src/routes/listings-queue-page.tsx, apps/web/src/features/listings-queue/bulk-identify-parts-bar.tsx, apps/web/test/bulk-identify-parts-ui.test.tsx, apps/web/test/ebay-scan-ui.test.tsx, apps/web/test/non-working-badge-visibility.test.tsx, apps/web/test/listings-queue-page.test.tsx |
| R1 | Review T1 — shared types (`packages/shared/src/identifyPartsJob.ts`, `packages/shared/src/listings.ts`) against Req 2 (`ListListingIdsResponse` shape), Req 6, 8, 9 (`IdentifyPartsBulkOutcome`/`IdentifyPartsBulkResult`/`IdentifyPartsBulkResponse` shapes backing the bulk endpoint's outcomes), Req 10, 11 (`identifyPartsStatus` field shape on `ListingSummary`, `errorMessage` null-ability), barrel export from `index.ts`. Spec compliance first, then code quality (doc comments). | reviewer | T1 | complete | 0 | peter-gibbons | 2026-10-09T00:10:23Z | 2026-10-09T00:50:17Z | 8 | 2026-10-09T00:10:23Z | 10800 | null | no | |
| TE1 | Test T1 — prove the new shared types compile, are exported from `packages/shared/src/index.ts`'s barrel, and match the exact shape every consumer (T2's `identifyPartsStatus` mapping, T3's bulk response, T6's outcome-counting summary) expects. | tester | T1 | complete | 0 | peter-gibbons | 2026-10-09T00:10:23Z | 2026-10-09T00:50:17Z | 10 | 2026-10-09T00:10:23Z | 42000 | null | no | packages/shared/src/bulkIdentifyPartsTypes.test.ts |
| R2 | Review T2 — `GET /api/listings/ids` + `identifyPartsStatus` embedding (`apps/server/src/db/queries/listings.ts`, `apps/server/src/routes/listings.ts`) against Req 2 (every matching id across all pages, no LIMIT/OFFSET, correct status/sourceId filtering, static route matches before the parametric `/:id` route), Req 10, 11 (`identifyPartsStatus` correctly mapped from `getLatestJobForListing`, null when no job, `errorMessage` carried through only on `failed`). | reviewer | T2 | complete | 0 | peter-gibbons | 2026-10-09T00:10:23Z | 2026-10-09T00:50:17Z | 10 | 2026-10-09T00:10:23Z | 7600 | null | no | |
| TE2 | Test T2 — write and run real server-side tests proving `GET /api/listings/ids` returns every id matching filters with no page cap, and that listing summaries embed `identifyPartsStatus` correctly (no job → null, latest job's stage/errorMessage otherwise). This endpoint currently has zero test coverage. | tester | T2 | complete | 0 | peter-gibbons | 2026-10-09T00:10:23Z | 2026-10-09T00:50:17Z | 20 | 2026-10-09T00:10:23Z | 34000 | null | no | apps/server/test/listings.test.ts |
| R3 | Review T3 — `POST /api/listings/identify-parts/bulk` (`apps/server/src/routes/identifyParts.ts`) against Req 6 (one request enqueues per selected id), 7 (reuses `insertQueuedJobIfNoneActive`, no duplicate jobs), 8 (summary outcome), 9 (`not_found` reported distinctly, never dropped or erroring the whole batch), 13 (existing single-listing route in the same file is untouched/unaffected). | reviewer | T3 | complete | 0 | peter-gibbons | 2026-10-09T00:10:23Z | 2026-10-09T00:50:17Z | 10 | 2026-10-09T00:10:23Z | 9000 | null | no | |
| TE3 | Test T3 — write and run real tests for the bulk endpoint: mixed found/not-found ids, an id with an already-active job skipped (no duplicate), empty-array input, response order matches input order; confirm the existing single-listing `POST` route's own tests still pass unaffected. This endpoint currently has zero test coverage. | tester | T3 | complete | 0 | peter-gibbons | 2026-10-09T00:10:23Z | 2026-10-09T00:50:17Z | 20 | 2026-10-09T00:10:23Z | 5800 | null | no | apps/server/test/identifyPartsRoute.test.ts |
| R4 | Review T4 — client API wrappers (`apps/web/src/features/listings/listings-api.ts`) against Req 2 (`fetchListingIds` query-param construction matches `fetchListings`' own, unwraps `.ids`) and Req 6 (`enqueueBulkIdentifyParts` posts `{ listingIds }`, unwraps `.results`). | reviewer | T4 | complete | 0 | peter-gibbons | 2026-10-09T00:10:23Z | 2026-10-09T00:50:17Z | 8 | 2026-10-09T00:10:23Z | 3600 | null | no | |
| TE4 | Test T4 — prove `fetchListingIds` and `enqueueBulkIdentifyParts` call the right URL/method/body and correctly unwrap their responses (mocked fetch). | tester | T4 | complete | 0 | peter-gibbons | 2026-10-09T00:10:23Z | 2026-10-09T00:50:17Z | 12 | 2026-10-09T00:10:23Z | 14000 | null | no | apps/web/test/listings-api.test.ts |
| R5 | Review T5 — checkbox + identify-parts-status column (`apps/web/src/features/listings-queue/listings-queue-table.tsx`, `apps/web/src/features/listings/identify-parts-status-badge.tsx`) against Req 1 (per-row checkbox toggles selection), Req 2 (header checkbox wired against `allFilteredIds`/`selectedIds` props), Req 3 (tri-state checked/indeterminate/unchecked logic correct via ref, since `indeterminate` has no JSX prop), Req 10 (four visually distinct states incl. null → em dash), Req 11 (failed badge's `title` attribute carries the real `errorMessage`). FAIL: Req 10's in-progress pill color is correct in production (`text-sky-700`, distinct from `EbayScanBadge`'s emerald) but no test in `ebay-scan-ui.test.tsx` asserts its class, only its text — a color collision would ship silently undetected. | reviewer | T5 | complete | 0 | peter-gibbons | 2026-10-09T00:10:23Z | 2026-10-09T00:50:17Z | 12 | 2026-10-09T00:10:23Z | 70000 | null | yes | |
| TE5 | Test T5 — using `apps/web/test/ebay-scan-ui.test.tsx` and `apps/web/test/non-working-badge-visibility.test.tsx` (both already mount the table directly), prove: all/some/none-selected renders header checked/indeterminate/unchecked correctly, a per-row checkbox toggle calls `onToggleOne` with the right id, and each `identifyPartsStatus` value renders the correct badge incl. a failed row's hover `title`. Scope strictly to `listings-queue-table.tsx`/`identify-parts-status-badge.tsx` and these two test files — do not touch `listings-queue-page.tsx` or its test files (TE6's territory). | tester | T5 | complete | 0 | peter-gibbons | 2026-10-09T00:10:23Z | 2026-10-09T00:50:17Z | 18 | 2026-10-09T00:10:23Z | 48000 | null | yes | apps/web/test/ebay-scan-ui.test.tsx, apps/web/test/non-working-badge-visibility.test.tsx |
| T7 | Fix T5's must_fix verbatim: `apps/web/test/ebay-scan-ui.test.tsx`'s test 'renders the per-stage in-progress pill text for each non-terminal stage' (~line 318) asserts only textContent for the in-progress identify-parts-status pill, never its className — unlike the sibling completed/failed-state tests in the same describe block. Add className-contains assertions to this test (mirroring exactly the pattern those siblings use): assert the in-progress pill carries its real production class `text-sky-700` (per identify-parts-status-badge.tsx) and NOT `text-emerald-700` (EbayScanBadge's color) — so a future accidental color collision would fail the test. No production code change. | builder | T5 | complete | 1 | ShinyViper | 2026-10-09T00:50:17Z | 2026-10-09T01:15:00Z | 15 | 2026-10-09T00:50:17Z | 2000 | null | no | apps/web/test/ebay-scan-ui.test.tsx |
| R7 | Re-review T7's fix: confirm `apps/web/test/ebay-scan-ui.test.tsx`'s in-progress-pill test now asserts `className` contains `text-sky-700` and does not contain `text-emerald-700` for both non-terminal stages, mirroring the sibling completed/failed tests, and confirm no production code was changed. | reviewer | T7 | complete | 1 | RegisteredSloth | 2026-10-09T01:30:00Z | 2026-10-09T01:32:03Z | 6 | 2026-10-09T01:30:00Z | 3200 | null | no | |
| TE7 | Re-run `apps/web/test/ebay-scan-ui.test.tsx` in full and confirm it passes, including the new className assertions. Report real pass/fail output. | tester | T7 | complete | 1 | SuddenMarmot | 2026-10-09T01:30:00Z | 2026-10-09T01:32:14Z | 6 | 2026-10-09T01:30:00Z | null | null | no | |
| R6 | Review T6 — selection state, action bar, polling (`apps/web/src/routes/listings-queue-page.tsx`, `apps/web/src/features/listings-queue/bulk-identify-parts-bar.tsx`) against Req 2 (`allFilteredIds` refetch keyed on `filters` only, not `page`), Req 4 (`selectedIds` untouched by the page/filter-triggered effect, persists across both), Req 5 (bar shown iff selection non-empty, exact count), Req 6 (one request enqueues for every selected id), Req 7 (bulk call relies on the server's own concurrency rule, no client-side duplicate suppression needed), Req 8, 9 (summary rendering incl. not_found), Req 12 (2000ms polling starts/stops correctly based on non-terminal rows on the current page only). | reviewer | T6 | complete | 0 | peter-gibbons | 2026-10-09T00:10:23Z | 2026-10-09T00:50:17Z | 12 | 2026-10-09T00:10:23Z | 16500 | null | yes | |
| TE6 | Test T6 — using `apps/web/test/bulk-identify-parts-ui.test.tsx` and `apps/web/test/listings-queue-page.test.tsx`, prove: selection survives a simulated page/filter change, the action bar appears/disappears and shows the correct count, a bulk click produces the correct summary rendering, and polling starts while a visible row is non-terminal and stops once all visible rows settle. Scope strictly to `listings-queue-page.tsx`/`bulk-identify-parts-bar.tsx` and these two test files — do not touch `listings-queue-table.tsx` or its test files (TE5's territory). | tester | T6 | complete | 0 | peter-gibbons | 2026-10-09T00:10:23Z | 2026-10-09T00:50:17Z | 18 | 2026-10-09T00:10:23Z | 23000 | null | yes | apps/web/test/bulk-identify-parts-ui.test.tsx |
| U1 | UAT pass over the whole feature: select several Listings individually across more than one page, confirm the header checkbox shows indeterminate/checked correctly and the selection survives paging and changing the status/Source filter; use the header control to select every filtered Listing across all pages; fire the bulk Identify Parts button and confirm a real job is enqueued per selected Listing (skipping any already active) with a correct result summary; confirm the queue table shows each row's job status without opening it, refreshes automatically while jobs are in flight, stops refreshing once settled, and a failed row's hover text shows its real error message; confirm the existing single-listing Identify Parts button on a Listing's own detail view still behaves exactly as before. | uat | T1;T2;T3;T4;T5;T6 | complete | 2 | ProbableCobra | 2026-10-09T02:20:00Z | 2026-10-09T02:40:41Z | 25 | 2026-10-09T02:20:00Z | 22600 | null | no | |
| T8 | Fix U1's Req 12 must_fix verbatim: `apps/web/src/routes/listings-queue-page.tsx`'s `<BulkIdentifyPartsBar onCleared={...} />` callback only calls `setSelectedIds(new Set())` after a bulk run, never re-triggering `loadListings` — so the rows the bulk click just enqueued keep their stale `identifyPartsStatus: null` in state, the polling effect's non-terminal guard sees nothing pending, and the 2000ms interval never arms until a manual reload. Fix: change the callback to `onCleared={() => { setSelectedIds(new Set()); void loadListings(); }}`, re-fetching the current page immediately so the just-queued rows render their real (non-terminal) badges and the existing polling effect picks them up on its own — no change to the interval logic itself, which UAT confirmed works correctly once armed. Also add a test to `apps/web/test/bulk-identify-parts-ui.test.tsx` asserting `fetchListings` is called again after a bulk click resolves (the existing tests all seed already-non-terminal rows, which armed the interval before the click and hid this gap). | builder | T6 | complete | 2 | YoungestCephalopod | 2026-10-09T01:35:00Z | 2026-10-09T02:00:00Z | 12 | | 4000 | null | yes | apps/web/src/routes/listings-queue-page.tsx, apps/web/test/bulk-identify-parts-ui.test.tsx |
| R8 | Re-review T8's fix: confirm `listings-queue-page.tsx`'s `onCleared` callback now calls `loadListings()` in addition to clearing selection, confirm selection-clearing behavior is preserved, and confirm the new test in `bulk-identify-parts-ui.test.tsx` genuinely exercises the fix (seeds no-job rows before the bulk click, not already-non-terminal rows that would mask the original bug). | reviewer | T8 | complete | 2 | AbundantTrout | 2026-10-09T02:00:00Z | 2026-10-09T02:06:19Z | 8 | 2026-10-09T02:00:00Z | 15000 | null | no | |
| TE8 | Re-run `apps/web/test/bulk-identify-parts-ui.test.tsx` and `apps/web/test/listings-queue-page.test.tsx` in full, confirming all pass including T8's new test. Report real pass/fail output. | tester | T8 | complete | 2 | MarriedGazelle | 2026-10-09T02:00:00Z | 2026-10-09T02:09:28Z | 8 | 2026-10-09T02:00:00Z | null | null | no | |

## Assumptions

- A1 (cycle 0): `BaselineTests` is 738 (546 server + 187 web + 5 shared), `BaselineSuite: pass`,
  measured fresh in this worktree (`.worktrees/bulk-identify-parts`) after a plain `npm ci` at its
  root.
- A2 (cycle 0): "Select all" (Req 2) scopes to every Listing matching the queue's existing
  status/Source filters, across every page — not literally every Listing in the database
  regardless of filter, and not merely the current page. Confirmed directly with the user: no new,
  separate filtering layer is introduced for bulk-select itself: it rides on the filters the queue
  screen already has.
- A3 (cycle 0): Selection persists across both page changes and filter changes for the remainder
  of the visit to this screen (confirmed directly with the user) — it is not persisted to storage
  across a full page reload/navigation away from the screen entirely, since nothing in the request
  asked for that and every other piece of this screen's transient UI state (open filters, which
  row's edit panel is open) already resets on a fresh load.
- A4 (cycle 0): No artificial cap on how many Listings can be bulk-selected or bulk-triggered at
  once. `IDENTIFY_PARTS_POOL_SIZE` (default 1) still governs how many of the resulting jobs run
  concurrently — selecting, say, all 143 current Listings at once queues 143 jobs that then drain
  sequentially through the existing single-worker pool, taking a long time to fully settle, not a
  new failure mode. This is the same queue depth and throughput behavior a user could already
  reach by clicking the single-listing button 143 times in a row; bulk-select only removes the
  manual repetition, it does not change the pipeline's own capacity.
- A5 (cycle 0): The bulk endpoint does not re-validate or special-case a Listing that is not
  `status: 'open'` (e.g. already accepted/rejected) — identify-parts has never been gated by
  Listing status anywhere in this codebase (the existing single-listing button works on any saved
  Listing), and the request did not ask for a new restriction here.
- A6 (cycle 0): The per-row identify-parts status badge (Req 10) reflects only the *latest* job for
  that Listing (mirroring `getLatestJobForListing`, the same function the existing single-listing
  poll endpoint already uses) — a Listing's job history beyond its most recent run is out of scope,
  matching how the single-listing button itself only ever shows the latest job's state.
- A7 (cycle 0): The auto-refresh polling (Req 12) re-fetches the current page of listings (the same
  `loadListings` the page already calls on filter/page change) rather than opening a second,
  parallel lightweight "just statuses" endpoint — simpler, and the existing page-size (20) keeps
  the re-fetch cheap; a true bulk status endpoint was considered and rejected as unneeded
  complexity for this screen's data volume.
- A8 (cycle 0): T6 also patched `apps/web/test/listings-queue-page.test.tsx` (outside its assigned
  file list) to add `fetchListingIds`/`enqueueBulkIdentifyParts` to that test's `listings-api`
  module mock and `identifyPartsStatus: null` to its Listing fixture — its own `fetchListings`
  mock and the queue page's new effect calling `fetchListingIds` on mount would otherwise throw.
  No existing assertion in that file was changed. T6 also added `identifyPartsStatus: null` to the
  fixture factories in the two assigned test files (ebay-scan-ui.test.tsx,
  non-working-badge-visibility.test.tsx), since T5's new status-badge column crashed on the
  pre-existing fixtures lacking that field — prop-patching the four new required table props alone
  did not make these tests pass.
- A9 (cycle 0): The build-lead's six builder dispatches left two stray writes on the main
  checkout (`/mnt/d/repositories/pc-parts-flipper`, branch `main`), the same recurring class of
  issue documented in ebay-condition-filter's A8/A12/A15/A17. Independently found via `git status`
  on main after the cycle: (1) T3's dispatch wrote its real, complete diff
  (`apps/server/src/routes/identifyParts.ts`, the new `POST .../identify-parts/bulk` route) to
  `main` only — the worktree's own copy of that file was confirmed via direct diff to still be the
  pre-T3 original, meaning T3's actual work never reached the feature branch at all. Fixed by the
  orchestrator: ported main's exact file content into the worktree verbatim (confirmed identical by
  diff afterward), then discarded the stray copy on `main` via `git checkout --`. (2) T4's dispatch
  wrote `apps/web/src/features/listings/listings-api.ts` to both `main` and the worktree,
  content-identical in both places (confirmed via `diff`) — the worktree's own copy was correct and
  unaffected; the stray duplicate on `main` was discarded the same way. After both fixes, `main`
  carries only its pre-existing, unrelated drift (`.claude/feature/part-price-estimation/dashboard.html`,
  untracked `artifacts/`), confirmed via a fresh `git status` on `main` showing none of this
  feature's files present. The full test suite was re-run after porting T3's real content and
  passed (546 server + 195 web + 5 shared = 746, matching `BaselineTests` 738 + 8 new from T6).
- A10 (cycle 0) — corrects ebay-condition-filter's A11's root-cause guess, which does not hold up
  under direct verification: `npm run build -w apps/server` (full `tsc`, never invoked by `npm
  test`) independently confirmed to show the exact same ~43 pre-existing TypeScript errors (field-
  name drift between `apps/server/src/db/types.ts`'s own local type definitions and
  `packages/shared`'s types — e.g. `Source.platformType` vs `platform`, `ListingComparison`'s
  renamed fields, `TeardownResult`/`Part`/`Sale`/`SaleListing` missing several fields) whether or
  not any of T1-T6's changes are present — proven by `git stash`, rebuilding `packages/shared`'s
  dist to match the stashed (pre-feature) source, then running `apps/server`'s build twice (once
  stashed, once popped) and diffing the two error lists: identical 43 errors both times, only two
  line numbers shifted by T2's unrelated insertions, zero new errors introduced by this feature.
  This is not a "worktree-local node_modules artifact" as A11 speculated (reproduced identically on
  a completely fresh worktree created this session) — it is a genuine, pre-existing structural type
  drift in the server package, present on `main` at `cbb6860` itself, unrelated to and unaffected
  by any feature built on top of it. Out of this feature's scope (the Standing Checks require the
  test suite and lint, neither of which runs `tsc`), left untouched.
- A11 (cycle 0): Three different, unrelated tests flaked exactly once each across four consecutive
  full-suite runs in this worktree during verification (`test/profit.test.ts`,
  `test/gracefulShutdown.test.ts`'s real-server-port-binding case, `test/parts.test.ts`) — each
  passed cleanly either in isolation or on a subsequent full-suite re-run, and none touch any file
  this feature changed. Attributed to environmental timing contention (real server/port-binding
  tests racing under this sandbox's I/O load) rather than a regression; the suite was confirmed
  fully green (746/746) on both the first and fourth full runs.
- A12 (cycle 0): `actual_tokens` is `null` for all twelve R*/TE* validation rows. `skills/feature/
  bin/measure-child-cost.py child-cost --tag "<tag>"` is built around an `AGENT_TAG: <tag>` literal
  line that a different dispatch mechanism writes into a child's own transcript; the `task` tool
  available in this run has no such mechanism (confirmed: `grep -r AGENT_TAG` against all twelve
  children's own per-task transcript files, e.g.
  `~/.omp/agent/sessions/.../FunctionalTiglon/FunctionalTiglon.R1.jsonl`, found zero matches). The
  script still returned non-null numbers for every tag queried — traced each one
  (`_find_omp_transcript_by_tag`) and confirmed every match resolved to an unrelated file: either
  this very lead's own root transcript (whose persisted JSON happens to contain the literal text
  "AGENT_TAG:" as part of this skill's own instructions, a false positive `_iter_omp_jsonl_paths`'
  own docstring names as a known risk but the code never actually excludes) or a completely
  different historical feature's validation run from 2026-10-02 (`ValidateLead1.jsonl`, an unrelated
  session that happens to reuse the same generic tag text "review T1"/"test T6"). Writing either
  number into `actual_tokens` would be reporting another run's cost as this one's; `null` is the
  honest value, per the instruction to never substitute a guess. Each row's reported
  `estimated_tokens` (the agent's own self-report) is written instead, where it fell between
  3,600 (R4) and 70,000 (R5).
- A13 (cycle 0): One full-suite run surfaced a single failure —
  `test/listingPhotos.test.ts > POST /api/listings/:id/photos > stores an uploaded photo under
  photos/<id>-<uuid>.<ext>, on disk and in photoPaths`, `ENOENT` statting the uploaded file off a
  freshly-created temp data dir — in a file no task in this feature touches. Reproduced
  deterministically 3/3 times in isolation, including once with every one of this feature's changes
  `git stash`ed back to base commit `cbb6860` (same A10/A11 technique), where it failed identically.
  This is a pre-existing defect in the photo-upload test's own temp-dir/async-write handling,
  unrelated to and unaffected by this feature; not a `must_fix` here. (Distinct from A11's
  once-each, load-contention flakes — this one reproduces every time, in isolation, at base —
  worth a bug report against `listingPhotos.test.ts` outside this feature's scope.)
- A14 (cycle 0): TE4 and TE6 each independently reported a failure inside a file another task's own
  tester (TE5) was concurrently editing at that exact moment
  (`non-working-badge-visibility.test.tsx`'s checkbox tests, and `ebay-scan-ui.test.tsx`'s "Complete"
  pill text, respectively) — both non-reproducing, each a different concrete assertion mismatch
  across repeated runs, the signature of reading a file mid-write rather than a real defect.
  Resolved by re-running the full suite once, serially, after all twelve R*/TE* children had
  returned and every file was settled: both describe blocks pass clean (confirmed in the Cycle Log
  below) — no action needed, no file touched to fix it.
- A15 (cycle 1): Between cycle 0's validation and dispatching T7, the orchestrator independently
  found the build-lead's cycle-0 dispatches had left two stray writes on the main checkout
  (`/mnt/d/repositories/pc-parts-flipper`, branch `main`): T3's dispatch had written its real,
  complete diff (the new `POST /api/listings/identify-parts/bulk` route) to `main` only — the
  worktree's own copy was confirmed via direct `diff` to still be the pre-T3 original, meaning
  T3's actual work had never reached the feature branch. Fixed by porting main's exact file content
  into the worktree verbatim (confirmed identical by `diff` afterward), then discarding the stray
  copy on `main` via `git checkout --`. T4's dispatch had also written `listings-api.ts` to `main`,
  but content-identical to the worktree's own correct copy — discarded the same way, no porting
  needed. The full suite was re-run clean after porting (746 tests, matching the post-T6 figure)
  before validation was dispatched.
- A16 (cycle 1): `npm run build -w apps/server` (full `tsc`) independently confirmed, via `git
  stash` against the exact base commit plus rebuilding `packages/shared`'s dist to match the
  stashed state before diffing error lists, to show the identical ~43 pre-existing TypeScript
  errors whether or not any of this feature's changes are present — a genuine, pre-existing
  structural type drift between `apps/server/src/db/types.ts`'s own local type definitions and
  `packages/shared`'s types, present on `main` at `cbb6860` itself. This corrects
  ebay-condition-filter's A11, whose "worktree-local node_modules artifact" root-cause guess does
  not hold up (reproduced identically on this completely separate, freshly-created worktree). Out
  of this feature's Standing Checks scope (test suite + lint, not `tsc`), left untouched.
- A17 (cycle 1): The host environment (WSL) crashed mid-session after cycle 0's validation
  completed and T7's fix was dispatched and had already finished (confirmed: T7's `completed_at`
  timestamp, 2026-10-09T01:15:00Z, predates the crash). On resumption: the `/tmp`-based Node 22
  install used earlier in the session was gone (tmpfs, wiped by the crash) — re-provisioned via the
  already-installed `~/.nvm/versions/node/v22.23.3` instead (persists across crashes, unlike
  `/tmp`). The worktree's own `node_modules` and all git history/working-tree state were intact and
  unaffected (disk-backed, not crash-sensitive the way `/tmp` or in-memory process state is). The
  full suite was re-run twice after recovery and passed clean both times at 767/767, matching cycle
  0's validated count exactly — nothing was lost. One of the two post-crash verification runs was
  itself accidentally killed mid-run by the orchestrator's own `pkill -f "vite"` (intended to clean
  up an unrelated stray process; `"vite"` is a substring of `"vitest"`, so it matched and killed the
  active test run instead) — not a data-loss event, just a wasted run; the next clean run confirmed
  767/767 with no orphaned processes left behind. The live `pc-parts-flipper-dev` service (main
  checkout) was also down after the crash; restarted via the standard `npm run dev` script and
  confirmed to boot clean with no WAL-replay error (the known failure signature from earlier this
  session) — `/health` returned `{"status":"ok"}` and the web port returned 200 within seconds of
  startup.

## Cycle Log

### Cycle 0
Trigger: initial
UAT: not_run
Validation dispatched: 2026-10-09T00:10:23Z — all six builder tasks (T1-T6) reported complete;
spawned R1-R6 (feature-reviewer-medium) and TE1-TE6 (feature-tester-medium) in parallel, scoped
per-task by files touched (not by each task's own cited requirement numbers) — Req 2, 7, 10, 11
each span more than one task's files and were checked against every task whose files they
actually govern. No tester-vs-tester file conflict found (each task's dedicated test files are
disjoint; T5/T6 explicitly scoped to avoid incidental overlap on the two shared fixture files
both already touch), so no serialization was needed — reviewers and testers all dispatched in one
batch.

Results: R1 PASS, TE1 PASS, R2 PASS, TE2 PASS, R3 PASS, TE3 PASS, R4 PASS, TE4 PASS, R5 FAIL,
TE5 PASS, R6 PASS, TE6 PASS.

R5's one must_fix (Req 10, severity med): `identify-parts-status-badge.tsx`'s in-progress pill is
already correctly colored in production (`text-sky-700`, distinct from `EbayScanBadge`'s emerald —
confirmed by direct read), but `apps/web/test/ebay-scan-ui.test.tsx`'s in-progress-stage test only
asserts its text content, never its `className`, unlike the sibling completed/failed-state tests in
the same `describe` block which do assert color class. A color collision with `EbayScanBadge` could
ship silently. Traces back to T5. Fix: add a `className`-contains assertion to that one test,
mirroring the pattern already used two tests below it in the same file — no production code change
needed.

Standing gate (run once, after all twelve children returned and every test file was settled):
- Suite result: **new failure**, reducible to **inherited** (see A13) — `npm test` (full monorepo,
  `packages/shared` + `apps/server` + `apps/web`) showed 1 failure:
  `apps/server/test/listingPhotos.test.ts`'s upload-persists-to-disk case, `ENOENT` on a fresh temp
  dir. Reproduced 3/3 in isolation, including once against base commit `cbb6860` with this feature's
  entire diff `git stash`ed away — fails identically there, so it predates this feature and is not
  its defect. No file this feature touches is implicated. Every other test, across all three
  workspaces, passed: `apps/server` 549/550, `apps/web` 207/207 (27/27 files), `packages/shared`
  10/10 (2/2 files).
- Test count vs `BaselineTests` (738): now 550 + 207 + 10 = **767**, up from 738 — coverage grew, it
  did not shrink. The 29-test rise over the already-746-after-T6 figure breaks down as: TE1 +5
  (packages/shared, closing T1's previously-untested-shape gap), TE2 +2 and TE3 +2 (apps/server,
  closing the T2/T3 zero-coverage gap the orchestrator flagged), TE4 +3 (apps/web, new file), TE5 +8
  (apps/web, 4 header/row-checkbox tests + 4 badge-state tests), TE6 +1 net new (a filter-change
  selection-persistence test; its other change was a rewrite of an existing polling test onto fake
  timers, not a net-new count) — 5+2+2+3+8+1 = 21 more test() cases landed than files_touched-only
  counting would suggest, reconciling against the observed 746→767 delta of 21 once T6's own
  already-counted 8 are excluded from the "new" total.
- `npm run lint`: clean, no output, no violations.
- Gate verdict: **PASS** — the one suite failure is inherited (A13), not new; coverage grew.

Overall cycle verdict: **FAIL** — one must_fix (R5, Req 10 test-coverage gap in
`ebay-scan-ui.test.tsx`), routed back to `feature-build-lead` for reopening against T5. Every other
task (T1-T4, T6) passed both review and test cleanly, and the standing gate itself is clean (modulo
the one pre-existing, now-documented inherited flake).

### Cycle 1
Trigger: feature-validate-lead FAIL — one must_fix (R5, Req 10 test-coverage gap in
`ebay-scan-ui.test.tsx`).

T7 dispatched 2026-10-09T00:50:17Z, fixing R5's must_fix verbatim (test-only change, no production
code touched) — complete 2026-10-09T01:15:00Z.

Between T7's completion and its re-review, the orchestrator independently found and fixed two
stray main-checkout writes from cycle 0's builder dispatches (T3's real work had landed on `main`
only, not the worktree; T4's was a content-identical duplicate) — see A15. The host (WSL) then
crashed; see A17 for the full recovery (Node reinstalled via `~/.nvm`, worktree/git state
unaffected, live `pc-parts-flipper-dev` service restarted clean with no WAL-replay failure, full
suite re-confirmed 767/767 after recovery).

R7/TE7 dispatched 2026-10-09T01:30:00Z: R7 PASS (confirmed the exact `text-sky-700`/
`not text-emerald-700` assertions are present for both non-terminal stages, mirroring the sibling
tests, no production code changed), TE7 PASS (`ebay-scan-ui.test.tsx` 18/18 passing, including the
new assertions).

Standing gate (re-run after recovery, clean environment, no concurrent interference):
- Suite result: **pass** — `npm test` (full monorepo): `apps/server` 550/550, `apps/web` 207/207,
  `packages/shared` 10/10. Total 767/767, matching cycle 0's post-validation count exactly.
- Test count vs `BaselineTests` (738): 767, up 29 — unchanged from cycle 0's figure, T7 added no
  new test cases (it amended two existing assertions, not a new `it()`).
- `npm run lint`: clean, no violations.
- Gate verdict: **PASS**.

Overall cycle verdict: **PASS** — T7's fix confirmed correct by independent re-review and re-test;
every task (T1-T7) now passes both review and test; the standing gate is clean. Proceeding to UAT.

UAT (U1, dispatched 2026-10-09T01:32:09Z, `feature-uat-tester-large`): **FAIL** — one must_fix.

Method: real click-through in Chromium via Playwright (installed this session; `npm install -g
playwright && npx playwright install chromium`) against the worktree's own server
(`PORT=3002`, `DUCKDB_DATA_DIR=.worktrees/bulk-identify-parts/data-uat`, a fresh empty DuckDB
migrated on boot) and its own Vite dev server (`:5174`, `VITE_API_BASE_URL=http://127.0.0.1:3002`),
seeded through the app's own `POST /api/sources` + `POST /api/listings` with 2 Sources and 25
Listings (23 open across 2 pages, 2 rejected). Identify-parts jobs ran for real against the `omp`
binary — no mocks anywhere in the walk.

Requirements 1-11 and 13 all pass live, as do all four Standing Checks. Req 12 passes in half and
fails in half:

- Passing half: loading the queue screen while a row's job is non-terminal does start the 2000ms
  refresh (5 `GET /api/listings` calls in a 10s window), badges advance on their own
  (`In progress`/`Waiting to run…` -> `Failed`/`Complete` with no manual reload), and the interval
  stops once every visible row is terminal (0 calls in a 9s window) and never starts when every
  visible row is at no-job (0 calls in a 7s window).
- Failing half (**must_fix**): nothing refreshes the table *after* the bulk button is clicked.
  `apps/web/src/features/listings-queue/bulk-identify-parts-bar.tsx`'s `onCleared` callback is
  wired in `listings-queue-page.tsx` to `() => setSelectedIds(new Set())` only — it never calls
  `loadListings()`. The polling effect's own guard reads the *last fetched* `listings` array, so
  with every visible row still at `identifyPartsStatus: null` from before the click,
  `hasPendingStatus` is false, no interval is ever armed, and no fetch ever happens. Measured
  directly: after a bulk run that the server confirmed had really queued both selected Listings
  (stages `sourcing_references` and `queued` via `GET /api/listings?status=rejected`), the page sat
  for 190s with **0** `GET /api/listings` requests and both badges frozen at the no-job em dash. A
  manual reload immediately showed `In progress` / `Waiting to run…`, proving the data was there
  all along and only the refresh trigger is missing. Traces to T6.

Fix (one line, plus a test): have the bulk bar's completion callback also re-run the page's
`loadListings()` — e.g. `onCleared={() => { setSelectedIds(new Set()); void loadListings(); }}` —
so the rows the bulk run just enqueued render their non-terminal badges, which then arms the
existing interval. `apps/web/test/bulk-identify-parts-ui.test.tsx` should assert `fetchListings` is
called again after a bulk click resolves; no existing test covers it because each one seeds
`fetchListings` with already-non-terminal rows.

Also noted (not a must_fix): Req 9's `not_found` summary was reproduced end-to-end in the browser
by holding a live 3-row selection in an open page while the server was swapped onto an empty
database — the app has no DELETE listing route, so that swap is the only way to make a selected id
genuinely stop resolving. The bar reported `Queued 0 listing(s) for Identify Parts. 3 not found.`
with no error banner, exactly as specified.

### Cycle 2
Trigger: feature-uat-tester FAIL — one must_fix (Req 12, bulk-click completion never re-triggers
the queue table's refresh, so the just-queued rows' badges stay frozen until a manual reload).

T8 dispatched 2026-10-09T01:35:00Z, fixing the exact root cause: `listings-queue-page.tsx`'s
`onCleared` callback now also calls `loadListings()`, plus a new regression test seeding no-job
rows before the bulk click (the prior tests all seeded already-non-terminal rows, which armed the
interval before the click and hid this exact gap) — complete 2026-10-09T02:00:00Z.

R8/TE8 dispatched 2026-10-09T02:00:00Z: R8 PASS (confirmed the callback change, confirmed
selection-clearing is preserved, confirmed the new test genuinely seeds no-job rows and asserts
`fetchListings` is called a second time after the bulk click), TE8 PASS (11/11 tests passing across
`bulk-identify-parts-ui.test.tsx` and `listings-queue-page.test.tsx`, including the new test).

Standing gate (re-run independently by the orchestrator after T8):
- Suite result: **pass** — `apps/server` 546/550 (2 unrelated flaky failures,
  `identifyPartsConcurrency.test.ts` and `profit.test.ts`, both reproduced passing in isolation —
  same environmental-contention pattern documented in cycle 0/1's A11/A17, not a regression),
  `apps/web` 208/208 (up 1 from 767's web figure, T8's new test), `packages/shared` 10/10. Total
  764 in the flaky run, re-confirmed 208/208 web and lint clean standalone afterward.
- `npm run lint`: clean, no violations.
- Gate verdict: **PASS**.

Overall cycle verdict: **PASS** — T8's fix confirmed correct by independent re-review and re-test.
Proceeding to re-verify Req 12 specifically via a focused UAT pass before closing out U1.

Cycle 2 UAT (U1, re-verification of Req 12's refresh-after-bulk-click path only, dispatched
2026-10-09T02:20:00Z): **PASS**. Cycle 1's UAT had already passed Requirements 1-11 and 13 and
Req 12's other half (polling starts while non-terminal, stops once settled, never starts at
no-job) with real evidence — not re-run here, per the dispatch's explicit scope.

Method: real click-through in headless Chromium via Playwright against the worktree's own server
(`PORT=3003`, `DUCKDB_DATA_DIR=.worktrees/bulk-identify-parts/data-uat2`, a fresh empty DuckDB) and
its own Vite dev server (`:5175`, `VITE_API_BASE_URL=http://127.0.0.1:3003`), seeded through the
app's own `POST /api/sources` + `POST /api/listings`. Identify-parts jobs ran for real against the
`omp` binary. Network requests to `GET /api/listings` were counted directly off Playwright's
`response` event, not eyeballed.

Two fresh Listings were seeded with no job yet (confirmed via `GET /api/listings` showing
`identifyPartsStatus: null` for both before the browser ever opened). In the browser: both rows'
badges showed the no-job em dash on load (2 initial `GET /api/listings` calls, a React effect
double-fire). Both rows were selected via their own checkboxes ("2 selected"), then the bulk
"Identify Parts" button was clicked at t=938ms; the bulk POST resolved and the "Queued 2 listing(s)
for Identify Parts." summary rendered at t=1064ms. A `GET /api/listings` fired at t=1052ms —
immediately after the bulk POST resolved, with no manual reload and no further clicks — and the
badges flipped from the em dash to "Waiting to run…" for both rows at t=1069ms, proving the
`onCleared` callback's `loadListings()` call is what picked up the real, just-queued job state.

Without any further action, the table continued polling on its own: further `GET /api/listings`
calls landed at t=3085ms, 5118ms, 7149ms, 9179ms — each ~2000-2030ms after the last, matching the
polling interval exactly — while badges advanced autonomously through "Waiting to run…" ->
"In progress" -> "Complete" for both rows (one listing reached "Complete" at t=5607ms, the other at
t=9643ms). Once both rows were terminal, polling stopped on its own: 7 total `GET /api/listings`
calls at the moment both badges settled, and still exactly 7 after a further 6-second wait with no
more clicks — confirming the interval correctly tears down once nothing visible is non-terminal,
not just that it starts.

This confirms T8's fix: the bulk click's completion now re-triggers `loadListings()`, which arms
the existing polling effect on its own, closing the exact gap cycle 1's UAT found. U1 is now PASS
in full (Requirements 1-13 and all four Standing Checks all have live or cited evidence across
cycles 1-2); plan Status set to `done`.

