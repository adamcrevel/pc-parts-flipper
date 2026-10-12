# Feature: ebay-description-and-specifics

Status: done
Cycle: 1 / 3
FeatureStarted: 2026-10-12T01:23:00Z
FeatureCompletedAt: 2026-10-12T06:00:00Z
OrchestrationTokensActual: 2192468
OrchestrationTokensBreakdown: input 0 + output 52,541 + cache-write 999,829 + cache-read 1,140,098, across 173 turns
Walkthrough: https://gist.githack.com/adamcrevel/6cac6e9a4180ff3d0f8923eee3cef703/raw/walkthrough.html
Prototype: none
BaselineTests: 944
BaselineSuite: fail

## Goal

User-reported gap, confirmed by investigation: a scanned eBay listing's full item description and
its seller-provided "Item Specifics" (structured name/value pairs eBay shows on the listing page —
RAM, storage, processor, OS, GPU, etc.) are never captured at all. Confirmed directly against the
user's own example, "gameing pc Ryzen 5 5600" (id `c87e761e-d475-4afa-8817-31f807ad76d8`, a real,
already-scanned production listing): its stored `description` is `null`, and in fact **every one of
the 222 real listings currently in production has `description: null`** — this is not an isolated
bug, it is the actual behavior of the scan pipeline today.

Root cause, confirmed by reading the code: `scanService.ts`'s `importCandidateIfNew` hardcodes
`description: null` on every imported Listing. eBay's search endpoint
(`item_summary/search`, what a scan actually calls) never returns a full description or item
specifics in the first place — those only exist on eBay's single-item detail endpoint
(`GET /buy/browse/v1/item/{itemId}`), confirmed against eBay's own Browse API documentation
(`description: string`, HTML, up to 500,000 characters; `localizedAspects: Array<{name, type,
value}>`, the item specifics). That detail endpoint is already called elsewhere in this codebase
(`ebayConnector.ts`'s `createEbayItemDetailClient`), but only by the one-time manual photo-backfill
script, and even then only to extract image URLs — the same response's `description` and
`localizedAspects` fields are fetched and immediately discarded.

This feature captures both fields (full description, HTML-stripped to plain text; every item
specific eBay reports, not a curated subset) and stores them in the Listing's existing `description`
field — the same field `buildIdentificationPrompt` already includes verbatim in the AI
identification prompt, so **no prompt-building change is needed** for Requirement 6. This happens
for every newly-scanned eBay listing going forward, and, via a new one-time backfill (mirroring the
existing photo-backfill script's own pattern) for every eBay listing already imported without it —
including the user's own example.

## Requirements

1. A newly-scanned eBay listing's full seller-written item description is fetched (from eBay's
   single-item detail endpoint, the only endpoint that carries it) and stored, converted from eBay's
   HTML to plain text.
2. A newly-scanned eBay listing's full set of seller-provided Item Specifics (every name/value pair
   eBay's `localizedAspects` reports for that item — not a hardcoded subset such as only
   RAM/storage/CPU/OS/GPU) is fetched and stored, each pair clearly rendered as its own `Name: Value`
   line, visually distinct from the prose description.
3. Both are stored together in the Listing's existing `description` field, prose description first,
   then the item specifics block.
4. Every eBay-sourced Listing already in the database before this feature shipped, whose
   `description` is still null, is backfilled with the same description + item specifics capture —
   via a new one-time script following this project's own established pattern
   (`photoBackfill.ts`/`backfill-photos.ts`), run once against the real production database as part
   of delivering this feature, not left as an unused capability.
5. A failure fetching eBay's item detail (the item was removed, a transient API error, etc.) never
   prevents the Listing itself from being imported or backfilled — it is logged and the Listing's
   description is simply left as it was, the same graceful-degradation behavior this codebase
   already uses for photo downloads.
6. The combined description + item specifics text is available to AI part identification
   (`buildIdentificationPrompt`) without any change to that prompt-building code — proven by the fact
   that it already reads `listing.description` verbatim, so storing the richer text in that same
   field is what satisfies this requirement.
