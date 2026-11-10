Status: proposed
Cycle: 0 / 3
FeatureStarted: 2026-10-16T19:06:32Z
OrchestrationTokensActual: null
OrchestrationTokensBreakdown: null
Prototype: https://gist.githack.com/adamcrevel/84e129394990800a1a7c58c4c3762721/raw/prototype.html
BaselineTests: 1018
BaselineSuite: fail
Issue: https://github.com/adamcrevel/pc-parts-flipper/issues/3
IssueLastSeen: 2026-10-16T19:26:49Z

## Goal

Add Mercari and Facebook Marketplace as automated-scan Sources alongside eBay, so the app can find
candidate PC-part listings on both without the operator checking either site by hand. Neither
platform has a public listings API, so both connectors drive a real headless/headed browser
(Playwright) instead of a plain HTTP client — Mercari to pass its Cloudflare bot check, Facebook
Marketplace to carry a real logged-in session on a dedicated secondary account. Craigslist and
OfferUp are deliberately out of scope this round (see Assumptions).

## Requirements

1. The app can run an automated Mercari scan for a Source: one or more configured search-query
   strings and an optional max-price ceiling, mirroring eBay's existing `queries`/`maxPrice` config
   shape. Each found item becomes a candidate Listing with title, asking price, listing photos, and
   a listing URL, deduplicated against Listings already imported for that Source exactly the way
   eBay-sourced candidates are deduplicated today. When a max price is configured, an item priced
   exactly at the ceiling is included and one priced $0.01 above it is excluded, proven as two
   explicit test cases (not inferred from Mercari's own search API, which may not honor the filter
   server-side).
