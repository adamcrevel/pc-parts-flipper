Status: ready_for_merge
Cycle: 3 / 3
FeatureStarted: 2026-11-11T05:51:35Z
OrchestrationTokensActual: null
OrchestrationTokensBreakdown: null
Prototype: https://gist.githack.com/adamcrevel/ab26f3322a966bb34e0b0e54f572e1b1/raw/prototype.html
BaselineTests: 1181
BaselineSuite: fail
Issue: https://github.com/adamcrevel/pc-parts-flipper/issues/4
IssueLastSeen: 2026-11-11T05:51:35Z

## Goal

Stop the Listings queue from silently accumulating dead listings, and stop them from cluttering the
actionable queue once found. Today a scan only ever imports new candidates — nothing ever notices
when a previously-imported, still-`open` Listing has sold or been delisted on the marketplace it
came from, so it sits forever requiring the same Accept/Reject decision as a listing that's still
live. This feature adds a direct per-item recheck to the scan pipeline that, once it confirms a
Listing is genuinely gone, automatically moves it to a new terminal `removed` status — out of the
actionable Accept/Reject flow entirely, filterable separately, same as `accepted`/`rejected` already
are — while still showing why (sold vs. simply no longer listed) via a visible badge.

## Requirements

1. `ListingStatus` gains a new terminal value, `'removed'` — a Listing whose own marketplace page
   confirms it's gone, auto-transitioned there by the scan pipeline (Requirement 3), never by a user
   action. `Listing` separately gains `marketplaceStatus` (`'sold' | 'removed' | null`) and
   `marketplaceStatusDetectedAt` (ISO timestamp, or `null`) — nullable, defaulting to `null` for
   every existing and newly-created Listing, carrying *why* a `removed`-status Listing is gone (the
   `status` field alone can't distinguish sold from simply delisted). Neither `marketplaceStatus`/
   `marketplaceStatusDetectedAt`, nor the `'removed'` status value, is ever settable through the
   public `POST /api/listings` / `PUT /api/listings/:id` request body — only the scan pipeline
   (Requirement 3) ever writes them.
2. Accept/Reject stops being offered for a `removed`-status Listing — this already falls out of the
   existing `listing.status === 'open'` guard the Accept/Reject buttons are already conditioned on
   (`apps/web/src/features/listings/listing-list.tsx`); no new conditional logic duplicates it.
3. Each scan pass, for the Source being scanned, considers every one of its already-imported Listings
   still in `open` status whose `externalItemId` did **not** appear among this pass's connector
   results. For each one, before marking anything, run a **direct per-item recheck against that
   specific listing's own marketplace page** — never inferred purely from its absence in one page of
   search results, since a scan can legitimately return fewer/different results for reasons
   unrelated to the item being gone (a `maxPrice` edited, a query term changed, a connector's own
   page-size limit). Only when that direct recheck itself confirms the item is gone does the Listing
   atomically transition `open` → `removed` (guarded the same way `transitionOpenListing` already
   atomically guards every other status transition, so a concurrent user Accept/Reject request and
   this scan-driven transition can never both win), with `marketplaceStatus` and
   `marketplaceStatusDetectedAt` set in that same guarded write.
4. When a `removed`-status Listing's `externalItemId` reappears among a later scan pass's results for
   the same Source, it atomically transitions back `removed` → `open` (same guarded-write pattern,
   guarding on `status = 'removed'` instead), clearing `marketplaceStatus`/
   `marketplaceStatusDetectedAt` back to `null`/`null` — the system always reflects current
   marketplace reality, even if that means a Listing the user had mentally filed as done reappears in
   the actionable queue.
5. A Listing already transitioned to `removed` is never re-verified by a later scan while it stays
   `removed` and still missing (bounded per-item network cost: one recheck per transition, not one
   per listing per scan forever) — only Requirement 4's reappearance check runs against it.
6. ~~eBay's per-item recheck can only ever resolve to `active`/`removed`, never `sold` (404-only
   premise)~~ — **SUPERSEDED in Cycle 3** by a real UAT finding: eBay's Browse API `getItem` does
   NOT 404 identically for sold vs delisted items; it returns HTTP 200 with real
   `estimatedAvailabilities[0].estimatedAvailabilityStatus`/`estimatedAvailableQuantity`/
   `estimatedSoldQuantity`/`itemEndDate` fields even for gone items. Corrected requirement (user
   decision, Cycle 3): eBay's per-item recheck resolves `'active'` only when genuinely still
   available; otherwise `'sold'` when `estimatedSoldQuantity > 0`, else `'removed'` — matching
   Mercari's finer sold/removed split rather than collapsing every gone eBay item to `'removed'`. A
   404 still resolves `'removed'` directly without reading a body. The finer sold/removed split
   itself is a real platform behavior, not a guess — confirmed live against production listings
   (Cycle 3), and stated plainly in the connector's own code comment.
7. Mercari's per-item recheck can genuinely distinguish `sold` from `removed` — confirmed live during
   planning: a real Mercari search response's `itemsList[].status` field carries distinct values
   (`on_sale`, `trading`, and documented but not yet captured `sold_out`) beyond the `on_sale`-only
   set the existing connector already filters search results to. The per-item recheck re-visits that
   same item's own detail page (the exact technique `mercariItemDetail.ts`'s existing description
   fetcher already uses) and reads its current `status` field from the same `__NEXT_DATA__` node;
   confirm live during the build (not guessed) whether that node's `status` field carries the same
   values as the search response's.
8. Facebook Marketplace's per-item recheck is best-effort — no live dedicated-account session exists
   to confirm its exact signal during this work, the same documented limitation the rest of that
   connector already carries. Implemented the same way (direct per-item page visit in the
   authenticated session), flagged plainly as unconfirmed in its own code comment, not presented as
   equally reliable to Mercari's.
9. The Listings queue table shows a visible badge on any Listing currently carrying a
   `marketplaceStatus`, using the exact same shared badge convention already established there
   (`NonWorkingBadge`/`EbayScanBadge`), reading "Sold" or "No longer listed" per Requirement 1.
10. The Listings queue's existing Status filter (`STATUS_OPTIONS` in `listing-list.tsx`, the same
    mechanism `'accepted'`/`'rejected'` already use) gains `'removed'` as a fourth filterable value —
    this is not a new filter feature, it's the existing one already covering every other terminal
    status, now covering this one too.

## Standing checks

