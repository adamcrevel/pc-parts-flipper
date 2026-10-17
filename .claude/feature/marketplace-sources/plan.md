Status: done
Cycle: 2 / 3
FeatureStarted: 2026-10-16T19:06:32Z
OrchestrationTokensActual: null
OrchestrationTokensBreakdown: null
Prototype: https://gist.githack.com/adamcrevel/84e129394990800a1a7c58c4c3762721/raw/prototype.html
BaselineTests: 1018
BaselineSuite: fail
Issue: https://github.com/adamcrevel/pc-parts-flipper/issues/3
IssueLastSeen: 2026-10-16T19:26:49Z
FeatureCompletedAt: 2026-10-17T02:47:14Z

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

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| PT1 | Clickable HTML prototype covering T11's UI changes: platform dropdown with Mercari/Facebook Marketplace options, Mercari's connector-config editor (reused eBay shape), Facebook Marketplace's editor (queries+maxPrice plus location/radius), and a Sources table row per new platform with a working "Scan now" button. | prototype | none | complete | 0 | | 2026-10-16T19:40:00Z | 2026-10-16T19:48:07Z | 10 | 2026-10-16T19:40:00Z | 34600 | null | no |
| T1 | Shared types (`packages/shared/src/connectors.ts`, `sources.ts`): add `MercariConnectorConfig { queries: string[]; maxPrice?: number }` (same shape as `EbayConnectorConfig`, a separate named interface per this file's existing one-interface-per-platform convention) and `FacebookMarketplaceConnectorConfig { queries: string[]; location?: string; radiusMiles?: number; maxPrice?: number }`; add `'mercari'` to the `PlatformType` union in `sources.ts` (`facebook_marketplace` already exists there); widen `CreateSourceInput.connectorConfig`'s type to `EbayConnectorConfig \| MercariConnectorConfig \| FacebookMarketplaceConnectorConfig \| null`. | builder | none | complete | 0 | | | 2026-10-16T19:52:45Z | 2026-10-16T20:24:44Z | 15 | 2026-10-16T19:45:23Z | 5700 | 62070 | no |
| T2 | DB migration (`apps/server/src/db/schema.ts`, `migrate.ts`): add `'mercari'` to the `platform_type` enum. DuckDB's `ALTER TYPE ... ADD VALUE` has no `IF NOT EXISTS` (confirmed: PostgreSQL supports it, DuckDB does not), so add a small dedicated idempotent step in `migrate.ts` (same one-off-function pattern as the existing `migrateExpectedPartsNullablePrice`, just far simpler) that runs the `ALTER TYPE platform_type ADD VALUE 'mercari'` and swallows only the specific "already contains the value" error, rethrowing anything else — called once per boot, after `ENUM_STATEMENTS`. MUST FIX (cycle 0 retry 1): `migratePlatformTypeAddMercari`'s backup/drop/recreate/restore rebuild crashes with `Catalog Error: Could not drop the table because this table is main key table of the table "expected_parts_new"` on `DROP TABLE listings`, against any database that has already run the pre-existing `migrateExpectedPartsNullablePrice` rebuild — i.e. every real production database (confirmed twice independently: an isolated repro, and the standing gate's own whole-suite run). Root cause: DuckDB's own RENAME-poisons-catalog behavior once a CREATE-new/RENAME dance has run against a table another table's FK still references — rebuilding `listings` a second time (this task) after `expected_parts`/`teardown_results` were already rebuilt once (the pre-existing migration) hits that poisoned state. The fix must survive being run against an already-migrated real database, not only a fresh one — verify explicitly by running `migrateExpectedPartsNullablePrice` first, then this migration, against the same on-disk file, not just a synthetic fresh-schema test. | builder | none | complete | 0 | | | 2026-10-16T22:21:27Z | 2026-10-16T22:39:04Z | 15 | 2026-10-16T20:00:23Z | 48000 | null | no | apps/server/src/db/migrate.ts |
| T3 | Refactor the eBay-only description-fetch wiring in `apps/server/src/scan/scanService.ts` and `apps/server/src/connectors/types.ts` into a connector-generic hook, so adding Mercari/Facebook Marketplace connectors never needs a third `connector.platformType === '...'` branch. In `types.ts`, add an optional `createDescriptionFetcher?(): (externalItemId: string) => Promise<string \| null>` to `MarketplaceConnector`. In `scanService.ts`: delete the `ScanServiceDeps` interface and the `deps` parameter from `scanSourceWithConnector`/`importCandidateIfNew`/`attachCandidateDescription`; `attachCandidateDescription` now takes the fetcher function directly (or `undefined`) instead of checking `connector.platformType !== 'ebay'`; `scanSource()` calls `connector.createDescriptionFetcher?.()` once per scan pass (replacing its current `connector.platformType === 'ebay' ? { fetchEbayItemDescription: createLazyEbayDescriptionFetcher() } : {}` ternary) and passes the resulting function (or `undefined`) straight through — same once-per-scan-pass timing as today, just not gated on a platform-name string. Also change `scanSourceWithConnector`'s `JSON.parse(source.connectorConfig) as EbayConnectorConfig` to `as unknown` and drop the now-unused `EbayConnectorConfig` import — each connector's own `search()` already validates/narrows its config. In `apps/server/src/connectors/ebayConnector.ts`: move `createLazyEbayDescriptionFetcher`'s exact logic (lazy, memoized-per-call `createEbayItemDetailClient`) onto the exported `ebayConnector` object as its own `createDescriptionFetcher` method. Must not change any externally-observable behavior: `apps/server/test/scanService.test.ts`'s HTTP-call-count assertions (one token call, one search call, one detail call, N image downloads for one new candidate) and its detail-fetch-failure test must still pass unmodified. MUST FIX (cycle 0 retry 1): add a test proving `createDescriptionFetcher` is built exactly once per scan pass and the same returned function is reused for every candidate within it (e.g. assert the underlying per-call resource — `createEbayItemDetailClient`'s OAuth token fetch — is invoked once across multiple new candidates in one scan, not once per candidate). | builder | none | complete | 0 | | | 2026-10-16T22:21:27Z | 2026-10-16T22:39:04Z | 30 | 2026-10-16T20:15:23Z | 48000 | null | no | apps/server/test/scanService.test.ts |
| T4 | New `apps/server/src/connectors/browserSession.ts`: a shared Playwright helper used by both new connectors. Export a `launchScanBrowser(): Promise<Browser>` wrapping `chromium.launch({ headless: true })`, plus the shared constants/init-script both connectors need for a realistic fingerprint (a real desktop Chrome user-agent string matching Playwright's bundled Chromium build, and an init script patching `navigator.webdriver` to `undefined`) — exported separately from the launch call itself so T8's persistent, logged-in context (which cannot reuse a bare headless launch) can still reuse the same UA/init-script constants rather than duplicating them. Add `playwright` as a pinned dependency in `apps/server/package.json`. | builder | none | complete | 0 | | | 2026-10-16T19:52:45Z | 2026-10-16T20:24:44Z | 20 | 2026-10-16T20:45:23Z | 10500 | 62070 | no |
| T5 | New `apps/server/src/connectors/mercariConnector.ts` implementing `MarketplaceConnector` for `platformType: 'mercari'`. `search(config)` validates `config` against `MercariConnectorConfig`'s shape (non-empty array of non-blank query strings; optional non-negative `maxPrice`) the same way `ebayConnector.ts`'s `validateEbayConnectorConfig` does, throwing `AppError(400)` on a malformed shape. For each query: open a page via T4's `launchScanBrowser()` at `https://www.mercari.com/search/?keyword=<query>` (confirmed live: a real browser — even headless, with no prior cookies — passes Mercari's Cloudflare JS challenge automatically; a bare HTTP request gets a 403 "Just a moment..." challenge page every time), then run `page.evaluate(() => fetch('/v1/api?operationName=searchFacetQuery&variables=...'))` inside that same authenticated page context (confirmed live: this exact GraphQL call is what the real search page itself makes, returning `data.search.itemsList[]`) to get results — confirm the current persisted-query `extensions` hash and the exact `criteria` fields live (captured once already: `offset`, `length`, `query`, plus category/brand/condition filter arrays) by re-running the same network-capture technique (open the real search page, read its own outgoing requests) rather than hand-copying a hash that may rotate. Map each `itemsList[]` entry to `CandidateListing`: `id` (already `m`-prefixed, e.g. `m68587273171`) → `externalItemId`; `name` → `title`; `price` is in whole US cents (confirmed live: a card showing "$142.50" carried `price: 14250`) → `askingPrice = price / 100`; `photos[].imageUrl` → `imageUrls`; listing URL is `https://www.mercari.com/us/item/<id>/` (confirmed live link pattern); `status !== 'on_sale'` entries are excluded (sold/reserved items never become candidates); `nonWorking` is always `false` — the sampled `itemsList` entries carry no structured parts-only/non-working condition field comparable to eBay's `conditionId`, only free-text title hints (e.g. "Parts/ Repair: ..."), which this connector does not attempt to parse. When `maxPrice` is configured, filter candidates client-side with `askingPrice <= maxPrice` regardless of whether Mercari's own `criteria` object has a price-bound field that already does this server-side — test both an item priced exactly at the ceiling (kept) and one $0.01 over (dropped). Register nothing yet (T9 wires the registry). MUST FIX (cycle 0 retry 1): split this file (244 lines) the same way T6 already split Mercari's own detail-fetch logic out — move a clearly separable piece (e.g. the config-validation + candidate-mapping functions) into a new sibling file so the remaining file is comfortably under the ~200-line cap, matching the standing check's own named split strategy for this file. | builder | T1, T4 | complete | 0 | | | 2026-10-16T22:21:27Z | 2026-10-16T22:39:04Z | 35 | 2026-10-16T21:05:23Z | 11800 | null | no | apps/server/src/connectors/mercariConnector.ts; apps/server/src/connectors/mercariSearchMapping.ts |
| T6 | New `apps/server/src/connectors/mercariItemDetail.ts`, wired onto T5's exported connector as its `createDescriptionFetcher` method (a one-line addition to `mercariConnector.ts`: import the new file's export and assign it). Exports a function that, given a shared browser (from T4) and an `externalItemId`, navigates to `https://www.mercari.com/us/item/<id>/` and reads the item's description out of the page's own embedded `<script id="__NEXT_DATA__">` JSON (confirmed live: this script tag exists on a real item-detail page and is populated — its exact JSON path to the description field was not captured during planning and must be confirmed live against a real page before being hard-coded). Returns `null` (never throws past its own boundary) when the tag is missing or the expected field isn't found, logged at Warn, matching `attachCandidateDescription`'s existing best-effort contract from T3. | builder | T5, T3 | complete | 0 | | | 2026-10-16T20:59:24Z | 2026-10-16T21:12:41Z | 25 | 2026-10-16T21:40:23Z | 14800 | 175696 | no |
| T7 | New `apps/server/src/scripts/facebook-marketplace-login.ts`, following the exact same CLI-script convention as the existing `backfill-photos.ts`/`seed-reference-photos.ts` (a plain `tsx`-run script, no HTTP route). Launches a **headed** (visible) Playwright Chromium window, navigates to `https://www.facebook.com/login`, then waits for the operator to finish logging in by hand (including any 2FA/checkpoint challenge) — poll for navigation away from the login/checkpoint URL, or wait on a single stdin line ("press Enter once you're logged in") if polling proves unreliable — then calls the browser context's `storageState({ path })` to persist cookies + local storage to `<DATA_DIR>/facebook-marketplace-session.json` (same `DATA_DIR` resolution `photoStorage.ts` already uses). Add a `login-facebook-marketplace` npm script to `apps/server/package.json` (`tsx --env-file-if-exists=.env src/scripts/facebook-marketplace-login.ts`). The script's own top-of-file comment states plainly that this must be run against the **dedicated secondary account**, never the operator's primary one. MUST FIX (cycle 0 retry 1): fix the orphaned-Chromium-process leak — `browser` must be closed in a `finally` (or an outer `catch`) covering every step after a successful launch; a `page.goto()` failure, a context/page creation failure, and a `storageState()` write failure must all still close the browser before the error propagates. | builder | none | complete | 0 | | | 2026-10-16T22:21:27Z | 2026-10-16T22:39:04Z | 25 | 2026-10-16T22:05:23Z | 5600 | null | no | apps/server/src/scripts/facebook-marketplace-login.ts |
| T8 | New `apps/server/src/connectors/facebookMarketplaceConnector.ts` (splitting a sibling detail-fetch file out of it if needed to stay near the ~200-line cap, the same way T5/T6 split) implementing `MarketplaceConnector` for `platformType: 'facebook_marketplace'`. `search(config)` validates `config` against `FacebookMarketplaceConnectorConfig`'s shape (queries/maxPrice like T5, plus optional `location`/`radiusMiles`), `AppError(400)` on malformed input. Loads T7's persisted `storageState` file; if it is missing, throws a clear `AppError` directing the operator to run `npm run login-facebook-marketplace`. Opens a Playwright context carrying that `storageState` (reusing T4's shared UA/init-script constants, not its bare headless launch, since this context must carry the logged-in session) and, for each configured query, navigates to Facebook Marketplace's own search (confirm the real URL/query-param shape — e.g. query, location, radius, price range — live, against the dedicated account's real logged-in session; this cannot be hand-guessed without credentials, which do not exist until T7 has been run once). Check first whether the page's own internal network calls expose a clean JSON/GraphQL response (the same network-capture technique already used to find Mercari's endpoint) before falling back to scraping the rendered DOM's listing cards for title/price/photo/href. Maps results to `CandidateListing` the same way as T5 (`nonWorking` always `false`, no structured condition field observed on Marketplace either); same exact-boundary `maxPrice` behavior as Requirement 1/T5. If navigating to search instead lands on a login or checkpoint page, throws a clear `AppError` naming the login script to re-run rather than returning an empty/silent result. Implements `createDescriptionFetcher()` the same way as T6, visiting each listing's own URL in the same authenticated context. This connector is the one most likely to need rework as Facebook's anti-bot defenses change — note that plainly in the file's own top comment. MUST FIX (cycle 0 retry 1): (1) Requirement 6's login/checkpoint guard must stop being URL-prefix-only — also catch an inline login wall rendered at the search URL itself, a root-path redirect, and a non-OK HTTP response, so none of those three produce the silent zero-result scan Requirement 6 forbids. (2) Add a test asserting `storageState` and the shared UA/init-script are actually passed into `newContext()` — removing either today leaves every test green. (3) Add a test asserting `page.goto()`'s actual URL — navigating to the wrong place, or skipping navigation entirely, today leaves every test green. (4) Split both `facebookMarketplaceConnector.ts` (242 lines) and `facebookMarketplaceListing.ts` (281 lines) further to land comfortably under the ~200-line cap. | builder | T1, T3, T4, T7 | complete | 0 | | albert-einstein | 2026-10-16T22:40:12Z | 2026-10-16T22:51:11Z | 60 | 2026-10-16T22:30:23Z | 22000 | null | no | apps/server/src/connectors/facebookMarketplaceConnector.ts; apps/server/src/connectors/facebookMarketplaceSession.ts; apps/server/src/connectors/facebookMarketplaceConfig.ts; apps/server/src/connectors/facebookMarketplaceDom.ts; apps/server/src/connectors/facebookMarketplaceListing.ts; apps/server/test/facebookMarketplaceConnector.test.ts |
| T9 | `apps/server/src/connectors/registry.ts`: register `mercariConnector` under `'mercari'` and `facebookMarketplaceConnector` under `'facebook_marketplace'` in `CONNECTOR_REGISTRY`; update the file's own comment, which currently says only `'ebay'` is registered. MUST FIX (cycle 0 retry 1): repoint `apps/server/test/ebayConnector.test.ts`'s `getConnectorForPlatform` "rejects an unregistered platform type" case and `apps/server/test/scan.test.ts`'s "returns 400 for a non-ebay platformType Source" case away from `'facebook_marketplace'` (now a registered platform) to `'other'` (the one platform type genuinely left unregistered), mirroring the identical fix already applied on the apps/web side. | builder | T6, T8 | complete | 0 | | derek-zoolander | 2026-10-16T22:51:11Z | 2026-10-16T22:53:32Z | 10 | 2026-10-16T23:30:23Z | 900 | null | no | apps/server/test/ebayConnector.test.ts; apps/server/test/scan.test.ts |
| T10 | `apps/server/src/routes/sourceValidation.ts`: add `'mercari'` to `VALID_PLATFORM_TYPES` (`'facebook_marketplace'` is already there); add `validateMercariConnectorConfig`/`validateFacebookMarketplaceConnectorConfig`, mirroring `validateEbayConnectorConfig`'s exact rules (non-empty non-blank `queries`; optional non-negative `maxPrice`; Facebook's additionally accepts an optional `location` string and an optional non-negative `radiusMiles`, normalizing a present-but-blank `location` to the same "omitted" treatment the file's existing `notes` field already gets); branch `validateSourceInput`'s connector-config validation on all three now-validated platform types instead of only `'ebay'`. MUST FIX (cycle 0 retry 1): bring `validateSourceInput`'s cyclomatic complexity back under 10 (ESLint's own built-in complexity rule measured it at 11) — extract the new 3-way platform-config dispatch into its own small helper function rather than inlining it as nested ternaries. | builder | T1 | complete | 0 | | | 2026-10-16T22:21:27Z | 2026-10-16T22:39:04Z | 20 | 2026-10-16T23:40:23Z | 5600 | null | no | apps/server/src/routes/sourceValidation.ts |
| T11 | Web UI (`apps/web/src/features/sources/`): `source-form.tsx`'s `PLATFORM_OPTIONS` gains `{ value: 'mercari', label: 'Mercari' }`; `source-row.tsx`'s `PLATFORM_LABELS` gains `mercari: 'Mercari'`, and its `canScan` check (currently hardcoded to `source.platformType === 'ebay'`) generalizes to a small client-side constant array of scannable platform types (`['ebay', 'mercari', 'facebook_marketplace']`, with a comment that it must be kept in sync with the server's `registry.ts` by hand — `apps/web` cannot import the server's registry directly, per the existing boundary). `connector-config-editor.tsx`: rename/generalize the existing queries+maxPrice editor so Mercari reuses it unchanged (same shape as eBay's), and add a second editor variant for Facebook's extra `location`/`radiusMiles` fields; `source-form.tsx` picks the right editor and validator per `platformType`, the same way it already picks eBay's today. | builder | T1, T10 | complete | 0 | | | 2026-10-16T20:59:24Z | 2026-10-16T21:12:41Z | 35 | 2026-10-17T00:00:23Z | 68000 | 175696 | yes |
| T12 | Packaging/docs: `.gitignore` gains an entry for `**/data/facebook-marketplace-session.json`; `apps/server/.env.example` gets a new comment block (no new env vars for Mercari — confirmed live that a fresh headless browser passes its Cloudflare check with zero prior state every time; Facebook Marketplace needs one `npm run login-facebook-marketplace` run first, against the dedicated secondary account, before its Source can be scanned) and a one-time machine-setup note (`npx playwright install chromium`) next to the existing eBay-credentials block; README gets a one-line pointer to the same note. MUST FIX (cycle 0 retry 1): fix `.env.example`'s documented `npm run login-facebook-marketplace` command to actually work verbatim from the repo root — add the `-w apps/server` workspace flag (or `-w @pc-parts-flipper/server`), matching how every other apps/server-only script is documented elsewhere in this repo. | builder | T4, T7 | complete | 0 | | | 2026-10-16T22:40:12Z | 2026-10-16T22:51:11Z | 15 | 2026-10-17T00:35:23Z | 10900 | null | no | apps/server/.env.example |
| R1 | Review T1 (packages/shared/src/connectors.ts, packages/shared/src/sources.ts). Confirm MercariConnectorConfig {queries, maxPrice?} and FacebookMarketplaceConnectorConfig {queries, location?, radiusMiles?, maxPrice?} are separate named interfaces (not merged) per this file's one-interface-per-platform convention; PlatformType union now includes 'mercari'; CreateSourceInput.connectorConfig is EbayConnectorConfig \| MercariConnectorConfig \| FacebookMarketplaceConnectorConfig \| null. Read-only — no Edit/Write. | reviewer | T1 | complete | 0 | | 2026-10-16T21:32:19Z | 2026-10-16T21:37:25Z | 12 | 2026-10-16T21:32:19Z | 36000 | null | no | |
| TE1 | Test T1 (same files). Confirm `npm run build -w packages/shared` and a typecheck succeed, and that the widened connectorConfig union is actually exercised by T10's validators and T5/T8's connectors (spot-check, don't re-review their code). Add/confirm a test proving all three connector-config shapes and null are accepted by the type. export NVM_DIR=/home/adamcrevel/.nvm && source "$NVM_DIR/nvm.sh" && nvm use 22.23.3 before any npm/node command. | tester | T1 | complete | 0 | | 2026-10-16T21:32:19Z | 2026-10-16T21:42:55Z | 15 | 2026-10-16T21:32:19Z | 21000 | null | no | packages/shared/src/connectors.test.ts |
| R2 | Review T2 (apps/server/src/db/schema.ts, apps/server/src/db/migrate.ts). **Central scrutiny item**: the builder (A9) claims DuckDB has no ALTER TYPE statement at all, contradicting planning-time web research showing DuckDB docs with `ALTER TYPE x ADD VALUE 'y'`. Independently re-verify against a REAL DuckDB connection using this project's own installed binding (`@duckdb/node-api` 1.4.4-r.4 in apps/server/node_modules, same import pattern as migrate.ts), not an unrelated system CLI. Write a tiny throwaway script (delete it when done) that creates an enum type and runs ALTER TYPE against this exact binding; report the literal result. Only then judge whether migratePlatformTypeAddMercari's full backup/drop/recreate/restore rebuild of the FK subtree rooted at `sources` was actually necessary. Separately, regardless of that finding, verify on its own merits: idempotency (two consecutive runs, second is a true no-op), data preservation (every table's rows survive byte-for-byte including the platform_type/platform VARCHAR round-trip casts), FK integrity after restore, and that this is the only DB-touching change (standing check: no raw SQL from connectors/routes). **CENTRAL RETRY SCRUTINY (cycle 0 retry 1)**: the builder (A30) claims a new `rebuildCorruptedCatalog` helper (EXPORT DATABASE / DETACH / delete file / re-ATTACH / IMPORT DATABASE round-trip), run unconditionally before the existing subtree rebuild, fixes DuckDB's RENAME-poisons-catalog bug — verified against an already-migrated database with the full FK subtree surviving byte-for-byte and a second run a true no-op. This is the single highest-risk fix in this feature (a startup-crashing bug on every real production database): independently reproduce this exact scenario from scratch yourself — run the pre-existing `migrateExpectedPartsNullablePrice` rebuild first, then `migratePlatformTypeAddMercari`, against the same on-disk database file — rather than trust the builder's self-report, and additionally confirm the fix is still idempotent on a THIRD run, not just the two already claimed. Read-only — run verification via Bash only, never modify project files. export NVM_DIR=/home/adamcrevel/.nvm && source "$NVM_DIR/nvm.sh" && nvm use 22.23.3 first. | reviewer | T2 | complete | 0 | | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 30 | 2026-10-16T22:56:35Z | 76000 | null | no | |
| TE2 | Test T2 (same files). Run `apps/server/test/db.test.ts` (A19 reports 38/38) and confirm it still passes from inside the worktree. Prove migratePlatformTypeAddMercari's idempotency and data preservation yourself: seed a DB with rows across the FK subtree, run the migration twice, assert every row survives byte-for-byte and the second run is a true no-op. Use break-run-restore on one restore statement to prove your test can actually fail, then restore the file exactly. **MUST (cycle 0 retry 1)**: independently reproduce the exact must_fix scenario from scratch — run the pre-existing `migrateExpectedPartsNullablePrice` rebuild first against a seeded on-disk database file, THEN run `migratePlatformTypeAddMercari` against that same already-migrated file, and assert it does not crash and the full FK subtree survives byte-for-byte. Then run `migratePlatformTypeAddMercari` a THIRD consecutive time against that same file and assert it is still a true no-op (not just the two runs A30 already claims). export NVM_DIR=/home/adamcrevel/.nvm && source "$NVM_DIR/nvm.sh" && nvm use 22.23.3 first. FAIL: migratePlatformTypeAddMercari crashes on any already-migrated real database (Catalog Error dropping listings, root-caused to DuckDB's own RENAME-poisons-catalog behavior) — a genuine must_fix, not a test flaw. | tester | T2 | complete | 0 | | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 30 | 2026-10-16T22:56:35Z | 42800 | null | no | apps/server/test/db.test.ts |
| R3 | Review T3 (apps/server/src/scan/scanService.ts, apps/server/src/connectors/types.ts, apps/server/src/connectors/ebayConnector.ts). Confirm MarketplaceConnector gained `createDescriptionFetcher?(): (externalItemId: string) => Promise<string \| null>`; ScanServiceDeps and its `deps` parameter are gone from scanSourceWithConnector/importCandidateIfNew/attachCandidateDescription; attachCandidateDescription takes the fetcher directly; scanSource() calls `connector.createDescriptionFetcher?.()` once per scan pass; ebayConnector.ts's createLazyEbayDescriptionFetcher logic moved onto ebayConnector.createDescriptionFetcher unchanged in behavior; no `connector.platformType === '...'` branch remains. **MUST FIX RETEST (cycle 0 retry 1)**: confirm the must_fix's new test(s) genuinely prove createDescriptionFetcher is built exactly once per scan pass and reused for every candidate (A31: a connector-agnostic spy-based test plus an eBay OAuth-token-call-count test, 2 calls across 2 candidates not 3) — read the new test(s) and confirm they'd fail against a once-per-candidate regression, don't just trust the builder's count. **SEPARATE SCRUTINY — IRC desync report**: the build-lead running this retry batch reported a transient mid-batch filesystem desync in this shared worktree during T3's build, where apps/server/test/scanService.test.ts briefly reverted to HEAD content before self-correcting; it says this was independently re-verified on-disk afterward and nothing was lost. Independently confirm this file on disk RIGHT NOW actually contains A31's two new once-per-scan-pass tests — read the file yourself, do not trust the prior report. Read-only. FAIL: no test protects the 'createDescriptionFetcher built once per scan pass, reused for every candidate' contract this refactor exists to generalize. | reviewer | T3 | complete | 0 | | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 15 | 2026-10-16T22:56:35Z | 18000 | null | no | |
| TE3 | Test T3 (same files). Run `apps/server/test/scanService.test.ts` — its HTTP-call-count assertions (one token call, one search call, one detail call, N image downloads for one new candidate) and its detail-fetch-failure test must pass UNMODIFIED. Confirm this literally — diff the test file against its pre-feature version if possible to confirm no assertion was loosened to make it pass. **MUST (cycle 0 retry 1) — IRC desync re-verification**: the build-lead reported a transient mid-batch filesystem desync in this shared worktree where this exact file (apps/server/test/scanService.test.ts) briefly reverted to HEAD content before self-correcting, and claims independent on-disk re-verification afterward confirmed nothing was lost. Do not trust that report — read the file on disk right now yourself and confirm it genuinely contains the two new once-per-scan-pass tests A31 describes (a connector-agnostic spy-based test and an eBay OAuth-token-call-count test proving 2 calls across 2 new candidates, not 3), run them, and report their actual pass/fail result. export NVM_DIR=/home/adamcrevel/.nvm && source "$NVM_DIR/nvm.sh" && nvm use 22.23.3 first. | tester | T3 | complete | 0 | | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 15 | 2026-10-16T22:56:35Z | 13000 | null | no | |
| R4 | Review T4 (apps/server/src/connectors/browserSession.ts, apps/server/package.json). Confirm launchScanBrowser(): Promise<Browser> wraps chromium.launch({headless:true}); shared UA string matches the pinned playwright's bundled Chromium build (A14 claims Chrome for Testing 156.0.8078.4 — spot-check node_modules/playwright-core/browsers.json yourself); init script patches navigator.webdriver to undefined; UA/init-script constants exported separately from the launch call. Standing checks: playwright pinned to a real version (A13: ^1.64.1), no floating */latest; file opens with a block comment; file is near/under the ~200-line cap. Read-only. | reviewer | T4 | complete | 0 | | 2026-10-16T21:32:19Z | 2026-10-16T21:33:33Z | 15 | 2026-10-16T21:32:19Z | 6600 | null | no | |
| TE4 | Test T4 (apps/server/package.json, apps/server/src/connectors/browserSession.ts). Confirm playwright is pinned, not floating (read package.json/package-lock.json). Confirm launchScanBrowser actually launches headless chromium (a real smoke test, closing the browser after). NOTE: apps/server/package.json is also edited by T7 (adds a login-facebook-marketplace npm script) — if you use break-run-restore on package.json, restore it BEFORE ending your turn; you are intentionally run before T7's tester to avoid a collision on this shared file. export NVM_DIR=/home/adamcrevel/.nvm && source "$NVM_DIR/nvm.sh" && nvm use 22.23.3 first. | tester | T4 | complete | 0 | | 2026-10-16T21:32:19Z | 2026-10-16T21:38:24Z | 15 | 2026-10-16T21:32:19Z | 24300 | null | no | apps/server/test/browserSession.test.ts |
| R5 | Review T5 (apps/server/src/connectors/mercariConnector.ts, apps/server/src/connectors/mercariSearchMapping.ts). **MUST FIX RETEST (cycle 0 retry 1)**: confirm the file-size must_fix is genuinely resolved — A32 claims the split (config-validation + candidate-mapping moved to a new mercariSearchMapping.ts) brought mercariConnector.ts from 244 to 119 lines (new file 144 lines); independently count both files' actual line counts and confirm both are comfortably under the ~200-line cap. Separately re-verify on their own merits (now split across two files): search(config) validates MercariConnectorConfig's shape, AppError(400) on malformed input; maxPrice boundary is client-side filtered inclusive-at-ceiling (an item at the ceiling kept, one $0.01 over dropped — Requirement 1's explicit two-case bar); status !== 'on_sale' excluded; price cents→dollars conversion; nonWorking always false; listingDate defaults to today (A17) and externalItemId (not listingDate) is the dedup key. Confirm mercariConnector.test.ts needed no changes (A32) since it only imports the public connector export. Both files open with a block comment. Read-only. | reviewer | T5 | complete | 0 | | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 20 | 2026-10-16T22:56:35Z | 23000 | null | no | |
| TE5 | Test T5 (apps/server/src/connectors/mercariConnector.ts, apps/server/src/connectors/mercariSearchMapping.ts). Prove Requirement 1's two explicit max-price boundary cases with real, separate test cases (ceiling kept, +$0.01 dropped). Confirm dedup against already-imported externalItemIds. Confirm AppError(400) for malformed config (empty queries, blank query string, negative maxPrice). Use break-run-restore on one assertion to prove it can fail, then restore. **MUST (cycle 0 retry 1)**: confirm `apps/server/test/mercariConnector.test.ts` still passes unmodified after the A32 file split (the test only imports the public connector export) — run it and report the actual result, don't just trust A32's claim. NOTE: this file is also touched by T6 (a one-line wiring addition) — T6 already passed and is not part of this retry batch, so it is safe to touch. export NVM_DIR=/home/adamcrevel/.nvm && source "$NVM_DIR/nvm.sh" && nvm use 22.23.3 first. | tester | T5 | complete | 0 | | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 20 | 2026-10-16T22:56:35Z | 24000 | null | no | apps/server/test/mercariConnector.test.ts |
| R6 | Review T6 (apps/server/src/connectors/mercariItemDetail.ts, and its one-line wiring addition in mercariConnector.ts). Confirm it navigates to the item-detail URL and reads the description from the real confirmed __NEXT_DATA__ path (A25: props.pageProps.serverState's normalized ItemDetail:<id> node's description field) — spot-check the code literally reads this path, not a guessed one; returns null (never throws past its own boundary) when the tag/field is missing, logged at Warn, matching attachCandidateDescription's best-effort contract from T3; opens/closes its own short-lived browser context in a finally block. File opens with a block comment; near/under the 200-line cap. Read-only. FAIL: the outer navigation-failure catch path had zero test coverage (resolved in the same cycle — see TE6). | reviewer | T6 | complete | 0 | | 2026-10-16T21:32:19Z | 2026-10-16T21:35:38Z | 15 | 2026-10-16T21:32:19Z | 11800 | null | no | |
| TE6 | Test T6 (apps/server/src/connectors/mercariItemDetail.ts, and its one-line wiring addition in mercariConnector.ts). Confirm a missing/malformed __NEXT_DATA__ tag returns null without throwing (unit test with a mocked page), and that a Warn-level log fires. Confirm the browser context is closed even when the description-field lookup throws partway through (finally). SPECIFICALLY: add a test where page.goto() rejects (e.g. a navigation timeout), asserting fetchMercariItemDescription still resolves null rather than throwing past its own boundary, and that logger.warn fires with a message distinguishing this cause from a missing-tag/malformed-JSON cause. Use break-run-restore on the outer try/catch to prove this new test can actually fail, then restore. NOTE: mercariConnector.ts was touched by T5's tester in an earlier batch, which has now fully returned — it is safe to touch now. | tester | T6 | complete | 0 | | 2026-10-16T21:58:00Z | 2026-10-16T22:06:24Z | 15 | 2026-10-16T21:58:00Z | 48000 | null | no | apps/server/test/mercariItemDetail.test.ts |
| R7 | Review T7 (apps/server/src/scripts/facebook-marketplace-login.ts, its npm script in apps/server/package.json). Confirm it launches a HEADED (visible) browser, navigates to facebook.com/login, detects login completion via the isLoggedInUrl predicate (A15) rather than the stdin fallback, persists storageState to <DATA_DIR>/facebook-marketplace-session.json using photoStorage.ts's own DATA_DIR resolution, and reuses T4's shared UA/init-script constants (A16). Confirm the top-of-file comment states this must run against the dedicated secondary account, never the primary one. Cross-cutting standing check (spans T7 and T12): the session file must be covered by .gitignore BEFORE it can ever be written — confirm T12's .gitignore pattern (`**/data/facebook-marketplace-session.json`) actually matches the literal path this script writes to. **MUST FIX RETEST (cycle 0 retry 1)**: confirm the orphaned-Chromium-process leak is genuinely fixed — A33 claims `browser` is now declared `let browser: Browser \| undefined` before the try, with cleanup moved into a `finally` block covering every post-launch failure path (goto, context/page creation, storageState write), consolidating process.exit into one call after try/catch/finally. Read the actual code and confirm the finally block truly runs browser.close() on every failure path named, not just the success path. Read-only. | reviewer | T7 | complete | 0 | | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 18 | 2026-10-16T22:56:35Z | 27500 | null | no | |
| TE7 | Test T7 (apps/server/src/scripts/facebook-marketplace-login.ts). Test isLoginOrCheckpointUrl-style login-detection (plan.md assumption A15 calls it isLoggedInUrl; read the actual exported name) as the pure function it is, with real test cases (true once on facebook.com and off /login or /checkpoint; false while still on either) — confirm at least the ~8 cases assumption A15 claims exist and that they're meaningful, not padding. You cannot test the real interactive login flow (no dedicated account exists in this sandbox) — note that plainly rather than attempting it. **MUST (cycle 0 retry 1)**: independently confirm the resource-leak must_fix (A33) is genuinely resolved — mock a failure after a successful browser launch on each of the three named paths (goto() failure, context/page creation failure, storageState() write failure) and assert browser.close() was called in every case, not just the prior success-only path. Include the actual pass/fail result in your digest. NOTE: apps/server/package.json was touched by T4's tester in an earlier batch, which has now fully returned — it is safe to touch now if needed. | tester | T7 | complete | 0 | | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 18 | 2026-10-16T22:56:35Z | 14500 | null | no | apps/server/test/facebookMarketplaceLogin.test.ts |
| R8 | Review T8 (apps/server/src/connectors/facebookMarketplaceConnector.ts, facebookMarketplaceSession.ts, facebookMarketplaceConfig.ts, facebookMarketplaceDom.ts, facebookMarketplaceListing.ts, apps/server/test/facebookMarketplaceConnector.test.ts). **MUST FIX RETEST (cycle 0 retry 1)**: A35 claims all 4 must_fix items are resolved — (1) Req 6's login/checkpoint guard widened from URL-prefix-only to four independent signals in `assertSearchPageAuthenticated` (/login or /checkpoint URL, a bare facebook.com root redirect, a non-OK navigation status, an inline login wall in the DOM at the search URL), each throwing the same AppError naming `npm run login-facebook-marketplace`, plus a tightened `parseFacebookUrl` host check (exact/subdomain match, not endsWith); (2) a test asserting storageState/shared UA/init-script are passed into newContext(); (3) a test asserting page.goto()'s exact URL; (4) both files split further (facebookMarketplaceConnector.ts 156 lines, facebookMarketplaceSession.ts 173, facebookMarketplaceConfig.ts 54, facebookMarketplaceDom.ts 146, facebookMarketplaceListing.ts 153). Read the actual code for each of the 4 fixes and confirm independently — trace `assertSearchPageAuthenticated` line by line for all four signals, confirm the two new tests actually assert what A35 claims, and independently count each file's lines. This remains Requirement 6's single most safety-critical behavior in the feature. Confirm the file's top comment still flags it as most likely to need rework, and A20's documentation-sourced choices are still honestly flagged. Read-only. FAIL: `parseFacebookUrl`'s tightened host check (facebookMarketplaceSession.ts:86) is correct code with zero test coverage — reverting it to the old spoofable `endsWith('facebook.com')` leaves the entire 612-line facebookMarketplaceConnector.test.ts suite green (proven by evaluating both implementations over every URL literal the suite feeds these predicates). | reviewer | T8 | complete | 0 | | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 30 | 2026-10-16T22:56:35Z | 21000 | null | no | |
| TE8 | Test T8 (same files). This is the highest-stakes connector in the feature (Requirement 6's silent-failure prohibition) — prioritize proving: (1) a missing storageState file throws the clear AppError naming the login script (delete/mock the file and assert the thrown error's message, don't just read the code); (2) landing on a login/checkpoint page throws an AppError rather than returning [] (mock the navigation to land on a checkpoint URL and assert the specific error); (3) exact-boundary maxPrice (ceiling kept, +$0.01 dropped) same as T5's requirement. Use break-run-restore on one of these three to prove your test can actually fail. **MUST (cycle 0 retry 1)**: independently exercise A35's three newly-widened guard signals (bare facebook.com root redirect, non-OK navigation status, inline DOM login wall at the search URL) — mock each one separately and assert `assertSearchPageAuthenticated` throws the AppError in every case, not just the original URL-prefix case. Also confirm the two new tests for storageState/UA-passed-into-newContext() and page.goto()'s exact URL actually exist and pass. export NVM_DIR=/home/adamcrevel/.nvm && source "$NVM_DIR/nvm.sh" && nvm use 22.23.3 first. | tester | T8 | complete | 0 | | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 35 | 2026-10-16T22:56:35Z | 18000 | null | no | apps/server/test/facebookMarketplaceConnector.test.ts |
| R9 | Review T9 (apps/server/src/connectors/registry.ts). Confirm mercariConnector registered under 'mercari' and facebookMarketplaceConnector under 'facebook_marketplace' in CONNECTOR_REGISTRY; the file's own comment no longer says only 'ebay' is registered. Small/mechanical. **MUST FIX RETEST (cycle 0 retry 1)**: confirm A37's repoint is genuinely applied and correct — `apps/server/test/ebayConnector.test.ts`'s `getConnectorForPlatform` "rejects an unregistered platform type" case now uses `'other'` (not `'facebook_marketplace'`), and `apps/server/test/scan.test.ts`'s "returns 400 for a non-ebay platformType Source" case now uses `platformType: 'other'` — read both files and confirm the literal repoint, not just A37's claim. Read-only. | reviewer | T9 | complete | 0 | derek-zoolander | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 18 | 2026-10-16T22:56:35Z | 4800 | null | no | |
| TE9 | Test T9 (apps/server/src/connectors/registry.ts, apps/server/test/ebayConnector.test.ts, apps/server/test/scan.test.ts). Confirm (or add) a test asserting CONNECTOR_REGISTRY has entries for 'mercari' and 'facebook_marketplace' resolving to the right connector modules, alongside the pre-existing 'ebay' entry. **MUST (cycle 0 retry 1)**: run `apps/server/test/ebayConnector.test.ts` and `apps/server/test/scan.test.ts` and confirm both pass with the A37 repoint (`'other'` in place of `'facebook_marketplace'` in both cases) — report the actual pass/fail result. Small/mechanical. export NVM_DIR=/home/adamcrevel/.nvm && source "$NVM_DIR/nvm.sh" && nvm use 22.23.3 first. | tester | T9 | complete | 0 | derek-zoolander | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 10 | 2026-10-16T22:56:35Z | 3800 | null | no | apps/server/src/connectors/registry.ts; apps/server/test/registry.test.ts; apps/server/test/ebayConnector.test.ts; apps/server/test/scan.test.ts |
| R10 | Review T10 (apps/server/src/routes/sourceValidation.ts, apps/server/test/sourceValidation.test.ts). Confirm VALID_PLATFORM_TYPES includes 'mercari'; validateMercariConnectorConfig/validateFacebookMarketplaceConnectorConfig mirror validateEbayConnectorConfig's exact rules (non-empty non-blank queries; optional non-negative maxPrice; Facebook's location normalizes present-but-blank to omitted like the existing notes field; optional non-negative radiusMiles); validateSourceInput branches on all three platform types now. **MUST FIX RETEST (cycle 0 retry 1)**: A34 claims the 3-way platform-config dispatch was extracted into a new `validateConnectorConfigForPlatform` helper (sequential if-returns, matching the file's existing style) and eslint now confirms validateSourceInput's complexity is under 10 — independently run eslint's complexity rule against this file and confirm the measured figure, don't just trust A34's claim; also confirm no validation rule or behavior changed in the extraction. Standing check: no raw SQL in this file. Read-only. | reviewer | T10 | complete | 0 | | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 18 | 2026-10-16T22:56:35Z | 7000 | null | no | |
| TE10 | Test T10 (apps/server/src/routes/sourceValidation.ts, apps/server/test/sourceValidation.test.ts). Confirm A23's new dedicated fast unit-test file actually exercises validateSourceInput directly. Prove negative cases for both new platforms (empty queries, blank query, negative maxPrice, negative radiusMiles) fail validation, and a blank location normalizes to omitted the same way notes does. **MUST (cycle 0 retry 1)**: confirm the extracted `validateConnectorConfigForPlatform` helper (A34) did not change any validation rule or behavior — run the full `sourceValidation.test.ts` suite and confirm every existing assertion still passes unmodified. export NVM_DIR=/home/adamcrevel/.nvm && source "$NVM_DIR/nvm.sh" && nvm use 22.23.3 first. | tester | T10 | complete | 0 | | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 18 | 2026-10-16T22:56:35Z | 9800 | null | no | |
| R11 | Review T11 (apps/web/src/features/sources/source-form.tsx, source-row.tsx, connector-config-editor.tsx, facebook-marketplace-config-editor.tsx, apps/web/test/source-ebay-connector.test.tsx). **Flagged**: A27 says T11 also edited apps/web/src/features/sale-listings/sale-listings-list.tsx (outside features/sources/, not named in T11's file list), justified as required for `tsc -b` against the widened PlatformType union. TRACE THIS FILE'S DIFF yourself — it currently holds `const PLATFORM_LABELS: Record<PlatformType, string> = {...}` at line 7, a `Record<PlatformType,string>` with no index signature, so a missing union member genuinely fails to compile; confirm this live by reading the file and, if useful, temporarily removing the 'mercari' key and running `tsc -b` to see it fail, then restoring. Confirm the edit is minimal (one label entry added, nothing else touched) and renders 'Mercari' the same way Sources does. Separately confirm T11's own scope: PLATFORM_OPTIONS gains {value:'mercari', label:'Mercari'}; PLATFORM_LABELS gains mercari:'Mercari'; canScan generalizes to a client-side array ['ebay','mercari','facebook_marketplace'] with a hand-sync comment (standing check: apps/web never imports apps/server directly); connector-config-editor.tsx reused unchanged for Mercari; a new facebook-marketplace-config-editor.tsx (A26) handles location/radiusMiles; source-form.tsx picks the right editor/validator per platformType. Confirm A28's repointed test assertions ('other' replacing 'facebook_marketplace' as the non-scannable stand-in) are still true negatives, not weakened. Read-only. | reviewer | T11 | complete | 0 | | 2026-10-16T21:32:19Z | 2026-10-16T21:41:35Z | 25 | 2026-10-16T21:32:19Z | 59000 | null | yes | |
| TE11 | Test T11 (same files + sale-listings-list.tsx). Run apps/web's vitest suite for the touched files. **Visual evidence gate**: this is a ui:yes task whose change affects appearance (new dropdown option, two editor variants, a Sources table row per new platform with a working Scan button). If you have access to a real browser/screenshot tool, start the web app and capture screenshots proving: (1) the platform dropdown showing Mercari and Facebook Marketplace options, (2) Mercari's connector-config editor rendered after selecting it, (3) Facebook Marketplace's editor with its location/radius fields visible, (4) a Sources table row per new platform with an enabled Scan now button — each with a path and a one-sentence description including neighbouring elements. If no browser/screenshot tool is available, do NOT substitute computed-style values, DOM queries, or source reads as proof — report BLOCKED explicitly for the visual-evidence requirement and say plainly no browser tool exists. export NVM_DIR=/home/adamcrevel/.nvm && source "$NVM_DIR/nvm.sh" && nvm use 22.23.3 first. | tester | T11 | complete | 0 | | 2026-10-16T21:32:19Z | 2026-10-16T21:50:03Z | 30 | 2026-10-16T21:32:19Z | 150000 | null | yes | |
| R12 | Review T12 (.gitignore, apps/server/.env.example, README.md). Confirm .gitignore covers `**/data/facebook-marketplace-session.json` before T7's script can ever write it; .env.example gets a comment block correctly stating no new env vars for Mercari and that Facebook Marketplace needs one `npm run login-facebook-marketplace` run first, plus a `npx playwright install chromium` one-time setup note next to the existing eBay-credentials block; README gets a one-line pointer to the same note. **MUST FIX RETEST (cycle 0 retry 1)**: A36 claims the documented login command now works verbatim from the repo root after adding a `-w @pc-parts-flipper/server` workspace flag — independently run the exact documented command (with `--help` appended so it doesn't actually launch a browser) from the repo root and confirm npm dispatches to the apps/server workspace script rather than erroring "Lifecycle script not found". Read-only. | reviewer | T12 | complete | 0 | | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 12 | 2026-10-16T22:56:35Z | 18000 | null | no | |
| TE12 | Test T12 (.gitignore, apps/server/.env.example, README.md). Packaging/docs with no executable logic — confirm by running `git check-ignore -v apps/server/data/facebook-marketplace-session.json` from the worktree root that it actually matches the new .gitignore rule (a real command, not a read-through), and that README/.env.example render/parse correctly (no broken markdown, no syntax error introduced in .env.example). **MUST (cycle 0 retry 1)**: independently run the exact documented `npm run login-facebook-marketplace -w @pc-parts-flipper/server --help` (or whatever exact form A36 landed on — read .env.example for the literal command) from the repo root and confirm it dispatches correctly rather than erroring. export NVM_DIR=/home/adamcrevel/.nvm && source "$NVM_DIR/nvm.sh" && nvm use 22.23.3 first. | tester | T12 | complete | 0 | | 2026-10-16T22:56:35Z | 2026-10-16T23:16:55Z | 12 | 2026-10-16T22:56:35Z | 26000 | null | no | |
| T13 | Add real test coverage for `apps/server/src/connectors/facebookMarketplaceSession.ts`'s `parseFacebookUrl` host-spoofing guard (the tightened exact/subdomain match that replaced the old spoofable `endsWith('facebook.com')` check, landed in T8's cycle-0-retry-1 fix). Add at least one test asserting a lookalike host — e.g. `https://evilfacebook.com/...` or `https://notfacebook.com/...` — is correctly distinguished from a real `facebook.com` host or one of its real subdomains, either by calling `parseFacebookUrl` directly or by exercising whichever guard in `facebookMarketplaceConnector.ts`/`facebookMarketplaceSession.ts` consumes its result for Requirement 6's login/checkpoint detection. Prove the test can fail: temporarily revert line 86's host check to the old `endsWith('facebook.com')` form, confirm the new test fails, then restore. | builder | T8 | complete | 1 | | | 2026-10-16T23:33:31Z | 2026-10-16T23:46:00Z | 15 | 2026-10-16T23:32:15Z | 12500 | null | no | apps/server/test/facebookMarketplaceSession.test.ts |
| R13 | Review T13 (apps/server/test/facebookMarketplaceSession.test.ts). Confirm the 30 new tests genuinely exercise `parseFacebookUrl`'s host-spoofing guard (Requirement 6) through `isLoginOrCheckpointUrl`/`isFacebookRootUrl` rather than being vacuous. Do not trust the builder's self-report (A39) — independently confirm the mutation-kill claim yourself, without touching the tracked `facebookMarketplaceSession.ts` (read-only, no Edit/Write): copy the file to a scratch location outside the repo, in the scratch copy only revert line 86's host check to the old spoofable `parsed.hostname.endsWith('facebook.com')` form, run the 30 tests against that scratch copy (via a scratch-local import path) and confirm the expected lookalike-host cases fail, then confirm the real tracked file's tests all still pass 30/30 unmodified. Also confirm no test is trivially true regardless of the guard (e.g. asserting on an unrelated property). | reviewer | T13 | complete | 1 | | 2026-10-16T23:52:25Z | 2026-10-16T23:54:23Z | 12 | 2026-10-16T23:52:25Z | 4800 | null | no | |
| TE13 | Test T13 (apps/server/test/facebookMarketplaceSession.test.ts). Run `npx vitest run test/facebookMarketplaceSession.test.ts` from apps/server and confirm 30/30 pass. Do not trust the builder's self-report (A39) — independently reproduce the mutation-kill proof yourself directly on the tracked `apps/server/src/connectors/facebookMarketplaceSession.ts` using break-run-restore: revert line 86's host check to the old spoofable `parsed.hostname.endsWith('facebook.com')` form, re-run the test file and confirm the lookalike-host cases fail (report the exact failing count), then restore line 86 exactly to the tightened exact/subdomain form, confirm `git diff` on that file is clean, and re-run to confirm 30/30 pass again. export NVM_DIR=/home/adamcrevel/.nvm && source "$NVM_DIR/nvm.sh" && nvm use 22.23.3 before any npm/node command. | tester | T13 | complete | 1 | | 2026-10-16T23:52:25Z | 2026-10-16T23:55:03Z | 15 | 2026-10-16T23:52:25Z | 10200 | null | no | |
| U1 | UAT pass for cycle 1: exercise the whole marketplace-sources feature end to end as a real user would (Sources CRUD/UI, Mercari scan, Facebook Marketplace scan with a real dedicated-account session if available, scan-triggered Listing import with photos/description, dedup, the ~200-line/doc-comment/DuckDB-boundary/apps-web-boundary standing checks) — not task by task. | uat | T13 | complete | 1 | | 2026-10-17T00:07:51Z | 2026-10-17T00:28:17Z | | 2026-10-17T00:07:51Z | 46000 | | no |
| T14 | Fix a real auth-bypass bug in `apps/server/src/connectors/mercariConnector.ts`'s `searchOneQuery`, found during cycle-1 UAT's live investigation (not a task from a prior must_fix — found directly against the real site): the function injects its own `page.evaluate(() => fetch(url, { headers: { accept: '*/*' } }))` call for the `searchFacetQuery` request instead of letting the already-loaded page issue that request itself. Mercari's real bearer/CSRF auth headers are minted by the page's own JS and held only in memory — confirmed live that neither token exists in any cookie, `localStorage`, or `sessionStorage` key on a real search page — so the hand-built fetch has no way to attach them and Mercari's API correctly rejects it with a `200` response body `{"errors":[{"status":401,"message":"Unauthorized"}]}`. Two fixes, same root cause: (1) Replace the injected fetch with Playwright's own response-capture (e.g. `page.waitForResponse(resp => resp.url().includes('searchFacetQuery') && resp.request().method() === 'GET')` raced against the `page.goto()` navigation that naturally triggers Mercari's own authenticated call) and read that response's real body instead of firing a second, parallel, credential-less one. (2) After parsing the body, check for a top-level `errors` array and throw an `AppError(502)` with Mercari's own error message when present — mirroring `ebayConnector.ts`'s `!response.ok` throw — instead of `body.data?.search?.itemsList ?? []` silently treating ANY API error (this one, a future rate-limit, a future persisted-query-hash rotation) as "zero results found." Verify live against the real site (same technique used throughout this feature): confirm the fix returns real, non-empty, real-world results for a real query term, and confirm a forced/mocked `errors`-body response now throws instead of returning `[]`. Update `mercariConnector.test.ts` for the new throw-on-`errors` behavior if any existing test's mock shape is now stale. | builder | T5 | complete | 2 | | | 2026-10-17T01:25:21Z | 2026-10-17T01:34:16Z | 30 | 2026-10-17T01:24:13Z | 48000 | null | no | apps/server/src/connectors/mercariConnector.ts, apps/server/src/connectors/mercariSearchMapping.ts, apps/server/test/mercariConnector.test.ts |
| R14 | Review T14 (apps/server/src/connectors/mercariConnector.ts, apps/server/src/connectors/mercariSearchMapping.ts). Confirm `searchOneQuery` no longer injects its own `page.evaluate(() => fetch(...))` call for `searchFacetQuery` and instead captures the page's own already-authenticated response via `page.waitForResponse` raced against `page.goto`; confirm a top-level `errors` array in an otherwise-200 response now throws `AppError(502)` with Mercari's own message instead of `body.data?.search?.itemsList ?? []` silently swallowing it as zero results. Confirm Requirement 1's exact-boundary maxPrice behavior and Req 1's dedup wiring remain correct and unbroken by this refactor (pre-existing tests, not newly introduced here). **Do not trust the builder's self-reported live verification (A41: 94 real results for "graphics card", a real captured 200 response with no errors) — independently re-run a live query against the real mercari.com yourself** via a fresh throwaway tsx script (deleted after use) that imports and calls the real `mercariConnector.search()` against a real headless Chromium, and confirm real non-empty results yourself. Separately, independently confirm the errors-array-throws-AppError(502) behavior against a forced/mocked response (read `apps/server/test/mercariConnector.test.ts`'s new T14 regression test at the bottom of the first `describe` block and confirm it is non-vacuous, or build your own forced-response repro). Read-only — no Edit/Write. | reviewer | T14 | complete | 2 | | 2026-10-17T01:35:32Z | 2026-10-17T01:51:54Z | 15 | 2026-10-17T01:35:32Z | 46500 | null | no | |
| TE14 | Test T14 (apps/server/src/connectors/mercariConnector.ts, apps/server/src/connectors/mercariSearchMapping.ts, apps/server/test/mercariConnector.test.ts). Run `npx vitest run test/mercariConnector.test.ts` from apps/server and confirm all tests pass. **Do not trust the builder's self-reported live verification (A41) — independently re-run a live query against the real mercari.com yourself**: write a fresh throwaway tsx script (deleted after use) that imports and calls the real `mercariConnector.search()` with a real headless Chromium against a real query term (e.g. "graphics card"), and confirm it returns real, non-empty results (not an empty array from a Cloudflare block or stale auth). Separately, independently confirm the errors-array-throws-AppError(502) behavior against a forced/mocked response yourself: break-run-restore the errors-array guard in `mercariConnector.ts` (comment it out), confirm the existing T14 regression test in `mercariConnector.test.ts` now fails without it, then restore the file exactly and confirm `git diff` is clean and the suite is green again. export NVM_DIR=/home/adamcrevel/.nvm && source "$NVM_DIR/nvm.sh" && nvm use 22.23.3 before any npm/node command. | tester | T14 | complete | 2 | | 2026-10-17T01:35:32Z | 2026-10-17T01:51:54Z | 20 | 2026-10-17T01:35:32Z | 20800 | null | no | |
| U2 | UAT pass for cycle 2: re-exercise the Mercari live scan path end to end (now fixed) plus a fast re-check of every requirement/standing check U1 already covered, to confirm T14's fix composes cleanly with the rest of the feature — not task by task. | uat | T14 | complete | 2 | | 2026-10-17T02:06:27Z | 2026-10-17T02:47:14Z | | 2026-10-17T02:06:27Z | 29700 | | no |


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
- A8 (cycle 0): T1's `FacebookMarketplaceConnectorConfig` doc comment summarizes queries/location/
  radiusMiles/maxPrice together in one sentence rather than per-field JSDoc, since `EbayConnectorConfig`
  carries no per-field doc comments to mirror and the file's convention is one comment per interface.
- A9 (cycle 0): T2's literal instruction (`ALTER TYPE platform_type ADD VALUE`, swallowing only the
  "already contains" error) assumed Postgres-style behavior DuckDB does not have — empirically
  confirmed against two independent DuckDB binaries that DuckDB has no `ALTER TYPE` statement at
  all, which would throw on every boot, not just upgrades. Implemented the functionally-equivalent,
  data-safe outcome instead: the same backup/drop/recreate/restore rebuild pattern
  `migrateExpectedPartsNullablePrice` already uses, scoped to the full FK subtree rooted at
  `sources`, re-running the file's own `ENUM_STATEMENTS`/`TABLE_STATEMENTS`/`ALTER_STATEMENTS` as
  the single source of truth. Verified end-to-end against a simulated pre-existing database with all
  rows surviving byte-for-byte and a second run being a true no-op; mutation-tested (3/3 killed).
- A10 (cycle 0): T3 places the `connector.createDescriptionFetcher?.()` call inside
  `scanSourceWithConnector` rather than literally in `scanSource`, since the task required deleting
  `scanSourceWithConnector`'s `deps` parameter entirely, leaving no channel to pass a fetcher built
  in `scanSource` down to `importCandidateIfNew`. Observationally identical for every real caller and
  every existing test.
- A11 (cycle 0): T3 introduced an exported `DescriptionFetcher` type alias in `types.ts` instead of
  repeating the inline function signature three times — cosmetic only, same resulting type.
- A12 (cycle 0): T3's "Starting scan" info log in `scanSourceWithConnector` now records
  `platformType` instead of `queryCount`, since `config` is now typed `unknown` and `queries.length`
  is unreachable without a platform-specific cast — the exact branch this refactor removes. No test
  asserts either field.
- A13 (cycle 0): T4 pinned `playwright` as `^1.64.1` (npm's current latest stable at build time),
  keeping this file's existing caret-prefixed-exact-version style (every other dependency uses a
  caret) rather than a bare version — the task's "no floating `*`/`latest`" requirement is about
  unpinned ranges, not about deviating from the file's own pinning convention.
- A14 (cycle 0): T4's UA string is version-matched to the Chromium build this pinned `playwright`
  actually bundles (Chrome for Testing 156.0.8078.4, confirmed by reading
  `node_modules/playwright-core/browsers.json`), not a hand-guessed figure.
- A15 (cycle 0): T7 detects login completion by polling `page.url()` against an `isLoggedInUrl`
  predicate (true once on facebook.com and no longer under `/login` or `/checkpoint`), not the
  stdin-fallback the task offered as an alternative — simpler, needs no extra operator action, and
  unit-testable as a pure function (proven with 8 cases). The real multi-step Facebook login/2FA
  flow is unverified end-to-end since no real dedicated account exists yet in this sandbox.
- A16 (cycle 0): T7 reuses T4's `browserSession.ts` `SCAN_BROWSER_USER_AGENT`/
  `SCAN_BROWSER_INIT_SCRIPT` constants for the headed login context, per that file's own stated
  purpose of letting a persistent logged-in context share the same fingerprint patch — keeps the
  saved session's apparent browser fingerprint consistent with what T8's scan connector presents
  when replaying it.
- A17 (cycle 0): T5 defaults `CandidateListing.listingDate` to today's date for a Mercari item, since
  the itemsList entries' confirmed-live field list has no creation-date field and the real response
  body couldn't be captured from this sandbox's network (Cloudflare-blocked). `externalItemId`, not
  `listingDate`, is what dedupes candidates, so this doesn't risk duplicate imports — only the
  displayed listing date reads as scan-date until a future live capture confirms the real field.
- A18 (cycle 0): T5's `mercariConnector.ts` is kept as one 243-line file (slightly over the ~200-line
  soft target) rather than split, since the split option in the task table was stated for T8 only
  and all of T5's content (live-capture rationale, criteria shape, validation, mapping) is load-
  bearing, not padding.
- A19 (cycle 0): T5 discovered `packages/shared/src/connectors.ts`/`sources.ts` did not actually carry
  T1's types in this worktree, despite the task table (then) marking T1 complete, and re-landed T1's
  exact documented scope to unblock itself and T8. Separately, T2 and T8 themselves had been applied
  to the main repo checkout instead of this worktree (a path-resolution mistake, the same class T4
  self-caught in round 1) — `feature-build-lead` found and fixed this directly: copied T2's
  (`db/schema.ts`/`migrate.ts`) and T8's (`facebookMarketplaceConnector.ts`,
  `facebookMarketplaceListing.ts`, its test file) real edits into the worktree, copied T12's stray
  README.md edit into the worktree, reverted the main checkout's accidental changes, and reran
  `tsc --noEmit`, `eslint`, and the full affected test suite (`db.test.ts` 38/38,
  `scanService.test.ts` 16/16, `mercariConnector.test.ts`, `facebookMarketplaceConnector.test.ts`,
  `sourceValidation.test.ts`) from inside the worktree — all pass. T8's own builder could not run
  its own verification due to a session-local filesystem-view bug in its sandbox; `feature-build-lead`
  supplied that verification instead, after the file recovery, as noted above.
- A20 (cycle 0): T8's Facebook Marketplace search URL/response-field/DOM-selector choices are
  best-evidenced from public documentation and scraping write-ups, not confirmed live — no real
  dedicated Facebook account/session exists in this sandbox. Isolated to `facebookMarketplaceListing.ts`
  by design so a future correction against a real session is a small, localized edit. Flagged plainly
  in both new files' top comments per the task's own instruction.
- A21 (cycle 0): T8 defaults `listingDate` to today's date for Facebook Marketplace candidates too —
  no creation-date field was found in either the GraphQL-node shape or the scraped card text.
- A22 (cycle 0): T8's `createDescriptionFetcher()` opens a fresh short-lived browser context per
  description call rather than one shared across a whole scan pass (unlike eBay's lazy-shared-client
  pattern), since `MarketplaceConnector` has no "scan pass finished" hook a longer-lived browser could
  close on — a fresh-per-call context closed in its own `finally` cannot leak a process either way.
- A23 (cycle 0): T10 created `apps/server/test/sourceValidation.test.ts` as fast pure-unit tests
  importing `validateSourceInput` directly, since no dedicated unit-test file for this module existed
  yet (only `sources.test.ts`'s slower full-server HTTP-level ebay coverage) and the task named this
  file explicitly.
- A24 (cycle 0): T10 ordered `VALID_PLATFORM_TYPES` as `['ebay', 'facebook_marketplace', 'mercari',
  'other']` (and the matching error-message order) — no ordering was specified; cosmetic only,
  `Array.includes` is order-independent.
- A25 (cycle 0): T6's `createDescriptionFetcher` confirmed Mercari's real description JSON path live
  (sitemap-discovered item pages, since the search GraphQL call is Cloudflare-blocked from this
  sandbox): `props.pageProps.serverState`'s normalized `ItemDetail:<id>` node's `description` field.
  Opens a fresh short-lived browser per call (closed in `finally`), matching T8's Facebook connector
  precedent rather than eBay's shared-client pattern, since nothing signals "scan pass finished" for
  a shared browser to close on.
- A26 (cycle 0): T11 split Facebook Marketplace's connector-config editor into its own new file
  (`facebook-marketplace-config-editor.tsx`) rather than folding it into `connector-config-editor.tsx`,
  mirroring this feature's established mercariConnector.ts/mercariItemDetail.ts split pattern, to stay
  near the ~200-line soft cap per file.
- A27 (cycle 0): T11 fixed a pre-existing `PLATFORM_LABELS` map in
  `apps/web/src/features/sale-listings/sale-listings-list.tsx` (outside `features/sources/`) to add a
  `mercari` entry — required for `tsc -b` to pass against the widened shared `PlatformType` union; not
  itself part of the task's named file list but a necessary consequence of widening the union.
- A28 (cycle 0): T11 repointed two existing `source-ebay-connector.test.tsx` assertions that had used
  `'facebook_marketplace'` as a stand-in for "a platform with no connector editor" / "a non-scannable
  platform" — both premises broke once Facebook Marketplace became scannable with its own editor, so
  those tests now use `'other'` instead (still true negatives, same intent).
- A29 (cycle 0): feature-validate-lead's standing-gate full-suite run found two pre-existing tests
  that assumed `'facebook_marketplace'` meant "a platform with no automated-scan connector" —
  `apps/server/test/ebayConnector.test.ts`'s `getConnectorForPlatform` "rejects an unregistered
  platform type" case, and `apps/server/test/scan.test.ts`'s "returns 400 for a non-ebay platformType
  Source" case. Both broke once T8/T9 registered a real connector for `facebook_marketplace` — the
  same premise A28 already found and fixed on the `apps/web` side, missed on `apps/server`. Filed as
  a must_fix on T9 (the registry change that broke them), not a new task, since the fix is the same
  one-line repoint (to `'other'`, the one platform genuinely unregistered) A28 already modeled.
- A30 (cycle 0): T2's must_fix retry root-caused the Catalog Error to a stale FK catalog entry
  DuckDB retains after `migrateExpectedPartsNullablePrice`'s own CREATE-new/DROP-old/RENAME dance
  (persists across reconnects, survives `DROP TABLE ... CASCADE`). Fixed via a
  `rebuildCorruptedCatalog` helper (EXPORT DATABASE / DETACH / delete file / re-ATTACH / IMPORT
  DATABASE round-trip) run unconditionally before `migratePlatformTypeAddMercari`'s existing
  subtree rebuild, scoped entirely to `migrate.ts`; `schema.ts` unchanged. Verified against a
  database that had already run `migrateExpectedPartsNullablePrice`: no Catalog Error, full FK
  subtree preserved byte-for-byte, second run a true no-op; `test/db.test.ts`'s 39 tests pass 3
  consecutive runs.
- A31 (cycle 0): T3's must_fix added two tests proving `createDescriptionFetcher` is built once per
  scan pass and reused across candidates — a connector-agnostic spy-based unit test in
  `scanSourceWithConnector`, and an eBay-specific OAuth-token-call-count test (2 total calls across
  2 new candidates, not 3). Falsified against a manual once-per-candidate regression to confirm
  discriminating power; the existing 16 tests/assertions were left unmodified.
- A32 (cycle 0): T5's must_fix split `mercariConnector.ts`'s config-validation and search-result-
  mapping logic (`validateMercariConnectorConfig`, `mapSearchItem`, `buildSearchVariables`, and
  their supporting types/constants) into a new `apps/server/src/connectors/mercariSearchMapping.ts`,
  bringing `mercariConnector.ts` from 244 to 119 lines (new file 144 lines) with no behavior change
  — `mercariConnector.test.ts` only imports the public connector export, so it needed no changes.
- A33 (cycle 0): T7's must_fix moved browser cleanup into a `finally` block (declaring `browser` as
  `let browser: Browser | undefined` before the try, consolidating `process.exit` into one call
  after try/catch/finally) so every post-launch failure path (goto, context/page creation,
  storageState write) closes Chromium before the error propagates, without changing the headed-
  launch, login-detection, or persistence logic.
- A34 (cycle 0): T10's must_fix extracted the 3-way platform-config dispatch into a new
  `validateConnectorConfigForPlatform` helper placed before `validateSourceInput`, using sequential
  if-returns (matching the file's existing style) rather than nested ternaries — no validation rule
  or behavior changed; eslint confirms `validateSourceInput`'s complexity is now under 10.
- A35 (cycle 0): T8's must_fix widened Requirement 6's login/checkpoint guard from URL-prefix-only
  to four independent signals checked in `assertSearchPageAuthenticated`: `/login`/`/checkpoint`
  URL, a bare facebook.com root redirect, a navigation status outside 200–399, and an inline login
  wall in the DOM at the search URL itself — each throws the same `AppError` naming
  `npm run login-facebook-marketplace`. Also tightened `parseFacebookUrl`'s host check from
  `endsWith('facebook.com')` to an exact/subdomain match, closing a spoofable-host gap. Added tests
  asserting `storageState`/shared UA/init-script are passed into `newContext()` and that
  `page.goto()`'s exact URL is correct. Split both oversized files into facebookMarketplaceSession.ts
  (173 lines, session + guard), facebookMarketplaceConfig.ts (54 lines, config validation), and
  facebookMarketplaceDom.ts (146 lines, DOM fallback + description scraping), leaving
  facebookMarketplaceConnector.ts at 156 lines (orchestration only) and facebookMarketplaceListing.ts
  at 153 lines — mirroring T5/T6's mercariConnector/mercariSearchMapping/mercariItemDetail split.
  Verified via tsc, eslint complexity check, 46/46 relevant tests passing, and 10/10 mutations killed
  (guard bypasses, wiring drops, wrong-URL navigation).
- A36 (cycle 0): T12's must_fix added the `-w @pc-parts-flipper/server` workspace flag to
  `.env.example`'s documented `npm run login-facebook-marketplace` command (matching the exact form
  already used in `facebook-marketplace-login.ts`'s own top-of-file comment and this repo's other
  cross-feature precedent, which key off package.json's `name` field rather than the directory path)
  — verified by running the command with `--help` from the repo root and confirming npm correctly
  dispatches to the apps/server workspace script instead of erroring "Lifecycle script not found".
  README.md's existing pointer never reproduced the command itself, so it had no instance of this bug.
- A37 (cycle 0): T9's must_fix repointed `getConnectorForPlatform('facebook_marketplace')` →
  `getConnectorForPlatform('other')` in `ebayConnector.test.ts` (line 528) and
  `platformType: 'facebook_marketplace'` → `platformType: 'other'` in `scan.test.ts` (line 206) —
  a two-line test-input repoint, no production code or other test cases touched, mirroring A28's
  identical fix on the apps/web side.
- A38 (cycle 0): TE9's retry-1 dispatch found `apps/server/src/connectors/registry.ts` missing T9's
  own already-"complete" registration changes when its test run began — the same desync pattern A19
  already documented once in this worktree. TE9 re-applied T9's documented scope (both connectors
  registered, comment updated) to unblock its own test run, exactly as A19's precedent modeled;
  R9 independently re-reviewed the resulting file and confirmed it matches T9's row. Flagging this
  recurrence for visibility: this shared worktree has now self-healed from the same class of
  mid-run file-loss twice (A19, A38) across this feature's build/validate cycles.
- A39 (cycle 1): T13's builder added `apps/server/test/facebookMarketplaceSession.test.ts` (new
  file, 30 tests) covering `parseFacebookUrl`'s host-spoofing guard indirectly through the exported
  `isLoginOrCheckpointUrl`/`isFacebookRootUrl` functions, since `parseFacebookUrl` itself is a
  private, non-exported helper. Covers: lookalike hosts (`evilfacebook.com`, `notfacebook.com`,
  `myfacebook.com`) correctly rejected on both /login and /checkpoint paths and at root; real
  `facebook.com` and a real subdomain (`m.facebook.com`) correctly accepted as positive controls;
  non-login/checkpoint paths and malformed/unparseable URLs handled gracefully. Mutation-kill
  proven: reverting line 86's host check to the old spoofable `endsWith('facebook.com')` form
  flips 8 of the 30 new tests to failing, then restoring line 86 returns all 30 to passing —
  confirmed independently by `feature-build-lead` by reading the restored file and re-running the
  full facebookMarketplaceSession/Connector/Login suite (103/103 passing) after the builder
  returned.
- A40 (cycle 1): R13's and TE13's `actual_tokens` are both recorded `null` rather than
  `measure-child-cost.py`'s literal printed figure. The script returned the identical number
  (250761) for both distinct dispatches — independently confirmed bogus by grepping each child's
  own transcript file directly: neither `ValidateCycle1/ValidateCycle1.R13.jsonl` nor
  `ValidateCycle1/ValidateCycle1.TE13.jsonl` contains the literal `AGENT_TAG: review T13` /
  `AGENT_TAG: test T13` needle the script searches for at all. The script instead matched this
  lead's own top-level transcript (`ValidateCycle1.jsonl`, which echoes the dispatch prompt text
  containing both tags and is always the most-recently-modified file while this lead is still
  running), returning this lead's own running cost twice over rather than either child's. Per the
  skill's own instruction, a measured figure that is not a real per-child measurement is written
  `null`, never substituted with the bogus number or an estimate.
- A41 (cycle 2): T14's builder removed `buildSearchVariables`/`SEARCH_FACET_PERSISTED_QUERY`/
  `SEARCH_FACET_TYPES`/`SEARCH_PAGE_LENGTH` from `mercariSearchMapping.ts` as dead code (confirmed
  via repo-wide grep that nothing else referenced them) rather than leaving them unused, since the
  fix's whole point is that the page's own JS now issues and builds the `searchFacetQuery` request
  itself — `mercariConnector.ts` no longer hand-builds it. `MercariSearchFacetResponse` widened with
  an optional top-level `errors?: { status?: number; message: string }[]`. The new errors-array
  guard throws `new Error(body.errors.map(e => e.message).join('; '))`, mirroring
  `ebayConnector.ts`'s `extractEbayErrorMessage` join-of-messages fallback; for Mercari's documented
  single-error shape this reduces to just that one message (proven by the new test asserting
  `message: 'Unauthorized'` exactly). `page.waitForResponse`'s predicate filters on
  `method() === 'GET'`, matching the real captured request. Verified: `tsc --noEmit` clean;
  `vitest run test/mercariConnector.test.ts` 7/7 passing (including the new errors-array regression
  test); `npm run lint` clean; a break-run-restore mutation test (removing the errors-array guard)
  confirmed the new test fails without it, then the file was restored intact. **Live verification**
  against the real mercari.com site (a throwaway tsx script, deleted after use, exercising the real
  `mercariConnector.search()` via a real headless Chromium against the query "graphics card"):
  returned 94 real results, sample item `{externalItemId: 'm75992822617', title: 'ASUS ROG ASTRAL
  GEFORCE RTX 5090 32GB Graphics Card', askingPrice: 329.99, listingUrl:
  'https://www.mercari.com/us/item/m75992822617/'}`. A separate diagnostic script (also deleted)
  independently confirmed the captured response's real URL
  (`.../v1/api?operationName=searchFacetQuery&variables=...`), status 200, and a real JSON body
  reporting `count: 21595` total matches server-side — proving the fix now reads Mercari's own
  authenticated response rather than the credential-less 401-`errors` body the bug produced before.
- A42 (cycle 2): R14 and TE14 each independently re-ran their own fresh live query against the real
  mercari.com (separate throwaway scripts, both deleted after use, neither reading or trusting
  A41's claim) rather than trusting the builder's self-report — both observed the same 94-result
  outcome for "graphics card" the builder reported, with the identical sample item
  (`m75992822617`, ASUS ROG ASTRAL GEFORCE RTX 5090 32GB, $329.99), confirming it independently
  rather than merely restating it. TE14 additionally hit two genuine Cloudflare 403s on other live
  attempts from this sandbox's datacenter IP (confirmed via `cf-ray`/`server: cloudflare`
  response headers) — unrelated to T14's fix (the pre-existing `!response.ok()` branch correctly
  turned each into `AppError(502)` rather than silently returning zero results), and itself further
  unplanned confirmation that branch still works against the real site. Both R14 and TE14 also
  independently forced the errors-array-throws-AppError(502) behavior themselves (R14 via its own
  fresh vitest fixture asserting `response.ok()` was called and returned `true` so the 502
  provably came from the errors-array branch and not the `!response.ok()` branch; TE14 via
  break-run-restore directly on the tracked file, confirming the regression test fails without the
  guard and passes again once restored, `git diff` clean). Both PASS, no must_fix.
- A43 (cycle 2): `measure-child-cost.py --tag "review T14"` and `--tag "test T14"` both again
  returned the identical bogus figure (250761) A40 already documented for R13/TE13 in cycle 1 —
  re-confirmed bogus the same way: grepping both `ValidateCycle2/ValidateCycle2.R14.jsonl` and
  `ValidateCycle2/ValidateCycle2.TE14.jsonl` directly for the literal `AGENT_TAG: review T14` /
  `AGENT_TAG: test T14` needle found zero matches in either child's own transcript — the script is
  matching this lead's own top-level transcript again, not either child's. Per A40's precedent and
  the skill's own instruction, both R14's and TE14's `actual_tokens` are recorded `null`.








## Cycle Log

### Cycle 0
Trigger: initial
Standing gate (feature-validate-lead, cycle 0): full suite run from the worktree
(`npm run build -w packages/shared && npm run test --workspaces --if-present`, Node 22.23.3).
apps/web: 29/29 files, 302/302 tests pass (including `eslint-import-boundary.test.ts`, one of
BaselineSuite's own originally-failing files). packages/shared: 4/4 files, 28/28 tests pass.
apps/server: 51/66 files pass, 741/791 tests pass, 46 skipped. Total tests run: 1121, against
BaselineTests 1018 — coverage held and grew (+103), no shrinkage.
apps/server's 15 failing files split two ways: 11 are the same hook-timeout /
`Cannot read properties of undefined (reading 'stop')` signature BaselineSuite already documented
(real child-process server spawns colliding under this machine's resource contention) —
app-shell, identifyPartsConcurrency, identifyPartsRoute, listingsAcceptReject, pagination, parts,
photoServing, profit, purchases, saleListings, sales — inherited, not this feature's defect.
`listingPhotos.test.ts`'s one failure (ENOENT stat on a concurrent-upload temp file) is the same
resource-contention family and touches no file this feature changed — also inherited.
The remaining 3 are new, real regressions: `db.test.ts`'s `migratePlatformTypeAddMercari` case
(the T2 catalog-poisoning crash, see Findings), and `ebayConnector.test.ts` /
`scan.test.ts` (A29, filed on T9).
Findings:
- [T2, critical] apps/server/src/db/migrate.ts: migratePlatformTypeAddMercari crashes with
  `Catalog Error: Could not drop the table because this table is main key table of the table
  "expected_parts_new"` on `DROP TABLE listings`, against any database that has ever run the
  pre-existing migrateExpectedPartsNullablePrice rebuild — i.e. every real production database.
  Confirmed twice independently (TE2's isolated repro, and the standing gate's own full-suite run
  failing on TE2's added test/db.test.ts case with the identical error). Crashes server startup
  entirely on upgrade, not just one scan.
- [T3] apps/server/src/scan/scanService.ts / connectors/types.ts / connectors/ebayConnector.ts: no
  test protects "createDescriptionFetcher is built once per scan pass, reused for every candidate,"
  the design contract this refactor exists to generalize.
- [T5] apps/server/src/connectors/mercariConnector.ts is 244 lines, over the ~200-line cap the
  standing check's own wording already named this file's keep-under-cap split for.
- [T7] apps/server/src/scripts/facebook-marketplace-login.ts leaks a real orphaned Chromium process
  on any post-launch error path (browser const-declared inside try, never closed in catch) —
  confirmed independently by both its reviewer and tester.
- [T8] facebookMarketplaceConnector.ts / facebookMarketplaceListing.ts: Req 6's expired-session
  guard is URL-prefix-only (3 realistic silent-failure shapes remain unguarded); two vacuous-test
  gaps (storageState/UA never asserted onto newContext; page.goto's URL never asserted); both new
  files exceed the ~200-line cap (242 and 281 lines).
- [T9, see A29] apps/server/test/ebayConnector.test.ts and apps/server/test/scan.test.ts: both
  used `'facebook_marketplace'` as the "no connector registered" stand-in before T9 registered a
  real connector for it — repoint both to `'other'`, mirroring A28's identical fix on the web side.
- [T10] apps/server/src/routes/sourceValidation.ts: validateSourceInput's measured cyclomatic
  complexity is 11 (ESLint's own built-in rule), over the common 10 threshold, from the new 3-way
  platform dispatch.
- [T12] apps/server/.env.example's documented `npm run login-facebook-marketplace` command fails
  verbatim from the repo root (missing `-w apps/server`) — npm workspaces don't auto-delegate.
Retries: T2, T3, T5, T7, T8, T9, T10, T12 retried in place (cycle 0 retry 1) — each must_fix was
confined to its own single task, so none opened a new cycle. T1, T4, T11 passed clean, no retry
needed.
Standing gate (feature-validate-lead, cycle 0 retry 1): full suite re-run from the worktree root
(`npm run build -w packages/shared && npm run test --workspaces --if-present`, then `npm run lint`,
Node 22.23.3), once against the full post-batch tree after all 8 retried tasks landed together.
Build: clean. Lint (`eslint .`): clean, zero violations. apps/web: 29/29 files, 302/302 tests pass.
packages/shared: 4/4 files, 28/28 tests pass. apps/server: 61/66 files pass, 760/820 tests pass
(2 test-level failures, 58 skipped). Total tests run: 1150, against BaselineTests 1018 — coverage
held and grew (+132), no shrinkage. apps/server's 5 failing files (app-shell.test.ts,
listings.test.ts, photoServing.test.ts, teardown.test.ts, gracefulShutdown.test.ts) all carry the
same `Cannot read properties of undefined (reading 'stop')` / hook-timeout / signal-race signature
BaselineSuite already documented (real child-process server spawns and SIGTERM/SIGHUP timing
colliding under this machine's resource contention, worsened here by 16 reviewer/tester agents
running concurrently) — none touch a file this feature changed (connectors/, scan/,
routes/sourceValidation.ts, sources/, packages/shared/src/{sources,connectors}.ts); inherited, not
this feature's defect. No new regression this retry round — the 3 regressions the first standing
gate found (db.test.ts, ebayConnector.test.ts, scan.test.ts) are gone, confirming T2's and T9's
fixes.
Findings (retry 1):
- [T8] facebookMarketplaceSession.ts:86 — `parseFacebookUrl`'s tightened host check (exact/
  subdomain match replacing the old spoofable `endsWith('facebook.com')`) is correct code with
  zero test coverage: reverting it to the old loose check leaves the entire 612-line
  facebookMarketplaceConnector.test.ts suite green. Confirmed independently by evaluating both
  implementations over every URL literal the suite feeds these predicates — 0 behavioural
  differences on any literal the suite actually exercises. Not a production-code defect (the fix
  is genuinely correct), but a real regression-detection gap on a security-relevant guard in
  Requirement 6's single most safety-critical code path.
Retries (retry 1 verdicts): T2 PASS (central scrutiny item independently reproduced from scratch —
rebuildCorruptedCatalog genuinely fixes the catalog-poisoning crash across 3 consecutive runs
against an already-migrated database). T3 PASS (both A31 tests confirmed on disk and
non-vacuous; IRC filesystem-desync report independently re-verified — file genuinely intact). T5
PASS (line-count split independently measured: 119/144 lines). T7 PASS (finally-block cleanup
fix confirmed line-by-line and mutation-tested across all 3 named failure paths). T8 FAIL (see
Findings above — one test-coverage gap remains). T9 PASS (A37 repoint independently confirmed in
both files). T10 PASS (complexity independently re-measured at 8, down from 11). T12 PASS
(documented login command independently re-run from the repo root, dispatches cleanly). 7 of 8
pass; T8 carries one remaining must_fix.
UAT: not_run

### Cycle 1
Trigger: T8's second failure this cycle (feature-validate-lead, cycle 0 retry 1 re-review) — a
must_fix landing on a task already retried once this cycle, per Step 4.3's rule.
Findings:
- [T8] apps/server/src/connectors/facebookMarketplaceSession.ts:86 (`parseFacebookUrl`): the
  tightened host check (exact/subdomain match replacing the old spoofable
  `endsWith('facebook.com')`) is correct code with zero test coverage — reverting it to the old
  loose check leaves the entire `facebookMarketplaceConnector.test.ts` suite green. A real
  regression-detection gap on a security-relevant guard inside Requirement 6's single most
  safety-critical code path, not a production-code defect.
T13 dispatched (feature-build-lead) to close the Cycle 1 finding above: builder added
`apps/server/test/facebookMarketplaceSession.test.ts` (30 tests, see A39) covering the host-
spoofing guard via `isLoginOrCheckpointUrl`/`isFacebookRootUrl`, proved mutation-kill by
reverting line 86 to the old spoofable form (8/30 new tests flip to failing) then restoring it
(30/30 pass again). `feature-build-lead` independently confirmed the restored file matches the
exact/subdomain form and re-ran `test/facebookMarketplaceSession.test.ts` +
`facebookMarketplaceConnector.test.ts` + `facebookMarketplaceLogin.test.ts` (103/103 passing).
Standing gate (feature-build-lead, cycle 1): full suite re-run from the worktree root
(`npm run build -w packages/shared && npm run test --workspaces --if-present`, then `npm run
lint`, Node 22.23.3). Build: clean. Lint (`eslint .`): clean, zero violations. packages/shared:
4/4 files, 28/28 tests pass. apps/web: 28/29 files pass, 301/302 tests pass — the 1 failing file
is `eslint-import-boundary.test.ts`, a 90s-timeout, the same originally-failing BaselineSuite file
(resource-contention flake, not a regression). apps/server: re-run isolated from the web run to
disambiguate flakiness — 68/68 files pass on a dedicated apps/server-only run (897 tests, 35
skipped; an earlier combined run in the same gate transiently showed 3 different files fail —
app-shell.test.ts, identifyPartsRoute.test.ts, teardown.test.ts — each the same pre-existing
`Cannot read properties of undefined (reading 'stop')` / hook-timeout signature BaselineSuite
already documents; none touch connectors/, scan/, routes/sourceValidation.ts, or this feature's
any other changed file, and none fail twice in a row). Total tests this gate: 28 + 897 + 301 =
1226 (plus apps/web's 1 flaky-skip file would add its own tests back on a clean re-run), against
BaselineTests 1018 — coverage held and grew, no shrinkage. No new regression from T13; the only
finding this cycle opened is now closed.
R13/TE13 dispatched (feature-validate-lead) to review/test T13. Both PASS. R13 independently
reproduced the builder's mutation-kill claim without touching the tracked file — a scratch-copy
evaluation of all 30 test inputs against the old spoofable `endsWith('facebook.com')` form and the
new exact/subdomain form found exactly 8 of 30 tests flip, matching A39's claim exactly, with no
vacuous assertion among the remaining 22. TE13 independently reproduced it for real, directly on
the tracked file: baseline 30/30 pass, line 86 reverted to the old spoofable form → exactly 8/30
fail (by the same 8 test names R13 derived), line 86 restored → 30/30 pass again, `git diff` clean,
and a regression sweep of facebookMarketplaceConnector.test.ts +
facebookMarketplaceLogin.test.ts + facebookMarketplaceSession.test.ts together still passes
103/103. No must_fix from either.
Standing gate (feature-validate-lead, cycle 1): full suite run from the worktree root
(`npm run build -w packages/shared && npm run test --workspaces --if-present`, then `npm run
lint`, Node 22.23.3). Build: clean. Lint (`eslint .`): clean, zero violations. packages/shared:
4/4 files, 28/28 tests pass. apps/web: 29/29 files, 302/302 tests pass (including
eslint-import-boundary.test.ts, clean this run). apps/server: 62/67 files pass, 828 tests pass +
22 skipped (850 total this workspace). The 5 failing files
(identifyPartsConcurrency.test.ts, profit.test.ts, saleListings.test.ts, sales.test.ts,
scan.test.ts) all carry the identical `Hook timed out in 30000ms` on `startTestServer` /
`Cannot read properties of undefined (reading 'stop')` on `server.stop()` signature BaselineSuite
and every prior gate this feature has run already document as this machine's real child-process
server-spawn resource contention, not a code defect — none touch connectors/, scan/ (the file's
own logic, as opposed to its startup hook), routes/sourceValidation.ts, or any other file this
feature changed, and none assert against anything T13 touched. T13's own three target files
(facebookMarketplaceSession/Connector/Login) are not among the 5 and were separately confirmed
green by TE13 above. Total tests this gate: 28 + 850 + 302 = 1180, against BaselineTests 1018 —
coverage held and grew (+162, +30 of it T13's own new file), no shrinkage. No `ui: yes` task this
cycle (T13 is `ui: no`), so the visual-evidence gate does not apply. No new regression.
UAT: blocked
UAT checks:
- Build/dev-server startup: `npm run build -w packages/shared` clean; apps/server bound port 3001
  with real seeded `/api/sources` data; apps/web's Vite server reported ready on port 5173.
- Req 7 (Sources UI, live browser): platform dropdown lists Mercari/Facebook Marketplace alongside
  eBay/Other; selecting each renders its own connector-config editor (Mercari: query + max price;
  Facebook Marketplace: query + max price + location + radius).
- Req 7 (inline validation, live): a blank search query on submit shows an inline error before any
  save completes.
- Req 7 (create/scan round trip, Mercari, live): real POST /api/sources + POST .../scan fired from
  real UI clicks; new row appeared; Scan button present and enabled.
- Req 7 (create/edit/scan round trip, Facebook Marketplace, live): real POST/PUT /api/sources fired
  with location/radius/maxPrice; reopening the edit form showed the exact saved values persisted
  (not just an optimistic UI echo); Scan button present and enabled.
- Req 6 (missing-session guard, live, both API and UI): POST .../scan against a Facebook
  Marketplace Source with no session file returned HTTP 400 naming
  `npm run login-facebook-marketplace`; the rendered UI surfaced that same error text on a real
  click, not a silent no-op; confirmed the session file genuinely did not exist beforehand.
- Req 5 (login script, live): `npm run login-facebook-marketplace -w @pc-parts-flipper/server`
  launched a real headed Chromium window; grepped the whole server source tree for any stored
  Facebook password and found none; killing the script mid-wait wrote no partial session file;
  `git check-ignore -v apps/server/data/facebook-marketplace-session.json` matched the real
  `.gitignore` rule.
- Req 1 (Mercari connector plumbing, live, partial): the connector's own exported
  `launchScanBrowser`/UA/init-script loaded the real mercari.com search page without a Cloudflare
  challenge; the max-price filter and the connector-agnostic dedup path were confirmed by direct
  source read, not live data (no live candidates were reachable — see UAT failure below).
- Standing checks (file size, doc comments, playwright pin, both import boundaries, DuckDB
  boundary, lint): all independently re-checked live and passed; suite/coverage cited from
  feature-validate-lead's just-completed cycle-1 standing gate (1180 tests vs. BaselineTests 1018).
UAT failure: Requirements 1/2 and 3/4's live positive-result scan could not be exercised — Mercari
returned `{"foundCount":0,"newCount":0}` with no thrown error on a real scan attempt, and no
dedicated Facebook account exists in this sandbox to attempt Requirement 3/4 at all. Investigating
the Mercari gap with the user (not feature-uat-tester, which had characterized it as a network/IP
issue and "not a code defect") found a real, independent code defect: `searchOneQuery` fires its
own unauthenticated `fetch()` instead of letting the page's own JS issue its authenticated request,
so Mercari's API correctly 401s it — and the `?? []` fallback then silently swallows that error as
an empty result instead of throwing. Filed as T14 below.

### Cycle 2
Trigger: UAT (cycle 1) returned BLOCKED on live Mercari data; investigating that blocker with the
user (prompted by a sharp factual question about whether it was an IP/account issue) surfaced a
real connector defect independent of any network property — confirmed live, not inferred.
Findings:
- [T14] apps/server/src/connectors/mercariConnector.ts (searchOneQuery): fires its own
  credential-less `fetch()` for the `searchFacetQuery` call instead of capturing the page's own
  authenticated request, so Mercari's API correctly rejects it with a 401-in-200 GraphQL error body
  that the connector's `?? []` fallback then silently treats as "zero results found" rather than
  throwing — on this IP, on any other IP, and on any future real API failure (rate limit, hash
  rotation) alike.
T14 dispatched (feature-build-lead) to fix the finding above: builder replaced the injected
`page.evaluate(() => fetch(...))` call with Playwright's own `page.waitForResponse` raced against
`page.goto`, reading the page's own already-authenticated `searchFacetQuery` response, and added a
top-level `errors`-array check that now throws `AppError(502)` with Mercari's own message instead
of silently falling through to `[]` (see A41). Verified by the builder via `tsc --noEmit`, `vitest
run test/mercariConnector.test.ts` (7/7), `npm run lint`, a break-run-restore mutation test, and a
live run against the real mercari.com returning 94 real results.
R14/TE14 dispatched (feature-validate-lead) to review/test T14. Both PASS. Neither trusted the
builder's self-reported live-verification claim (A41) — each independently ran its own fresh
throwaway script against the real mercari.com and independently observed the same 94-result
outcome for "graphics card," with the identical sample item, confirming it firsthand rather than
restating it; TE14 additionally hit two genuine Cloudflare 403s on other live attempts from this
sandbox's IP, confirming the pre-existing `!response.ok()` branch still correctly throws
`AppError(502)` rather than silently returning zero results in that case too. Both also
independently forced the errors-array-throws-`AppError(502)` behavior themselves rather than
trusting the builder's own regression test: R14 built its own fresh vitest fixture proving the 502
provably came from the errors-array branch (not `!response.ok()`); TE14 used break-run-restore
directly on the tracked file, confirming the regression test fails without the guard and the file
restores clean (see A42). No must_fix from either reviewer or tester.
Standing gate (feature-validate-lead, cycle 2): full suite run from the worktree root (`npm run
build -w packages/shared && npm run test --workspaces --if-present`, then `npm run lint`, Node
22.23.3). Build: clean. Lint (`eslint .`): clean, zero violations. packages/shared: 4/4 files,
28/28 tests pass. apps/web: 29/29 files, 302/302 tests pass. apps/server: 63/67 files pass, 831
tests pass + 20 skipped (851 total this workspace); the 4 failing files
(identifyPartsRoute.test.ts, parts.test.ts, teardown.test.ts, and one further file in the same
batch) all carry the identical `Hook timed out in 30000ms` on `startTestServer` / `Cannot read
properties of undefined (reading 'stop')` signature every prior gate this feature has run already
documents as this machine's real child-process server-spawn resource contention, not a code
defect. Re-ran apps/server in isolation twice more to disambiguate flakiness from a real
regression: each isolated run failed a *different* 4-file subset (identifyPartsConcurrency.test.ts
/ parts.test.ts / purchases.test.ts / one more, then a third combination) with the identical
`stop()`/hook-timeout signature each time, and no file ever touching `connectors/`, `scan/`, or
`routes/sourceValidation.ts` failed twice in a row — confirming flakiness, not a regression. Every
file this feature's T14 touched or that exercises its own area was separately run in isolation and
came back 100% clean: `mercariConnector.test.ts`, `scan.test.ts`, `ebayConnector.test.ts`,
`sourceValidation.test.ts`, `sources.test.ts`, `facebookMarketplaceConnector.test.ts`,
`facebookMarketplaceSession.test.ts` — 7/7 files, 161/161 tests, 0 failures. Total tests this
gate: 28 + 851 + 302 = 1181, against `BaselineTests` 1018 — coverage held and grew (+163), no
shrinkage. No `ui: yes` task this cycle (T14 is `ui: no`), so the visual-evidence gate does not
apply. No new regression.
Retries (cycle 2 verdicts): T14 PASS (both R14 and TE14 independently reproduced the builder's
live-site claim and the errors-array-throw claim themselves, from scratch, rather than trusting
the self-report — see above and A42). No must_fix open this cycle.
UAT: passed
UAT checks:
- App startup, live: apps/server bound :3001 (migrations clean), apps/web's Vite server ready on
  :5173.
- Requirement 1, fully live end to end: created a real Mercari Source via POST /api/sources
  (query "graphics card"), triggered a real scan via POST /api/sources/:id/scan against the real
  mercari.com — two genuine Cloudflare 403s correctly surfaced as AppError(502) (T14's fix intact),
  a third attempt succeeded with foundCount=94; GET /api/listings confirmed 94 real Listing rows
  created (real externalItemId/listingUrl, real titles, real varied prices).
- Requirement 2, fully live: created Listings carry real per-item descriptions only obtainable
  from each item's own detail page (e.g. a GPUz/Heaven-benchmark-specific description).
- Requirement 1 (photos): a sampled downloaded photoPath is a genuine 243KB 1600x1200 JPEG.
- Scan metadata, live: the Source's lastScannedAt/lastScanFoundCount updated correctly once the
  full async detail-fetch/photo-download pipeline finished (polled 20→70→94 over ~2 minutes).
- Requirement 6, re-confirmed live: a Facebook Marketplace scan with no session file present still
  returns HTTP 400 naming `npm run login-facebook-marketplace`, unregressed by T14.
- Requirements 3/4 (Facebook Marketplace live scan): still accepted out-of-scope this sandbox — no
  dedicated account exists here; unchanged from cycle 1, not re-attempted per instruction.
- Requirement 5 and Requirement 7: unchanged by T14 (no UI/script file touched this cycle); cited
  from cycle 1's U1 full live walk rather than re-run.
- Standing checks (file size, DuckDB/apps-web boundaries, lint, playwright pin, session-file
  gitignore): re-confirmed live for the two files T14 touched plus a fresh `git check-ignore -v`
  run; suite/coverage cited from feature-validate-lead's cycle-2 standing gate (1181 tests vs.
  BaselineTests 1018, no shrinkage).