2. Each newly-imported Mercari candidate gets a full description fetched from its own item detail
   page (not just the search-result summary), the same one-extra-call-per-new-candidate shape
   eBay's connector already uses — a failed detail fetch still imports the Listing, just without a
   description, logged at Warn (mirrors eBay's existing failure handling exactly).
3. The app can run an automated Facebook Marketplace scan for a Source, authenticated as a
   **dedicated secondary Facebook account** (never the operator's primary account — the user's own
   risk-mitigation choice): configured search-query strings, an optional location, an optional
   search radius, and an optional max-price ceiling. Each found item becomes a candidate Listing the
   same way as Requirement 1, with the same exact-boundary max-price behavior.
4. Each newly-imported Facebook Marketplace candidate gets a full description fetched from its own
   listing detail page, the same shape as Requirement 2.
5. A one-time, interactive command-line script lets the operator log into the dedicated Facebook
   account in a real, visible (non-headless) browser window — so any checkpoint/2FA challenge can be
   solved by a human — and persists that logged-in session to local disk for reuse by every later
   scan. No Facebook password is ever typed into a config file or an environment variable, and no
   scan re-authenticates from scratch.
6. When a Facebook Marketplace scan is attempted with no persisted session, or the persisted session
   has clearly expired (the scan lands on a login/checkpoint page instead of search results), it
   fails with one clear, actionable error naming the login script to re-run — never a silent
   zero-result scan that looks identical to "nothing matched."
7. The Sources UI (create/edit form, inline validation, round-trip on save, "Scan now" button) works
   for platformType `mercari` and `facebook_marketplace` exactly the way it already works for `ebay`
   today — a new connector-config editor per platform, with the same inline-validation-before-submit
   behavior the eBay editor already has.

## Standing checks

- The whole test suite passes, and the test count holds at or above `BaselineTests` (1018: 707
  apps/server + 287 apps/web + 24 packages/shared). `BaselineSuite` is already `fail` in this sandbox
  on a clean `origin/main` checkout before this feature touches anything — 20 of 59 `apps/server`
  test files and 1 `apps/web` test file (`eslint-import-boundary.test.ts`, the boundary check
  itself) failed on a fresh pristine run, almost all via real child-process server spawns timing out
  or colliding on fixed ports under this machine's resource contention, not a code defect this
  feature introduces. This feature owes leaving it no worse than that baseline, not repairing it.
- `npm run lint` (eslint.config.mjs) runs clean with no new violation.
- `apps/web` never imports `apps/server` directly (the existing `import/no-restricted-paths` rule,
  proven by `apps/web/test/eslint-import-boundary.test.ts`) — every new web file reaches the server
  only through the existing HTTP API client.
- All DuckDB access stays inside `apps/server/src/db` (existing boundary) — the new enum-value
  migration is the only DB-touching change, added to `apps/server/src/db/migrate.ts`/`schema.ts`;
  no connector or route issues raw SQL.
- No new source file exceeds ~200 lines (this project's own long-standing convention, applied by
  every prior feature's plan and enforced by review) — `connectors/mercariConnector.ts`,
  `connectors/mercariItemDetail.ts`, `connectors/browserSession.ts`,
  `connectors/facebookMarketplaceConnector.ts` (and its own detail-fetch sibling file if the
  builder splits it), and `scripts/facebook-marketplace-login.ts` are all new; each task below
  names the split that keeps it under the cap.
- Every new source file opens with a block comment explaining its purpose and the real-world
  reasoning behind its design (this project's own convention — every existing file read while
  planning this feature carries one), not just a one-line description.
- The new `playwright` dependency is pinned to a real version in `apps/server/package.json` (no
  floating `*`/`latest`), matching how every existing dependency in that file is pinned.
- The Facebook Marketplace session file (`data/facebook-marketplace-session.json`) is covered by
  `.gitignore` before it can ever be written by the login script, matching the existing convention
  that nothing under the local `data/` directory (DuckDB file, photos, reference photos) is tracked.

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| PT1 | Clickable HTML prototype covering T11's UI changes: platform dropdown with Mercari/Facebook Marketplace options, Mercari's connector-config editor (reused eBay shape), Facebook Marketplace's editor (queries+maxPrice plus location/radius), and a Sources table row per new platform with a working "Scan now" button. | prototype | none | complete | 0 | | 2026-10-16T19:40:00Z | 2026-10-16T19:48:07Z | 10 | 2026-10-16T19:40:00Z | 34600 | null | no |
| T1 | Shared types (`packages/shared/src/connectors.ts`, `sources.ts`): add `MercariConnectorConfig { queries: string[]; maxPrice?: number }` (same shape as `EbayConnectorConfig`, a separate named interface per this file's existing one-interface-per-platform convention) and `FacebookMarketplaceConnectorConfig { queries: string[]; location?: string; radiusMiles?: number; maxPrice?: number }`; add `'mercari'` to the `PlatformType` union in `sources.ts` (`facebook_marketplace` already exists there); widen `CreateSourceInput.connectorConfig`'s type to `EbayConnectorConfig \| MercariConnectorConfig \| FacebookMarketplaceConnectorConfig \| null`. | builder | none | not_started | 0 | | | | | 15 | | | | no |
| T2 | DB migration (`apps/server/src/db/schema.ts`, `migrate.ts`): add `'mercari'` to the `platform_type` enum. DuckDB's `ALTER TYPE ... ADD VALUE` has no `IF NOT EXISTS` (confirmed: PostgreSQL supports it, DuckDB does not), so add a small dedicated idempotent step in `migrate.ts` (same one-off-function pattern as the existing `migrateExpectedPartsNullablePrice`, just far simpler) that runs the `ALTER TYPE platform_type ADD VALUE 'mercari'` and swallows only the specific "already contains the value" error, rethrowing anything else — called once per boot, after `ENUM_STATEMENTS`. | builder | none | not_started | 0 | | | | | 15 | | | | no |
| T3 | Refactor the eBay-only description-fetch wiring in `apps/server/src/scan/scanService.ts` and `apps/server/src/connectors/types.ts` into a connector-generic hook, so adding Mercari/Facebook Marketplace connectors never needs a third `connector.platformType === '...'` branch. In `types.ts`, add an optional `createDescriptionFetcher?(): (externalItemId: string) => Promise<string \| null>` to `MarketplaceConnector`. In `scanService.ts`: delete the `ScanServiceDeps` interface and the `deps` parameter from `scanSourceWithConnector`/`importCandidateIfNew`/`attachCandidateDescription`; `attachCandidateDescription` now takes the fetcher function directly (or `undefined`) instead of checking `connector.platformType !== 'ebay'`; `scanSource()` calls `connector.createDescriptionFetcher?.()` once per scan pass (replacing its current `connector.platformType === 'ebay' ? { fetchEbayItemDescription: createLazyEbayDescriptionFetcher() } : {}` ternary) and passes the resulting function (or `undefined`) straight through — same once-per-scan-pass timing as today, just not gated on a platform-name string. Also change `scanSourceWithConnector`'s `JSON.parse(source.connectorConfig) as EbayConnectorConfig` to `as unknown` and drop the now-unused `EbayConnectorConfig` import — each connector's own `search()` already validates/narrows its config. In `apps/server/src/connectors/ebayConnector.ts`: move `createLazyEbayDescriptionFetcher`'s exact logic (lazy, memoized-per-call `createEbayItemDetailClient`) onto the exported `ebayConnector` object as its own `createDescriptionFetcher` method. Must not change any externally-observable behavior: `apps/server/test/scanService.test.ts`'s HTTP-call-count assertions (one token call, one search call, one detail call, N image downloads for one new candidate) and its detail-fetch-failure test must still pass unmodified. | builder | none | not_started | 0 | | | | | 30 | | | | no |
| T4 | New `apps/server/src/connectors/browserSession.ts`: a shared Playwright helper used by both new connectors. Export a `launchScanBrowser(): Promise<Browser>` wrapping `chromium.launch({ headless: true })`, plus the shared constants/init-script both connectors need for a realistic fingerprint (a real desktop Chrome user-agent string matching Playwright's bundled Chromium build, and an init script patching `navigator.webdriver` to `undefined`) — exported separately from the launch call itself so T8's persistent, logged-in context (which cannot reuse a bare headless launch) can still reuse the same UA/init-script constants rather than duplicating them. Add `playwright` as a pinned dependency in `apps/server/package.json`. | builder | none | not_started | 0 | | | | | 20 | | | | no |
| T5 | New `apps/server/src/connectors/mercariConnector.ts` implementing `MarketplaceConnector` for `platformType: 'mercari'`. `search(config)` validates `config` against `MercariConnectorConfig`'s shape (non-empty array of non-blank query strings; optional non-negative `maxPrice`) the same way `ebayConnector.ts`'s `validateEbayConnectorConfig` does, throwing `AppError(400)` on a malformed shape. For each query: open a page via T4's `launchScanBrowser()` at `https://www.mercari.com/search/?keyword=<query>` (confirmed live: a real browser — even headless, with no prior cookies — passes Mercari's Cloudflare JS challenge automatically; a bare HTTP request gets a 403 "Just a moment..." challenge page every time), then run `page.evaluate(() => fetch('/v1/api?operationName=searchFacetQuery&variables=...'))` inside that same authenticated page context (confirmed live: this exact GraphQL call is what the real search page itself makes, returning `data.search.itemsList[]`) to get results — confirm the current persisted-query `extensions` hash and the exact `criteria` fields live (captured once already: `offset`, `length`, `query`, plus category/brand/condition filter arrays) by re-running the same network-capture technique (open the real search page, read its own outgoing requests) rather than hand-copying a hash that may rotate. Map each `itemsList[]` entry to `CandidateListing`: `id` (already `m`-prefixed, e.g. `m68587273171`) → `externalItemId`; `name` → `title`; `price` is in whole US cents (confirmed live: a card showing "$142.50" carried `price: 14250`) → `askingPrice = price / 100`; `photos[].imageUrl` → `imageUrls`; listing URL is `https://www.mercari.com/us/item/<id>/` (confirmed live link pattern); `status !== 'on_sale'` entries are excluded (sold/reserved items never become candidates); `nonWorking` is always `false` — the sampled `itemsList` entries carry no structured parts-only/non-working condition field comparable to eBay's `conditionId`, only free-text title hints (e.g. "Parts/ Repair: ..."), which this connector does not attempt to parse. When `maxPrice` is configured, filter candidates client-side with `askingPrice <= maxPrice` regardless of whether Mercari's own `criteria` object has a price-bound field that already does this server-side — test both an item priced exactly at the ceiling (kept) and one $0.01 over (dropped). Register nothing yet (T9 wires the registry). | builder | T1, T4 | not_started | 0 | | | | | 35 | | | | no |
| T6 | New `apps/server/src/connectors/mercariItemDetail.ts`, wired onto T5's exported connector as its `createDescriptionFetcher` method (a one-line addition to `mercariConnector.ts`: import the new file's export and assign it). Exports a function that, given a shared browser (from T4) and an `externalItemId`, navigates to `https://www.mercari.com/us/item/<id>/` and reads the item's description out of the page's own embedded `<script id="__NEXT_DATA__">` JSON (confirmed live: this script tag exists on a real item-detail page and is populated — its exact JSON path to the description field was not captured during planning and must be confirmed live against a real page before being hard-coded). Returns `null` (never throws past its own boundary) when the tag is missing or the expected field isn't found, logged at Warn, matching `attachCandidateDescription`'s existing best-effort contract from T3. | builder | T5, T3 | not_started | 0 | | | | | 25 | | | | no |
| T7 | New `apps/server/src/scripts/facebook-marketplace-login.ts`, following the exact same CLI-script convention as the existing `backfill-photos.ts`/`seed-reference-photos.ts` (a plain `tsx`-run script, no HTTP route). Launches a **headed** (visible) Playwright Chromium window, navigates to `https://www.facebook.com/login`, then waits for the operator to finish logging in by hand (including any 2FA/checkpoint challenge) — poll for navigation away from the login/checkpoint URL, or wait on a single stdin line ("press Enter once you're logged in") if polling proves unreliable — then calls the browser context's `storageState({ path })` to persist cookies + local storage to `<DATA_DIR>/facebook-marketplace-session.json` (same `DATA_DIR` resolution `photoStorage.ts` already uses). Add a `login-facebook-marketplace` npm script to `apps/server/package.json` (`tsx --env-file-if-exists=.env src/scripts/facebook-marketplace-login.ts`). The script's own top-of-file comment states plainly that this must be run against the **dedicated secondary account**, never the operator's primary one. | builder | none | not_started | 0 | | | | | 25 | | | | no |
| T8 | New `apps/server/src/connectors/facebookMarketplaceConnector.ts` (splitting a sibling detail-fetch file out of it if needed to stay near the ~200-line cap, the same way T5/T6 split) implementing `MarketplaceConnector` for `platformType: 'facebook_marketplace'`. `search(config)` validates `config` against `FacebookMarketplaceConnectorConfig`'s shape (queries/maxPrice like T5, plus optional `location`/`radiusMiles`), `AppError(400)` on malformed input. Loads T7's persisted `storageState` file; if it is missing, throws a clear `AppError` directing the operator to run `npm run login-facebook-marketplace`. Opens a Playwright context carrying that `storageState` (reusing T4's shared UA/init-script constants, not its bare headless launch, since this context must carry the logged-in session) and, for each configured query, navigates to Facebook Marketplace's own search (confirm the real URL/query-param shape — e.g. query, location, radius, price range — live, against the dedicated account's real logged-in session; this cannot be hand-guessed without credentials, which do not exist until T7 has been run once). Check first whether the page's own internal network calls expose a clean JSON/GraphQL response (the same network-capture technique already used to find Mercari's endpoint) before falling back to scraping the rendered DOM's listing cards for title/price/photo/href. Maps results to `CandidateListing` the same way as T5 (`nonWorking` always `false`, no structured condition field observed on Marketplace either); same exact-boundary `maxPrice` behavior as Requirement 1/T5. If navigating to search instead lands on a login or checkpoint page, throws a clear `AppError` naming the login script to re-run rather than returning an empty/silent result. Implements `createDescriptionFetcher()` the same way as T6, visiting each listing's own URL in the same authenticated context. This connector is the one most likely to need rework as Facebook's anti-bot defenses change — note that plainly in the file's own top comment. | builder | T1, T3, T4, T7 | not_started | 0 | | albert-einstein | | | 60 | | | | no |
| T9 | `apps/server/src/connectors/registry.ts`: register `mercariConnector` under `'mercari'` and `facebookMarketplaceConnector` under `'facebook_marketplace'` in `CONNECTOR_REGISTRY`; update the file's own comment, which currently says only `'ebay'` is registered. | builder | T6, T8 | not_started | 0 | | derek-zoolander | | | 10 | | | | no |
| T10 | `apps/server/src/routes/sourceValidation.ts`: add `'mercari'` to `VALID_PLATFORM_TYPES` (`'facebook_marketplace'` is already there); add `validateMercariConnectorConfig`/`validateFacebookMarketplaceConnectorConfig`, mirroring `validateEbayConnectorConfig`'s exact rules (non-empty non-blank `queries`; optional non-negative `maxPrice`; Facebook's additionally accepts an optional `location` string and an optional non-negative `radiusMiles`, normalizing a present-but-blank `location` to the same "omitted" treatment the file's existing `notes` field already gets); branch `validateSourceInput`'s connector-config validation on all three now-validated platform types instead of only `'ebay'`. | builder | T1 | not_started | 0 | | | | | 20 | | | | no |
| T11 | Web UI (`apps/web/src/features/sources/`): `source-form.tsx`'s `PLATFORM_OPTIONS` gains `{ value: 'mercari', label: 'Mercari' }`; `source-row.tsx`'s `PLATFORM_LABELS` gains `mercari: 'Mercari'`, and its `canScan` check (currently hardcoded to `source.platformType === 'ebay'`) generalizes to a small client-side constant array of scannable platform types (`['ebay', 'mercari', 'facebook_marketplace']`, with a comment that it must be kept in sync with the server's `registry.ts` by hand — `apps/web` cannot import the server's registry directly, per the existing boundary). `connector-config-editor.tsx`: rename/generalize the existing queries+maxPrice editor so Mercari reuses it unchanged (same shape as eBay's), and add a second editor variant for Facebook's extra `location`/`radiusMiles` fields; `source-form.tsx` picks the right editor and validator per `platformType`, the same way it already picks eBay's today. | builder | T1, T10 | not_started | 0 | | | | | 35 | | | | yes |
| T12 | Packaging/docs: `.gitignore` gains an entry for `**/data/facebook-marketplace-session.json`; `apps/server/.env.example` gets a new comment block (no new env vars for Mercari — confirmed live that a fresh headless browser passes its Cloudflare check with zero prior state every time; Facebook Marketplace needs one `npm run login-facebook-marketplace` run first, against the dedicated secondary account, before its Source can be scanned) and a one-time machine-setup note (`npx playwright install chromium`) next to the existing eBay-credentials block; README gets a one-line pointer to the same note. | builder | T4, T7 | not_started | 0 | | | | | 15 | | | | no |

Reviewer (`R<n>`) and tester (`TE<n>`) rows for T1-T12, `depends_on` their own task id, `cycle: 0`, `status: not_started`, added by `feature-validate-lead` once each builder task completes — omitted here per the standard task-table convention (they mirror the row above one-for-one).

## Assumptions

- A1 (cycle 0): Scope is Mercari + Facebook Marketplace only this round. Craigslist and OfferUp were
  researched (Craigslist: no official API, easy to scrape technically, but a documented history of
  Craigslist successfully suing scrapers under CFAA/ToS/copyright — $3.1M 3Taps/PadMapper settlement
  2015, $60M RadPad default judgment 2022; OfferUp: no official API, heavily-defended anti-bot SPA)
  and paused by the user's own explicit choice, not a technical blocker — out of scope for this
  feature entirely, not a deferred task.
- A2 (cycle 0): Facebook Marketplace's ToS, as rewritten effective 2025-01-01, prohibits automated
  collection "whether you scrape logged in or logged out," closing the logged-out safe harbor Meta
  v. Bright Data (2024) had opened. The user chose to proceed anyway, against a **dedicated secondary
  account** rather than their primary one, after being told: the realistic exposure is Meta
  checkpointing/restricting/banning that account (not a lawsuit — every Meta suit found during
  research targeted industrial-scale commercial operations, never an individual's own low-volume
  personal account), and that CFAA exposure specifically is low for this fact pattern post-*Van
  Buren v. United States* (2021), which requires bypassing a technical barrier, not just breaking a
  contractual promise while using valid, self-owned credentials.
- A3 (cycle 0): Mercari's own site (search pages and item-detail pages alike) sits behind Cloudflare
  bot management — confirmed live: a bare HTTP request gets a 403 challenge page every time, while
  a real browser (even headless, with zero prior cookies) passes automatically every time tested.
  No login or persisted session is needed for Mercari at all — only a real browser per scan pass —
  so Mercari carries none of Facebook's account-risk profile.
- A4 (cycle 0): The daily 2am scheduled scan (`apps/server/src/scan/scheduler.ts`, unchanged by this
  feature) will run the Facebook Marketplace connector on the same fixed cadence as every other
  Source. A perfectly regular daily automation pattern against a logged-in account is a weak
  additional signal to anti-scraping detection; no jitter/randomized-timing mitigation was requested
  and none is added here, since nothing in the request asked for scheduling changes — flagged as a
  risk to be aware of, not built around.
- A5 (cycle 0): Reviewed peer feature `feat/add-parts-workflow` (issue #2, `Planning`) — touches
  `apps/server/src/db`, `routes`, `apps/web/src/routes`, `features/parts`, `features/teardown`, and
  `packages/shared/src/{parts,teardown}.ts`. No file overlap with this feature's areas
  (`connectors/`, `scan/`, `routes/sourceValidation.ts`, `features/sources`,
  `packages/shared/src/{sources,connectors}.ts`); no coordination needed.
- A6 (cycle 0): `BaselineTests`/`BaselineSuite` were recorded against a fresh `origin/main` checkout
  before any change in this feature, per the standing-check rule's own instruction — the 20
  already-failing `apps/server` test files and the 1 already-failing `apps/web` test file are not
  this feature's responsibility to fix, only to not make worse.
- A7 (cycle 0): Mercari's and Facebook Marketplace's exact live request shapes (Mercari's persisted
  GraphQL query hash; Facebook Marketplace's search URL/query-param shape and whatever internal API
  or DOM structure its results actually come from) were confirmed live against Mercari (which needs
  no credentials to test) but could not be confirmed for Facebook Marketplace during planning, since
  testing it requires the dedicated secondary account's real login session, which does not exist
  until T7 runs. T8's own task names the exact technique (the same live network-capture investigation
  already used for Mercari) to pin that shape during the build itself, rather than guessing it here.

## Cycle Log

### Cycle 0
Trigger: initial
UAT: not_run