- The whole test suite passes, and the test count holds at or above `BaselineTests` (1181: 851
  apps/server + 302 apps/web + 28 packages/shared). `BaselineSuite` is already `fail` on a clean
  `origin/main` checkout before this feature touches anything — 5 `apps/server` test files failed on
  a fresh pristine run via real child-process server spawns timing out under this machine's resource
  contention (the same documented, pre-existing, unrelated flake the prior `marketplace-sources`
  feature's own plan recorded against this exact machine). This feature owes leaving it no worse,
  not repairing it.
- `npm run lint` (eslint.config.mjs) runs clean with no new violation.
- `apps/web` never imports `apps/server` directly (the existing `import/no-restricted-paths` rule).
- All DuckDB access stays inside `apps/server/src/db` — the new columns/enum value are the only
  DB-touching change, reached everywhere else only through
  `apps/server/src/db/queries/listings.ts`'s existing exported functions.
- No new source file exceeds ~200 lines; each task below names the split that keeps it under the cap
  where one is needed.
- Every new source file opens with a block comment explaining its purpose, matching this project's
  existing convention.
- The DuckDB `listing_status` ENUM gains `'removed'` via the exact rebuild-pattern migration helper
  (`rebuildCorruptedCatalog` + the FK-subtree rebuild) `feat/marketplace-sources` already built and
  proved for `platform_type` in `apps/server/src/db/migrate.ts` — reused, not re-solved from scratch.
  A naive `ALTER TYPE ... ADD VALUE` (DuckDB has no such statement at all, confirmed in that prior
  feature) must not be attempted again.
- `marketplaceStatus`/`marketplaceStatusDetectedAt`, and the `'removed'` status value, are never
  readable/settable fields on `ListingRequestBody`/`validateListingInput` (the public HTTP
  request-body validator) — confirmed by a direct read of `listingValidation.ts`, not merely
  asserted. Only `apps/server/src/scan` ever writes them.
- Both of `transitionOpenListing`'s atomically-guarded directions (open→removed, removed→open) are
  proven under a genuine concurrent-write test (a real race between the scan-driven transition and a
  simulated user Accept/Reject on the same Listing), not merely sequential calls in turn — matching
  this project's own existing concurrency-proof convention (`concurrency.test.ts`).
- eBay's `createStatusChecker` implementation resolves `'active'`/`'sold'`/`'removed'` from the real
  200-body availability/sold-quantity/end-date fields (or `'removed'` directly on 404), per
  Requirement 6 as corrected in Cycle 3 — `ebayConnector.test.ts` asserts all three outcomes against
  the real observed response shapes, not merely `'active'`/`'removed'`.

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| PT1 | Clickable HTML prototype covering T7's UI change: a new rose/red MarketplaceStatusBadge (mirroring NonWorkingBadge/EbayScanBadge's convention) shown in the Listings queue table next to the existing badges, and in the Listing detail/edit view's badge row, for a Listing carrying a non-null marketplaceStatus. | prototype | none | complete | 0 | | 2026-11-11T06:30:00Z | 2026-11-11T06:38:07Z | 10 | 2026-11-11T06:30:00Z | 10600 | null | no |
| T1 | Shared types + DB layer. `packages/shared/src/listings.ts`: add `'removed'` to `ListingStatus`; add `MarketplaceListingStatus = 'sold' \| 'removed'` and `marketplaceStatus: MarketplaceListingStatus \| null` / `marketplaceStatusDetectedAt: string \| null` to `Listing` — **do not** add any of these three to `CreateListingInput`/`UpdateListingInput` in this shared file (those back the public HTTP request body; Requirement 1 requires all three stay unreachable from it). `apps/server/src/db/schema.ts`: add `'removed'` to the `listing_status` ENUM statement, and add `ALTER TABLE listings ADD COLUMN IF NOT EXISTS marketplace_status VARCHAR` / `... marketplace_status_detected_at TIMESTAMP` (both nullable, no default) to `ALTER_STATEMENTS`. `apps/server/src/db/migrate.ts`: extend the existing `rebuildCorruptedCatalog`/FK-subtree-rebuild migration helper (built for `platform_type` in `feat/marketplace-sources`) to also cover `listing_status` gaining `'removed'` — read that existing function in full first and extend its pattern, do not write a second, parallel one. `apps/server/src/db/queries/listings.ts`: add `marketplaceStatus`/`marketplaceStatusDetectedAt` (camelCase) to `mapRow`; add both, plus `status`, as optional fields on the DB-layer `UpdateListingInput` (already has `status` — only the two new fields are additions) so `updateListing`'s `buildSetClause` call can write all three together; add a new atomically-guarded function alongside `transitionOpenListing` (e.g. `transitionListingMarketplaceStatus(id, fromStatus, toStatus, marketplaceStatus, marketplaceStatusDetectedAt)`) using the exact same `UPDATE ... WHERE id = $id AND status = $fromStatus` guard pattern, returning whether it actually won the race, for T6 to call in both directions (open→removed and removed→open). MUST FIX (cycle 0 retry 1): `apps/server/src/routes/listingValidation.ts`'s `VALID_STATUSES` array was never extended to include `'removed'` — add it there. Without this fix, `GET /api/listings?statuses=removed` has `'removed'` silently dropped by `parseEnumListParam`, the surviving filter list is empty, and the function returns `undefined` (= "no filter"), so checking the new Removed box in the Listings queue shows every Listing instead of filtering. Add a test exercising this exact query param. | builder | none | complete | 0 | | 2026-11-11T19:19:08Z | 2026-11-11T19:30:26Z | 35 | 2026-11-11T17:43:41Z | 48000 | null | no |
| T2 | `apps/server/src/connectors/types.ts`: add an exported `ListingLiveStatus = 'active' \| 'sold' \| 'removed'` type and an optional `createStatusChecker?(): (externalItemId: string) => Promise<ListingLiveStatus>` method on `MarketplaceConnector`, documented the same way `createDescriptionFetcher` already is — built at most once per scan pass, the returned function reused for every missing-candidate lookup in that pass, so a connector can set up one shared lazily-created resource (an OAuth token, a browser session) inside the closure. Omitting it means "this platform has no per-item status recheck" — the scan service (T6) then skips Requirement 3 entirely for that connector rather than branching on `platformType`. | builder | none | complete | 0 | | 2026-11-11T17:44:46Z | 2026-11-11T17:58:17Z | 15 | 2026-11-11T18:18:41Z | 5600 | 44938 | no |
| T3 | `apps/server/src/connectors/ebayConnector.ts`: implement `createStatusChecker()` reusing `createEbayItemDetailClient`'s existing OAuth-token/host-resolution path (the same lazy-shared-client pattern `createDescriptionFetcher` already uses). Calls `GET /buy/browse/v1/item/{itemId}` for the given `externalItemId`: a 404 resolves `'removed'`; any 2xx resolves `'active'`. **Never resolves `'sold'`** — eBay's Browse API cannot distinguish a sold item from a delisted one (Requirement 6); the function's own doc comment states this plainly, citing the same reasoning `descriptionBackfill.ts`'s existing comment about eBay 404s already uses. Any other non-2xx/non-404 response rethrows as a genuine error (does not silently resolve to any status) — mirrors this project's own existing lesson (the Mercari auth-bypass bug fixed in the prior feature) about never treating an unexpected failure response as a clean, mundane outcome. | builder | T2 | complete | 0 | | 2026-11-11T17:59:17Z | 2026-11-11T18:19:33Z | 25 | 2026-11-11T18:33:41Z | 18700 | 94312 | no |
| T4 | `apps/server/src/connectors/mercariConnector.ts` (splitting a sibling file if needed to stay under the ~200-line cap, mirroring this connector's existing `mercariSearchMapping.ts`/`mercariItemDetail.ts` split). Implement `createStatusChecker()` by navigating to the item's own detail page (`https://www.mercari.com/us/item/<id>/`, the same URL `mercariItemDetail.ts`'s description fetcher already visits) and reading its current `status` field from the same `__NEXT_DATA__` `ItemDetail:<id>` node that fetcher already reads `description` from — **confirm live during this task** (open a real item's detail page in a real browser, read the real `__NEXT_DATA__` payload) whether that node actually carries a `status` field with the same values search results do (`on_sale`, `trading`, and whatever the real sold-state value turns out to be — a live search already confirmed `'on_sale'`/`'trading'` exist; confirm the sold-specific value live too, do not guess it). Map: `'on_sale'` → `'active'`; any other real status value found → `'sold'`; the node/page not found at all (the item's own listing no longer resolves) → `'removed'`. MUST FIX (cycle 0 retry 1): `mercariStatusChecker.ts`'s `readItemStatus` measures cyclomatic complexity 12 (project convention caps at 10, confirmed via a real ad hoc eslint run — `eslint-plugin-complexity` is listed in `package.json` but not wired into a rule, so `npm run lint` alone won't catch this). Flatten or split the six sequential type-guard branches (nextData→props→pageProps→serverState→itemDetail→status). Also bring the file back under the ~200-line cap (currently 223 lines) — split further if the complexity fix alone doesn't do it. | builder | T2 | complete | 0 | | 2026-11-11T19:19:08Z | 2026-11-11T19:30:26Z | 35 | 2026-11-11T18:58:41Z | 14500 | null | no |
| T5 | `apps/server/src/connectors/facebookMarketplaceConnector.ts` (or a sibling file, same split convention as this connector's existing `facebookMarketplaceSession.ts`/`facebookMarketplaceDom.ts`/`facebookMarketplaceListing.ts`). Implement `createStatusChecker()` best-effort: navigate to the listing's own URL in the authenticated session (reusing the existing persisted `storageState`/shared UA, same as this connector's existing description fetch), look for a DOM-rendered "Sold"/"no longer available" indicator vs. the page resolving normally. No real dedicated-account session exists to confirm this live during this work — state that plainly in the function's own top comment, the same honesty this connector's existing `facebookMarketplaceListing.ts` header comment already models for its search/description logic. MUST FIX (cycle 0 retry 1): every sold/removed signal in `facebookMarketplaceStatus.ts` (`SOLD_SELECTOR`, `hasSoldLine`, `UNAVAILABLE_PATTERNS`) is read at whole-document/whole-page-text scope instead of scoped to the item's own PDP container — confirmed live by executing the real classifier: a listing whose own description reads "no longer available at retail" classifies `'removed'`; a related-item tile's own "Sold" line/aria-label classifies the rechecked item `'sold'`; Facebook's own permission/visibility interstitial ("This content isn't available right now") also classifies `'removed'`. Scope all three reads to the item's own PDP container (the connector already has `data-testid` anchors for this, e.g. `marketplace_pdp_sold_pill`/`marketplace_pdp_description`), keeping `'active'` as the fail-safe default when that container can't be found. Add mirror-direction tests to `facebookMarketplaceStatus.test.ts`: realistic "not available" prose on the item's own page → `'active'`, the real interstitial → `'removed'`, a foreign/related-item sold signal → `'active'`, an in-PDP sold pill → `'sold'`. | builder | T2 | complete | 0 | | albert-einstein | 2026-11-11T19:19:08Z | 2026-11-11T19:30:26Z | 35 | 2026-11-11T19:33:41Z | 17500 | null | no |
| T6 | `apps/server/src/scan/scanService.ts`: after the existing new-candidate import loop in `scanSourceWithConnector`, implement Requirements 3-5. Query this Source's currently-`open` Listings whose `externalSource` matches `connector.platformType` and whose `externalItemId` is non-null (reuse `listListings({ sourceId, status: 'open' })` with a `limit` covering every row, the same `limit: total` idiom `routes/listings.ts`'s `listFilteredSummaries` already uses — do not add a new listing query for this part). For each row **missing** from this pass's candidate `externalItemId`s: if `connector.createStatusChecker` exists, build it once (lazy, shared for the whole pass, exactly the `createDescriptionFetcher` pattern already established), call it once per missing row, and on `'sold'`/`'removed'` call T1's `transitionListingMarketplaceStatus(id, 'open', 'removed', status, new Date().toISOString())` — a resolved `'active'` writes nothing (Requirement 3's false-positive guard); a missing row's `marketplaceStatus`/status-checker call is skipped entirely if the connector has none (no flag, no guess). Separately, query this Source's currently-`removed` Listings and, for any whose `externalItemId` **is** present among this pass's candidates, call `transitionListingMarketplaceStatus(id, 'removed', 'open', null, null)` (Requirement 4) — do not run a status-checker call for these, their mere reappearance in results is itself the positive signal. A single row's status-checker call failing (network error, unexpected response) must not abort the whole scan pass — log and continue, the same fail-soft contract `attachCandidatePhotos`/`attachCandidateDescription` already use elsewhere in this file. MUST FIX (cycle 0 retry 1): three of `scanService.test.ts`'s assertions are vacuous — (1) the "status-checker built once per scan pass" proof uses a test with exactly one missing row, so it can't distinguish "built once per pass" from "built once per row"; add a case with 2+ missing rows in one pass asserting the checker-factory is called exactly once. (2) The reappearance (removed→open) path's `externalSource`/`platformType` guard has no test that would catch it breaking — deleting it leaves the suite green; add a test proving a `removed` row from a DIFFERENT platform than the one currently scanning is never touched by this pass's reappearance check. (3) `marketplaceStatusDetectedAt` is only asserted non-null/parseable, never as reflecting this pass's actual detection time — assert it against a real captured timestamp bound (e.g. before/after the scan call), not just "is a date". | builder | T1, T2 | complete | 0 | | albert-einstein | 2026-11-11T19:31:12Z | 2026-11-11T19:38:16Z | 45 | 2026-11-11T20:08:41Z | 24000 | null | no |
| T7 | Web UI. New `apps/web/src/features/listings/marketplace-status-badge.tsx`, mirroring `non-working-badge.tsx`'s exact structure/convention (a `className` prop, `cn()`-composed Tailwind classes, a rose/red color family distinct from `NonWorkingBadge` (amber) and `EbayScanBadge` (emerald)) — renders `Sold` or `No longer listed` text depending on `listing.marketplaceStatus`. Render it in `listing-list.tsx`'s existing badge row (next to `EbayScanBadge`/`NonWorkingBadge`) whenever `listing.marketplaceStatus !== null`, and in the Listing detail/edit view wherever `NonWorkingBadge` is already shown there. `listing-list.tsx`'s `STATUS_OPTIONS` array gains `{ value: 'removed', label: 'Removed' }` (Requirement 10) — the existing filter checkbox UI needs no other change to support it. Confirm (do not assume) that the existing `listing.status === 'open'` guard already hides Accept/Reject for a `'removed'` row with no code change of its own — if any other code path renders those buttons unconditionally, fix that path too, naming it explicitly in this task's own digest. MUST FIX (cycle 0 retry 1): `marketplace-status-badge-visibility.test.tsx`'s null-omission assertions ("omits the badge for a listing with `marketplaceStatus: null`") only check the badge's label text, never that the badge element itself is absent — proven by mutation: deleting the `listing.marketplaceStatus !== null`/`initialValue?.marketplaceStatus !== null` guards in both `listing-list.tsx` and `listing-form.tsx` still leaves all 10 tests passing (the unconditionally-rendered badge just shows an empty, unrecognized-text pill). Fix the assertions to confirm the badge element itself is absent (e.g. `queryByText`/role-based absence check, not just "the specific label text isn't present"), and re-run the same mutation to confirm the strengthened tests now fail without the guards. | builder | T1 | complete | 0 | | 2026-11-11T19:31:12Z | 2026-11-11T19:38:16Z | 25 | 2026-11-11T20:53:41Z | 10300 | null | yes |
| R1 | Review T1's shared types + DB layer (`packages/shared/src/listings.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/db/migrate.ts`, `apps/server/src/db/queries/listings.ts`) against Requirement 1 (marketplaceStatus/marketplaceStatusDetectedAt and `'removed'` never settable via the public POST/PUT body), the atomic-guard clause of Requirements 3-4, and the standing checks on the ENUM-rebuild migration pattern being reused (not a naive `ALTER TYPE`) and on the fields staying unreachable from `ListingRequestBody`/`validateListingInput` (confirm by directly reading `listingValidation.ts`). FAIL: `listingValidation.ts`'s `VALID_STATUSES` was never updated to include `'removed'`, so the web UI's new Removed status-filter checkbox silently applies no filter at all. RETRY 1 VERIFIED — `VALID_STATUSES` now reads `['open','accepted','rejected','removed']` (confirmed by direct read, not just `git diff`); the new `statuses=removed` test in `listings.test.ts` was run for real and passes; independently re-ran `git status --porcelain`/`git diff --stat` against the main checkout (SCRUTINY) — diff --stat fully empty, only four pre-existing unrelated untracked scratch files, nothing under this feature's paths; Req 1 unreachability and the transitionListingMarketplaceStatus CAS-guard clause re-confirmed unchanged by direct read. | reviewer | T1 | complete | 0 | | 2026-11-11T19:42:42Z | 2026-11-11T20:13:13Z | 20 | 2026-11-11T19:42:42Z | 36000 | null | no |
| TE1 | Test T1's DB layer: run/extend `apps/server/test/db.test.ts` and `apps/server/test/listingMarketplaceStatus.test.ts`, proving `transitionListingMarketplaceStatus`'s CAS guard (both open→removed and removed→open directions) holds under a genuine concurrent-write race, per the standing check matching `concurrency.test.ts`'s own convention. | tester | T1 | complete | 0 | | 2026-11-11T19:42:42Z | 2026-11-11T20:13:13Z | 25 | 2026-11-11T19:42:42Z | 42000 | null | no |
| R2 | Review T2's connector contract (`apps/server/src/connectors/types.ts`): `ListingLiveStatus` shape and the `createStatusChecker` optional-method doc comment, against Requirement 3's contract clause (built at most once per scan pass, reused for every missing-candidate lookup, optional so its absence means the scan service skips Requirement 3 for that connector rather than branching on `platformType`). | reviewer | T2 | complete | 0 | | 2026-11-11T18:23:21Z | 2026-11-11T19:03:02Z | 10 | 2026-11-11T18:23:21Z | 10400 | null | no |
| TE2 | Test T2's connector contract: confirm the whole workspace type-checks (`tsc`/build) with every connector (`ebayConnector.ts`, `mercariConnector.ts`, `facebookMarketplaceConnector.ts`) implementing the new optional `createStatusChecker` method against `types.ts`'s declared shape, and confirm `scanService.test.ts` already exercises a connector genuinely lacking the method (the skip-when-absent path). | tester | T2 | complete | 0 | | 2026-11-11T18:23:21Z | 2026-11-11T19:03:02Z | 15 | 2026-11-11T18:23:21Z | 24000 | null | no |
| R3 | Review T3's eBay status checker (`apps/server/src/connectors/ebayConnector.ts`) against Requirement 6 (never resolves `'sold'`, only `'active'`/`'removed'`, any other non-2xx/non-404 response rethrows as a genuine error) and the standing check that eBay's implementation and its own tests never produce or assert a `'sold'` outcome anywhere. | reviewer | T3 | complete | 0 | | 2026-11-11T18:23:21Z | 2026-11-11T19:03:02Z | 15 | 2026-11-11T18:23:21Z | 24000 | null | no |
| TE3 | Test T3's eBay status checker: run/extend `apps/server/test/ebayConnector.test.ts`'s `createStatusChecker` coverage (404→`'removed'`, 2xx→`'active'`, other non-2xx/non-404→throws, and assert `'sold'` is never produced anywhere in this file's tests). | tester | T3 | complete | 0 | | 2026-11-11T18:23:21Z | 2026-11-11T19:03:02Z | 20 | 2026-11-11T18:23:21Z | 11400 | null | no |
| R4 | Review T4's Mercari status checker (`apps/server/src/connectors/mercariConnector.ts`, `apps/server/src/connectors/mercariStatusChecker.ts`) against Requirement 7. SCRUTINY: the task's own literal wording said "any other real status value found → 'sold'"; the builder instead mapped Mercari's own `stop`/`cancel`/`admin_cancel` to `'removed'` (per `REMOVED_ITEM_STATUSES` read out of Mercari's shipped JS chunk) rather than `'sold'`, but by its own admission these specific values, and `sold_out`, were found via static reading of that shipped code, never observed live on a real item page in that state — Requirement 7 says "confirm live during the build (not guessed)". Judge whether reading Mercari's own real shipped source is an acceptable substitute for "confirm live" here, or whether this needs an actual live-observed item in each state before merging. Independently verify what the shipped chunk actually contains yourself (do not trust the builder's quoted JS in `mercariStatusChecker.ts`'s header comment) — fetch it yourself — and if a live item reachable via a real Mercari search in a non-`on_sale`, non-`'sold'`-badge state can be found, check its detail page directly rather than relying on static code alone. Also check this new file against the ~200-line-cap standing check (it is currently 223 lines). FAIL: `mercariStatusChecker.ts`'s `readItemStatus` measures cyclomatic complexity 12 (project convention caps at 10); SCRUTINY resolved — shipped-source reading judged an acceptable, independently-reconfirmed-live substitute for the four unobserved values given bounded blast radius and fail-safe behavior, not itself a must_fix. RETRY 1 VERIFIED — logic split into new `mercariStatusMapping.ts`; manually re-counted cyclomatic complexity: `readItemStatus`/`mapItemStatus` = 2 each, highest function in the three reviewed files (`fetchMercariItemStatus`) = 9, all under cap 10; `mercariStatusMapping.ts`=125 lines, `mercariStatusChecker.ts`=106 lines, `mercariConnector.ts`=116 lines, all under the ~200-line cap; Req 7's mapping substance reconfirmed unchanged via 21/21 passing tests plus 6 independent production-source mutations, all killed. | reviewer | T4 | complete | 0 | | 2026-11-11T19:42:42Z | 2026-11-11T20:13:13Z | 40 | 2026-11-11T19:42:42Z | 55000 | null | no |
| TE4 | Test T4's Mercari status checker: run/extend `apps/server/test/mercariStatusChecker.test.ts` (`on_sale`→`'active'`, `trading`/`sold_out`→`'sold'`, `stop`/`cancel`/`admin_cancel`→`'removed'`, 404/missing-node→`'removed'`, unrecognized status or malformed payload→throws). | tester | T4 | complete | 0 | | 2026-11-11T19:42:42Z | 2026-11-11T20:13:13Z | 25 | 2026-11-11T19:42:42Z | 24000 | null | no |
| R5 | Review T5's Facebook status checker (`apps/server/src/connectors/facebookMarketplaceConnector.ts`, `apps/server/src/connectors/facebookMarketplaceSession.ts`, `apps/server/src/connectors/facebookMarketplaceStatus.ts`) against Requirement 8 (best-effort, flagged plainly as unconfirmed in its own top comment, not presented as equally reliable to Mercari's/eBay's) and Assumption A9's fail-safe convention (throws on missing/expired session, refused navigation, or browser-launch failure rather than guessing a status). FAIL: every sold/removed signal in `facebookMarketplaceStatus.ts` is read at whole-document/whole-page-text scope, so another listing's sold tile, the seller's own prose, or Facebook's permission interstitial can falsely retire or sell a live Listing. FAIL: round 1's two named false positives are genuinely closed (reproduced live against the fixed code via an out-of-tree harness driving the real `collectListingPageSignals`/`classifyListingPageSignals`), but the retry's own new `UNAVAILABLE_CONTAINER_SELECTOR` re-opens the same defect class — its `[role="alert"]` member is a generic, document-wide ARIA live-region selector, not a Marketplace-PDP-specific one; reproduced live: a live listing whose guessed PDP container fails to match, carrying an ordinary page-level alert banner, misclassifies `'removed'` (actual `classifyListingPageSignals` output confirmed). Also, the test fixture's `querySelector` doesn't model real document-order/comma-selector semantics, so it can catch the scope being narrowed but not widened (e.g. a future broad fallback like `'[data-testid=...], [role="main"], body'` would pass every existing test while reintroducing round 1's exact bug on a real page). Traces to T5. | reviewer | T5 | complete | 0 | albert-einstein | 2026-11-11T19:42:42Z | 2026-11-11T20:13:13Z | 25 | 2026-11-11T19:42:42Z | 22000 | null | no |
| TE5 | Test T5's Facebook status checker: run/extend `apps/server/test/facebookMarketplaceStatus.test.ts` (sold/removed DOM-signal classification, the shared `LOGIN_WALL_SELECTOR` auth-failure path throwing rather than guessing, an unrecognized-but-healthy page resolving `'active'`). | tester | T5 | complete | 0 | albert-einstein | 2026-11-11T19:42:42Z | 2026-11-11T20:13:13Z | 30 | 2026-11-11T19:42:42Z | 23000 | null | no |
| R6 | Review T6's scan-pipeline integration (`apps/server/src/scan/scanService.ts`) against Requirements 3-5: direct per-item recheck only for a row missing from this pass's candidates (never inferred from absence alone), the lazy-shared-status-checker-per-pass pattern, both guarded transitions calling T1's `transitionListingMarketplaceStatus` correctly (open→removed on sold/removed, removed→open on reappearance with no status-checker call), no re-verification of an already-`removed` listing while it stays missing, and a single status-checker failure logged and skipped rather than aborting the whole scan pass. Also confirm all DB access here goes only through `apps/server/src/db/queries/listings.ts`'s exported functions (standing check). FAIL: `scanService.test.ts` has three vacuous/unguarded assertions (build-once-per-pass, the removed→open reappearance's cross-platform guard, `marketplaceStatusDetectedAt`'s actual value) that would not catch a real regression in each. RETRY 1 VERIFIED — all three fixes independently mutation-proved (guard/assertion removed → real test failure; restored → green): 2+-missing-row build-once-per-pass case, cross-platform reappearance guard, and the before/after timestamp bracket proved in both directions; every round-1-passed clause (per-item recheck scoping, lazy shared checker, both guarded transitions, no re-verification of an already-removed row, single-failure fail-soft, DB access routed only through queries/listings.ts) re-verified by direct read plus additional mutation. | reviewer | T6 | complete | 0 | albert-einstein | 2026-11-11T19:42:42Z | 2026-11-11T20:13:13Z | 30 | 2026-11-11T19:42:42Z | 28000 | null | no |
| TE6 | Test T6's scan-pipeline integration: run/extend `apps/server/test/scanService.test.ts` (missing-candidate recheck resolving each of active/sold/removed, reappearance reverse-transition, no-repeat-check on a still-missing already-`removed` row across a second pass, connector-without-`createStatusChecker` skip, and a single status-checker failure not aborting the pass). | tester | T6 | complete | 0 | albert-einstein | 2026-11-11T19:42:42Z | 2026-11-11T20:13:13Z | 35 | 2026-11-11T19:42:42Z | 28000 | null | no |
| R7 | Review T7's web UI change (`apps/web/src/features/listings/marketplace-status-badge.tsx`, `apps/web/src/features/listings/listing-list.tsx`, `apps/web/src/features/listings/listing-form.tsx`) against Requirements 2, 9, 10. SCRUTINY: the build-lead's digest reports this builder's first edit/write pass accidentally landed in the main repo checkout (`/mnt/d/repositories/pc-parts-flipper`) instead of this worktree, was self-caught and redone, and was independently verified clean by the build-lead. Independently re-verify this claim is still true right now yourself: run `git status --porcelain` and `git diff --stat` against `/mnt/d/repositories/pc-parts-flipper` directly — do not trust the prior report. SCRUTINY resolved — independently re-ran both commands against the main checkout: empty diff --stat, only pre-existing unrelated untracked files, nothing under `apps/web/src/features/listings/`; the A10 claim holds. RETRY 1 VERIFIED — badge-visibility test's null-omission assertions now check the badge element's own absence via `data-testid`, not just label text; independently re-ran the round-1 mutation (guard weakened to `!== undefined`) and confirmed 3/10 tests now fail as expected, then confirmed exact restore to 10/10 green; Req 2/9/10 clauses (Accept/Reject guard, badge text, STATUS_OPTIONS) re-confirmed unchanged by direct read. | reviewer | T7 | complete | 0 | | 2026-11-11T19:42:42Z | 2026-11-11T20:13:13Z | 20 | 2026-11-11T19:42:42Z | 28000 | null | yes |
| TE7 | Test T7's web UI change: run/extend `apps/web/test/listings-page.test.tsx` and `apps/web/test/marketplace-status-badge-visibility.test.tsx`, and capture real screenshots (a path plus a one-sentence description of what each image shows, including neighbouring elements) proving `MarketplaceStatusBadge` renders in the Listings queue table and in the Listing detail/edit view, and that `STATUS_OPTIONS` offers `'Removed'` — this is a `ui: yes` task, so the standing visual-evidence gate requires screenshots, not DOM queries/computed styles alone. FAIL: the badge-visibility test's null-omission assertions only check label text, so an unconditionally-rendered empty badge (the guard deleted) would still pass; real screenshots were captured and confirm the badge itself renders correctly. RETRY 1 VERIFIED — re-ran the full target test files (34/34 passing); independently reproduced the mutation check (both guards killed, restore confirmed via md5); captured 3 new real Playwright screenshots (queue-table-sold-and-null.png, detail-view-sold.png, detail-view-null.png) under `.claude/feature/stale-listing-detection/screenshots/`, each showing the badge present/absent against a neighbouring listing for direct comparison. | tester | T7 | complete | 0 | | 2026-11-11T19:42:42Z | 2026-11-11T20:13:13Z | 30 | 2026-11-11T19:42:42Z | 165000 | null | yes |
| T8 | Fix `apps/server/src/connectors/facebookMarketplaceStatus.ts`'s `UNAVAILABLE_CONTAINER_SELECTOR` (found during cycle-0-retry-1 re-review — a second, distinct false-positive in the same code T5 just fixed, not a leftover from T5's own original scope): its `[role="alert"]` member is a generic, document-wide ARIA live-region selector, not Marketplace-PDP-specific — a live listing whose guessed PDP container fails to match (likely, since all PDP testids are unverified guesses) but carries an ordinary page-level alert banner (e.g. a privacy notice) misclassifies `'removed'` — confirmed live via the real `classifyListingPageSignals`. Drop `[role="alert"]` (and reconsider `[data-testid="error_page"]`) so the gone-interstitial read stays Marketplace-PDP-specific; add a case where an unmatched PDP + a `[role="alert"]` banner asserts `'active'`, its mirror (a genuine PDP-unavailable region still asserts `'removed'`), and a live-PDP + alert-banner case pinning PDP-over-interstitial precedence. Separately, `facebookMarketplaceStatus.test.ts`'s `fakeDocument`'s `querySelector` returns the PDP region if ANY comma-separated selector part matches, not the first element in real document order, so it can catch scope narrowing but not a future widening regression — make `fakeDocument` honour document order (one ordered element list, return the first match) so a PDP selector that also matches a broad fallback behaves as it would on a real page. DONE — removed both `[role="alert"]` and `[data-testid="error_page"]` from `UNAVAILABLE_CONTAINER_SELECTOR` (builder judged `error_page` also too generic/unverified as PDP-specific, documented in the selector's own comment). `fakeDocument` refactored to one ordered element list with real `querySelector` first-match-in-order semantics; 4 new tests added (unmatched-PDP+generic-alert → active, live-PDP+alert → active/sold precedence x2, genuine interstitial+alert-present → removed). Independently re-ran all 52 tests in `facebookMarketplaceStatus.test.ts` green; independently reproduced the regression by re-inserting `[role="alert"]` into the selector — 1 of the 4 new tests failed as expected (proving the suite is regression-sensitive), then restored the original fixed file and confirmed byte-identical via md5 and 52/52 green again. `npx eslint` on both touched files reported zero violations. MUST FIX (cycle 1 retry 1): (1) `SOLD_SELECTOR`'s `[aria-label^="Sold"]` member is a raw CSS attribute-prefix match with no word boundary — reproduced live: an `aria-label="Soldering iron Hakko FX-888D, photo 1 of 4"` matches it and misclassifies a live listing `'sold'`. Drop the `^=` member, or replace it with the explicit forms it was meant to catch (`[aria-label="Sold out"]`, `[aria-label^="Sold "]`, `[aria-label^="Sold·"]`); pin both directions with tests. (2) The PDP-scoped sold/removed reads (`pdp.querySelector(selectors.sold)`, `hasSoldLine`) only exclude a related-items rail that is a DOM *sibling* of the PDP container — if that rail is instead nested *inside* the PDP container/pagelet (unknowable without a live session), both reads leak; reproduced live two ways: a neighbour tile's own `aria-label="Sold"` and a neighbour's bare "Sold" text line, each retiring a different live listing. Narrow the sold reads to the PDP's own header/price subtree rather than the whole PDP subtree, or document the unverified nesting assumption plainly in the selector's own comment (Requirement 8's convention) if it can't be determined without a live session. Add mirror-direction tests for both fixes. DONE (cycle 1 retry 1) — FIX 1: dropped the `^=` member entirely (not the suggested prefix replacement either — a photo's own aria-label carries the listing title, so any prefix form re-opens the class for a title beginning "Sold as is ..."; pinned by a mutation test); selector is now `[aria-label="Sold"], [aria-label="Sold out"], [data-testid="marketplace_pdp_sold_pill"]`, exact matches only. FIX 2: `readScopedPageSignals` now treats any `a[href*="/marketplace/item/"]` inside the PDP whose numeric id differs from the page's own URL id (or is unreadable) as a foreign tile — the same stable anchor signature `facebookMarketplaceDom.ts` already relies on; foreign tiles are hidden (`display:none`) while `innerText` is read (so nested sold/removed signals inside them are excluded) and restored in `finally`. FIFTH VARIANT found and fixed per this round's explicit instruction to look for one: `SOLD_LINE_PATTERNS`' hyphen form matched "Sold-out edition ..." as a title line (no required whitespace after the hyphen) — tightened so a hyphen needs following whitespace. Verified: 76/76 tests pass (58→76, 18 new, 0 existing edited/removed); 11/11 mutations killed including a mutation applying the task's own suggested prefix-replacement wording (confirming that suggestion itself would have re-opened the class); 10/10 cases reproduced live in real headless Chromium (Playwright, real `collectListingPageSignals`/`classifyListingPageSignals` against `page.route`-served Marketplace-shaped HTML), including hide-and-read exclusion and post-read restoration; `npx eslint` clean on both files; `tsc --noEmit` clean. File is now 304 lines (pre-existing ~200-cap overage grew by +73 from this task's own fix — unlike round 1's +7, this is a real addition for the reviewer to weigh a split against). | builder | T5 | complete | 1 | | albert-einstein | 2026-11-11T22:25:03Z | 2026-11-11T22:40:47Z | 30 | 2026-11-11T21:28:35Z | 24000 | | no |
| R8 | Review T8's fix to `apps/server/src/connectors/facebookMarketplaceStatus.ts`'s `UNAVAILABLE_CONTAINER_SELECTOR` (now narrowed to only `[data-testid="marketplace_pdp_unavailable"]`) against Requirement 8's best-effort/fail-safe convention and the same selector-scope-leakage false-positive class two prior rounds already found in this exact file (T5 original, T5 retry 1). Confirm `[role="alert"]`/`[data-testid="error_page"]` are genuinely gone from this file, and that no other document-wide-generic member remains in any selector this file still reads (`PDP_CONTAINER_SELECTOR`, `SOLD_SELECTOR`, `UNAVAILABLE_CONTAINER_SELECTOR`). SCRUTINY: independently construct at least one adversarial input beyond the builder's own 4 new tests that could still misclassify a live listing `'removed'` or a removed/foreign-tile listing `'active'`/`'sold'` via this same scope-leakage class — reproduce it live against the real `classifyListingPageSignals`/`collectListingPageSignals`, not reasoned about in the abstract. Separately judge whether `facebookMarketplaceStatus.test.ts`'s refactored `fakeDocument` (one ordered element list, first-match-in-order `querySelector`) is actually exercised by a genuine overlapping-match conflict anywhere in the builder's 4 new tests, or whether every one of them uses selectors with no real overlap (which would pass identically under the old buggy model and so prove nothing about document-order fidelity) — if the latter, that is itself a gap to report. Re-confirm the ~200-line-cap standing check against this file's current line count now that the fix added explanatory comments. FAIL: `SOLD_SELECTOR`'s `[aria-label^="Sold"]` prefix-matches unrelated titles like "Soldering iron Hakko FX-888D" (reproduced live in real Chromium against the real classifier, misclassifying a live listing `'sold'`), and the PDP-scoped sold/removed reads can still leak into a related-items rail nested *inside* the PDP's own subtree rather than a sibling of it (round 1's neighbour-tile defect, one level down — two distinct live-reproduced mechanisms). Both are real false-positive regressions in the exact scope-leakage class this task exists to close, traced to pre-existing `facebookMarketplaceStatus.ts` code this task's own review scope covers (not newly introduced by T8's diff itself). The document-order fixture gap (builder's 4 tests don't exercise it) and the `error_page` member's zero test coverage were independently also found by TE8 and already repaired in the live test file this round. FAIL (round 2): `SOLD_LINE_PATTERNS`' volunteered fifth-variant fix added the required-following-whitespace guard to the ASCII hyphen only — the en-dash/pipe/bullet members of the same alternation still bare-match a `Sold<sep>` title prefix with nothing required after it, misclassifying a live listing `'sold'` (reproduced live in real headless Chromium: `Sold–out edition Funko Pop`, `Sold|Trade bundle, RTX 3080`, `Sold•out vinyl reissue box set`). FIX1, FIX2 and the hyphen half of FIX3 are all independently reproduced live and genuinely correct. Separately, judged fresh (not defaulting to round 1's "+7, not-charged" waiver): the file's 304 lines, +73 net from this task's own diff, now needs a two-file split — propose moving the page-reading half (selectors + `readScopedPageSignals`/`collectListingPageSignals`) into a new `facebookMarketplaceStatusDom.ts`, leaving classification logic in this file. | reviewer | T8 | complete | 1 | albert-einstein | 2026-11-11T22:41:58Z | 2026-11-11T23:11:06Z | 20 | 2026-11-11T22:41:58Z | 39500 | null | no |
| TE8 | Test T8's fix: run/extend `apps/server/test/facebookMarketplaceStatus.test.ts`'s existing coverage (52 tests including the builder's 4 new ones) and independently construct at least one adversarial test case beyond those 4 for the same false-positive/false-negative scope-leakage class — a document-wide-generic signal misclassifying a live listing `'removed'`, or an overly broad PDP/sold/interstitial selector misclassifying a removed or foreign-tile listing `'active'`/`'sold'` — proven by actually running it against the real `classifyListingPageSignals`/`collectListingPageSignals`, not merely asserted. Independently verify the `fakeDocument` document-order model is itself correct: construct a genuine comma-selector ordering conflict in the fixture (e.g. two distinct elements each matching a different one of `PDP_CONTAINER_SELECTOR`'s three testid variants, placed in a specific relative order) and confirm `fakeDocument.querySelector` returns whichever is actually first in the fixture's declared document order, not merely whichever selector part is listed first in the comma-joined string. Report the full file's pass/fail counts, including your new case(s). PASS (test-quality defect found and repaired in-file) — ran the existing 52 tests green first, found 3 of the builder's 4 new tests vacuous against their own claimed regression (pre-T8-fix `fakeDocument` returned empty text for every document-scoped element, so no fixture could ever carry the unavailable-pattern text the bug is actually about) and the `error_page` half of the narrowing wholly uncovered; repaired the builder's test (b) and added 5 new tests (N1-N5, one an `it.each` of 2) proven regression-sensitive by a 6-mutation matrix, including an independent document-order proof (two PDP-selector members placed in each relative order, both directions correctly resolved by real document order, not comma-list order) and a GONE_STATUS/live-PDP precedence case. Touched `apps/server/test/facebookMarketplaceStatus.test.ts` only. File now 58/58 green, 647→754 lines. No production misclassification found. FAIL (round 2): independently reproduced the same `SOLD_LINE_PATTERNS` en-dash/pipe/bullet prefix leak live in real headless Chromium (own harness, real `chromium.launch`/`page.route`/`collectListingPageSignals`) and pinned it with 4 new tests (80 total, 76 passed/4 failed); builder's 76/76-test and 11/11-mutation claims both independently re-verified true, but the claimed "10/10 reproduced live" evidence has no artifact anywhere in the repo (playwright is `vi.mock`'d in the committed suite) — flagged as a process risk, not a code must_fix. Touched `apps/server/test/facebookMarketplaceStatus.test.ts` only. | tester | T8 | complete | 1 | albert-einstein | 2026-11-11T22:41:58Z | 2026-11-11T23:11:06Z | 25 | 2026-11-11T22:41:58Z | 46000 | null | no |
| T9 | Fix `apps/server/src/connectors/facebookMarketplaceStatus.ts`'s `SOLD_LINE_PATTERNS` (found during cycle-1-retry-1 re-review — the volunteered fifth-variant fix from T8's own prior retry only guarded the ASCII hyphen member, leaving the other three separator characters in the same alternation unfixed, confirmed live): `/^sold\s*(?:[•|–]|-\s)/i`'s en-dash (`–`), pipe (`\|`), and bullet (`•`) members still bare-match a `"Sold<separator>"` title prefix with nothing required after it (e.g. "Sold–out edition Funko Pop", "Sold\|out edition Funko Pop", "Sold•out edition Funko Pop" all wrongly classify `'sold'`). Require the same following-whitespace (or end-of-string) boundary after every separator character, not just the hyphen — e.g. `/^sold\s*[•|–-](?:\s|$)/i` — then pin both directions (restrictive: "Sold<sep>word" with no following space stays `'active'`; permissive: "Sold <sep> Listed N weeks ago" stays `'sold'`) for all four separator characters, not just the one already covered. Separately, split `apps/server/src/connectors/facebookMarketplaceStatus.ts` (currently 304-305 lines, 70% of the overage from this task's own prior retry alone) back under the ~200-line cap: move the page-reading half (`PDP_CONTAINER_SELECTOR`/`SOLD_SELECTOR`/`ITEM_LINK_SELECTOR`/`UNAVAILABLE_CONTAINER_SELECTOR` with their comment blocks, `BrowserScopeElement`, `ScopeSelectors`, `readScopedPageSignals`, `collectListingPageSignals`) into a new `apps/server/src/connectors/facebookMarketplaceStatusDom.ts` (~170 lines), leaving classification logic (`ListingPageSignals`, `SOLD_LINE_PATTERNS`, `UNAVAILABLE_PATTERNS`, `GONE_STATUSES`, the auth-guard helpers, `hasSoldLine`, `classifyListingPageSignals`) in `facebookMarketplaceStatus.ts` (~135 lines) — mirroring this connector's existing Session/Listing/Dom split convention. Do not delete the file's existing comment-heavy disclosure of unverified selector assumptions (Requirement 8's own convention) to hit the line count. Finally, this is the fourth round of unverifiable "reproduced live in real headless Chromium" claims on this exact file with no committed artifact (`playwright` is `vi.mock`'d in the test file; no `page.route`/`chromium.launch` anywhere in the repo for this connector) — add one real, committed live-Chromium test to `facebookMarketplaceStatus.test.ts` (or a sibling test file), following the precedent `apps/server/test/browserSession.test.ts` already sets for launching a real browser in this test suite, exercising at least the `SOLD_LINE_PATTERNS` fix end to end against a real `page.route`-served Marketplace-shaped HTML page — so a future round's "reproduced live" claim on this file has a real, auditable artifact to point to instead of an unverifiable assertion. DONE — REGEX: `/^sold\s*[•|–-](?:\s|$)/i`, boundary required after all four separators, verified by an exhaustive character audit of every regex/selector in both resulting files (nothing else found). SPLIT: `facebookMarketplaceStatusDom.ts` (182 lines: both selector constants + `BrowserScopeElement`/`ScopeSelectors`/`readScopedPageSignals`/`collectListingPageSignals`) + `facebookMarketplaceStatus.ts` (147 lines: classification logic), callers (`facebookMarketplaceConnector.ts`, its test file) migrated; a pre-edit behaviour inventory of the old file was checked against the two new files to confirm nothing dropped. LIVE TEST: new `apps/server/test/facebookMarketplaceStatusLive.test.ts` (116 lines) launches real headless Chromium via `launchScanBrowser()` (same precedent as `browserSession.test.ts`), serves Marketplace-shaped HTML via real `page.route`, and runs the real `collectListingPageSignals`/`classifyListingPageSignals` — 14 cases (restrictive/permissive/end-of-line × all 4 separators + a neighbour-rail-only case), real run: 14/14 passed. This live run caught a genuine browser-only bug during development (missing UTF-8 charset meant Chromium decoded the routed body as windows-1252, silently breaking the en-dash/bullet cases) — fixed in the fixture. MUTATIONS: 8 against the live test (8/8 killed, including reverting to the old hyphen-only guard); unit suite initially 6/8 against the same mutations (missing a permissive pipe/bullet case and an end-of-line case) — added 3 more rows to close the gap, then 8/8 unit-killed too; 86 unit tests total (was 76, +4 from this round's prior already-failing regression tests now passing, +6 new). Independently re-ran: `tsc --noEmit` clean; eslint with `complexity:10` clean on all 5 touched files; `facebookMarketplaceConnector.test.ts` 58/58 and `browserSession.test.ts` 1/1 still green. CYCLE 2 RETRY 1 DONE — `facebookMarketplaceStatusLive.test.ts`'s fixture now nests the neighbour tile as a real DOM descendant of the PDP container (not a sibling) with its own distinct id, an `aria-label="Sold"` pill, and a bare "Sold" text line, plus three new cases: own-id in-container tile still classifies `'sold'` from its own pill (not excluded), a standalone own-`SOLD_SELECTOR`-pill case (empty-text pill so the innerText path can't mask the selector-read mutation), and a no-PDP real-interstitial case asserting `'removed'`. Real run: 17/17 live tests passing. Re-ran the same mutation set (foreign-tile-exclusion/sold-pill-read/interstitial-read each hard-wired, plus two bonus mutations) against `facebookMarketplaceStatusDom.ts` — 5/5 killed, confirmed restored clean by grep + `tsc --noEmit` + eslint + 163/163 total green across the four related test files (test-file-only change, no production code touched). | builder | T8 | complete | 2 | | albert-einstein | 2026-11-12T00:01:50Z | 2026-11-12T00:06:00Z | 35 | 2026-11-11T23:12:50Z | 14600 | null | no |
| R9 | Re-review T9's cycle-2-retry-1 fix to `apps/server/test/facebookMarketplaceStatusLive.test.ts`'s fixture against R9's own prior FAIL this cycle: the neighbour tile is now nested *inside* the PDP container (not a sibling), carrying its own distinct id, a `SOLD_SELECTOR` pill, and a bare "Sold" text line, and three new cases were added (own-id in-container tile stays 'sold', standalone own-pill-only stays 'sold', no-PDP real interstitial stays 'removed') — 17 live tests now, up from 14. Independently reproduce the three hard-wired mutations the builder claims are now caught (foreign-tile exclusion off, sold-pill read off, interstitial read off) against the real `apps/server/src/connectors/facebookMarketplaceStatusDom.ts`, confirm each one fails a distinct subset of the 17 live tests, then restore the file byte-for-byte and re-confirm 17/17 green — do not trust the builder's own mutation report. Do not re-litigate the `SOLD_LINE_PATTERNS` boundary fix or the file split — both already independently verified clean twice this cycle; only re-open either if something looks wrong. | reviewer | T9 | complete | 2 | albert-einstein | 2026-11-12T00:13:21Z | 2026-11-12T00:34:10Z | 20 | 2026-11-12T00:13:21Z | 55000 | null | no |
| TE9 | Test T9's cycle-2-retry-1 fix: run the real `apps/server/test/facebookMarketplaceStatusLive.test.ts` yourself, confirm it still launches a genuine (not mocked) headless browser, and now passes 17/17 (up from 14 — 3 new cases: own-id in-container tile stays 'sold', standalone own-pill-only stays 'sold', no-PDP real interstitial stays 'removed'). Independently construct and run at least one mutation of your own against the three previously-vacuous reads (foreign-tile exclusion, sold-pill read, interstitial read) in `apps/server/src/connectors/facebookMarketplaceStatusDom.ts` and confirm each is now genuinely caught by the live suite — restore the file afterward and re-confirm clean (byte-diff + green re-run). Confirm `facebookMarketplaceStatus.test.ts`'s unit suite, `facebookMarketplaceConnector.test.ts`, and `browserSession.test.ts` are all still green, and `tsc --noEmit`/eslint compile clean. | tester | T9 | complete | 2 | albert-einstein | 2026-11-12T00:13:21Z | 2026-11-12T00:34:10Z | 25 | 2026-11-12T00:13:21Z | 46000 | null | no |
| T10 | UAT ran a real scan against the production eBay Source (166 stale listings from Oct 16) and found Requirement 6's factual premise false: eBay's `GET /buy/browse/v1/item/{id}` does NOT 404 identically for sold vs delisted items — it returns HTTP 200 with real availability fields even for gone items (observed live: `estimatedAvailabilities[0].estimatedAvailabilityStatus`, `estimatedAvailableQuantity`, `estimatedSoldQuantity`, `itemEndDate`), so `apps/server/src/connectors/ebayConnector.ts`'s `checkItemStatus` (every 2xx → `'active'`, body never read) never retires a stale eBay listing. Of the 166 real listings swept, ~137 are actually gone (118 `OUT_OF_STOCK` with `itemEndDate` in the past, 19 `OUT_OF_STOCK` with no end date but `estimatedAvailableQuantity: 0` and `estimatedSoldQuantity` 2–6, 8 `IN_STOCK` with `itemEndDate` in the past) and ~20 are genuinely still live (`IN_STOCK`, not ended). User's explicit decision: implement the fuller fix, matching Mercari's finer sold/removed split rather than collapsing everything to `'removed'`. In `checkItemStatus`: on a 2xx response, read the body's `estimatedAvailabilities[0].estimatedAvailabilityStatus`/`estimatedAvailableQuantity`/`estimatedSoldQuantity`/`itemEndDate`. Resolve `'active'` only when the item is genuinely still available (`estimatedAvailabilityStatus !== 'OUT_OF_STOCK'` and no past `itemEndDate`). Otherwise the item is gone: resolve `'sold'` when `estimatedSoldQuantity > 0`, else `'removed'` (covers the 19 OUT_OF_STOCK-with-no-sold-quantity case and the 8 ended-but-IN_STOCK case, and the 20-genuinely-live case stays `'active'`). Keep the existing 404 → `'removed'` branch (an item that 404s was never observed to report a sold quantity). Update the file's header/doc comment (currently states eBay "never resolves 'sold'" and 404s identically either way) to describe the real basis plainly: 200 + availability/sold-quantity/end-date fields, not 404, and that eBay can now resolve `'sold'` when its own `estimatedSoldQuantity` signal is present. Update `apps/server/test/ebayConnector.test.ts`'s `createStatusChecker` cases accordingly — the existing `expect(status).not.toBe('sold')` assertions (lines ~559, 574, 645) are now wrong for the fuller fix and must be replaced with cases that actually assert `'sold'`/`'removed'`/`'active'` against each of the four real shapes UAT observed (OUT_OF_STOCK+past-end-date+sold>0 → sold; OUT_OF_STOCK+no-end-date+qty0+sold>0 → sold; OUT_OF_STOCK+past-end-date+sold=0 or absent → removed; IN_STOCK+past-end-date → removed; IN_STOCK+not-ended → active; 404 → removed). After the fix, re-run UAT's own eBay scan against a copy of the real production DuckDB (the isolated copy UAT already made is at `/tmp/uat-stale/pc-parts-flipper.duckdb`, or a fresh copy of `data/pc-parts-flipper.duckdb`) and confirm the ~137 gone rows leave the open queue (split correctly between `'sold'`/`'removed'`) while the ~20 genuinely-live rows stay `'open'`. DONE — `checkItemStatus` now parses the 2xx body (`EbayItemAvailability`/`itemEndDate` added to `EbayItemDetail`) through a new exported pure `classifyEbayItemStatus(detail, now)`: `'active'` iff not `OUT_OF_STOCK` and no past `itemEndDate`, else `'sold'` when `estimatedSoldQuantity > 0` else `'removed'`; 404 branch and non-404 `AppError(502)` throw unchanged. Doc comment rewritten to state the real 200-body basis. `ebayConnector.test.ts`: the three now-wrong `not.toBe('sold')` cases replaced with real-shape sold/removed/active assertions (10 cases) plus a `classifyEbayItemStatus` describe pinning the end-date boundary, unparseable dates, and `LIMITED_STOCK` staying not-gone — suite 45/45 (was 33). `tsc --noEmit`/eslint/complexity all clean. 11/11 mutations killed (ignore-out-of-stock, ignore-end-date, end-date-flip, end-date-inclusive-nan, sold-threshold-ge, sold-removed-swap, always-active, and-to-or, limited-stock-gone, drop-404-branch, body-ignored). Offline replay of UAT's own 166-row real snapshot through the new classifier: 118+19=137 → sold, 6 → removed, 2 → sold (IN_STOCK+past-end+sold>0), 1 (404) → removed, 20 → active. LIVE RE-RUN: fresh copy of UAT's own DB, real eBay credentials, real scan — 140 rows sold, 6 removed, 20 stay open (166 before: all open); 165/166 match the offline snapshot exactly, the 1 discrepancy (`v1|407288406768|0`) is eBay itself answering inconsistently across probes (404 once, 200 OUT_OF_STOCK/sold=1 three times) — both branches resolve it to a retired status either way, consistent with spec. | builder | T3 | complete | 3 | albert-einstein | 2026-11-12T01:57:10Z | 2026-11-12T02:09:02Z | 35 | 2026-11-12T01:56:14Z | 24000 | null | no |
| R10 | Review T10's fuller eBay status-classification fix (`apps/server/src/connectors/ebayConnector.ts`'s `classifyEbayItemStatus`, `checkItemStatus`, `EbayItemAvailability`/`EbayItemDetail`) against Requirement 6 as corrected by UAT/cycle-3 (eBay's 200-body `estimatedAvailabilities[0].estimatedAvailabilityStatus`/`estimatedAvailableQuantity`/`estimatedSoldQuantity`/`itemEndDate` fields, not 404-only, decide `'active'`/`'sold'`/`'removed'`), the standing check that the file's own doc comment states the real 200-body basis plainly (not the old disproven 404-only premise), and the standing check that eBay's implementation is no longer barred from producing `'sold'` (Requirement 6's original never-`'sold'` constraint is gone this cycle — confirm the doc comments/tests were updated consistently, not left half-describing the old premise). Judge the classification boundary itself: `'active'` iff not `OUT_OF_STOCK` and no past `itemEndDate`; otherwise gone, `'sold'` when `estimatedSoldQuantity > 0` else `'removed'`; 404 still resolves `'removed'` directly without reading a body; any other non-2xx/non-404 still throws `AppError(502)` rather than guessing. Independently verify the builder's live re-run claim against real code: using the real captured sweep snapshot (`/tmp/uat-stale/ebay-sweep.json`, 166 rows) and the real `classifyEbayItemStatus`/`checkItemStatus` as they exist in the file right now, re-derive the classification decision for a sample of rows by hand (pick at least one from each of the four real shapes: OUT_OF_STOCK+past-end+sold>0, OUT_OF_STOCK+no-end+qty0+sold>0, IN_STOCK+past-end+sold=0, IN_STOCK+not-ended) and confirm the aggregate 139 sold/7 removed/20 active split the snapshot itself implies is what the real code actually produces — do not take the builder's "offline replay" and "live re-run" numbers on their own say-so. PASS — boundary, 404/throw branches, doc comments, and all 6 real-shape test cases confirmed exact; independently reproduced 139 sold/7 removed/20 active over all 166 real rows via `tsx`-imported real `classifyEbayItemStatus`/`checkItemStatus` (5 deterministic runs, 0 disagreements with an independent hand-rule cross-check); 15/16 hand-applied mutations killed, 2 non-blocking surviving mutants noted (exact-millisecond end-date equality; a defensive no-op body-read inserted into the already-correct 404 branch) — neither a requirement-level gap. Zero must_fix. | reviewer | T10 | complete | 3 | albert-einstein | 2026-11-12T02:13:15Z | 2026-11-12T02:33:20Z | 25 | 2026-11-12T02:13:15Z | 27000 | null | no |
| TE10 | Test T10's fuller eBay status-classification fix: run/extend `apps/server/test/ebayConnector.test.ts`'s `createStatusChecker`/`classifyEbayItemStatus` coverage — confirm the 10 real-shape sold/removed/active assertions (OUT_OF_STOCK+past-end-date+sold>0→sold, OUT_OF_STOCK+no-end-date+qty0+sold>0→sold, OUT_OF_STOCK+past-end-date+sold=0/absent→removed, IN_STOCK+past-end-date→removed, IN_STOCK+not-ended→active, 404→removed) plus the `classifyEbayItemStatus` describe block (end-date boundary, unparseable dates, `LIMITED_STOCK` staying not-gone) all genuinely pass, and that none of the old `expect(status).not.toBe('sold')` assertions remain. Independently reproduce the builder's 11/11 mutation-kill claim (ignore-out-of-stock, ignore-end-date, end-date-flip, end-date-inclusive-nan, sold-threshold-ge, sold-removed-swap, always-active, and-to-or, limited-stock-gone, drop-404-branch, body-ignored) by actually hand-mutating `classifyEbayItemStatus`/`checkItemStatus` and re-running the suite, restoring the file afterward and reconfirming clean (byte-diff + green re-run). Separately, using the real captured sweep snapshot (`/tmp/uat-stale/ebay-sweep.json`) and the real `classifyEbayItemStatus` imported directly (not a reimplementation), classify all 166 rows yourself and confirm the aggregate split (139 sold/7 removed/20 active, matching the single 404-vs-200-flake item `v1|407288406768|0` the builder's digest names) actually comes out of the real code — this is the same re-derivation R10 is doing independently; do not coordinate answers, just both confirm the real code produces it. `tsc --noEmit`/eslint clean on the touched file. PASS — 45/45 green; 16/16 hand-mutations killed (the builder's 11 plus 5 of the tester's own, pinning the end-date and sold-threshold boundaries in both directions); real 166-row snapshot replayed through the real (not reimplemented) `classifyEbayItemStatus`/`checkItemStatus` gave exactly 139 sold/7 removed/20 active, with `v1|407288406768|0` confirmed as the one row this snapshot recorded via its 404 branch; `tsc --noEmit`/eslint clean; scratch replay script removed, repo clean. Zero must_fix. | tester | T10 | complete | 3 | albert-einstein | 2026-11-12T02:13:15Z | 2026-11-12T02:33:20Z | 30 | 2026-11-12T02:13:15Z | 26000 | null | no |


