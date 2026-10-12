# Overview
eBay scans previously stored `description: null` on every imported Listing — eBay's search endpoint
never returns a full item description or seller "Item Specifics," and the code never called the one
endpoint that does. This feature fetches both from eBay's single-item detail endpoint for every
newly-scanned listing, formats them into the Listing's existing `description` field, and backfills
all 222 already-imported production listings (including the user's own reported example) so the gap
is closed for data that already existed, not just new scans going forward.

## Fetching and formatting eBay's description + specifics
Summary: A new connector capability turns eBay's raw HTML description and `localizedAspects` array
into one plain-text block — stripped, decoded, capped at 5000 characters — ready to drop straight
into a Listing's `description` field.
Tasks: T1
Flow:
- eBay detail response: Raw `description` HTML + `localizedAspects`
- stripHtml: Strip tags, decode entities, collapse whitespace
- formatEbayItemDetails: Join description + specifics, cap at 5000 chars
- fetchItemDescription: One API call per item, 502 on failure
Files:
- apps/server/src/connectors/ebayConnector.ts: Adds `stripHtml`, `formatEbayItemDetails`, and the `fetchItemDescription` client method that calls eBay's single-item detail endpoint and formats its response.
- apps/server/test/ebayConnector.test.ts: Unit-proves HTML stripping, entity decoding, truncation boundaries, and the null-vs-empty branches, plus a full round-trip through `fetchItemDescription` (success, 404, empty-response cases).

## Capturing description at scan time, without a wasted API call
Summary: Newly-scanned eBay listings now get one extra detail-fetch call per genuinely new
candidate — never per search result, never for duplicates, never for non-eBay sources — and a
failed fetch degrades gracefully instead of blocking the import.
Tasks: T2
Flow:
- New candidate imported: Listing created from search result
- attachCandidateDescription: Platform-gated, lazy eBay detail fetch
- Success: Description saved onto the Listing
- Failure: Logged and swallowed, import still counts
Files:
- apps/server/src/scan/scanService.ts: Adds `ScanServiceDeps`, `attachCandidateDescription` (eBay-only, best-effort, mirrors the existing photo-attach shape), and `createLazyEbayDescriptionFetcher` to share one OAuth token per scan rather than fetching eagerly or per-candidate.
- apps/server/test/scanService.test.ts: Updates the exact call-budget assertion (now 1 search + 1 token + 1 detail call for one new candidate) and adds cases proving a failed detail fetch still imports the Listing, and that duplicates in the same batch never trigger a second detail call.

## One-time backfill for already-imported listings
Summary: A new script, mirroring the existing photo-backfill's structure, finds every eBay Listing
still missing a description and fetches/saves it — the mechanism that was run for real against
production to fix the user's own already-scanned example and all other pre-existing listings.
Tasks: T3
Flow:
- listListingsMissingDescription: Query eBay listings with null description
- backfillOneListing: Fetch detail, save, or skip/fail per outcome
- runDescriptionBackfill: Loop the batch, lazily create the eBay client
- npm run backfill-descriptions: CLI entry point, reports summary, sets exit code
Files:
- apps/server/src/db/queries/listings.ts: Adds `listListingsMissingDescription`, mirroring `listListingsMissingPhotos`'s WHERE clause and ordering exactly.
- apps/server/src/scan/descriptionBackfill.ts: New file holding the backfill's logic — `backfillOneListing`'s three-outcome handling (succeeded/skipped/failed), the batch runner, and `runDescriptionBackfill`'s lazy client creation.
- apps/server/src/scripts/backfill-descriptions.ts: Thin CLI entry point that runs the backfill, logs the summary, and exits non-zero on any failure.
- apps/server/package.json: Registers the `backfill-descriptions` npm script, mirroring the existing `backfill-photos` entry.
- apps/server/test/descriptionBackfill.test.ts: Proves all four `backfillOneListing` outcomes with recording fakes, and the real-DuckDB query's inclusion/exclusion/ordering behavior.

## Running the backfill against production
Summary: The backfill mechanism itself was proven correct in a test database first; the orchestrator
then ran it for real against the live production DuckDB file — no code task was needed, just the
operational step the earlier UAT pass flagged as missing.
Tasks: (no task id — Cycle 1's orchestrator-run production step, recorded in the plan's Assumptions and Cycle Log)
Files:
- (none — this was a direct run of `npm run backfill-descriptions` against `data/pc-parts-flipper.duckdb`, with the live dev service stopped first and a backup taken; result `{"succeeded":222,"skipped":0,"failed":0,"listingCount":222}`.)
