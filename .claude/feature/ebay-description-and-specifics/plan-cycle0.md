# Feature: ebay-description-and-specifics

Status: proposed
Cycle: 0 / 3
FeatureStarted: 2026-10-12T01:23:00Z
OrchestrationTokensActual: 32328
OrchestrationTokensBreakdown: input 0 + output 9,435 + cache-write 9,778 + cache-read 13,115, across 8 turns
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
| T1 | eBay connector: fetch and format item description + specifics (Req 1-3). `apps/server/src/connectors/ebayConnector.ts`: extend the `EbayItemDetail` interface with `description?: string;` and `localizedAspects?: Array<{ name: string; value: string }>;` (both already present on eBay's real single-item detail response, confirmed against eBay's own Browse API docs — `type` is not read, only `name`/`value`). Add a private `stripHtml(html: string): string` helper: removes `<script>...</script>` and `<style>...</style>` blocks (tags and their content both), converts `<br>`/`<br/>`/`</p>`/`</div>`/`</li>` into a newline, strips every remaining tag, decodes the common HTML entities (`&amp;` `&lt;` `&gt;` `&quot;` `&#39;`/`&apos;` `&nbsp;`, plus numeric entities `&#NNN;`), collapses 3+ consecutive newlines to 2 and runs of spaces/tabs to one, and trims. Add an exported `formatEbayItemDetails(detail: { description?: string; localizedAspects?: Array<{ name: string; value: string }> }): string \| null`: HTML-strips and trims `detail.description` (omitted entirely from the output if blank after stripping); formats every `localizedAspects` entry as `` `${name}: ${value}` ``, one per line, under a `'Item Specifics (per eBay):'` header (the whole specifics block omitted if the array is absent or empty); joins whichever of the two parts are present with a blank line between them; returns `null` if neither part produced any content (an eBay item that genuinely has no description and no specifics is still null, not an empty string); caps the combined result at 5000 characters (eBay descriptions can run up to 500,000 characters — this bounds the AI prompt's token cost), truncating with a trailing `'... [truncated]'` marker when the cap is hit. Add a new method `fetchItemDescription(externalItemId: string): Promise<string \| null>` to the existing `EbayItemDetailClient` interface/implementation returned by `createEbayItemDetailClient()`: calls the same `GET /buy/browse/v1/item/{itemId}` endpoint `fetchItemImageUrls` already calls (same error handling, same AppError(502)-on-failure convention), and returns `formatEbayItemDetails(body)` on the parsed response body. This is a new, independent method — it does not change `fetchItemImageUrls`'s existing signature or behavior, and existing callers (`photoBackfill.ts`) are untouched. | builder | | not_started | 0 | | | | 35 | | | | no | |
| T2 | Scan-time capture (Req 1, 2, 3, 5, 7), depends on T1. `apps/server/src/scan/scanService.ts`: add an exported `ScanServiceDeps` interface with one optional member, `fetchEbayItemDescription?: (externalItemId: string) => Promise<string \| null>`, documented as: never called unless the Source's connector is eBay's, never called for an already-seen duplicate, and left `undefined` by every existing test using a fake `MarketplaceConnector` so none of them gain a new network call. `scanSourceWithConnector` gains a third, optional `deps?: ScanServiceDeps` parameter, threaded through to a new private `attachCandidateDescription(listingId, candidate, connector, fetchEbayItemDescription)` helper called from `importCandidateIfNew` right alongside the existing `attachCandidatePhotos` call: no-ops immediately if `connector.platformType !== 'ebay'` or `fetchEbayItemDescription` is undefined; otherwise calls it, and if the result is non-null, `updateListing(listingId, { description })`; wraps the whole thing in the exact same try/catch-and-`logger.warn`-and-continue shape `attachCandidatePhotos` already uses (Req 5 — a detail-fetch failure must never fail the Listing's own import). `scanSource` (the real, production wrapper — not `scanSourceWithConnector` itself) is the ONLY place that constructs the real dependency: add a small private `createLazyEbayDescriptionFetcher()` helper that returns a function closing over a memoized, lazily-created `createEbayItemDetailClient()` call (created on that function's own first invocation, not eagerly) — this is what keeps a scan that imports zero new candidates from making any extra eBay OAuth call at all, and keeps a scan that imports several new candidates to one shared OAuth token rather than one per candidate. `scanSource` passes `{ fetchEbayItemDescription: createLazyEbayDescriptionFetcher() }` as `deps` only when `connector.platformType === 'ebay'`, matching the same platform-gating `attachCandidateDescription` itself already checks (defense in depth, not redundant — `scanSourceWithConnector` is also called directly, with injected test deps, bypassing `scanSource` entirely). Update `apps/server/test/scanService.test.ts`'s existing `'scanSource photo download call budget (Req 2)'` describe block (the one asserting exactly one `/buy/browse/` call and one `/oauth2/token` call for a scan importing one new candidate): its own comment already explains why a per-item eBay API call would normally be the wrong pattern — add a note immediately above the updated assertions explaining that this feature's own single-item detail call is the deliberate, necessary exception that comment warns against conflating with a real per-item-scaling regression, since eBay's search summaries genuinely never carry description/specifics data no matter how the connector is written. Extend its `fetchMock` to also handle a `/buy/browse/v1/item/` request (matched by URL substring, same style as its existing `/oauth2/token`/`/buy/browse/` branches) returning a fixture `{ description: '<p>Great condition</p>', localizedAspects: [{ name: 'RAM', value: '16GB' }] }`; update the call-count assertions from 1 to 2 for both `/buy/browse/` and `/oauth2/token` (one of each for the search, one of each for the new lazily-created detail client), add `expect(urls.filter((u) => u.includes('/buy/browse/v1/item/'))).toHaveLength(1);`, and add a new assertion that the imported Listing's `description` now reads `'Great condition\n\nItem Specifics (per eBay):\nRAM: 16GB'` (or whatever `formatEbayItemDetails` actually produces for that exact fixture — assert the real value, not a substring match). | builder | T1 | not_started | 0 | | | | 40 | | | | no | |
| T3 | One-time description backfill for already-imported eBay listings (Req 4, 5), depends on T1. `apps/server/src/db/queries/listings.ts`: add `listListingsMissingDescription(externalSource: string): Promise<Listing[]>`, mirroring `listListingsMissingPhotos` exactly (`WHERE external_source = $external_source AND external_item_id IS NOT NULL AND description IS NULL ORDER BY created_at ASC, id ASC`, same doc-comment style explaining what it backs). `apps/server/src/scan/descriptionBackfill.ts` (new file, mirroring `apps/server/src/photos/photoBackfill.ts`'s structure line for line): exported `BackfillSummary { succeeded: number; skipped: number; failed: number }`; exported `BackfillDeps { fetchItemDescription(externalItemId: string): Promise<string \| null>; saveDescription(listingId: string, description: string): Promise<void>; }`; exported `BackfillOutcome = 'succeeded' \| 'skipped' \| 'failed'`; exported `backfillOneListing(listing: Listing, deps: BackfillDeps): Promise<BackfillOutcome>` — `'skipped'` when `listing.externalItemId` is null (same guard `photoBackfill.ts`'s own version has) or when the eBay call resolves `null` (nothing to backfill, not an error); `'failed'` on a thrown error, caught and logged, never propagated; `'succeeded'` otherwise, after calling `saveDescription`; exported `backfillListingDescriptions(listings: Listing[], deps: BackfillDeps): Promise<BackfillSummary>` — sequential, per-Listing progress logged at Info, identical shape to `backfillListingPhotos`; exported `runDescriptionBackfill(): Promise<BackfillSummary>` — calls `listListingsMissingDescription('ebay')`, returns the zero-tally summary immediately without creating any eBay client when the list is empty, otherwise lazily creates one `EbayItemDetailClient` shared across the whole run and wires `fetchItemDescription`/`saveDescription` (the latter via `updateListing(listingId, { description })`) into `backfillListingDescriptions`. `apps/server/src/scripts/backfill-descriptions.ts` (new file, copying `backfill-photos.ts` line for line except calling `runDescriptionBackfill`/importing from `descriptionBackfill.js`). `apps/server/package.json`: add a `"backfill-descriptions": "tsx --env-file-if-exists=.env src/scripts/backfill-descriptions.ts"` script entry alongside the existing `backfill-photos` one. | builder | T1 | not_started | 0 | | | | 30 | | | | no | |
| R1 | Review T1 against Req 1-3, scoped to `ebayConnector.ts`. Confirm `stripHtml` genuinely removes script/style content (not just their tags), decodes the named entities, and collapses whitespace sensibly on a realistic multi-paragraph eBay-style description with nested tags; confirm `formatEbayItemDetails` returns `null` (not `''`) when both inputs are empty/absent, correctly omits either section when only one is present, and the 5000-character truncation triggers at exactly the right point with the trailing marker; confirm `fetchItemDescription` reuses the exact same error-handling convention as `fetchItemImageUrls` (same AppError(502) shape) and does not alter that sibling method's own behavior at all. PASS only if at least one hand-traced example input/output pair for `stripHtml` and `formatEbayItemDetails` each is verified against the actual code, not read as plausible. | reviewer | T1 | not_started | 0 | | | | 15 | | | | no | |
| TE1 | Test T1. Extend `apps/server/test/ebayConnector.test.ts` with: `stripHtml`/`formatEbayItemDetails` unit cases covering a realistic HTML description (paragraphs, bold, a line break, a `<script>` block that must disappear entirely), entity decoding, the both-present/description-only/specifics-only/neither-present branches (confirming `null` specifically for the last one), and the 5000-character truncation boundary (one case just under the cap, one case over it, asserting the exact truncated output, not just its length); a `fetchItemDescription` case (same `fetchMock`-stubbed-global-fetch style the existing `createEbayItemDetailClient` tests already use) proving a realistic fixture response round-trips through to the expected formatted string, a 404 case proving it throws the same `AppError(502)` shape `fetchItemImageUrls` already proves, and a case proving an item with neither description nor aspects resolves `null` rather than throwing. PASS: all new cases pass, no regression in the rest of `ebayConnector.test.ts`. | tester | T1 | not_started | 0 | | | | 25 | | | | no | |
| R2 | Review T2 against Req 1, 2, 3, 5, 7, scoped to `scanService.ts` and its test file. Confirm `attachCandidateDescription`'s platform-gate and undefined-deps-gate both genuinely no-op (read the exact conditional, don't infer it from the description); confirm the try/catch truly swallows a thrown error without ever failing the Listing's own import (trace the call site inside `importCandidateIfNew`); confirm `createLazyEbayDescriptionFetcher`'s memoization genuinely creates the client at most once per scan, on first actual use, not eagerly at `scanSource`'s own top (read the closure, don't assume); confirm the updated call-budget test's new assertions (2x `/buy/browse/`, 2x `/oauth2/token`, 1x `/buy/browse/v1/item/`, the description-populated assertion) are all present and each is checking the real value, not a loosened/weakened version of what T2's description promised. PASS only if the lazy-creation claim is verified by tracing the actual closure code, not taken on faith from a comment. | reviewer | T2 | not_started | 0 | | | | 15 | | | | no | |
| TE2 | Test T2 (already substantially specified inside T2's own description — this role's job is to run what T2's builder wrote, confirm it actually falsifies, and extend it if a gap remains). Confirm the updated `scanSource photo download call budget` test passes and genuinely fails if `attachCandidateDescription`'s platform-gate is removed (a mutation check: temporarily make the gate always-true, confirm the test's call-count assertions catch a non-eBay connector wrongly getting a description fetch — or, if this project's fake connectors are all eBay-typed and such a mutation can't be exercised this way, confirm by direct code reading instead and say so plainly). Add a case proving a detail-fetch failure (stub the `/buy/browse/v1/item/` branch to return a non-200 response) still results in `newCount: 1` for that scan and the Listing's `description` stays `null` — Req 5 proven live, not just by trusting the try/catch's shape. PASS: all cases pass, no regression in the rest of `scanService.test.ts`. | tester | T2 | not_started | 0 | | | | 25 | | | | no | |
| R3 | Review T3 against Req 4, 5, scoped to `listListingsMissingDescription`, `descriptionBackfill.ts`, `backfill-descriptions.ts`, and the `package.json` script entry. Confirm the query's WHERE clause matches `listListingsMissingPhotos`'s own structure exactly (external_source, external_item_id IS NOT NULL, the new description IS NULL predicate, same ordering); confirm `backfillOneListing`'s three-outcome logic matches `photoBackfill.ts`'s own `backfillOneListing` precisely (skip-on-null-external-id, skip-on-nothing-to-backfill, fail-on-thrown-error, succeed-otherwise) with no outcome miscategorized; confirm `runDescriptionBackfill` genuinely skips client creation on an empty list (read the early-return, don't assume); confirm the CLI script's exit-code convention matches `backfill-photos.ts`'s (`summary.failed > 0` -> exit 1). PASS only if `backfillOneListing`'s three branches are each traced against T3's own description, not spot-checked on one branch alone. | reviewer | T3 | not_started | 0 | | | | 15 | | | | no | |
| TE3 | Test T3. New `apps/server/test/descriptionBackfill.test.ts`, mirroring `apps/server/test/photoBackfill.test.ts`'s structure precisely (isolated-DuckDB-tmpdir dynamic-import pattern for the query test, in-memory `recordingDeps`-style fakes for the batch tests — no real eBay call and no real file write in any case here): cover `backfillOneListing`'s three outcomes (succeeded with a real description saved, skipped for a null external id, skipped for a null eBay response, failed for a thrown error) and `listListingsMissingDescription`'s real-DuckDB query proof (a Listing with a description present is excluded, one with description null and a real external id is included, one with description null but no external id is excluded, ordering is oldest-created-first). PASS: new test file fully passes, matches the rigor of the file it mirrors. | tester | T3 | not_started | 0 | | | | 30 | | | | no | |

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

## Cycle Log

### Cycle 0
Trigger: initial
UAT: not_run