## Assumptions

- A1 (cycle 0): `ListingStatus` gains exactly one new value, `'removed'`, covering both `sold` and
  generically `removed` at the workflow-status level — the finer sold-vs-removed distinction lives
  only in the separate `marketplaceStatus` field (for the badge's text), per the user's explicit
  "a different state" (singular) correction mid-planning. Two separate terminal statuses were
  considered and rejected as unrequested extra workflow complexity.
- A2 (cycle 0): The missing/reappeared comparison (Requirements 3-5) is scoped to a Source's `open`
  and `removed` Listings only — an `accepted` Listing has already become a Purchase (no longer
  actionable either way) and a `rejected` one was already dismissed by the user; recomputing either
  wastes a per-item network call for no decision the user can still make.
- A3 (cycle 0): `BaselineTests`/`BaselineSuite` were recorded against a fresh `origin/main` checkout
  (post `feat/marketplace-sources` merge) before this feature touches anything, per the standing
  rule's own instruction — the 5 already-failing `apps/server` test files are the same documented
  resource-contention flake the prior feature's own plan recorded on this machine, not this
  feature's responsibility to fix.
- A4 (cycle 0): `feature-issues.py list` returned no in-flight peer features at planning time — no
  coordination needed.
- A5 (cycle 0, T1): `migrateListingStatusAddRemoved`'s FK-subtree rebuild is scoped to only the
  tables actually on a foreign-key path rooted at `listings` (sales, sale_listings,
  teardown_results, identify_parts_jobs, part_reference_photos, parts, expected_parts, purchases,
  listings) — narrower than the prior `platform_type` migration's subtree, which also had to touch
  `sources`/`sale_listings` for reasons specific to that column. No table outside this subtree
  references `listing_status`.
- A6 (cycle 0, T2): `createStatusChecker`'s returned function type follows the existing
  `DescriptionFetcher` naming convention, since the task description only specified the method's
  inline signature, not a name for the function-type alias itself.
- A7 (cycle 0, T3): `createStatusChecker`'s factory/function-type names match T2's already-shipped
  `types.ts` exactly (`createStatusChecker`/`StatusChecker`), not a `DescriptionFetcher`-style alias
  the task prose implied — A6 above turned out not to hold once T2 actually landed; T3 followed the
  real shipped contract rather than the plan's earlier guess.
- A8 (cycle 0, T4): Mercari's own shipped production JS (`ITEM_STATUS`/`REMOVED_ITEM_STATUSES`,
  confirmed live by reading Mercari's own served chunk) groups `'stop'`/`'cancel'`/`'admin_cancel'`
  as removed, separate from `'sold_out'` — mapped those three to `'removed'` rather than `'sold'`,
  diverging from the task's literal "any other status value found → sold" wording, because following
  that wording verbatim would reintroduce the sold-vs-removed conflation this feature exists to fix.
  `'sold_out'` itself, and the three removed-group values, were found in Mercari's own code but never
  independently observed on a real item's live detail page during this work (no sold/removed item id
  was reachable via search to walk to its detail page) — flagged explicitly as such in
  `mercariStatusChecker.ts`'s own header comment, not presented as equally confirmed as
  `'on_sale'`/`'trading'`/404.
