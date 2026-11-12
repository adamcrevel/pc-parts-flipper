Status: proposed
Cycle: 0 / 3
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
6. eBay's per-item recheck can only ever resolve to `active` (still found) or `removed` (gone) —
   **never `sold`**. Confirmed via eBay's own Browse API documentation/developer forums: `getItem`
   returns an identical 404 whether an item sold or was simply delisted; the Browse API serves only
   active listings and has no endpoint this project is credentialed for that distinguishes the two.
   This is a real platform limitation, not an implementation gap — stated plainly in the connector's
   own code comment, not silently narrowed.
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
- eBay's `createStatusChecker` implementation and its own tests never produce or assert a `'sold'`
  outcome — only `'active'`/`'removed'` — proving Requirement 6's limitation is actually enforced in
  code, not just described in a comment.

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| PT1 | Clickable HTML prototype covering T7's UI change: a new rose/red MarketplaceStatusBadge (mirroring NonWorkingBadge/EbayScanBadge's convention) shown in the Listings queue table next to the existing badges, and in the Listing detail/edit view's badge row, for a Listing carrying a non-null marketplaceStatus. | prototype | none | complete | 0 | | 2026-11-11T06:30:00Z | 2026-11-11T06:38:07Z | 10 | 2026-11-11T06:30:00Z | 10600 | null | no |
| T1 | Shared types + DB layer. `packages/shared/src/listings.ts`: add `'removed'` to `ListingStatus`; add `MarketplaceListingStatus = 'sold' \| 'removed'` and `marketplaceStatus: MarketplaceListingStatus \| null` / `marketplaceStatusDetectedAt: string \| null` to `Listing` — **do not** add any of these three to `CreateListingInput`/`UpdateListingInput` in this shared file (those back the public HTTP request body; Requirement 1 requires all three stay unreachable from it). `apps/server/src/db/schema.ts`: add `'removed'` to the `listing_status` ENUM statement, and add `ALTER TABLE listings ADD COLUMN IF NOT EXISTS marketplace_status VARCHAR` / `... marketplace_status_detected_at TIMESTAMP` (both nullable, no default) to `ALTER_STATEMENTS`. `apps/server/src/db/migrate.ts`: extend the existing `rebuildCorruptedCatalog`/FK-subtree-rebuild migration helper (built for `platform_type` in `feat/marketplace-sources`) to also cover `listing_status` gaining `'removed'` — read that existing function in full first and extend its pattern, do not write a second, parallel one. `apps/server/src/db/queries/listings.ts`: add `marketplaceStatus`/`marketplaceStatusDetectedAt` (camelCase) to `mapRow`; add both, plus `status`, as optional fields on the DB-layer `UpdateListingInput` (already has `status` — only the two new fields are additions) so `updateListing`'s `buildSetClause` call can write all three together; add a new atomically-guarded function alongside `transitionOpenListing` (e.g. `transitionListingMarketplaceStatus(id, fromStatus, toStatus, marketplaceStatus, marketplaceStatusDetectedAt)`) using the exact same `UPDATE ... WHERE id = $id AND status = $fromStatus` guard pattern, returning whether it actually won the race, for T6 to call in both directions (open→removed and removed→open). | builder | none | not_started | 0 | | | | | 35 | | | | no |
| T2 | `apps/server/src/connectors/types.ts`: add an exported `ListingLiveStatus = 'active' \| 'sold' \| 'removed'` type and an optional `createStatusChecker?(): (externalItemId: string) => Promise<ListingLiveStatus>` method on `MarketplaceConnector`, documented the same way `createDescriptionFetcher` already is — built at most once per scan pass, the returned function reused for every missing-candidate lookup in that pass, so a connector can set up one shared lazily-created resource (an OAuth token, a browser session) inside the closure. Omitting it means "this platform has no per-item status recheck" — the scan service (T6) then skips Requirement 3 entirely for that connector rather than branching on `platformType`. | builder | none | not_started | 0 | | | | | 15 | | | | no |
| T3 | `apps/server/src/connectors/ebayConnector.ts`: implement `createStatusChecker()` reusing `createEbayItemDetailClient`'s existing OAuth-token/host-resolution path (the same lazy-shared-client pattern `createDescriptionFetcher` already uses). Calls `GET /buy/browse/v1/item/{itemId}` for the given `externalItemId`: a 404 resolves `'removed'`; any 2xx resolves `'active'`. **Never resolves `'sold'`** — eBay's Browse API cannot distinguish a sold item from a delisted one (Requirement 6); the function's own doc comment states this plainly, citing the same reasoning `descriptionBackfill.ts`'s existing comment about eBay 404s already uses. Any other non-2xx/non-404 response rethrows as a genuine error (does not silently resolve to any status) — mirrors this project's own existing lesson (the Mercari auth-bypass bug fixed in the prior feature) about never treating an unexpected failure response as a clean, mundane outcome. | builder | T2 | not_started | 0 | | | | | 25 | | | | no |
| T4 | `apps/server/src/connectors/mercariConnector.ts` (splitting a sibling file if needed to stay under the ~200-line cap, mirroring this connector's existing `mercariSearchMapping.ts`/`mercariItemDetail.ts` split). Implement `createStatusChecker()` by navigating to the item's own detail page (`https://www.mercari.com/us/item/<id>/`, the same URL `mercariItemDetail.ts`'s description fetcher already visits) and reading its current `status` field from the same `__NEXT_DATA__` `ItemDetail:<id>` node that fetcher already reads `description` from — **confirm live during this task** (open a real item's detail page in a real browser, read the real `__NEXT_DATA__` payload) whether that node actually carries a `status` field with the same values search results do (`on_sale`, `trading`, and whatever the real sold-state value turns out to be — a live search already confirmed `'on_sale'`/`'trading'` exist; confirm the sold-specific value live too, do not guess it). Map: `'on_sale'` → `'active'`; any other real status value found → `'sold'`; the node/page not found at all (the item's own listing no longer resolves) → `'removed'`. | builder | T2 | not_started | 0 | | | | | 35 | | | | no |
| T5 | `apps/server/src/connectors/facebookMarketplaceConnector.ts` (or a sibling file, same split convention as this connector's existing `facebookMarketplaceSession.ts`/`facebookMarketplaceDom.ts`/`facebookMarketplaceListing.ts`). Implement `createStatusChecker()` best-effort: navigate to the listing's own URL in the authenticated session (reusing the existing persisted `storageState`/shared UA, same as this connector's existing description fetch), look for a DOM-rendered "Sold"/"no longer available" indicator vs. the page resolving normally. No real dedicated-account session exists to confirm this live during this work — state that plainly in the function's own top comment, the same honesty this connector's existing `facebookMarketplaceListing.ts` header comment already models for its search/description logic. | builder | T2 | not_started | 0 | | albert-einstein | | | 35 | | | | no |
| T6 | `apps/server/src/scan/scanService.ts`: after the existing new-candidate import loop in `scanSourceWithConnector`, implement Requirements 3-5. Query this Source's currently-`open` Listings whose `externalSource` matches `connector.platformType` and whose `externalItemId` is non-null (reuse `listListings({ sourceId, status: 'open' })` with a `limit` covering every row, the same `limit: total` idiom `routes/listings.ts`'s `listFilteredSummaries` already uses — do not add a new listing query for this part). For each row **missing** from this pass's candidate `externalItemId`s: if `connector.createStatusChecker` exists, build it once (lazy, shared for the whole pass, exactly the `createDescriptionFetcher` pattern already established), call it once per missing row, and on `'sold'`/`'removed'` call T1's `transitionListingMarketplaceStatus(id, 'open', 'removed', status, new Date().toISOString())` — a resolved `'active'` writes nothing (Requirement 3's false-positive guard); a missing row's `marketplaceStatus`/status-checker call is skipped entirely if the connector has none (no flag, no guess). Separately, query this Source's currently-`removed` Listings and, for any whose `externalItemId` **is** present among this pass's candidates, call `transitionListingMarketplaceStatus(id, 'removed', 'open', null, null)` (Requirement 4) — do not run a status-checker call for these, their mere reappearance in results is itself the positive signal. A single row's status-checker call failing (network error, unexpected response) must not abort the whole scan pass — log and continue, the same fail-soft contract `attachCandidatePhotos`/`attachCandidateDescription` already use elsewhere in this file. | builder | T1, T2 | not_started | 0 | | albert-einstein | | | 45 | | | | no |
| T7 | Web UI. New `apps/web/src/features/listings/marketplace-status-badge.tsx`, mirroring `non-working-badge.tsx`'s exact structure/convention (a `className` prop, `cn()`-composed Tailwind classes, a rose/red color family distinct from `NonWorkingBadge` (amber) and `EbayScanBadge` (emerald)) — renders `Sold` or `No longer listed` text depending on `listing.marketplaceStatus`. Render it in `listing-list.tsx`'s existing badge row (next to `EbayScanBadge`/`NonWorkingBadge`) whenever `listing.marketplaceStatus !== null`, and in the Listing detail/edit view wherever `NonWorkingBadge` is already shown there. `listing-list.tsx`'s `STATUS_OPTIONS` array gains `{ value: 'removed', label: 'Removed' }` (Requirement 10) — the existing filter checkbox UI needs no other change to support it. Confirm (do not assume) that the existing `listing.status === 'open'` guard already hides Accept/Reject for a `'removed'` row with no code change of its own — if any other code path renders those buttons unconditionally, fix that path too, naming it explicitly in this task's own digest. | builder | T1 | not_started | 0 | | | | | 25 | | | | yes |

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



## Cycle Log

### Cycle 0
Trigger: initial
UAT: not_run