7. The additional eBay API call this feature introduces (one single-item detail call per genuinely
   new candidate) is bounded to scale with the number of new listings a scan actually imports, never
   with the full search-result set a scan merely found — matching this codebase's own existing,
   test-enforced "no needless per-item API call" principle (already proven by an exact HTTP-call-count
   test for photos, which this feature's own task must update rather than violate).

## Standing Checks

- The whole test suite passes, and the test count holds at or above `BaselineTests` (944: 24 shared
  + 248 web + 672 server). `BaselineSuite` is recorded `fail`: the same single pre-existing,
  reproducible, unrelated failure already documented in the three most recent features
  (`apps/server/test/listingPhotos.test.ts`'s "stores an uploaded photo..." case, an `ENOENT` on a
  temp-dir photo path) — confirmed failing again in this fresh worktree before any change, fourth
  consecutive confirmation. Out of scope for this feature.
- `npm run lint` runs clean with no new violation.
- Any new/changed public function or type carries the same kind of header/block comment
  documentation already used elsewhere in the codebase.
- No DuckDB schema change of any kind — description and item specifics are stored in the Listing's
  existing `description` column; no new column, no migration.
- The eBay API call-count budget (Requirement 7) is proven by an exact HTTP-call-count assertion
  (the existing `scanSource photo download call budget` test in `scanService.test.ts`, updated for
  this feature's one legitimate new call type), not merely asserted as plausible in a code comment.

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| T1 | eBay connector: fetch and format item description + specifics (Req 1-3). `apps/server/src/connectors/ebayConnector.ts`: extend the `EbayItemDetail` interface with `description?: string;` and `localizedAspects?: Array<{ name: string; value: string }>;` (both already present on eBay's real single-item detail response, confirmed against eBay's own Browse API docs — `type` is not read, only `name`/`value`). Add a private `stripHtml(html: string): string` helper: removes `<script>...</script>` and `<style>...</style>` blocks (tags and their content both), converts `<br>`/`<br/>`/`</p>`/`</div>`/`</li>` into a newline, strips every remaining tag, decodes the common HTML entities (`&amp;` `&lt;` `&gt;` `&quot;` `&#39;`/`&apos;` `&nbsp;`, plus numeric entities `&#NNN;`), collapses 3+ consecutive newlines to 2 and runs of spaces/tabs to one, and trims. Add an exported `formatEbayItemDetails(detail: { description?: string; localizedAspects?: Array<{ name: string; value: string }> }): string \| null`: HTML-strips and trims `detail.description` (omitted entirely from the output if blank after stripping); formats every `localizedAspects` entry as `` `${name}: ${value}` ``, one per line, under a `'Item Specifics (per eBay):'` header (the whole specifics block omitted if the array is absent or empty); joins whichever of the two parts are present with a blank line between them; returns `null` if neither part produced any content (an eBay item that genuinely has no description and no specifics is still null, not an empty string); caps the combined result at 5000 characters (eBay descriptions can run up to 500,000 characters — this bounds the AI prompt's token cost), truncating with a trailing `'... [truncated]'` marker when the cap is hit. Add a new method `fetchItemDescription(externalItemId: string): Promise<string \| null>` to the existing `EbayItemDetailClient` interface/implementation returned by `createEbayItemDetailClient()`: calls the same `GET /buy/browse/v1/item/{itemId}` endpoint `fetchItemImageUrls` already calls (same error handling, same AppError(502)-on-failure convention), and returns `formatEbayItemDetails(body)` on the parsed response body. This is a new, independent method — it does not change `fetchItemImageUrls`'s existing signature or behavior, and existing callers (`photoBackfill.ts`) are untouched. | builder | | complete | 0 | peter-gibbons | 2026-10-12T01:58:30Z | 2026-10-12T02:02:19Z | 35 | 2026-10-12T01:57:40Z | 10500 | 34951 | no | apps/server/src/connectors/ebayConnector.ts |
| T2 | Scan-time capture (Req 1, 2, 3, 5, 7), depends on T1. `apps/server/src/scan/scanService.ts`: add an exported `ScanServiceDeps` interface with one optional member, `fetchEbayItemDescription?: (externalItemId: string) => Promise<string \| null>`, documented as: never called unless the Source's connector is eBay's, never called for an already-seen duplicate, and left `undefined` by every existing test using a fake `MarketplaceConnector` so none of them gain a new network call. `scanSourceWithConnector` gains a third, optional `deps?: ScanServiceDeps` parameter, threaded through to a new private `attachCandidateDescription(listingId, candidate, connector, fetchEbayItemDescription)` helper called from `importCandidateIfNew` right alongside the existing `attachCandidatePhotos` call: no-ops immediately if `connector.platformType !== 'ebay'` or `fetchEbayItemDescription` is undefined; otherwise calls it, and if the result is non-null, `updateListing(listingId, { description })`; wraps the whole thing in the exact same try/catch-and-`logger.warn`-and-continue shape `attachCandidatePhotos` already uses (Req 5 — a detail-fetch failure must never fail the Listing's own import). `scanSource` (the real, production wrapper — not `scanSourceWithConnector` itself) is the ONLY place that constructs the real dependency: add a small private `createLazyEbayDescriptionFetcher()` helper that returns a function closing over a memoized, lazily-created `createEbayItemDetailClient()` call (created on that function's own first invocation, not eagerly) — this is what keeps a scan that imports zero new candidates from making any extra eBay OAuth call at all, and keeps a scan that imports several new candidates to one shared OAuth token rather than one per candidate. `scanSource` passes `{ fetchEbayItemDescription: createLazyEbayDescriptionFetcher() }` as `deps` only when `connector.platformType === 'ebay'`, matching the same platform-gating `attachCandidateDescription` itself already checks (defense in depth, not redundant — `scanSourceWithConnector` is also called directly, with injected test deps, bypassing `scanSource` entirely). Update `apps/server/test/scanService.test.ts`'s existing `'scanSource photo download call budget (Req 2)'` describe block (the one asserting exactly one `/buy/browse/` call and one `/oauth2/token` call for a scan importing one new candidate): its own comment already explains why a per-item eBay API call would normally be the wrong pattern — add a note immediately above the updated assertions explaining that this feature's own single-item detail call is the deliberate, necessary exception that comment warns against conflating with a real per-item-scaling regression, since eBay's search summaries genuinely never carry description/specifics data no matter how the connector is written. Extend its `fetchMock` to also handle a `/buy/browse/v1/item/` request (matched by URL substring, same style as its existing `/oauth2/token`/`/buy/browse/` branches) returning a fixture `{ description: '<p>Great condition</p>', localizedAspects: [{ name: 'RAM', value: '16GB' }] }`; update the call-count assertions from 1 to 2 for both `/buy/browse/` and `/oauth2/token` (one of each for the search, one of each for the new lazily-created detail client), add `expect(urls.filter((u) => u.includes('/buy/browse/v1/item/'))).toHaveLength(1);`, and add a new assertion that the imported Listing's `description` now reads `'Great condition\n\nItem Specifics (per eBay):\nRAM: 16GB'` (or whatever `formatEbayItemDetails` actually produces for that exact fixture — assert the real value, not a substring match). MUST_FIX (Cycle 0 retry, from R2): the `scanSource photo download call budget (Req 2)` describe block's two tests both use a search response containing exactly one result, zero duplicates, so newCount always equals foundCount and the tests cannot distinguish “one detail call per newly-imported candidate” (correct) from “one detail call per search result” (the Req 7 regression) — both read identically when there are no duplicates in the batch. Add a new case in the same describe block: a search response with at least one already-imported duplicate alongside one new candidate (e.g. 2 results, 1 duplicate + 1 new); assert `result.foundCount` reflects the full result count (2) while `result.newCount` is 1; assert the `/buy/browse/v1/item/` call count is exactly 1 (matching the new-candidate count, not the larger total-result count) — this is what actually proves the detail call is scoped to genuinely-new candidates, since a regression that fires the detail call for every candidate (duplicates included) would make this new assertion fail while the two existing tests stay green. [Retry note: the feature-build-lead dispatch for this retry was interrupted by an environment crash before it could report back; T2's own work was independently verified complete and correct afterward via `git diff` (scanService.ts unchanged from cycle 0's original T2 implementation; scanService.test.ts gained exactly the must_fix's duplicate-vs-new-candidate test case) and a clean `npx vitest run test/scanService.test.ts` (16/16 passing). actual_tokens is left blank since no final report was received.] | builder | T1 | complete | 0 | peter-gibbons | 2026-10-12T03:24:25Z | 2026-10-12T04:24:00Z | 40 | 2026-10-12T02:32:40Z | | | no | apps/server/src/scan/scanService.ts, apps/server/test/scanService.test.ts |
| T3 | One-time description backfill for already-imported eBay listings (Req 4, 5), depends on T1. `apps/server/src/db/queries/listings.ts`: add `listListingsMissingDescription(externalSource: string): Promise<Listing[]>`, mirroring `listListingsMissingPhotos` exactly (`WHERE external_source = $external_source AND external_item_id IS NOT NULL AND description IS NULL ORDER BY created_at ASC, id ASC`, same doc-comment style explaining what it backs). `apps/server/src/scan/descriptionBackfill.ts` (new file, mirroring `apps/server/src/photos/photoBackfill.ts`'s structure line for line): exported `BackfillSummary { succeeded: number; skipped: number; failed: number }`; exported `BackfillDeps { fetchItemDescription(externalItemId: string): Promise<string \| null>; saveDescription(listingId: string, description: string): Promise<void>; }`; exported `BackfillOutcome = 'succeeded' \| 'skipped' \| 'failed'`; exported `backfillOneListing(listing: Listing, deps: BackfillDeps): Promise<BackfillOutcome>` — `'skipped'` when `listing.externalItemId` is null (same guard `photoBackfill.ts`'s own version has) or when the eBay call resolves `null` (nothing to backfill, not an error); `'failed'` on a thrown error, caught and logged, never propagated; `'succeeded'` otherwise, after calling `saveDescription`; exported `backfillListingDescriptions(listings: Listing[], deps: BackfillDeps): Promise<BackfillSummary>` — sequential, per-Listing progress logged at Info, identical shape to `backfillListingPhotos`; exported `runDescriptionBackfill(): Promise<BackfillSummary>` — calls `listListingsMissingDescription('ebay')`, returns the zero-tally summary immediately without creating any eBay client when the list is empty, otherwise lazily creates one `EbayItemDetailClient` shared across the whole run and wires `fetchItemDescription`/`saveDescription` (the latter via `updateListing(listingId, { description })`) into `backfillListingDescriptions`. `apps/server/src/scripts/backfill-descriptions.ts` (new file, copying `backfill-photos.ts` line for line except calling `runDescriptionBackfill`/importing from `descriptionBackfill.js`). `apps/server/package.json`: add a `"backfill-descriptions": "tsx --env-file-if-exists=.env src/scripts/backfill-descriptions.ts"` script entry alongside the existing `backfill-photos` one. | builder | T1 | complete | 0 | peter-gibbons | 2026-10-12T02:10:45Z | 2026-10-12T02:35:11Z | 30 | 2026-10-12T03:12:40Z | 68000 | 93991 | no | apps/server/src/db/queries/listings.ts, apps/server/src/scan/descriptionBackfill.ts, apps/server/src/scripts/backfill-descriptions.ts, apps/server/package.json |
| R1 | Review T1 against Req 1-3, scoped to `ebayConnector.ts`. Confirm `stripHtml` genuinely removes script/style content (not just their tags), decodes the named entities, and collapses whitespace sensibly on a realistic multi-paragraph eBay-style description with nested tags; confirm `formatEbayItemDetails` returns `null` (not `''`) when both inputs are empty/absent, correctly omits either section when only one is present, and the 5000-character truncation triggers at exactly the right point with the trailing marker; confirm `fetchItemDescription` reuses the exact same error-handling convention as `fetchItemImageUrls` (same AppError(502) shape) and does not alter that sibling method's own behavior at all. PASS only if at least one hand-traced example input/output pair for `stripHtml` and `formatEbayItemDetails` each is verified against the actual code, not read as plausible. | reviewer | T1 | complete | 0 | | 2026-10-12T02:10:58Z | 2026-10-12T02:37:54Z | 15 | 2026-10-12T02:10:58Z | 21800 | 202340 | no | |
| TE1 | Test T1. Extend `apps/server/test/ebayConnector.test.ts` with: `stripHtml`/`formatEbayItemDetails` unit cases covering a realistic HTML description (paragraphs, bold, a line break, a `<script>` block that must disappear entirely), entity decoding, the both-present/description-only/specifics-only/neither-present branches (confirming `null` specifically for the last one), and the 5000-character truncation boundary (one case just under the cap, one case over it, asserting the exact truncated output, not just its length); a `fetchItemDescription` case (same `fetchMock`-stubbed-global-fetch style the existing `createEbayItemDetailClient` tests already use) proving a realistic fixture response round-trips through to the expected formatted string, a 404 case proving it throws the same `AppError(502)` shape `fetchItemImageUrls` already proves, and a case proving an item with neither description nor aspects resolves `null` rather than throwing. PASS: all new cases pass, no regression in the rest of `ebayConnector.test.ts`. | tester | T1 | complete | 0 | | 2026-10-12T02:10:58Z | 2026-10-12T02:37:54Z | 25 | 2026-10-12T02:10:58Z | 52900 | 116358 | no | apps/server/test/ebayConnector.test.ts |
| R2 | Review T2 against Req 1, 2, 3, 5, 7, scoped to `scanService.ts` and its test file. Confirm `attachCandidateDescription`'s platform-gate and undefined-deps-gate both genuinely no-op (read the exact conditional, don't infer it from the description); confirm the try/catch truly swallows a thrown error without ever failing the Listing's own import (trace the call site inside `importCandidateIfNew`); confirm `createLazyEbayDescriptionFetcher`'s memoization genuinely creates the client at most once per scan, on first actual use, not eagerly at `scanSource`'s own top (read the closure, don't assume); confirm the updated call-budget test's new assertions (2x `/buy/browse/`, 2x `/oauth2/token`, 1x `/buy/browse/v1/item/`, the description-populated assertion) are all present and each is checking the real value, not a loosened/weakened version of what T2's description promised. PASS only if the lazy-creation claim is verified by tracing the actual closure code, not taken on faith from a comment. PASS (cycle 0 retry pass): all 7 checks confirmed on direct inspection plus a live `npx vitest run` (16/16) and `npx eslint` run — both gates, the try/catch swallow, the lazy OAuth memoization, the Req 2 budget assertions, the Req 7 must_fix retry case (`distinguishes newly-imported candidates from duplicates in the same batch`), and the Req 5 failure test are all genuinely present and correct; no must_fix. | reviewer | T2 | complete | 0 | peter-gibbons | 2026-10-12T04:25:44Z | 2026-10-12T04:42:48Z | 15 | 2026-10-12T04:25:44Z | 47300 | 163833 | no | |
| TE2 | Test T2 (already substantially specified inside T2's own description — this role's job is to run what T2's builder wrote, confirm it actually falsifies, and extend it if a gap remains). Confirm the updated `scanSource photo download call budget` test passes and genuinely fails if `attachCandidateDescription`'s platform-gate is removed (a mutation check: temporarily make the gate always-true, confirm the test's call-count assertions catch a non-eBay connector wrongly getting a description fetch — or, if this project's fake connectors are all eBay-typed and such a mutation can't be exercised this way, confirm by direct code reading instead and say so plainly). Add a case proving a detail-fetch failure (stub the `/buy/browse/v1/item/` branch to return a non-200 response) still results in `newCount: 1` for that scan and the Listing's `description` stays `null` — Req 5 proven live, not just by trusting the try/catch's shape. PASS (cycle 0 retry pass): full file run 16/16 green; the must_fix retry case (`distinguishes newly-imported candidates from duplicates in the same batch (Req 7)`) is mutation-proven — a mutation firing the detail fetch per search-result instead of per new-candidate makes exactly that test's call-count assertion fail (2 vs expected 1), reverted clean afterward; the platform-gate mutation survived (all fake connectors in this file are eBay-typed, so no test can catch a platform-gate regression) — reported plainly per the task's own fallback, confirmed instead by direct code reading; Req 5 failure case present and passing. No genuine gap found; no new test added. | tester | T2 | complete | 0 | peter-gibbons | 2026-10-12T04:25:44Z | 2026-10-12T04:42:48Z | 25 | 2026-10-12T04:25:44Z | 12500 | 64634 | no | |
| R3 | Review T3 against Req 4, 5, scoped to `listListingsMissingDescription`, `descriptionBackfill.ts`, `backfill-descriptions.ts`, and the `package.json` script entry. Confirm the query's WHERE clause matches `listListingsMissingPhotos`'s own structure exactly (external_source, external_item_id IS NOT NULL, the new description IS NULL predicate, same ordering); confirm `backfillOneListing`'s three-outcome logic matches `photoBackfill.ts`'s own `backfillOneListing` precisely (skip-on-null-external-id, skip-on-nothing-to-backfill, fail-on-thrown-error, succeed-otherwise) with no outcome miscategorized; confirm `runDescriptionBackfill` genuinely skips client creation on an empty list (read the early-return, don't assume); confirm the CLI script's exit-code convention matches `backfill-photos.ts`'s (`summary.failed > 0` -> exit 1). PASS only if `backfillOneListing`'s three branches are each traced against T3's own description, not spot-checked on one branch alone. FAIL: zero tests existed for descriptionBackfill.ts/listListingsMissingDescription at review time, resolved immediately after by TE3's new descriptionBackfill.test.ts (5 tests, mutation-proven). | reviewer | T3 | complete | 0 | peter-gibbons | 2026-10-12T02:55:59Z | 2026-10-12T03:19:32Z | 15 | 2026-10-12T02:55:59Z | 14900 | 50184 | no | |
| TE3 | Test T3. New `apps/server/test/descriptionBackfill.test.ts`, mirroring `apps/server/test/photoBackfill.test.ts`'s structure precisely (isolated-DuckDB-tmpdir dynamic-import pattern for the query test, in-memory `recordingDeps`-style fakes for the batch tests — no real eBay call and no real file write in any case here): cover `backfillOneListing`'s three outcomes (succeeded with a real description saved, skipped for a null external id, skipped for a null eBay response, failed for a thrown error) and `listListingsMissingDescription`'s real-DuckDB query proof (a Listing with a description present is excluded, one with description null and a real external id is included, one with description null but no external id is excluded, ordering is oldest-created-first). PASS: new test file fully passes, matches the rigor of the file it mirrors. | tester | T3 | complete | 0 | peter-gibbons | 2026-10-12T02:55:59Z | 2026-10-12T03:19:32Z | 30 | 2026-10-12T02:55:59Z | 15000 | 82100 | no | apps/server/test/descriptionBackfill.test.ts |
| U0 | UAT pass over the whole feature (Req 1-7): run against the worktree's own isolated DuckDB file, no live-production access. (a) Exercise a fresh scan importing a new eBay listing via a stubbed eBay search+detail response (same `vi.stubGlobal('fetch', ...)` technique the T1/T2 tests already use) and confirm the imported Listing's `description` column is populated with the prose description followed by the item-specifics block, not null. (b) Run `npm run backfill-descriptions` for real against the worktree's own DuckDB file (seeded with at least one eBay Listing whose `description` is null and has a real `externalItemId`, via a stubbed eBay detail response) and confirm the script actually updates that Listing's row in the database, not merely a dry run. (c) Read an actual built `buildIdentificationPrompt` output for a Listing carrying the new combined description + item-specifics text and confirm the richer text appears in the prompt verbatim, proving Req 6 with zero prompt-code change. |uat| T1;T2;T3 | complete | 0 | peter-gibbons | 2026-10-12T05:15:00Z | 2026-10-12T05:26:00Z | 20 | 2026-10-12T05:15:00Z | 22500 | 119313 | no | (none - throwaway UAT scripts deleted after use) |
| U1 | Independent re-check of Cycle 1's single Finding (A20 records the orchestrator's own real production run, not an independent check): against the real production database at `/mnt/d/repositories/pc-parts-flipper/data/pc-parts-flipper.duckdb` (read-only), confirm zero eBay listings have `description IS NULL`, confirm the total listing count is still 222 (no row lost/duplicated by the backfill), and confirm listing `c87e761e-d475-4afa-8817-31f807ad76d8` ("gameing pc Ryzen 5 5600", the user's own reported example) has a non-null `description` containing both prose and an item-specifics block. Also confirm the live `pc-parts-flipper-dev` service is healthy (`GET /health`) and its own `/api/listings/:id` response for that same listing reflects the same description, proving the fix is live, not only in the database file. |uat| T1;T2;T3;U0 | complete | 1 | peter-gibbons | 2026-10-12T05:50:00Z | 2026-10-12T05:59:00Z | 10 | 2026-10-12T05:50:00Z | 10000 | 60182 | no | (none - throwaway recheck script deleted after use) |

## Assumptions

- A1 (cycle 0): Description and item specifics are stored together in the Listing's existing
  `description` column (no new DB column, no schema migration) — this is what lets
  `buildIdentificationPrompt` pick up the richer data with zero prompt-building change, since it
  already reads that field verbatim, and avoids a schema change for data that has no other use in
  this app today beyond being read by a human and by the AI prompt, both of which already read
  `description` as one block of text.
- A2 (cycle 0): Item specifics are captured generically — every `localizedAspects` entry eBay
  reports for an item, not a hardcoded allowlist of the five the user happened to name (RAM, storage,
  processor, OS, GPU) in their example. eBay's own aspect set varies per listing/category, and a
  generic passthrough is both simpler to maintain and more fully satisfies "all these details" than
  a curated filter would.
- A3 (cycle 0): The backfill for already-imported eBay listings (Requirement 4) is in scope for this
  feature and will actually be run once against the real production database as part of delivering
  it — not merely built and left for someone to invoke later — because the user's own example
  ("gameing pc Ryzen 5 5600") is an already-scanned, already-imported listing, not a hypothetical
  future one; fixing only the go-forward scan path would leave their own example exactly as broken
  as they found it.
- A4 (cycle 0): The combined description + item specifics text is capped at 5000 characters
  (eBay's own description field can run up to 500,000 characters) to bound the AI identification
  prompt's token cost on the rare oversized listing. Not something the user asked for explicitly,
  but a reasonable technical safeguard against an unbounded prompt — stated here rather than left
  as a silent, undocumented limit.
- A5 (cycle 0): A failure fetching eBay's item detail (item removed, transient API error) degrades
  gracefully — the Listing still imports/backfills, its description is simply left as it was —
  matching the exact precedent this codebase already set for photo-download failures
  (`attachCandidatePhotos`'s own try/catch-and-warn shape).
- A6 (cycle 0): The one new eBay API call this feature adds (a single-item detail fetch) is
  deliberately scoped to genuinely new candidates at scan time, created lazily and shared across one
  OAuth token per scan run — not fetched for every item a search merely finds, and not a second,
  separate OAuth round-trip per new candidate. This necessarily changes an existing test's exact
  HTTP-call-count assertion (previously asserting exactly one `/buy/browse/` call and one
  `/oauth2/token` call for a one-new-candidate scan); the test is updated, not removed or loosened,
  to assert the new, still-exact, still-bounded count.
- A7 (cycle 0): `BaselineSuite` is recorded `fail` for the same single inherited, unrelated,
  reproducible test (`listingPhotos.test.ts`) already documented in the three most recent features —
  confirmed failing again, in isolation, in this fresh worktree before any change. Out of scope.
- A8 (cycle 0, T1): `localizedAspects` entries' `name`/`value` fields are used verbatim with no case
  normalization — eBay's own capitalization is trusted as-is, per the task spec's note that `type`
  is not read.
- A9 (cycle 0, T1): "Blank after stripping" for the description is defined as empty after
  `stripHtml` + trim (e.g. a description that is only tags/whitespace, like `<div></div>`, counts as
  blank and is omitted), matching the null-vs-empty distinction the spec calls out.
- A10 (cycle 0, T1): The 5000-character truncation cap is applied to the final joined string
  (description + blank line + specifics block), not independently to each part, since the spec says
  "the combined result".
- A11 (cycle 0, T1): `stripHtml`'s block-boundary-to-newline conversion only covers the elements the
  spec explicitly lists (`br`, `/p`, `/div`, `/li`) — other block tags (e.g. `</tr>`, `</h1>`) are
  simply stripped with no newline, consistent with "strips every remaining tag" being the catch-all.
- A12 (cycle 0, T1): `fetchItemDescription` reuses the same `GET /buy/browse/v1/item/{itemId}`
  endpoint and OAuth token as `fetchItemImageUrls` (one extra API call per item, not combined into
  `fetchItemImageUrls`), since the task describes it as a new independent method on the same client.
- A13 (cycle 0, R2/TE2): R2 and TE2 ran in the same parallel batch; R2's reported Req 5 must_fix
  (no test exercised a failed eBay item-detail fetch) was independently resolved by TE2's own
  concurrently-written test ("still imports the Listing and counts it as new when the eBay
  item-detail fetch fails (Req 5)", mutation-proven killed) — confirmed on disk after both
  returned. Treated as resolved, not reopened as a separate task.
- A14 (cycle 0, R3/TE3): R3 reported a must_fix that zero tests existed for
  `descriptionBackfill.ts`/`listListingsMissingDescription` — true at the moment R3 read the repo,
  but TE3 was concurrently writing `apps/server/test/descriptionBackfill.test.ts` in the same
  parallel batch. Confirmed directly via `bash`/`cat` (not the file-viewing tool) after both
  returned: the file exists, all 5 tests pass, and all three WHERE-clause predicates plus all four
  `backfillOneListing` branches are mutation-proven. Treated as resolved, not reopened.
- A15 (cycle 0, R2): R2's second must_fix stands unresolved — the one `scanSource photo download
  call budget` scenario that exercises the description path always has `foundCount === newCount`
  (one search result, zero duplicates), so it cannot distinguish "one detail call per newly-imported
  candidate" (Req 7, correct) from "one detail call per search result" (the regression Req 7
  forbids). Reported to the build lead as the one outstanding `must_fix` for this validation pass.
- A16 (cycle 0): `measure-child-cost.py`'s OMP tag-search (`AGENT_TAG: <tag>` content grep across
  every session this machine has ever run) returned wrong values for all four of this batch's
  dispatches — confirmed by grepping the matched files directly: they belonged to unrelated past
  features (`my-dev-team/.tect-runs-large`, an older `pc-parts-flipper` worktree run) that happen to
  reuse the same generic `"review T2"`/`"test T2"`/etc. tag text, and this host's own child
  transcripts carry no `AGENT_TAG:` line at all for the tool to match correctly in the first place.
  `actual_tokens` for R2/TE2/R3/TE3 were instead computed directly from each child's own transcript
  file (`ImperialBarnacle.<TaskName>.jsonl`, confirmed unique to this run via a feature-slug grep),
  using the same last-`totalTokens` logic the script itself implements, rather than trusting the
  script's own (here, mismatched) output.
- A17 (cycle 0, R2/TE2 retry pass): A15's outstanding must_fix is resolved — the builder added
  `'distinguishes newly-imported candidates from duplicates in the same batch (Req 7)'` to the
  `scanSource photo download call budget` describe block (a 2-result, 1-duplicate+1-new scenario);
  this retry's reviewer and tester both independently confirmed it mutation-proves the Req 7 bound
  (a detail-call-per-search-result mutation makes its call-count assertion fail, 2 vs expected 1).
  No must_fix remains open for T2. `measure-child-cost.py`'s OMP tag search again matched a stale,
  unrelated transcript for both `"review T2"`/`"test T2"` tags this pass too (returned the identical
  value, 148958, for both — the same failure mode A16 already documented), so `actual_tokens` for
  this pass's R2/TE2 were instead read directly from this run's own child transcripts
  (`RetryValidation.ReviewT2.jsonl` / `RetryValidation.TestT2.jsonl`, unambiguous by mtime and by
  being the only pair under this project's current session directory), same last-`totalTokens`
  logic the script itself implements.
- A18 (cycle 0, standing-gate run): `npm run test`'s first full-suite run showed 3 server test
  files fail with `Error: Hook timed out in 30000ms` on `startTestServer`'s `beforeAll` (a different
  random 2-3 files on a second full run) — none of them `listingPhotos.test.ts`, the one documented
  `BaselineSuite` failure, which in fact passed both times. Confirmed pure resource-contention
  flakiness, not a T2/feature regression: (1) every file that failed in either full run passed
  cleanly when rerun standalone or in a small group; (2) a full server-suite rerun with
  `npx vitest run --no-file-parallelism` (serializing the ~59 files' worth of concurrent real
  server boots + DuckDB instances this WSL/mounted-drive host otherwise contends on) passed clean,
  59/59 files, 690/690 tests, zero failures. T2's diff touches only `scanService.ts` and its own
  test file — nothing about server bootstrap or test infra — so this has no plausible causal link
  to this feature's work. Standing-gate verdict is based on this clean `--no-file-parallelism` run.
- A19 (cycle 1): UAT's one `must_fix` (run the production backfill) is an operational action, not
  a code defect — its own text says so explicitly, and every one of T1/T2/T3's mechanisms (scan-time
  capture, the backfill script itself, the prompt's zero-change pass-through) was already proven
  correct by UAT(a)/(b)/(c) and R1-R3/TE1-TE3. Cycle 1 therefore dispatches no `feature-build-lead`
  task — there is no code to build or fix. The orchestrator runs `npm run backfill-descriptions`
  directly against the real production database (worktree code, production DB file, the live
  `pc-parts-flipper-dev` service stopped first to avoid a concurrent-writer conflict with DuckDB),
  records the real result, then dispatches one more `feature-uat-tester` pass to independently
  confirm the production data changed as expected before closing Cycle 1.
- A20 (cycle 1): `npm run backfill-descriptions` was run for real against the production database
  (`/mnt/d/repositories/pc-parts-flipper/data/pc-parts-flipper.duckdb`), with the live
  `pc-parts-flipper-dev` service stopped first (it had already exited from an unrelated host
  crash) and a pre-run backup copy of the `.duckdb`/`.wal` files taken into `data/backups/` first.
  Result: `{"succeeded":222,"skipped":0,"failed":0,"listingCount":222}`. Verified directly by
  query before (222/222 eBay listings had `description IS NULL`) and after (0/222 do; 222 total
  listings unchanged, confirming no row was lost or duplicated). The user's own reported example
  (`c87e761e-d475-4afa-8817-31f807ad76d8`, "gameing pc Ryzen 5 5600") now carries a real prose
  description plus a 9-line Item Specifics block (Brand, Type, Processor, RAM Size, Operating
  System, Hard Drive Capacity, Most Suitable For, Storage Type, GPU), confirmed both by direct
  DuckDB query and by the live `pc-parts-flipper-dev` service's own `/api/listings/:id` response
  after being rebuilt and restarted. While main checkout's main branch had the temporary
  `apps/server/.env` copy needed to authenticate; removed immediately after the run, never
  committed (`.env` is gitignored). Before this run, main's own working tree was found to carry
  stray uncommitted copies of this feature's own T2/T3 output (`package.json`,
  `db/queries/listings.ts`, `test/scanService.test.ts` modified; `descriptionBackfill.ts`,
  `backfill-descriptions.ts` untracked) — leaked there at some point during Cycle 0's build,
  unrelated to any merge; reverted to match `origin/main` exactly (content confirmed identical to
  the worktree's own authoritative copy before discarding) so main stayed clean ahead of this run.

## Cycle Log

### Cycle 0
Trigger: initial
UAT: failed
UAT checks:
- Built packages/shared via `npm run build -w packages/shared` — succeeded, tsc exited 0.
- UAT(a): fresh scan of a stubbed new eBay listing (vi.stubGlobal fetch, isolated temp DuckDB) returned {foundCount:1, newCount:1}; imported Listing's description column held the prose description followed by an "Item Specifics (per eBay):" block (Req 1, 3).
- UAT(a): item-specifics aspect names ("Processor", "RAM Size") passed through verbatim, not filtered to a hardcoded allowlist, each rendered as its own Name: Value line (Req 2).
- UAT(c): the real, unmodified buildIdentificationPrompt(listing, []) included the Listing's full description verbatim under "LISTING DESCRIPTION:" (Req 6).
- UAT(c): git status --porcelain confirmed apps/server/src/ai/identificationPrompt.ts was never touched by this feature — Req 6's "zero prompt-code change" claim proven directly, not inferred.
- UAT(b): seeded a Listing with description:null and a real externalItemId in a fresh temp DuckDB, ran the real `npm run backfill-descriptions` CLI against it (stubbed eBay detail response) — exit 0, summary {succeeded:1, skipped:0, failed:0, listingCount:1}.
- UAT(b): queried the seeded Listing back out after the CLI run and confirmed its description column changed from null to the real fetched text — the backfill mechanism writes to the database for real, not a dry run (Req 4, mechanism half).
- Req 5a: a failed item-detail fetch during a scan (stubbed HTTP 404) still imports the Listing (newCount:1) with description left null, never blocking the import.
- Req 5b: backfillOneListing with a throwing fetch returns outcome 'failed' without propagating, and never calls saveDescription.
- Req 7: with 1 pre-existing duplicate + 1 new candidate in a 2-result search response, exactly 1 detail-fetch call was made, not 2 — the call budget scales with new imports, not total search results.
- Lint: `npm run lint` clean, 0 errors/0 warnings, after removing all throwaway UAT scripts.
- Standing gate cited from validate-lead's A18: 59/59 server test files, 690/690 server tests, zero failures on a controlled --no-file-parallelism rerun; 690 server (+24 shared +248 web) exceeds BaselineTests' 944 total, no shrinkage.
- No DuckDB schema change: git status --porcelain confirms apps/server/src/db/schema.ts untouched.
UAT failure: Requirement 4's "run once against the real production database as part of delivering this feature" clause has no record anywhere in plan.md that it has happened yet — A3 states only future intent. feature-uat-tester's own scope explicitly forbids live-production access, so it could not perform or confirm this itself; its own must_fix text calls this "a one-time operational action, not a code defect" since the backfill mechanism itself is fully proven correct and safe by UAT(b) above.
Retries: T2 (first failure this cycle, in-place retry) — R2 found the `scanSource photo download
  call budget` test couldn't distinguish "one detail call per new candidate" from "one per search
  result" since both existing scenarios had zero duplicates (newCount always equaled foundCount);
  must_fix appended to T2's own description, T2/R2/TE2 reset to not_started, same cycle. Resolved:
  retry's R2/TE2 both PASS, must_fix case mutation-proven (see A17).

### Cycle 1
Trigger: UAT found Requirement 4's production-run half not yet performed — the backfill mechanism
  itself was fully proven correct and safe (UAT(b)), but no one-time run against the real
  production database had happened yet, and UAT's own scope explicitly forbids live-production
  access so it could not perform or confirm this itself.
Findings:
- Run `npm run backfill-descriptions` against the real production DuckDB file (not a test/temp DB)
  before this feature is considered fully delivered — a one-time operational action, not a code
  defect, since the mechanism is already proven correct. Confirm in plan.md afterward, including
  the summary counts it reports.
UAT: passed
UAT checks:
- Live `pc-parts-flipper-dev` service (production, main checkout) GET /api/listings?limit=300 returned total=222 and exactly 222 listing rows — matches the pre-backfill total, confirming no row was lost or duplicated.
- Of those 222 rows, 0 have externalSource 'ebay' with a non-null externalItemId and a null description — the gap this feature fixes is fully closed in production.
- Listing c87e761e-d475-4afa-8817-31f807ad76d8 ("gameing pc Ryzen 5 5600", the user's own reported example) has a non-null, 551-character description containing both the prose paragraph and a 9-line "Item Specifics (per eBay):" block.
- GET /health on the live production service returned {"status":"ok"}.
- GET /api/listings/c87e761e-d475-4afa-8817-31f807ad76d8 on the live production service returned the same description observed via the bulk listing query — the fix is live, not only present in the database file.
- A direct-file read-only DuckDB connection was attempted first per the task's literal instruction and correctly failed with a lock-conflict error against the live service's own write lock; the live service was deliberately left running (never stopped) and the same three facts were instead confirmed through its own HTTP API, querying the identical production database file.