- A9 (cycle 0, T5): Facebook's `createStatusChecker` throws (rather than resolving a guessed status)
  on a missing/expired session, a refused navigation (403/429/5xx), or a browser-launch failure —
  matching T3's eBay convention of never silently resolving an ambiguous/failure outcome to a
  confident status the scan service would act on. An unrecognized-but-healthy page resolves
  `'active'` for the same fail-safe reason. Sold-vs-removed DOM signals themselves are unverified
  (no dedicated Facebook session exists in this environment) and ranked below eBay's/Mercari's
  reliability in both the new file's header comment and the factory's own top comment.
- A10 (cycle 0, T7): T7's builder's first edit/write pass unintentionally landed in the main checkout
  (`/mnt/d/repositories/pc-parts-flipper`) instead of this worktree, using repo-relative paths
  without the worktree prefix — caught via a failed test run (file not found), self-reverted with
  `git checkout --` on the two tracked files and deletion of the two new untracked files in the main
  checkout, then redone with explicit absolute worktree paths. Verified clean afterward by the
  build-lead: `git status` in the main checkout shows no tracked changes and no untracked files under
  `apps/web/src/features/listings/`.
- A11 (cycle 0, validate): `measure-child-cost.py`'s OMP tag-matching returned a non-null number for
  all 14 R/TE dispatches in this cycle, but direct inspection (grep + mtime compare) showed every
  query actually false-matched this lead's OWN top-level transcript (`ValidateCycle0-2.jsonl`, which
  partially echoes dispatched task text and is always the most-recently-modified file while this
  lead is still running) rather than any child's real transcript — the exact failure mode this
  project's own prior `marketplace-sources` feature retrospective already documented and resolved
  (`AGENT_TAG: review T13`/`test T13` false-matching the lead's own echoed dispatch prompt). Per that
  same precedent, every row's `actual_tokens` is written `null`, not the bogus printed numbers.
- A12 (cycle 0, validate): R4's SCRUTINY judgment (Mercari live-confirmation, Requirement 7) —
  reading Mercari's own real shipped production source for `sold_out`/`stop`/`cancel`/`admin_cancel`
  is treated as sourced fact, not a guess, and satisfies Requirement 7's intent even though it is not
  literally "confirmed live" for those four values; R4 independently re-fetched Mercari's live chunk
  today and reconfirmed the quoted constants byte-for-byte, and separately reconfirmed `on_sale`/
  `trading` against fresh live items. Not escalated to `must_fix`: the checker fails safe (throws
  rather than guessing on any unrecognized value) and the blast radius is bounded to the
  `marketplaceStatus` badge text alone (the `ListingStatus` transition is the same `'removed'` value
  either way per A1). A live `sold_out`/`stop`/`cancel`/`admin_cancel` item remains unreachable via
  Mercari's own client-rendered search in this environment.
- A13 (cycle 0, validate): R7's SCRUTINY re-verification (T7's stray main-checkout edit, A10) was run
  independently today, directly against `/mnt/d/repositories/pc-parts-flipper` — `git diff --stat`
  empty, `git status --porcelain` shows only four pre-existing unrelated untracked scraper-output
  files and `artifacts/`, nothing under `apps/web/src/features/listings/` or elsewhere related to
  this feature. A10's claim holds.
