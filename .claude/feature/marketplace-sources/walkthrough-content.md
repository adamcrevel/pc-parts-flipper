# Overview
Adds Mercari and Facebook Marketplace as automated-scan Sources alongside eBay. Neither platform has
a public listings API, so both connectors drive a real Playwright browser instead of a plain HTTP
client — Mercari to pass Cloudflare's bot check, Facebook Marketplace to carry a logged-in session on
a dedicated secondary account via a one-time interactive login script. A pre-existing eBay-only
description-fetch path in the scan service was generalized into a connector-agnostic hook so the two
new connectors slot in without a third platform-specific branch, and the Sources UI grew a config
editor and a scannable "Scan now" row for each new platform. A DuckDB enum migration, shared types,
and a late-discovered live auth bug in the Mercari search call round out the change.

## Shared types and schema
Summary: The platform-agnostic plumbing every other section builds on — the `PlatformType` union,
per-platform connector-config shapes, and the DuckDB enum migration that lets `sources.platform_type`
actually store `'mercari'`.
Tasks: T1, T2
Files:
- packages/shared/src/connectors.ts: adds `MercariConnectorConfig` and `FacebookMarketplaceConnectorConfig` as separate named interfaces (eBay's own one-interface-per-platform convention), and widens `CreateSourceInput.connectorConfig`'s union to include both.
- packages/shared/src/sources.ts: adds `'mercari'` to the `PlatformType` union (`facebook_marketplace` already existed).
- apps/server/src/db/schema.ts: adds `'mercari'` to the `platform_type` ENUM's creation statement.
- apps/server/src/db/migrate.ts: a one-off `migratePlatformTypeAddMercari` step, since DuckDB has no `ALTER TYPE ... ADD VALUE` at all — it backs up, drops, and rebuilds the entire ten-table FK subtree rooted at `sources` using the file's own ENUM/TABLE/ALTER statements as the single source of truth, preceded by a `rebuildCorruptedCatalog` helper that works around a DuckDB catalog bug (a stale FK dependency left behind by an earlier migration) that otherwise crashes the rebuild's first `DROP TABLE`.
- packages/shared/src/connectors.test.ts: proves all three connector-config shapes (and `null`) are accepted by the widened union.

## Mercari connector
Summary: A new automated-scan connector for Mercari, driving a real headless Chromium per search
(to pass Cloudflare's bot check with zero prior session state) and fetching each new candidate's
full description from its own item-detail page.
Tasks: T4, T5, T6, T14
Flow:
- Launch: shared Playwright helper opens a real Chromium page per query
- Search: page's own JS issues Mercari's search API call, authenticated by its own session
- Map results: validate config, filter by max-price ceiling, dedupe by externalItemId
- Fetch detail: open item page, read description from embedded __NEXT_DATA__ JSON
Files:
- apps/server/src/connectors/browserSession.ts: shared `launchScanBrowser()` plus a realistic desktop-Chrome UA/init-script pair (patches `navigator.webdriver`) both new connectors reuse; adds `playwright` as a pinned dependency.
- apps/server/src/connectors/mercariConnector.ts: `search()` opens a page per query and lets the page's own JS make the authenticated search call. Originally hand-built that call itself with `page.evaluate(() => fetch(...))`, which Mercari's API silently rejected (a 200 response with no results) because the real bearer/CSRF auth tokens are minted by the page's own JS and held only in memory, never in a cookie or storage key the hand-built fetch could read — T14 fixed this live-discovered bug by capturing the page's own already-authenticated response via `page.waitForResponse` instead, and throwing `AppError(502)` on a top-level `errors` array in an otherwise-200 body rather than silently returning zero results.
- apps/server/src/connectors/mercariSearchMapping.ts: config validation, candidate mapping, and the max-price boundary filter, split out of mercariConnector.ts to stay under the ~200-line file cap.
- apps/server/src/connectors/mercariItemDetail.ts: `createDescriptionFetcher` — navigates to an item's detail page and reads its description out of the page's embedded `__NEXT_DATA__` JSON; returns `null` (never throws past its own boundary) when the tag/field is missing, logged at Warn.
- apps/server/test/mercariConnector.test.ts, apps/server/test/mercariItemDetail.test.ts, apps/server/test/browserSession.test.ts: max-price boundary (ceiling kept, +$0.01 dropped), dedup, malformed-config rejection, the errors-array regression, and the missing-detail/navigation-failure paths.

## Facebook Marketplace connector + login script
Summary: A second new automated-scan connector, authenticated as a dedicated secondary Facebook
account via a persisted browser session, plus the one-time interactive script that creates that
session — and the guard that turns an expired session into one clear error instead of a silent
zero-result scan.
Tasks: T7, T8, T9, T13
Flow:
- Login (one-time): headed browser, operator logs in by hand (2FA/checkpoint included)
- Persist session: storageState written to data/facebook-marketplace-session.json
- Scan: context replays storageState, searches queries, applies max-price/location/radius
- Guard: four independent signals detect an expired session and fail loudly
Files:
- apps/server/src/scripts/facebook-marketplace-login.ts: a `tsx`-run CLI script, matching the existing `backfill-photos.ts` convention — launches a headed Chromium window, detects login completion by polling the URL away from `/login`/`/checkpoint`, and persists cookies/storage via `storageState()`; browser cleanup moved into a `finally` block so any post-launch failure still closes Chromium.
- apps/server/src/connectors/facebookMarketplaceConnector.ts: orchestrates the scan — loads the persisted session (throwing a clear `AppError` naming the login script if it's missing), opens a context carrying that session, and runs the search/mapping/description-fetch steps.
- apps/server/src/connectors/facebookMarketplaceSession.ts: the Requirement 6 login/checkpoint guard (`assertSearchPageAuthenticated`), checking four independent signals — a `/login`/`/checkpoint` URL, a bare facebook.com root redirect, a non-2xx/3xx navigation status, and an inline login wall in the DOM — plus `parseFacebookUrl`'s tightened exact/subdomain host match (closing a spoofable lookalike-host gap the original `endsWith('facebook.com')` check had).
- apps/server/src/connectors/facebookMarketplaceConfig.ts: config validation for `FacebookMarketplaceConnectorConfig` (queries/location/radiusMiles/maxPrice).
- apps/server/src/connectors/facebookMarketplaceDom.ts: DOM-fallback search-result scraping and description scraping for when the GraphQL shape doesn't apply.
- apps/server/src/connectors/facebookMarketplaceListing.ts: candidate-mapping from Facebook's search response/DOM into `CandidateListing`.
- apps/server/src/connectors/registry.ts: registers both `mercariConnector` and `facebookMarketplaceConnector` in `CONNECTOR_REGISTRY` alongside the existing `ebayConnector`.
- apps/server/test/facebookMarketplaceConnector.test.ts, facebookMarketplaceSession.test.ts, facebookMarketplaceLogin.test.ts, registry.test.ts: missing-session and login/checkpoint-guard behavior (mocked navigation), host-spoofing guard coverage (lookalike hosts vs. real facebook.com/subdomains, 30 tests), the login script's URL-based completion detection, and registry lookups for both new platforms.
- apps/server/test/ebayConnector.test.ts, apps/server/test/scan.test.ts: repointed two pre-existing tests that had used `'facebook_marketplace'` as a stand-in for "no connector registered" — now registered, so both use `'other'` instead (the one platform genuinely left unregistered).

## scanService description-fetch refactor
Summary: Generalizes the eBay-only description-fetch wiring in the scan service into a
connector-generic hook, so adding the two new connectors never needs a third
`connector.platformType === '...'` branch.
Tasks: T3
Files:
- apps/server/src/connectors/types.ts: adds a `DescriptionFetcher` type alias and an optional `createDescriptionFetcher?(): DescriptionFetcher` hook to `MarketplaceConnector` — a connector that omits it simply has no description fetch, with no platform-name branch anywhere downstream.
- apps/server/src/connectors/ebayConnector.ts: moves its existing lazy-shared-OAuth-client description-fetch logic onto `createDescriptionFetcher`, unchanged in behavior.
- apps/server/src/scan/scanService.ts: deletes the `ScanServiceDeps` interface and `deps` parameter entirely; `attachCandidateDescription` now takes the fetcher function directly; `scanSourceWithConnector` calls `connector.createDescriptionFetcher?.()` once per scan pass and reuses the result for every newly-imported candidate in that pass.
- apps/server/test/scanService.test.ts: existing HTTP-call-count assertions (one token call, one search call, one detail call) preserved unmodified, plus new tests proving the fetcher is built once per scan pass and reused across candidates, not once per candidate.

## Sources UI support
Summary: The Sources create/edit form, inline validation, and "Scan now" button now work for
`mercari` and `facebook_marketplace` exactly the way they already work for `ebay`.
Tasks: T11
Files:
- apps/web/src/features/sources/source-form.tsx: `PLATFORM_OPTIONS` gains Mercari; renders `ConnectorConfigEditor` for `ebay`/`mercari` and the new `FacebookConnectorConfigEditor` for `facebook_marketplace`; client-side validation branches on all three before submit.
- apps/web/src/features/sources/connector-config-editor.tsx: generalized from an eBay-only editor into a shared `ConnectorConfigEditor` taking a `platformLabel` prop, since eBay and Mercari share the identical queries+maxPrice shape; `buildEbayConnectorConfig` renamed to `buildQueriesConnectorConfig` to reflect serving both.
- apps/web/src/features/sources/facebook-marketplace-config-editor.tsx: a new sibling editor for Facebook Marketplace's extra `location`/`radiusMiles` fields, split into its own file (mirroring the mercariConnector/mercariSearchMapping split pattern) to stay under the ~200-line cap.
- apps/web/src/features/sources/source-row.tsx: `PLATFORM_LABELS` gains `mercari`; the `canScan` check generalizes from a hardcoded `platformType === 'ebay'` to a `SCANNABLE_PLATFORM_TYPES` constant array (kept in sync by hand with the server's registry, since apps/web cannot import apps/server directly).
- apps/web/src/features/sale-listings/sale-listings-list.tsx: a pre-existing `PLATFORM_LABELS` map outside `features/sources/` also gains a `mercari` entry — required for `tsc -b` to pass against the widened `PlatformType` union, a necessary consequence rather than part of T11's named file list.
- apps/web/test/source-ebay-connector.test.tsx, apps/web/test/source-mercari-facebook-connector.test.tsx: eBay-side tests repointed off `'facebook_marketplace'` as a "no editor" stand-in (now false); new tests cover both new platforms' editors, inline validation, and round-trip save.

## Packaging and docs
Summary: Setup notes and gitignore coverage for the new browser-driven connectors and the Facebook
session file.
Tasks: T12
Files:
- .gitignore: adds `**/data/facebook-marketplace-session.json`, matching the existing convention that nothing under `data/` is tracked — in place before the login script can ever write it.
- apps/server/.env.example: a new comment block noting Mercari needs no credentials (a fresh headless browser passes Cloudflare every time) while Facebook Marketplace needs one `npm run login-facebook-marketplace -w @pc-parts-flipper/server` run first, plus a one-time `npx playwright install chromium` setup note.
- README.md: a one-line pointer to the same setup note.
- apps/server/package.json: adds the `login-facebook-marketplace` npm script and the pinned `playwright` dependency.