- A14 (cycle 0, validate): `VALID_STATUSES` in `apps/server/src/routes/listingValidation.ts` (R1's
  finding) sits outside every builder task's named file list — no task in this cycle owned it — yet
  Requirement 10's new filterable `'removed'` value silently depends on it. Routed back to the build
  lead as a `must_fix` against T1 (the task that introduced the new `ListingStatus` value) rather than
  T7 (whose `STATUS_OPTIONS` UI change is itself correct and inert without this fix).
- A15 (cycle 0, validate retry 1): `measure-child-cost.py`'s OMP tag-matching was re-confirmed false
  for every one of this round's 10 R/TE dispatches, the same failure A11 already documented —
  direct inspection (`_find_omp_transcript_by_tag`'s own matching logic, run by hand against every
  tag) showed `review T1`/`test T1` false-matching this lead's own two most-recent top-level
  transcripts (`ValidateRetry1-2.jsonl`/`ValidateCycle0-2.jsonl`), and every other tag
  (`review/test T4`, `review/test T5`, `review/test T6`, `review T7`, `test T7`) false-matching
  unrelated sessions from entirely different projects dated 2026-10-02/10-06/10-16 — weeks before
  this feature existed. Every row's `actual_tokens` is written `null`, not the printed numbers.
- A16 (cycle 1, R8/TE8 round 2, validate): `measure-child-cost.py`'s OMP tag-matching was re-confirmed
  false for this round's 2 dispatches (`review T8`/`test T8`) — both printed the identical figure
  (243365), and direct inspection (`_find_omp_transcript_by_tag`'s own matching logic, run by hand
  against each tag) showed both false-matching the exact same file,
  `sessions/.../2026-10-06T07-59-48-663Z_.../BreezyGrasshopper.jsonl`, a session dated weeks before this
  feature existed — the same failure A11/A15 already documented, a third time. Both rows' `actual_tokens`
  are written `null`, not the printed number.
- A17 (cycle 2, R9/TE9, validate): `measure-child-cost.py`'s OMP tag-matching was re-confirmed false
  for this round's 2 dispatches (`review T9`/`test T9`) — both printed the identical figure (97371),
  and direct inspection (`_find_omp_transcript_by_tag`'s own matching logic, run by hand against each
  tag) showed both false-matching this lead's own top-level transcript
  (`sessions/.../2026-10-16T18-36-24-573Z_.../ValidateCycle2-2.jsonl`), a session dated weeks before
  this feature existed — the same failure A11/A15/A16 already documented, a fourth time. Both rows'
  `actual_tokens` are written `null`, not the printed number.
- A18 (cycle 2, R9/TE9 retry-1 round, validate): `measure-child-cost.py`'s OMP tag-matching was
  re-confirmed false for this round's 2 dispatches (`review T9`/`test T9`) — both printed the
  identical figure (134645), and direct inspection (`_find_omp_transcript_by_tag`'s own matching
  logic, run by hand against each tag) showed both false-matching the exact same file A17 already
  named, `sessions/.../2026-10-16T18-36-24-573Z_.../ValidateCycle2-2.jsonl`, a session dated weeks
  before this feature existed — the same failure A11/A15/A16/A17 already documented, a fifth time.
  Both rows' `actual_tokens` are written `null`, not the printed number.
- A19 (cycle 3, R10/TE10, validate): `measure-child-cost.py`'s tag-matching was re-confirmed false
  for this round's 2 dispatches (`review T10`/`test T10`) — this host has no `CLAUDE_CODE_SESSION_ID`
  set, so the script fell back to its OMP-session tag-matching path (the same one A11/A15/A16/A17/A18
  already documented as unreliable here), printing 121903 and 250761 respectively. Direct inspection
  (`_find_omp_transcript_by_tag`'s own matching logic, run by hand against each tag) showed both tags'
  most-recently-modified match was the exact same file, this lead's own current top-level transcript
  (`sessions/--mnt-d-repositories-pc-parts-flipper--/2026-10-16T18-36-24-573Z_.../ValidateCycle3.jsonl`,
  mtime matching this lead's own live activity) — confirmed beyond doubt by finding the literal string
  `AGENT_TAG: review T13` inside that same file: no `T13` task exists anywhere in this feature: that
  string is this lead's own system-prompt text (the worked example documenting A11's original failure
  mode), echoed into its own transcript, which the script's naive substring search then matched. The
  same failure A11/A15/A16/A17/A18 already documented, a sixth time. Both rows' `actual_tokens` are
  written `null`, not the printed numbers.





## Cycle Log

### Cycle 0
Trigger: initial
Findings:
- [T1] apps/server/src/routes/listingValidation.ts's VALID_STATUSES never extended to include
  'removed' — GET /api/listings?statuses=removed silently applies no filter at all.
- [T4] apps/server/src/connectors/mercariStatusChecker.ts's readItemStatus measures cyclomatic
  complexity 12 (cap 10); file is also 223 lines, over the ~200-line cap.
- [T5] apps/server/src/connectors/facebookMarketplaceStatus.ts reads every sold/removed signal at
  whole-document scope instead of the item's own PDP container — a related listing's sold tile, the
  item's own prose, or Facebook's permission interstitial can falsely retire or sell a live Listing.
- [T6] apps/server/test/scanService.test.ts has three vacuous assertions: the build-once-per-pass
  proof can't distinguish per-pass from per-row; the removed→open reappearance's cross-platform
  guard has no test that would catch it breaking; marketplaceStatusDetectedAt is only asserted
  non-null, never as reflecting the actual detection time.
- [T7] apps/web/test/marketplace-status-badge-visibility.test.tsx's null-omission assertions only
  check label text, not that the badge element itself is absent — an unconditionally-rendered empty
  badge would still pass.
Retries: T1, T4, T5, T6, T7 retried in place (cycle 0 retry 1) — each must_fix was confined to its
own single task, so none opened a new cycle. T2, T3 passed clean, no retry needed.

### Cycle 0 Retry 1
Trigger: re-review/re-test of T1, T4, T5, T6, T7's cycle-0-retry-1 fixes.
Findings:
- [T5] apps/server/src/connectors/facebookMarketplaceStatus.ts's new `UNAVAILABLE_CONTAINER_SELECTOR`
  re-opens the whole-document-scope defect class round 1 flagged: its `[role="alert"]` member is a
  generic, document-wide ARIA live-region selector, not Marketplace-PDP-specific — reproduced live
  (out-of-tree harness driving the real `collectListingPageSignals`/`classifyListingPageSignals`): a
  live listing whose guessed PDP container fails to match, carrying an ordinary page-level alert
  banner, misclassifies `'removed'`. The test fixture's `querySelector` also doesn't model real
  document-order/comma-selector semantics, so it can catch the scope narrowing but not widening.
Clean: T1, T4, T6, T7's retry-1 fixes all independently re-verified and re-reproduced (not merely
re-read) — R1's SCRUTINY (main-checkout cleanliness) and R5's SCRUTINY (false-positive reproduction
against the fixed code) both executed as directed; no new findings against T1, T4, T6, T7.
Retries: T5 needs a second retry (cycle 0 retry 2) — must_fix confined to T5's own file and test
fixture, so no new cycle opens. T1, T4, T6, T7 are done for this cycle.

### Cycle 1
Trigger: T5's second failure this cycle (feature-validate-lead, cycle 0 retry 1 re-review) — a
must_fix landing on a task already retried once this cycle, per Step 4.3's rule (the validate-lead's
own digest characterized this as a same-cycle "retry 2," but the skill's rule requires a new cycle
once a task has already had its one free in-place retry this cycle — corrected here by the
orchestrator).
Findings:
- [T5, now T8] apps/server/src/connectors/facebookMarketplaceStatus.ts's `UNAVAILABLE_CONTAINER_SELECTOR`
  (added by the cycle-0-retry-1 fix itself) re-opens the same false-positive class it was meant to
  close: its `[role="alert"]` member is a generic, document-wide selector, not PDP-specific — a
  listing whose guessed PDP container fails to match but carries an ordinary page alert banner
  misclassifies `'removed'`, confirmed live. The test fixture's `querySelector` also doesn't model
  real document order, so it catches scope narrowing but not widening.
UAT: not_run

### Cycle 1, R8/TE8 (T8 review/test round)
Trigger: T8 builder fix complete, dispatched for review/test per standard flow.
Findings:
- [T8] apps/server/src/connectors/facebookMarketplaceStatus.ts's `SOLD_SELECTOR` member
  `[aria-label^="Sold"]` is a raw CSS attribute-prefix match with no word boundary — reproduced live
  in real Chromium against the real `classifyListingPageSignals`: an `aria-label="Soldering iron
  Hakko FX-888D, photo 1 of 4"` matches it, misclassifying a live Soldering-iron listing `'sold'`.
  Separately, the PDP-scoped sold/removed reads (`pdp.querySelector(selectors.sold)`, `hasSoldLine`)
  only exclude a related-items rail that is a DOM *sibling* of the PDP container — if that rail is
  instead nested *inside* the PDP container/pagelet (unknowable without a live session, same
  unverified footing as every selector here), both reads leak, reproduced live two ways: a
  neighbour's own `aria-label="Sold"` tile and a neighbour's bare "Sold" text line, each retiring a
  different live listing. Both are the same scope-leakage false-positive class T5/T8 already fixed
  once each, one level down. Traces to T8 (the task whose review scope covers this file); neither
  member was touched by T8's own diff, both pre-date it.
Clean: T8's actual diff (the `UNAVAILABLE_CONTAINER_SELECTOR` narrowing to only
`[data-testid="marketplace_pdp_unavailable"]`, and the `error_page`/`role="alert"` removal) is
itself correct, plainly documented in the selector's own comment, eslint-clean, and the ~200-line
cap overage (231 lines) pre-dates this task's diff (net +7 lines), not charged to it. TE8
independently found and repaired, in the live test file, the test-quality gap R8 separately also
flagged: 3 of the builder's 4 new tests were vacuous against their own claimed regression (the old
`fakeDocument` carried no text on any document-scoped element, so no fixture could ever build the
condition the bug is about) and the `error_page` half of the narrowing had zero test coverage; TE8
added 5 new tests (N1-N5) proven regression-sensitive by a 6-mutation matrix, including an
independent, successful proof that the refactored `fakeDocument`'s document-order model is correct
(two PDP-selector members placed in each relative order, both directions resolved correctly by
document order rather than comma-list order) — this closes R8's F5/F4 findings without a further
retry needed on the test file itself.
Retries: T8 needs a retry (same cycle, first retry for T8) — both must_fix findings (`SOLD_SELECTOR`
prefix match, PDP-subtree sold/removed leak) are confined to `facebookMarketplaceStatus.ts`'s
production code; the test file's own gap is already resolved, so a T8 retry's test-side work is
pinning the two new fixes, not repairing coverage already fixed this round.

### Standing gate (cycle 1, R8/TE8 round)
Full suite run: `npm run test` (node 22.23.3). apps/server: 3 test files failed (`profit.test.ts`,
`purchases.test.ts`, `listingPhotos.test.ts`), 67 passed (70 total); 1 test failed, 939 passed, 8
skipped (948 total). apps/web: 30/30 files, 312/312 tests green. packages/shared: 4/4 files, 28/28
tests green. All 3 apps/server failures confirmed by direct read to use the exact
`startTestServer` real-child-process-spawn pattern the documented `BaselineSuite: fail` flake
already names (`profit.test.ts`/`purchases.test.ts`: `beforeAll` hook timeout spawning the test
server, cascading to `afterAll`'s `server.stop()` on `undefined`; `listingPhotos.test.ts`: its own
header comment says it "follows the same real-server-via-child-process pattern as
listings.test.ts / concurrency.test.ts", failing here on an ENOENT race against a
`pc-parts-flipper-concurrency-*` temp dir) — all three inherited, none traced to this feature's
code. Test count: 948 (server) + 312 (web) + 28 (shared) = 1288, vs `BaselineTests: 1181` — rose,
did not shrink (TE8's own 6 additions are part of this rise). Gate (a) passes on the inherited
exception; gate (b) passes outright.

### Cycle 1, R8/TE8 round 2 (T8 retry-1 re-review/re-test)
Trigger: T8's cycle-1-retry-1 fix (DONE (cycle 1 retry 1), the two must_fix items from round 1 plus a
volunteered fifth-variant fix) dispatched for its second R8/TE8 review/test round.
Findings:
- [T8] apps/server/src/connectors/facebookMarketplaceStatus.ts's `SOLD_LINE_PATTERNS` (line 50) — the
  volunteered fifth-variant fix added the required-following-whitespace guard to the ASCII hyphen only;
  the en-dash (–), pipe (|) and bullet (•) members of the same alternation still bare-match a
  `Sold<separator>` title prefix with nothing required after it, so `Sold–out edition Funko Pop`,
  `Sold|Trade bundle, RTX 3080` and `Sold•out vinyl reissue box set` all misclassify a live listing
  `'sold'` — the exact prefix-leak class this task exists to close, one separator character over.
  Independently reproduced three ways: R8's own live headless-Chromium harness (real `chromium.launch`,
  `page.route`-served HTML, the real `collectListingPageSignals`/`classifyListingPageSignals`), TE8's
  independent live harness plus 4 new unit tests pinning both directions, and this round's standing-gate
  full-suite run itself, which fails exactly those 4 new tests in `facebookMarketplaceStatus.test.ts`.
- [T8] File-size standing check: the file is now 304-305 lines against the ~200-line convention, +73 net
  from this task's own diff alone (round 1's own +7 growth was waived as pre-existing/not-charged; R8 was
  explicitly asked to judge this fresh rather than default to that waiver, given the different order of
  magnitude). R8's ruling: needs the split now — this feature's own Cycle 0 precedent already charged and
  split a smaller overage (`mercariStatusChecker.ts` at 223 lines), this task's diff alone is 70% of the
  current overage, it is a wholly new source file (the exact subject of the check), and every sibling
  connector file but one is 34-205 lines. Proposed seam: move the page-reading half
  (`PDP_CONTAINER_SELECTOR`/`SOLD_SELECTOR`/`ITEM_LINK_SELECTOR`/`UNAVAILABLE_CONTAINER_SELECTOR` with
  their comment blocks, `BrowserScopeElement`, `ScopeSelectors`, `readScopedPageSignals`,
  `collectListingPageSignals`) into a new `facebookMarketplaceStatusDom.ts` (~170 lines), leaving the
  classification logic (`ListingPageSignals`, `SOLD_LINE_PATTERNS`, `UNAVAILABLE_PATTERNS`,
  `GONE_STATUSES`, the auth-guard helpers, `hasSoldLine`, `classifyListingPageSignals`) in
  `facebookMarketplaceStatus.ts` (~135 lines).
Clean: FIX1 (`SOLD_SELECTOR` narrowing), FIX2 (foreign-tile hide-and-read exclusion, both the originally
reported nested-rail leak and the own-item-signal-still-fires counter-case) and the hyphen half of FIX3
(`SOLD_LINE_PATTERNS`) are all genuinely correct and independently reproduced live by both R8 and TE8,
each pinned by their own mutation matrices (R8: 7/7 killed; TE8: 12 unit + 6 live mutations, 18/18
killed). Round 1's own fix (`[role="alert"]`/`[data-testid="error_page"]` removal) still holds live. No
other document-wide-generic selector member remains in `PDP_CONTAINER_SELECTOR`/`SOLD_SELECTOR`/
`UNAVAILABLE_CONTAINER_SELECTOR`. The builder's 76/76-test and 11/11-mutation claims both independently
reproduced true (TE8 ran a superset — 12 unit mutations, 18/18 killed overall). The builder's "10/10
reproduced live in real headless Chromium" claim, however, has no artifact anywhere in the repo
(`playwright` is `vi.mock`'d in the committed test file; no `page.route`/`setContent`/`chromium.launch`
appears repo-wide) — R8 and TE8 each built their own independent live harness rather than taking the
claim on its say-so, and both confirm the three underlying fixes genuinely hold live even though the
builder's own claimed evidence is unreproducible after the fact. Not escalated to a production must_fix
(no code defect) but flagged for the build lead: this project already has precedent for a committed
real-browser test (`apps/server/test/browserSession.test.ts`), and a fourth straight round of an
unverifiable "reproduced live" claim on this exact file is itself a process risk worth closing.
Retries: T8 needs a fix — both must_fix items are confined to `facebookMarketplaceStatus.ts` (the
`SOLD_LINE_PATTERNS` character class, and the file split). T8 already used its one in-place retry this
cycle (cycle 1 retry 1); per the same rule the orchestrator applied when Cycle 1 itself opened (a
must_fix landing on a task already retried once this cycle opens a new cycle rather than a second
in-place retry), this looks like it should open Cycle 2 — flagged for the orchestrator/build lead to
apply; not applied here.

### Standing gate (cycle 1, R8/TE8 round 2)
Full suite run: `npm run test` (node 22.23.3, direct PATH prepend — the documented `source nvm.sh && nvm
use` shell form exits 3 with no output in this environment, the same finding TE8 reported). apps/server:
5 test files failed, 65 passed (70 total); 5 tests failed, 956 passed, 9 skipped (970 total). An
immediate same-suite re-run of apps/server alone shows a DIFFERENT 4 of the 5 failing files
(`identifyPartsConcurrency.test.ts`, `profit.test.ts`, `saleListings.test.ts`, `listingPhotos.test.ts`)
flaking between runs — consistent with the documented pre-existing resource-contention flake
(`BaselineSuite: fail`, "5 apps/server test files failed ... via real child-process server spawns timing
out under this machine's resource contention"). The fifth failing file,
`facebookMarketplaceStatus.test.ts` (4 tests), is NOT part of that flake population — it fails
deterministically on both runs, on the exact `SOLD_LINE_PATTERNS` leak R8/TE8 both independently
reproduced live above; this is a new, real regression traced to T8, not inherited. apps/web: 30/30
files, 312/312 tests green. packages/shared: 4/4 files, 28/28 tests green. Test count: 970 (server) +
312 (web) + 28 (shared) = 1310, vs `BaselineTests: 1181` — rose, did not shrink (TE8's own 4 new
adversarial tests are part of this rise, same pattern as last round). Gate (a) FAILS on
`facebookMarketplaceStatus.test.ts`'s 4 genuine failures (must_fix, traced to T8); the other 4 failing
files are the documented inherited exception. Gate (b) passes.

### Cycle 2
Trigger: T8's second failure this cycle (feature-validate-lead, cycle 1 retry 1 re-review) — a
must_fix landing on a task already retried once this cycle, per Step 4.3's rule (validate-lead
flagged this correctly for the orchestrator without altering Cycle numbering itself this time).
Findings:
- [T8, now T9] apps/server/src/connectors/facebookMarketplaceStatus.ts's `SOLD_LINE_PATTERNS`
  fifth-variant fix only guarded the ASCII hyphen separator; the en-dash/pipe/bullet members of the
  same alternation still bare-match a "Sold<separator>" title prefix with nothing required after
  it, confirmed live three independent ways (reviewer's own harness, tester's own harness, this
  round's standing-gate suite run itself, deterministically on both runs). Separately, the file is
  now 304-305 lines (70% of the overage from this task's own prior retry alone) — reviewer ruled,
  on fresh judgment as instructed, that it now needs a two-file split (unlike round 1's much
  smaller +7-line growth, waived as pre-existing).
UAT: not_run

### Cycle 2, R9/TE9 (T9 review/test round)
Trigger: T9 builder fix complete, dispatched for review/test per standard flow.
Findings:
- [T9] `apps/server/test/facebookMarketplaceStatusLive.test.ts` — the new live-Chromium artifact
  genuinely launches a real headless browser (independently confirmed by both R9 and TE9: R9 via
  `PLAYWRIGHT_BROWSERS_PATH` pointed at a nonexistent dir, which breaks the run inside
  `browserSession.ts`'s real `chromium.launch`; TE9 via `pgrep` during the run, observing real
  Playwright Chromium OS processes) and genuinely proves the `SOLD_LINE_PATTERNS` four-separator
  fix end to end (R9's M1/M2 mutations — boundary removed entirely, and the exact pre-T9
  hyphen-only shape — are both killed live and in the unit suite). But three of its cases
  (neighbour-tile exclusion, sold-pill read, gone-interstitial read) are vacuous: disabling each of
  the underlying pre-existing (T8) scoping mechanisms in turn leaves all 14 live tests green (R9's
  M3/M4/M5), so the live artifact doesn't prove what its own case names claim for anything beyond
  the separator regex itself.
Clean: The `SOLD_LINE_PATTERNS` fix itself is correct and complete — both R9 and TE9 independently
swept every BMP code point (plus astral-plane and lone-surrogate forms) through the real classifier
in both directions and found no sixth bare-prefix-leak variant; the regex requires the same
trailing boundary after all four separators, confirmed by hand-built strings evaluated directly
against the live pattern. The file split is complete — 19 top-level declarations inventoried across
the two new files, none duplicated or orphaned, both under the ~200-line cap (147 + 182 lines),
callers (`facebookMarketplaceConnector.ts` and its test) migrated with no stale imports anywhere in
`apps/server`. `tsc --noEmit`, eslint, and the `facebookMarketplaceConnector.test.ts`/
`browserSession.test.ts` suites are all independently confirmed still green. A concurrent-write
collision occurred mid-round (TE9's own mutation-probe break/run/restore pass against
`facebookMarketplaceStatusDom.ts` left line 48 mutated — `PDP_CONTAINER_SELECTOR`'s first entry
read `'body'` instead of the real testid selector — while R9 was independently reading the same
file); both R9 and TE9 detected this themselves via mtime/content mismatch, restored the original
bytes from their own pre-mutation snapshots, and re-verified the restoration three ways each
(byte/md5 comparison, a full green re-run, and `grep` for the mutated literal returning zero hits).
Retries: T9 needs a retry (first retry this cycle) — the must_fix is confined to
`facebookMarketplaceStatusLive.test.ts`'s own fixture (R9's concrete fix: move the neighbour tile
inside the PDP container with its own `aria-label="Sold"` pill and a distinct id, add a case for a
sold-pill-only page and a case for a no-PDP/unavailable-interstitial page) — no production code
defect, so this does not reopen a new cycle.

### Standing gate (cycle 2, R9/TE9 round)
Full suite run: `npm run test` (node 22.23.3, direct PATH prepend). apps/server: 4 test files failed
(rotating membership between flaking files — a same-suite re-run of apps/server alone showed a
DIFFERENT 3 of the 4 failing, `parts.test.ts`/`profit.test.ts`/`listingPhotos.test.ts` instead of the
first run's set), 67 passed (71 total); 1 test failed, 982 passed, 9 skipped (992 total). Every
failure confirmed by direct read to use the exact `startTestServer` real-child-process-spawn
`beforeAll` timeout / cascading `afterAll` pattern (or, for `listingPhotos.test.ts`, the documented
ENOENT race against a shared `pc-parts-flipper-concurrency-*` temp dir) the `BaselineSuite: fail`
flake and Cycle 1's own standing-gate entries already name — none touch
`facebookMarketplaceStatus`/`facebookMarketplaceStatusDom`/their test files, so none trace to T9.
apps/web: 30/30 files, 312/312 tests green. packages/shared: 4/4 files, 28/28 tests green. Test
count: 992 (server) + 312 (web) + 28 (shared) = 1332, vs `BaselineTests: 1181` — rose, did not
shrink. Gate (a) passes on the inherited exception (no new regression this round); gate (b) passes
outright. No `ui: yes` task this cycle (T9 is `ui: no`) — visual evidence gate does not apply.

### Cycle 2, R9/TE9 round 2 (T9 cycle-2-retry-1 re-review)
Trigger: T9's cycle-2-retry-1 fix complete, dispatched for its second R9/TE9 review/test round.
Findings: none. Both R9 and TE9 independently reproduced the fix closing last round's gap:
`facebookMarketplaceStatusLive.test.ts`'s fixture now nests the neighbour tile as a real DOM
descendant of the PDP container (not a sibling), carrying a distinct item id, its own
`SOLD_SELECTOR` pill, and its own bare "Sold" text line — 17 live tests now (was 14). Each of the
three previously-vacuous reads (foreign-tile exclusion, own-pill read, interstitial read) was
independently re-broken by hand: the lead ran 3 hard-wire mutations before dispatch, R9 ran 6 of
its own (including both directions of the exclusion boundary and a text-hide-off variant isolated
from the pill-exclusion variant), and TE9 ran 8 of its own, none overlapping either the lead's or
R9's — 17 independent mutations total against this gap, every one killed on a correctly-attributed
subset of the 17 live cases, file confirmed restored byte-identical (md5
acd4056cced982458132f0adb71b0a29) after each, independently reconfirmed by the lead directly before
this entry was written.
Clean: `tsc --noEmit` and eslint clean on every touched file; 164/164 green across the four related
test files (`facebookMarketplaceStatus.test.ts` 88 + `facebookMarketplaceStatusLive.test.ts` 17 +
`facebookMarketplaceConnector.test.ts` 58 + `browserSession.test.ts` 1). The `SOLD_LINE_PATTERNS`
boundary fix and the file split were not re-litigated (both independently verified clean twice
already this cycle) and nothing concretely wrong was spotted in either while in the files.
Non-blocking note: both R9 and TE9 independently surfaced the same residual coverage nuance and
ruled it non-blocking for the same reason — the live fixture now places every element (own pill,
own lines, neighbour tile) inside the single PDP container, so a hypothetical document-scope-
instead-of-PDP-scope regression in the pill read (`facebookMarketplaceStatusDom.ts:154`) or text
read (`:164`) would pass all 17 live cases. Not unguarded: the unit suite's `fakeDocument` (which
exposes only `querySelector`, not `querySelectorAll`/`document.body`) still turns red on exactly
that regression, via a `TypeError` from the stub's missing surface rather than a classification
assertion — a real, if indirect, guard. Neither reviewer nor tester escalated this to must_fix;
flagged for awareness only, with a cheap optional fixture remedy named in R9's own digest
(`neighbourOutsidePdp` case) if the build lead wants the live artifact's own coverage restored.
Process note: R9 and TE9 ran concurrent break-run-restore mutation sweeps against the same
untracked `facebookMarketplaceStatusDom.ts` and clobbered each other's intermediate state twice
before each independently detected it (md5 drift mid-sweep), coordinated via IRC, rebuilt their
runners to snapshot-verify pristine before and after every single mutation, and re-ran solo; both
finished with the file confirmed byte-identical to pristine and the 4-file suite green.
Retries: none — T9 passes clean. This closes Cycle 2 for T9.

### Standing gate (cycle 2, R9/TE9 retry-1 round)
Full suite run: `npm run test` (node 22.23.3, direct PATH prepend). apps/server: 5 test files failed,
66 passed (71 total); 2 tests failed, 982 passed, 11 skipped (995 total). Every failure confirmed by
direct read to be the exact documented pre-existing flake: `app-shell.test.ts`/
`identifyPartsRoute.test.ts`/`profit.test.ts` each a real `startTestServer` child-process-spawn
`beforeAll` hook timeout cascading to `afterAll`'s `server.stop()` on `undefined`;
`gracefulShutdown.test.ts` a spawned server hitting `EADDRINUSE` on the shared test port and never
becoming healthy within 90s; `listingPhotos.test.ts` the documented ENOENT race against a shared
`pc-parts-flipper-concurrency-*` temp dir. None touch
`facebookMarketplaceStatus`/`facebookMarketplaceStatusDom`/`scanService`/their test files — none
trace to T9. apps/web: 30/30 files, 312/312 tests green. packages/shared: 4/4 files, 28/28 tests
green. Test count: 995 (server) + 312 (web) + 28 (shared) = 1335, vs `BaselineTests: 1181` — rose,
did not shrink (T9's own +3 live test cases are part of this rise). Gate (a) passes on the inherited
exception (no new regression this round). Gate (b) passes outright. No `ui: yes` task this cycle
(T9 is `ui: no`) — visual evidence gate does not apply.
UAT: FAIL (2026-11-12). All scan-pipeline mechanics, Mercari's live sold/removed split, the UI badge,
and every other requirement independently re-verified against a real copy of the production DuckDB
(497 pre-existing eBay listings + Mercari) — PASS. But eBay retired 0 of 166 stale real listings:
Requirement 6's premise ("eBay's getItem 404s identically whether sold or delisted") is false live —
getItem actually returns HTTP 200 with real `estimatedAvailabilityStatus`/`estimatedAvailableQuantity`/
`estimatedSoldQuantity`/`itemEndDate` fields even for gone items, and `checkItemStatus` maps every 2xx
to `'active'` without reading the body. ~137 of the 166 real listings are actually gone (118
OUT_OF_STOCK past-end-date, 19 OUT_OF_STOCK no-end-date/qty0/sold 2-6, 8 IN_STOCK past-end-date); ~20
are genuinely live. Facebook Marketplace's live DOM path remains blocked (no dedicated session in this
sandbox, same limitation as `feat/marketplace-sources`) — only its fail-safe throw was observed.
Routed to the user: implement the fuller fix (resolve `'sold'` when `estimatedSoldQuantity > 0`,
matching Mercari's finer split, rather than collapsing every gone eBay item to `'removed'`) — approved,
now T10 (cycle 3).

### Cycle 3
Trigger: UAT failure (feature-uat-tester-xlarge) — `ebayConnector.ts`'s `checkItemStatus` never
retires a real stale eBay listing because Requirement 6's stated factual basis for the 404-only
premise is wrong live; this was never caught by any prior review/test round because none tested
against real production sold/ended eBay listings (only synthetic 404-vs-200 cases).
Findings:
- [T3, now T10] `ebayConnector.ts`'s `checkItemStatus` reads only HTTP status (404 → removed,
  anything else 2xx → active) and never reads the 200 response body's availability/sold-quantity/
  end-date fields — on real eBay data, ~137 of 166 stale listings are genuinely gone but were all
  left `'open'`. User decision: resolve `'sold'` when `estimatedSoldQuantity > 0`, else `'removed'`,
  for any OUT_OF_STOCK or past-`itemEndDate` response; keep the existing 404 → `'removed'` branch.
UAT: not_run

### Cycle 3, R10/TE10 (T10 review/test round)
Trigger: T10 builder fix complete, dispatched for review/test per standard flow.
Findings: none. Both R10 and TE10 independently re-derived the classification decision for real rows
across all four of UAT's observed shapes (OUT_OF_STOCK+past-end+sold>0, OUT_OF_STOCK+no-end+qty0+
sold>0, IN_STOCK+past-end+sold=0, IN_STOCK+not-ended) against the real `classifyEbayItemStatus`/
`checkItemStatus` as they exist in the file right now (imported directly via `tsx`, never a
reimplementation), and each independently replayed the full real 166-row captured UAT sweep snapshot
(`/tmp/uat-stale/ebay-sweep.json`) through that real code: both got exactly 139 sold / 7 removed / 20
active, matching the builder's own "offline replay" claim exactly, and both confirmed the single
404-vs-200 discrepancy item the builder's digest named (`v1|407288406768|0`) is recorded with `code:
404` in this snapshot — explaining why the builder's separate LIVE re-run against production (which hit
a live 200+sold response for that same item instead) landed on 140/6/20 rather than 139/7/20; either
outcome retires the item, so this is eBay's own live inconsistency, not a classifier defect. The
classification boundary itself (active iff not OUT_OF_STOCK and no past itemEndDate; otherwise sold iff
estimatedSoldQuantity > 0, else removed), the 404-direct-to-removed branch, and the non-404 throw are
all confirmed to match Requirement 6 as corrected this cycle. The file's doc comments were confirmed to
state the real 200-body basis plainly, with no leftover text implying the old disproven 404-only
premise. `ebayConnector.test.ts` has zero remaining `expect(status).not.toBe('sold')` assertions and
genuinely covers all 6 real shapes plus the classifier's own boundary/unparseable-date/LIMITED_STOCK
cases — 45/45 green (confirmed independently by both). TE10 independently reproduced all 11 of the
builder's claimed mutation kills, plus 5 of its own pinning the end-date and sold-threshold boundaries
in both directions (16/16 killed total); R10 independently hand-mutated 16 of its own and found 15/16
killed, surfacing two non-blocking surviving mutants (an exact-millisecond itemEndDate equality edge,
and a defensive no-op body-read that could be inserted into the already-correct 404 branch with no
observable effect on any real eBay 404 body) — neither escalated, since Requirement 6's actual
guarantees (404 ⇒ removed without reading a body; a gone item split sold/removed on its real
estimatedSoldQuantity) are fully mutation-proven. `tsc --noEmit`/eslint clean on both touched files per
both agents.
Retries: none — T10 passes clean. This closes Cycle 3 for T10.

### Standing gate (cycle 3, R10/TE10 round)
Full suite run: `npm run test` (node 22.23.3, direct PATH prepend — the documented `source nvm.sh &&
nvm use` shell form still exits 3 with no output in this environment). apps/server: 3 test files
failed, 68 passed (71 total); 1 test failed, 1001 passed, 5 skipped (1007 total). Every failure
confirmed by direct read to be the exact documented pre-existing flake named in `BaselineSuite: fail`
and every prior cycle's own standing-gate entries: `app-shell.test.ts` and `profit.test.ts` each a real
`startTestServer` child-process-spawn `beforeAll` hook timeout (30000ms) cascading to `afterAll`'s
`server.stop()` on `undefined`; `listingPhotos.test.ts` the documented ENOENT race against a shared
`pc-parts-flipper-concurrency-*` temp dir. None touch `ebayConnector.ts`, `classifyEbayItemStatus`,
`checkItemStatus`, or `ebayConnector.test.ts` — none trace to T10. apps/web: 30/30 files, 312/312 tests
green. packages/shared: 4/4 files, 28/28 tests green. Test count: 1007 (server) + 312 (web) + 28
(shared) = 1347, vs `BaselineTests: 1181` — rose, did not shrink. Gate (a) passes on the inherited
exception (no new regression this round). Gate (b) passes outright. No `ui: yes` task this cycle (T10
is `ui: no`) — visual evidence gate does not apply.

### UAT re-run (cycle 3, post-T10)
Trigger: re-run UAT after T10's eBay fix and its R10/TE10 PASS.
Result: PASS. Against a fresh copy of the real production DuckDB (497 pre-existing listings + new
Mercari/manual rows), a real eBay scan now splits 140 'sold' / 6 'removed' / 20 still-'open' out of
166 previously-stuck stale listings, independently cross-checked against 9 raw `GET
/buy/browse/v1/item/{id}` bodies fetched outside any connector code. Both transition directions
(open→removed and removed→open) re-proven live on real eBay data (not just Mercari, this time), with
Requirement 5's no-repeat-recheck bound holding across two further passes. Mercari's live sold/removed
split re-confirmed (`sold_out` observed live in a real search response for the first time, beyond
A8/A12's static-source-only confirmation). UI badges/filter/no-Accept-Reject, forbidden-field
hardening, and every standing check re-verified live and independently (not re-using the cycle-3
validate-lead's standing gate's own numbers beyond citing it for the whole-suite result). Two
environmental (not feature) gaps: Facebook Marketplace's live DOM path remains blocked (no dedicated
session in this sandbox, same as `feat/marketplace-sources`' own UAT); Mercari's removed→open reversal
pass hit a 25-minute Cloudflare 403 lockout on `searchFacetQuery` after repeated headless searches —
Requirement 4 itself is proven live on eBay through the same connector-agnostic pipeline code, so this
is recorded as an environmental note, not a gap in the feature. Updated Requirement 6's wording in
this plan (struck through the superseded 404-only premise, documented the corrected basis) and the
matching standing-check line, to keep the plan's own text truthful rather than leaving it
contradicted by the shipped code.
UAT: PASS (2026-11-12). Ready for merge.
