Status: done
Cycle: 2 / 3
FeatureStarted: 2026-10-05T16:46:02Z
OrchestrationTokensActual: null
OrchestrationTokensBreakdown: null
Prototype: .claude/feature/ai-visual-identification/dashboard.html (local file — no hosted-publish capability on this host, so there is no live URL)
BaselineTests: 313
BaselineSuite: pass
ApprovedBy: user (chat approval)
FeatureCompletedAt: 2026-10-05T23:48:00Z


# pc-parts-flipper — ai-visual-identification

## Goal

`POST /api/listings/:id/identify-parts` identifies parts from listing text and photos today, but the
photos are only ever compared against the model's own trained recall — nothing in the request shows
it what a confirmed example of a candidate part actually looks like. Four of seven parts in a listing
examined during this feature's planning came back with zero lead at all (a GPU's shroud/heat-pipe
shape, a stock cooler's silhouette, a motherboard's rear-I/O layout, a PSU's unlabeled body) despite
carrying real, described visual detail the model simply had nothing to compare it against. This
feature adds a second, targeted identification pass: for any part the first pass didn't fully pin
down, it looks up reference photos of already-confirmed real parts — grown automatically from this
app's own confirmed identifications, seeded at the start with a small curated set for the
highest-traffic categories — and asks the model to compare the listing's own photos against those
labeled references using visual identifying marks (shape, color, pattern, connector layout,
badge/sticker design), not just legible text. Pricing stays out of scope, as before.

## Requirements
1. The reference-photo library starts with a small curated seed set: real product photos pulled from
   manufacturers'/retailers' own public product pages for a handful of specific, common part models
   across the GPU, Case, and Cooler categories, downloaded once to local disk and each tagged with
   its real category/brand/partNumber.
2. Whenever a Listing is created or edited with an Expected Part carrying a non-null `brand`, every
   one of that Listing's photos is automatically added to the reference-photo library, tagged with
   that part's category/brand/partNumber — no separate user action, no manual "use as reference" flag.
3. Whenever a teardown submission records an Additional Part (typed fresh during teardown, not
   carried over from an Expected Part) with a non-null `brand`, the originating Purchase's Listing's
   photos are automatically added to the reference-photo library the same way as Requirement 2.
4. Saving the same Listing more than once (e.g. re-editing and resubmitting it, which replaces its
   Expected Parts wholesale) never creates duplicate reference-photo library entries for the same
   photo/category/brand/partNumber combination that was already promoted.
5. After `POST /api/listings/:id/identify-parts`'s existing single-pass identification completes, a
   part is eligible for a second, photo-comparison pass only when it is not fully and singly settled:
   its `brand` is null, OR its `partNumber` is null, OR its `identityCandidates` list is non-empty. A
   part the first pass already settled completely (non-null brand and partNumber, empty
   `identityCandidates`) is never sent through the second pass and never changes — matching this
   pipeline's existing "nothing changes when already confident" rule.
6. For each eligible part, the system looks up reference photos matching that part's category,
   preferring, in order: its own already-known brand/partNumber, then each of its proposed
   `identityCandidates`, and falling back to any reference photos in the same category when the part
   has no brand lead at all. The number of reference photos attached is capped per eligible part and
   capped again across the whole request, so a listing with several eligible parts never balloons the
   model call's size or latency without bound.
7. When the reference-photo library has no eligible photo for any eligible part in a given
   `identify-parts` call (nothing promoted yet, or nothing seeded for the relevant category), no
   second pass is made at all — the response is exactly what the first pass produced, with no extra
   latency or cost paid for a comparison that has nothing to compare against.
8. When a second pass does run, it attaches the selected reference photos — each one clearly labeled
   with the confirmed identity it represents — alongside the listing's own photos in the same model
   call, and instructs the model to compare them using visual identifying marks (shape, color,
   pattern, connector layout, badge/sticker design), not only legible text.
9. The second pass's result for an eligible part can do any of: (a) fill in a previously-null
   `brand`/`partNumber` when a reference photo is a confident visual match, (b) add to, narrow, or
   re-rank that part's `identityCandidates` list when the visual comparison supports it, or (c) leave
   the part exactly as the first pass reported it, when no attached reference genuinely resembles
   what's in the listing's own photos — never a guess the photos don't actually support, matching the
   existing "null/unchanged is honest, a wrong guess is not" rule this pipeline already follows.

## Standing checks
- The whole test suite passes, and the test count stays at or above `BaselineTests` (313, this
  feature's fresh-worktree baseline recorded above).
- ESLint runs clean with zero new violations.
- Every new public function/class carries a block comment; non-obvious lines carry a single-line
  comment above them (existing project convention).
- Logging follows the existing Error/Warn/Info/Debug/Trace convention — a reference photo promotion
  that's skipped as a duplicate, and a second pass that's skipped for lack of any eligible reference,
  both log at Info (an expected, non-error path), matching how the existing pipeline logs its own
  start/completion today; a malformed second-pass model response is coerced and logged at Warn the
  same way `coerceIdentityField`/`coerceIdentityCandidates` already do for the first pass.
- `apps/web` never imports `apps/server` directly (existing boundary, checked by the existing ESLint
  rule — no new exception needed). This feature adds no new web UI at all (see Assumption A3), so no
  new call site is at risk of this regardless.
- All DuckDB access for the new `part_reference_photos` table stays inside `apps/server/src/db` —
  reached only through a new `queries/referencePhotos.ts`, never raw SQL from a route handler.
- No new source file goes over ~200 lines. `apps/server/src/routes/listings.ts` (208 lines),
  `apps/server/src/db/queries/parts.ts` (209 lines), and `apps/server/src/ai/identificationParser.ts`
  (198 lines) are already at or past that before this feature starts; their additions here (a few
  lines each to call the new promotion/lookup functions) must stay minimal — the real new logic
  belongs in the new files this feature adds, not folded into these.
- The identification pipeline's own tests stub the `omp` runner (the existing
  `setOmpRunnerOverride` mechanism) for *both* the first and the new second pass — never a real AI
  call — matching `identifyPartsRoute.test.ts`/`partIdentification.test.ts`'s existing convention.
- `part_reference_photos` is written from two previously-separate code paths (the Listing save route
  and the teardown route) for the first time — concurrent writes against it (two overlapping requests
  that would promote the same photo/category/brand/partNumber combination at once) never produce two
  rows for the same combination and never throw an unhandled error, proven with real concurrent
  requests against the running server, not sequential calls — the same way `core-workflow`'s T14 and
  `ebay-scanning`'s T7 each proved their own concurrency guarantees.

## Tasks
| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| T1 | New table `part_reference_photos` (`id UUID PK, category component_category NOT NULL, brand VARCHAR NOT NULL, part_number VARCHAR, photo_path VARCHAR NOT NULL, source VARCHAR NOT NULL` — `'seed'` or `'confirmed_listing'` — `, listing_id UUID REFERENCES listings(id)` nullable (null for seed rows), `created_at TIMESTAMP NOT NULL DEFAULT current_timestamp`), added as a new `TABLE_STATEMENTS` entry in `apps/server/src/db/schema.ts` (after `listings`, since it FK-references it) plus two new `INDEX_STATEMENTS`: `idx_reference_photos_category_brand ON part_reference_photos(category, brand)` for lookup, and a `CREATE UNIQUE INDEX` on `(category, brand, part_number, photo_path)` for Requirement 4's dedup (DuckDB treats multiple NULLs as distinct per the existing `external_item_id` precedent, so two different photos for the same category/brand/null-partNumber stay distinct rows). Add `ReferencePhoto` to `apps/server/src/db/types.ts`. New `apps/server/src/db/queries/referencePhotos.ts` exporting: `promoteReferencePhotos(listingId: string, photoPaths: readonly string[], category: ComponentCategory, brand: string, partNumber: string \| null): Promise<void>` — inserts one row per photo path, catching the unique-index violation per row and treating it as "already promoted, skip" (same pattern as the eBay connector's duplicate-listing insert, Requirement 4); and `findReferencePhotosForLeads(category: ComponentCategory, leads: {brand: string \| null; partNumber: string \| null}[], limit: number): Promise<ReferencePhoto[]>` — when `leads` has at least one non-null-brand entry, prefers rows matching one of those brand/partNumber pairs (partNumber match optional), else returns any rows in that category, ordered most-recent-first, de-duplicated to at most one row per distinct brand+partNumber pair, capped at `limit`. Export both plus `ReferencePhoto` from `db/index.ts`'s barrel. MUST FIX (cycle 0 retry 1): (1) `idx_reference_photos_dedup`'s uniqueness on `(category, brand, part_number, photo_path)` never fires for a null-`part_number` row — DuckDB treats every NULL as distinct from every other NULL — so `promoteReferencePhotos` duplicates on every re-save of a brand-only reference; add an application-level existence check (query for a matching row first, treating `part_number IS NULL` explicitly) before inserting when `partNumber` is null, instead of relying on the unique index alone for that case. (2) `findReferencePhotosForLeads` must honor the `leads` array's own priority order (own brand/partNumber first, then each `identityCandidates` entry in order) when capping at `limit` — it currently does a plain `ORDER BY brand, part_number, created_at DESC`, an alphabetical sort with no connection to lead priority; rewrite the query/selection so a part's own known brand is always preferred over a lower-priority candidate brand, confirmed by a case where the alphabetically-earlier lead is NOT the part's own brand. | builder | | complete | 0 | sonnet | 2026-10-05T19:41:20Z | 2026-10-05T19:43:17Z | 20 | 2026-10-05T17:01:40Z | 10900 | | no |
| T2 | Hook `promoteReferencePhotos` (T1) into the two places a non-null-brand identity is actually confirmed by a human (Requirements 2-3): in `apps/server/src/routes/listings.ts`, after each `createExpectedPart` call in both the `POST /api/listings` and `PUT /api/listings/:id` handlers, call it once per created Expected Part whose `brand` is non-null, passing the just-created Listing's `photoPaths`. In `apps/server/src/routes/teardown.ts`, after the `createPart` call inside the `additionalParts` loop, call it once per Additional Part whose `brand` is non-null, passing the already-in-scope `listing.photoPaths` (the reconciled-Expected-Part branch of that same handler is deliberately **not** hooked — that identity was already promoted when its Expected Part was first saved, so hooking it too would only ever produce exact-duplicate, dedup-skipped inserts for no benefit). Both call sites run after their existing create succeeds and never block or fail the request if promotion itself throws (log Error and continue — a reference-library write failure must never break saving a Listing or submitting a teardown). MUST FIX (cycle 0 retry 1): Requirement 2's "created" half is dead code on `POST /api/listings` — that handler always calls `createListing({ ...input, photoPaths: [] })`, since this API has no field to attach photos at creation time; photos are only ever added afterward through the separate photo-upload route (`listingPhotos.ts`), which calls `updateListing` directly and never calls `promoteReferencePhotos`. Hook the promotion call into that photo-upload path too (after a photo is actually attached to a Listing that already has Expected Parts with a non-null brand), so a newly-created Listing's real first photos actually get promoted once both exist — not only on a subsequent full `PUT`. | builder | T1 | complete | 0 | sonnet | 2026-10-05T19:43:17Z | 2026-10-05T19:54:19Z | 15 | 2026-10-05T17:21:40Z | 6800 | | no |
| T3 | Seed data (Requirement 1): fetch a small curated set (roughly 8-12 photos total) of real product photos from manufacturers'/retailers' own public product pages, for specific, common models across GPU (e.g. a couple of distinct blower-style reference shrouds), Case (e.g. one or two common mid-tower models), and Cooler (e.g. the stock coolers bundled with common CPUs) — the same three categories the planning example found hardest to identify from recall alone. Save the files under `data/reference-photos/seed/` (new directory; `data/` is already gitignored, so these — like the user's own real listing photos — are never committed to the repo, only ever present on a machine that fetched them). New one-time script `apps/server/src/db/seedReferencePhotos.ts`, run manually (`tsx src/db/seedReferencePhotos.ts`) rather than from `migrate.ts`'s automatic boot sequence, since it needs outbound network access that a normal server boot must not depend on; it downloads the images and inserts one `part_reference_photos` row per photo via direct use of T1's query functions (`source: 'seed'`, `listingId: null`). Completed directly (not via the sandboxed build-lead sub-agent, which had no outbound network access): found and replaced all 10 of the sub-agent's seed URLs, which were fabricated Amazon CDN hash paths that every one of verifiably 404'd, with 10 real Wikimedia Commons photos — each individually downloaded and verified (HTTP 200, real decoded JPEG bytes) before being wired in, labeled with exactly what each photographed item actually is (a few are a specifically different real model than originally planned, e.g. AMD Wraith Spire not Wraith Stealth, NZXT H500i not H510, since that is what a real verified photo was available for). Also fixed two real bugs found while running it live: (1) Wikimedia 403s any request with no/generic User-Agent — added one; (2) `SEED_DIR` did not honor the `DUCKDB_DATA_DIR` override `client.ts`/`photoStorage.ts` already do, so an isolated-data-dir run would still write into the real shared `data/` directory — fixed to match that existing convention. Verified end to end: an isolated-DATA_DIR run confirmed file-write isolation now works; a real run against this worktree's own `data/` populated all 10 files under `data/reference-photos/seed/` and all 10 rows in `part_reference_photos` (confirmed via direct query), with the worktree's own listings/sources tables confirmed unaffected (0/0, a fresh worktree, not data loss). MUST FIX (cycle 0 retry 1): (1) `seedReferencePhotos.ts` is 288 lines, over the ~200-line Standing Check with no stated exception — split it (e.g. move the `SEED_PHOTOS` metadata array into a sibling data file/module, or move the download/insert logic out) so the main script file comes back under the cap, the same way T4's `visualComparisonParser.ts` split was already judged necessary for the same check. (2) Delete `SEED_SCRIPT_NOTES.md` from the repo root — it documents the original sub-agent's fabricated Amazon URLs and a different product list, never updated to match what actually ships, and is not a deliverable any task asked for; the script's own header comment (already updated) is this feature's real documentation of what it does and where the photos came from. | builder | T1 | complete | 0 | sonnet | 2026-10-05T19:43:17Z | 2026-10-05T19:54:19Z | 25 | 2026-10-05T17:36:40Z | 3600 | | no |
| T4 | Second-pass prompt and parser (Requirement 8-9). New `apps/server/src/ai/visualComparisonPrompt.ts`: `buildVisualComparisonPrompt(listing: Listing, eligibleParts: { partIndex: number; category: ComponentCategory; description: string; references: ReferencePhoto[] }[]): string` — for each eligible part, restates its category/description from the first pass and numbers/labels each of its attached reference photos with the confirmed identity it represents and its `source` (seeded vs. a previously confirmed real listing); instructs the model to compare the listing's own photos against the labeled references using identifying marks (shape, color, pattern, connector layout, badge/sticker design) and to return, per `partIndex`, either an updated `brand`/`partNumber`/`identityCandidates`, or an explicit "no change" when nothing attached genuinely matches — raw JSON only, same convention as the first pass's prompt. In `apps/server/src/ai/identificationParser.ts`, change `coerceIdentityField` and `coerceIdentityCandidates` from module-private to exported, so the new parser reuses them instead of duplicating their coercion logic; `parseVisualComparisonResponse` is implemented in a new sibling file `apps/server/src/ai/visualComparisonParser.ts` (not folded into `identificationParser.ts` itself — that file is one of the standing check's three named "keep additions minimal" files, and the full parser function would have pushed it to 275 lines; the split keeps `identificationParser.ts` at 199 lines while still reusing its two exported coercion helpers), built the same defensive way as `parseIdentificationResponse` (structural failure is fatal, a single malformed entry is coerced and logged at Warn, never dropped silently). MUST FIX (cycle 0 retry 1): `apps/server/test/visualComparison.test.ts` references a `PromptModule` type name that is never imported — it uses a named import (`import type { EligiblePart } from '../src/ai/visualComparisonPrompt.js'`) where every sibling test file in this project uses the namespace-import pattern (`import type * as PromptModule from ...`) for this; a standalone `npx tsc --noEmit` run confirms a real compile error (`error TS2304: Cannot find name 'PromptModule'`) that `vitest` itself doesn't type-check for and so never caught. Fix the import to match the established sibling pattern. | builder | T1 | complete | 0 | sonnet | 2026-10-05T19:43:17Z | 2026-10-05T19:54:19Z | 20 | 2026-10-05T17:36:40Z | 2000 | | no |
| T5 | Orchestration (Requirements 5-9): extend `apps/server/src/ai/partIdentification.ts`'s `identifyListingParts`. After the existing first pass parses, compute the eligible-part set per Requirement 5 (by index into the `parts` array, since nothing else is a stable identifier at this point). When empty, return the first pass's result unchanged (Requirement 5's last sentence). Otherwise, for each eligible part call T1's `findReferencePhotosForLeads` with its own brand/partNumber plus its `identityCandidates` as leads (category-only fallback when every lead's brand is null), capped at a new named constant `MAX_REFERENCE_PHOTOS_PER_PART = 3`; if the combined total across all eligible parts would exceed a new `MAX_TOTAL_REFERENCE_PHOTOS_PER_CALL = 12`, trim round-robin (take one from each eligible part's own list in turn) until the total fits, rather than letting one part's references crowd out another's. When the trimmed total is zero (Requirement 7), return the first pass's result unchanged — no second `omp` call is made. Otherwise build T4's prompt, resolve each reference photo's `photo_path` the same way `resolvePhotoPaths` already resolves listing photos (both are relative to the same data directory), call `getOmpRunner()` a second time with the listing's own photos plus the selected reference photos, parse with T4's `parseVisualComparisonResponse`, and merge each returned entry onto the first pass's `parts[entry.partIndex]` by overwriting `brand`/`partNumber`/`identityCandidates` with the second pass's values (Requirement 9) — a part the second pass didn't return an entry for (e.g. it was eligible but got zero references of its own) is left exactly as the first pass reported it. MUST FIX (cycle 0 retry 1): the merge loop applies every `comparisonUpdates` entry with zero validation that its `partIndex` was actually one of the indices included in the eligible-part set sent to the second pass — a hallucinated or out-of-range `partIndex` from the model can silently mutate a fully-settled part (directly violating Requirement 5's "never sent through the second pass and never changes" guarantee for that part) or throw an unhandled `TypeError` on an out-of-range index, crashing the whole `identify-parts` call. Filter `comparisonUpdates` to only `partIndex` values that were actually in the eligible-part set before applying any update; add a test for both the out-of-range case and the settled-part-targeted case. Also add a test for the eligibility arm not yet covered in isolation: `identityCandidates` non-empty while both `brand`/`partNumber` are already non-null. | builder | T1, T4 | complete | 0 | sonnet | 2026-10-05T19:54:19Z | 2026-10-05T19:59:12Z | 25 | 2026-10-05T18:01:40Z | 2400 | | no |
| T1-REV | Review T1 (`part_reference_photos` table in schema.ts, `ReferencePhoto` type, `db/queries/referencePhotos.ts`'s `promoteReferencePhotos`/`findReferencePhotosForLeads`, barrel export) against Requirements 1/4/6 and the Standing Checks (DuckDB access confined to `apps/server/src/db`, block/line comments, dedup via unique index). MUST FIX (cycle 0 retry 1, 2nd pass): both of retry 1's two MUST FIX items are genuinely resolved, but the fix for item (1) (a new app-level SELECT-then-INSERT existence check for null-`part_number` rows) introduced a fresh TOCTOU race — the check and the insert are two separate serialized-connection calls, not one atomic statement, so two concurrent requests promoting the identical (category, brand, partNumber=null, photoPath) combo can both pass the check before either inserts, producing two rows. This directly violates the Standing Check requiring concurrent writes against `part_reference_photos` never produce duplicate rows; no existing test (T1's own, sequential-only, or T2's one real concurrency test, which uses a non-null partNumber) can catch it. Fix: make it one atomic statement, e.g. `INSERT ... SELECT ... WHERE NOT EXISTS (...)`, closing the gap the same way the unique index already closes it for the non-null case. | reviewer | T1 | complete | 0 | sonnet | 2026-10-05T20:06:33Z | 2026-10-05T20:53:33Z | 10 | 2026-10-05T20:06:33Z | 20000 | null | no |
| T1-TST | Test T1 (`promoteReferencePhotos`/`findReferencePhotosForLeads`, unique-index dedup on category/brand/part_number/photo_path with NULL-distinctness, lookup priority ordering/cap). PASS: both retry-1 MUST FIX items mutation-proven fixed (reverting either the null-partNumber existence check or the lead-priority CASE ordering kills exactly the test(s) that guard it, nothing else). Added one new test (ZBrand/ABrand, both null partNumber) strengthening Requirement 6 coverage; referencePhotos.test.ts now 15/15. No production code touched. | tester | T1 | complete | 0 | sonnet | 2026-10-05T20:06:33Z | 2026-10-05T20:53:33Z | 15 | 2026-10-05T20:06:33Z | 16600 | null | no |
| T2-REV | Review T2 (`promoteReferencePhotos` hooked into `listings.ts`'s POST/PUT handlers, the photo-upload path, and `teardown.ts`'s additionalParts loop) against Requirements 2/3/4 and the Standing Checks (Info-level duplicate-skip logging, promotion failure never blocking the request, reconciled-Expected-Part branch correctly left unhooked per A5). MUST FIX (cycle 0 retry 1, 2nd pass): both retry-1 MUST FIX items (photo-upload hook, null guard) are genuinely resolved and `tsc --noEmit` is clean, but a fresh look found `apps/server/test/listingPhotos.test.ts:183` (`PHOTO_HOOK_PORT = 34_632`) and `apps/server/test/teardown.test.ts:347` (`HOOK_PORT = 34_632`) hardcode the identical port — independently reproduced deterministically by validation (3/3 runs of just those two files together), causing teardown.test.ts's 3 "Reference photo promotion hook" tests, including the Standing Check's own real-concurrent-write proof, to be skipped on EADDRINUSE whenever both files' hook servers overlap. Fix: give one of them its own distinct port (e.g. 34_633), per the project's existing port-uniqueness-tracking convention. | reviewer | T2 | complete | 0 | sonnet | 2026-10-05T20:06:33Z | 2026-10-05T20:53:33Z | 8 | 2026-10-05T20:06:33Z | 27000 | null | no |
| T2-TST | Test T2 (Requirement 2/3/4 promotion behavior including the photo-upload path, promotion-throws-but-request-succeeds, and the Standing Checks' concurrent-write guarantee for `part_reference_photos` via real concurrent requests against the running server). PASS: photo-upload promotion and the real-concurrency race test both mutation-proven; strengthened the race test with logger-spy assertions after discovering the original version couldn't distinguish `referencePhotos.ts`'s own dedup path from an unrelated outer try/catch safety net. Did not hit the T2-REV-reported port collision in this dispatch's own runs (timing-dependent). Dispatched after T1-TST returned, per this cycle's tester-conflict rule (both touch `referencePhotos.ts` via break-run-restore). | tester | T2 | complete | 0 | sonnet | 2026-10-05T20:06:33Z | 2026-10-05T20:53:33Z | 20 | 2026-10-05T20:06:33Z | 22000 | null | no |
| T3-REV | Review T3 (`seedReferencePhotos.ts` back under the ~200-line cap, stale `SEED_SCRIPT_NOTES.md` removed, real seed files under `data/reference-photos/seed/`, 10 real rows in `part_reference_photos`) against Requirement 1 and the Standing Checks (new-file line count, logging, `DUCKDB_DATA_DIR` override honored). MUST FIX (cycle 0 retry 1, 2nd pass): both retry-1 MUST FIX items (line count, stale notes file) are genuinely resolved, but `seedReferencePhotos.ts` never imports or calls T1's `promoteReferencePhotos`/`findReferencePhotosForLeads` despite the task's own description and Requirement 1 both saying it uses T1's query functions — it issues its own raw `INSERT INTO part_reference_photos`, with its own independently-reimplemented unique-constraint regex, bypassing the one module the Standing Check names as the sole access point and reopening T1's just-fixed null-partNumber dedup bug in this second, unreviewed path (inert today only because all 10 current seed entries have non-null partNumbers; Assumption A6 explicitly allows a brand-only one). Fix: add an exported seed-insert helper to `referencePhotos.ts` (e.g. `insertSeedReferencePhoto`) reusing the same null-safe dedup logic, call it from the script instead of raw SQL. | reviewer | T3 | complete | 0 | sonnet | 2026-10-05T20:06:33Z | 2026-10-05T20:53:33Z | 10 | 2026-10-05T20:06:33Z | 13000 | null | no |
| T3-TST | Test T3 (seed script's dedup-safe insert logic re-run idempotency after the line-count split, `DUCKDB_DATA_DIR` isolation, real files on disk and real rows match). PASS on its own assigned scope (both retry-1 items confirmed resolved; new `seedReferencePhotos.test.ts` added, 2/2, idempotent-re-run mutation-proven via real child-process spawn) but independently reached the same root cause T3-REV found from a testability angle: the script exports nothing and fuses CLI+download+insert logic ending in `process.exit()` (unlike the established `backfill-photos.ts`/`photoBackfill.ts` thin-wrapper-around-exported-function pattern this codebase already uses), making the DUCKDB_DATA_DIR-override half of its own idempotency guarantee unverifiable without a real child-process spawn or touching real seeded data. | tester | T3 | complete | 0 | sonnet | 2026-10-05T20:06:33Z | 2026-10-05T20:53:33Z | 12 | 2026-10-05T20:06:33Z | 27000 | null | no |
| T4-REV | Review T4 (`visualComparisonPrompt.ts`'s `buildVisualComparisonPrompt`, `visualComparisonParser.ts`'s `parseVisualComparisonResponse`, the fixed `PromptModule` import in `visualComparison.test.ts`) against Requirements 8/9 and the Standing Checks, including a real `tsc --noEmit` pass on the test file this time. MUST FIX (cycle 0 retry 1, 2nd pass): the retry-1 MUST FIX item is only partially resolved — the `PromptModule` namespace import was added and 3 of 5 `eligibleParts` declarations in the file were correctly annotated with it, but two earlier ones (lines 87, 97: `const eligibleParts = [];`) were missed and still produce real `TS7034`/`TS7005` implicit-any errors under a `tsc --noEmit` run that includes the test directory — the exact same "real compile error invisible to `vitest run`" failure class the original item was about. Independently reproduced by validation via an overlay tsconfig including `test`. Fix: annotate both as `const eligibleParts: PromptModule.EligiblePart[] = [];`, matching the other 3. | reviewer | T4 | complete | 0 | sonnet | 2026-10-05T20:06:33Z | 2026-10-05T20:53:33Z | 10 | 2026-10-05T20:06:33Z | 15000 | null | no |
| T4-TST | Test T4 (prompt correctly labels each reference photo with its confirmed identity/source, parser's malformed-response coercion/Warn-logging, structural-failure-is-fatal vs single-bad-entry-is-coerced distinction, `omp` runner stubbed not real), confirming the fixed test file both type-checks and runs. PASS: `tsc --noEmit` (scoped to `src`, the project's own normal invocation) clean, 24/24 tests pass, 3 mutations killed (source-label, structural-array-check, brand-coercion). Did not catch T4-REV's lines-87/97 finding, since that only surfaces when `test/` is included in the tsc program (outside this project's own `tsc`/build scope) — not a gap in this tester's own assigned verification. | tester | T4 | complete | 0 | sonnet | 2026-10-05T20:06:33Z | 2026-10-05T20:53:33Z | 15 | 2026-10-05T20:06:33Z | 8700 | null | no |
| T5-REV | Review T5 (`partIdentification.ts`'s extended `identifyListingParts` with the `partIndex` validation fix, eligibility per Requirement 5, lookup/cap/round-robin trim, zero-reference skip, guarded result merge) against Requirements 5-9 and the Standing Checks. The retry-1 MUST FIX item is genuinely resolved in source (`eligiblePartIndices` built from the post-trim `eligibleParts`, not `referencesByPart`'s raw keys). Found one real test-coverage gap (no test distinguished the fix from the pre-fix `referencesByPart.has()` check — reverting to it left all 55 tests green) — independently closed by T5-TST in this same dispatch round with a mutation-proven new test, so no longer outstanding. Also flagged an estimated cyclomatic-complexity figure (~12) for `identifyListingParts`, but this plan names no complexity Standing Check and no complexity tool is configured in this repo — not escalated, a style observation only. | reviewer | T5 | complete | 0 | sonnet | 2026-10-05T20:06:33Z | 2026-10-05T20:53:33Z | 12 | 2026-10-05T20:06:33Z | 24000 | null | no |
| T5-TST | Test T5 (eligibility boundary cases including the previously-untested identityCandidates-only arm, round-robin trim, zero-eligible-reference no-op path, guarded merge-onto-first-pass behavior with the new out-of-range/settled-part-targeted adversarial tests). PASS: added the one genuinely missing regression test (a partIndex eligible overall but trimmed to zero references by round-robin, still a live key in `referencesByPart`, receiving a hallucinated update) and mutation-proved it's non-redundant with the pre-existing out-of-range test (reverting to the pre-fix `referencesByPart.has()` check survives the old test but is killed by the new one). 55/55 pass. | tester | T5 | complete | 0 | sonnet | 2026-10-05T20:06:33Z | 2026-10-05T20:53:33Z | 18 | 2026-10-05T20:06:33Z | 22000 | null | no |
| T6 | Fix T1's cycle-0-retry-1 null-`part_number` dedup race (Requirement 4, the concurrent-write Standing Check): replaced the SELECT-then-INSERT pair in `promoteReferencePhotos`'s null-`partNumber` branch with one atomic `INSERT...SELECT...WHERE NOT EXISTS` statement, using the DuckDB `Count`-column pattern (`listings.ts`'s `markReservedSoldIfOpen`) to decide the Info-level skip log. Added a real concurrent-request test (two overlapping promotions of the same null-partNumber combo) proving exactly one row results; reverting the fix to the old two-statement form reproduces 2 rows and fails the new test. `tsc --noEmit` clean, `referencePhotos.test.ts` 16/16. | builder | | complete | 1 | | 2026-10-05T20:59:05Z | 2026-10-05T21:05:34Z | 10 | 2026-10-05T20:56:42Z | 18900 | null | no |
| T7 | Fix T2's hardcoded port collision: changed `listingPhotos.test.ts`'s `PHOTO_HOOK_PORT` from the colliding `34_632` to a distinct `34_633`; extended `teardown.test.ts`'s port-enumeration header comment to document both ports (teardown's own `HOOK_PORT` left at `34_632`, unchanged, per the task's "change only one" instruction). `tsc --noEmit` clean; `listingPhotos.test.ts` + `teardown.test.ts` run together 3x with zero EADDRINUSE (11 tests each run); grep confirms no other port duplication. | builder | | complete | 1 | | 2026-10-05T20:59:05Z | 2026-10-05T21:05:34Z | 5 | 2026-10-05T21:06:42Z | 10300 | null | no |
| T8 | Fix T3's bypass of T1's query layer: factored `promoteReferencePhotos`'s atomic insert-or-skip logic into an internal `insertReferencePhotoRow` helper in `referencePhotos.ts`, reused by `promoteReferencePhotos` unchanged externally and by a new exported `insertSeedReferencePhoto(category, brand, partNumber, photoPath): Promise<{inserted: boolean}>`; `seedReferencePhotos.ts` now calls it instead of raw SQL (grep confirms only `referencePhotos.ts` issues `INSERT INTO part_reference_photos`). Split the script per the `photoBackfill.ts`/`backfill-photos.ts` convention: `seedReferencePhotos.ts` now exports a side-effect-free `runSeed()`; new thin CLI wrapper `apps/server/src/scripts/seed-reference-photos.ts` mirrors `backfill-photos.ts`. Updated `package.json`'s `seed-reference-photos` script path and the test's child-process spawn target accordingly. `tsc --noEmit` clean; `seedReferencePhotos.test.ts` 2/2, `referencePhotos.test.ts` 16/16. MUST FIX (cycle 1 retry 1), both items now fixed (cycle 1 retry 2): (1) Split `findReferencePhotosForLeads` plus its `Lead` interface out of `referencePhotos.ts` into a new sibling `referencePhotoLookup.ts`, mirroring the T4/A7 split; `db/index.ts`'s barrel export updated so the one external call site (`partIdentification.ts`, via `db/index.js`) needed no change. `referencePhotos.ts` now 135 lines, `referencePhotoLookup.ts` 90 lines, both under the ~200-line cap. (2) The `'Reference Photos — insertSeedReferencePhoto'` test's two inserts changed from the colliding `'Motherboard'` to `'Storage'` (a category genuinely untouched elsewhere in the file, confirmed by grep — `'PSU'`, the task's own illustrative suggestion, was rejected since it's already used by other tests in this same file). `tsc --noEmit` clean; `referencePhotos.test.ts` 17/17 including the previously-broken `'returns empty array for category with no photos'` test, run as the whole file not in isolation. | builder | T6 | complete | 1 | | 2026-10-05T21:41:36Z | 2026-10-05T21:46:05Z | 15 | 2026-10-05T21:11:42Z | 24000 | null | no |
| T9 | Fix T4's remaining 2 missing type annotations: annotated both `apps/server/test/visualComparison.test.ts` lines 87/97 as `const eligibleParts: PromptModule.EligiblePart[] = [];`, matching the other 3 already-correct declarations in the file. Verified clean by temporarily widening `tsconfig.json`'s include to cover `test/` (then reverting it byte-for-byte, confirmed via diff) and re-running `tsc --noEmit`: zero TS7034/TS7005 errors referencing this file (35 unrelated pre-existing errors elsewhere untouched). `vitest run test/visualComparison.test.ts` 24/24. | builder | | complete | 1 | | 2026-10-05T20:59:05Z | 2026-10-05T21:05:34Z | 5 | 2026-10-05T21:26:42Z | 3400 | null | no |
| T6-REV | Review T6 (`promoteReferencePhotos`'s null-`part_number` dedup fix — atomic `INSERT...SELECT...WHERE NOT EXISTS`) against Requirement 4/the concurrent-write Standing Check. PASS, no must_fix. Directly reproduced the old bug: byte-for-byte reverted the branch to the old two-step SELECT-then-INSERT form, re-ran the concurrency test 5/5 times, deterministic failure (2 rows); restored (md5 match) and confirmed the atomic fix holds under a separate 60-iteration standalone `tsx` stress script (0/60 failures). Non-null-partNumber branch, Info-skip logging, return shapes, comments, and `findReferencePhotosForLeads` all confirmed untouched/correct. | reviewer | T6 | complete | 1 | | 2026-10-05T21:10:27Z | 2026-10-05T21:37:16Z | 12 | 2026-10-05T21:10:27Z | 36000 | null | no |
| T6-TST | Test T6 (real concurrent-request proof of the atomic null-partNumber dedup). PASS. `referencePhotos.test.ts`'s own concurrency test (two overlapping `promoteReferencePhotos` calls via `Promise.all`) run and passed (16/16 file total). Mutation-proof: reverted to the old two-step form, re-ran — failed deterministically (`expected 2 to be 1`); restored from backup, byte-identical (md5 match), re-ran — 16/16 pass again. Non-null-partNumber unique-constraint path confirmed still passing unmutated. | tester | T6 | complete | 1 | | 2026-10-05T21:10:27Z | 2026-10-05T21:37:16Z | 15 | 2026-10-05T21:10:27Z | 7600 | null | no |
| T7-REV | Review T7 (port change `listingPhotos.test.ts` 34_632→34_633, `teardown.test.ts` unchanged at 34_632 with documenting comment) against the port-collision must_fix. PASS, no must_fix. Confirmed both files' literal port values and the comment by direct read. Wider sweep: grepped every hardcoded port/`.listen()` call across all of `apps/server/test` (17 distinct ports inventoried) — 34_633 collides with nothing. Noted, not as a must_fix (already triaged pre-existing in A15), that `gracefulShutdown.test.ts`/`identifyPartsRoute.test.ts` still share 34_613 — neither touched by this feature. | reviewer | T7 | complete | 1 | | 2026-10-05T21:10:27Z | 2026-10-05T21:37:16Z | 10 | 2026-10-05T21:10:27Z | 10900 | null | no |
| T7-TST | Test T7 (`listingPhotos.test.ts` + `teardown.test.ts` run together repeatedly; grep-wide port check). PASS. Ran the two files together via real vitest 3x: 11/11 tests pass every run, zero EADDRINUSE. Independently grepped the whole `apps/server/test` port registry and confirmed 34_633 appears exactly once, no collision with 34_632 or any other file's port. | tester | T7 | complete | 1 | | 2026-10-05T21:10:27Z | 2026-10-05T21:37:16Z | 12 | 2026-10-05T21:10:27Z | 8500 | null | no |
| T8-REV | Review T8 (`insertReferencePhotoRow` helper, `insertSeedReferencePhoto` export, `seedReferencePhotos.ts` routed through it, `runSeed()`/CLI-wrapper split, the Standing Check line-count split, and the test-pollution fix) against the T3 bypass must_fix and the DuckDB-access-confinement/~200-line Standing Checks. PASS, no must_fix. Independently re-grepped (not trusting the builder): exactly 2 `INSERT INTO part_reference_photos` sites, both inside `insertReferencePhotoRow`; `referencePhotos.ts`/`referencePhotoLookup.ts` re-counted at 135/90 lines; `seedReferencePhotos.ts`'s `runSeed()` confirmed side-effect-free, `seed-reference-photos.ts` confirmed structurally identical to the `backfill-photos.ts` wrapper pattern by reading both files verbatim. Read the entirety of `referencePhotos.test.ts` by hand: `'Motherboard'` appears exactly once (the emptiness-test's own query, not an insert); the `insertSeedReferencePhoto` concurrent-dedup test now inserts under `'Storage'`. Confirmed `promoteReferencePhotos`/`findReferencePhotosForLeads` signatures/behavior unchanged by the split and every caller's barrel import still resolves (`tsc --noEmit` clean). Own full-suite run (`--pool=forks --poolOptions.forks.maxForks=4`): `apps/server` 29 files/268 tests, all green. | reviewer | T8 | complete | 1 | | 2026-10-05T21:48:40Z | 2026-10-05T22:01:07Z | 15 | 2026-10-05T21:48:40Z | 24000 | null | no |
| T8-TST | Test T8 (grep-confirmed single INSERT site; `insertSeedReferencePhoto` dedup-safety incl. null-partNumber reuse of T6's atomic fix; `runSeed`/CLI idempotent re-run; `DUCKDB_DATA_DIR` isolation; the new `referencePhotoLookup.ts` split still passes everything; the fixed test no longer pollutes shared DB state — confirm by running the full file, not just the new test in isolation). PASS, no must_fix. Two mutation proofs, both run for real: (1) reverted `insertReferencePhotoRow`'s null-partNumber branch to a naive two-step SELECT-then-INSERT — both the `promoteReferencePhotos` and `insertSeedReferencePhoto` concurrent-dedup tests failed deterministically (`expected 2 to be 1`); restored byte-identical (md5 match), 17/17 passed again. (2) Reverted the test-pollution fix itself (`insertSeedReferencePhoto` concurrent test's category back to `'Motherboard'`) — the `'returns empty array for category with no photos'` test then failed deterministically (one leftover row), proving the fix is real, not coincidental; restored byte-identical. `seedReferencePhotos.test.ts` run for real: 2/2 pass, including idempotent-re-run (spawns the actual CLI entry point twice) and `DUCKDB_DATA_DIR` isolation (confirmed the real shared `.duckdb` file's mtime untouched by any test run). Full `referencePhotos.test.ts` + `seedReferencePhotos.test.ts` together: 19/19 pass post-restore. | tester | T8 | complete | 1 | | 2026-10-05T21:48:40Z | 2026-10-05T22:01:07Z | 18 | 2026-10-05T21:48:40Z | null | null | no |
| T9-REV | Review T9 (both missing `PromptModule.EligiblePart[]` annotations added at `visualComparison.test.ts` lines 87/97). PASS, no must_fix. Re-found all 9 `eligibleParts` declarations in the file by direct grep (not trusting the row's line numbers) — every one consistently annotated. Verified via a widened-include `tsc --noEmit`: zero TS7034/TS7005 anywhere, 41 unrelated pre-existing errors elsewhere untouched. Mutation-proof: reverted line 87's annotation, re-ran — TS7034/TS7005 reappeared exactly as the original bug described; restored, re-ran `vitest` — 24/24. `tsconfig.json` restored byte-identical (`git status` clean). | reviewer | T9 | complete | 1 | | 2026-10-05T21:10:27Z | 2026-10-05T21:37:16Z | 8 | 2026-10-05T21:10:27Z | 10200 | null | no |
| T9-TST | Test T9 (widened `tsc --noEmit` shows zero TS7034/TS7005 for this file; full `vitest` pass). PASS. Noted the plan's literal "widen tsconfig.json's own include" instruction doesn't actually work as stated (the existing `rootDir: "./src"` produces unrelated TS6059 noise for every test file) — used a one-off `tsconfig.testcheck.json` instead (the stated alternative), confirmed zero errors referencing `visualComparison.test.ts`, 35 unrelated pre-existing errors elsewhere (matches the builder's own claim exactly). Mutation-proof: reverted line 87, reproduced TS7034(87,11)/TS7005(89,62) exactly; restored byte-identical. `vitest run test/visualComparison.test.ts`: real output 24/24 pass. | tester | T9 | complete | 1 | | 2026-10-05T21:10:27Z | 2026-10-05T21:37:16Z | 10 | 2026-10-05T21:10:27Z | 7300 | null | no |
| T10 | Fix the UAT-found reference-photo path resolution bug (Requirement 8-9, the actual point of this feature): `apps/server/src/ai/partIdentification.ts`'s second pass builds `referencePhotoPaths` via `resolvePhotoPaths([ref.photoPath])[0]`, which strips to basename and resolves under `PHOTOS_DIR` (`data/photos/`) — correct only for a listing's own `photos/<file>` paths. Every seed-sourced reference photo (`reference-photos/seed/<file>`) resolves to a nonexistent path, making the real `omp` CLI exit 1 ("File not found") and the whole `identify-parts` request 502 whenever a real second pass selects one — reproduced live by UAT against the real seeded Wikimedia photos, and independently reproduced by hand against the exact misresolved path. Fix: export `DATA_DIR` from `apps/server/src/photos/photoStorage.ts` (currently module-private) and resolve each reference photo's path as `path.join(DATA_DIR, ref.photoPath)` — the photo's full stored relative path, not just its basename — since a reference photo's `photo_path` is already relative to `DATA_DIR` by construction (both the `photos/<file>` and `reference-photos/seed/<file>` conventions assume this), unlike a listing's own photos which `resolvePhotoPaths` deliberately normalizes to a flat `PHOTOS_DIR` layout. Add a real-filesystem regression test (attach an actual seed-sourced reference photo file and assert the resolved absolute path exists on disk via `fs.existsSync` or equivalent) — the existing suite only ever stubs the `omp` runner and checks what path *string* gets passed to it, never that the string resolves to a real file, which is exactly how this bug went undetected through two full validation cycles. | builder | | complete | 2 | | 2026-10-05T23:02:41Z | 2026-10-05T23:08:20Z | 15 | 2026-10-05T23:01:10Z | 10400 | null | no |
| T10-REV | Review T10 (`DATA_DIR` export from `photoStorage.ts`, `partIdentification.ts`'s reference-photo resolution now `path.join(DATA_DIR, ref.photoPath)` instead of `resolvePhotoPaths`, the new real-filesystem regression test) against Requirements 8-9, the UAT cycle-1 must_fix, and the Standing Checks. PASS, no must_fix routed (one complexity finding triaged below, not blocking). Independently mutation-proved beyond build-lead's own A20 report: reverted the fix, re-ran the regression test — failed at the exact `existsSync` assertion for the right reason; also resolved a real `source='seed'` row (`reference-photos/seed/amd-rx6800xt-reference.jpg`) both ways directly against this worktree's real `data/pc-parts-flipper.duckdb` — fixed logic resolves to the real file (`existsSync` true), reverted logic resolves to the nonexistent `data/photos/amd-rx6800xt-reference.jpg` (`existsSync` false), reproducing UAT's exact 'File not found' failure mode; restored byte-identical (diff/md5 match), regression test green again. Confirmed the listing's-own-photos path (`resolvePhotoPaths`, first pass) is untouched and still correct; grepped the rest of `apps/server/src` for any sibling instance of the basename-strip bug — none found. Flagged (not must_fix — a maintainability/style measure, not a correctness or safety defect with a concrete failure case, so it doesn't meet this role's must_fix bar) that `identifyListingParts`'s real ESLint-measured cyclomatic complexity is 12, pre-existing from this feature's T5 orchestration logic, not introduced by T10's 2-line resolution-path patch — left for feature-build-lead's own discretion, not reopening T10. Also flagged two untracked scratch artifacts as non-blocking cleanup: a `_t10-mutation-check.ts` probe script (self-deleted by T10-TST's own cleanup before this digest was written — confirmed gone) and an empty leftover `data-MUTATION-PROOF-IGNORE-OVERRIDE/` directory at the worktree root from an earlier mutation-proof run, still present, harmless but should be deleted. | reviewer | T10 | complete | 2 | | 2026-10-05T23:11:59Z | 2026-10-05T23:26:12Z | 15 | 2026-10-05T23:11:59Z | 9500 | null | no |
| T10-TST | Test T10 (real-filesystem mutation-proof against real, already-seeded Wikimedia reference photos on disk, not just the builder's synthetic test fixture). PASS, no must_fix. `vitest run test/partIdentification.test.ts`: 56/56 before and after the mutation round-trip. Independently mutation-proved against this worktree's real `data/pc-parts-flipper.duckdb` and real `data/reference-photos/seed/*.jpg` files via a one-off script driving the real, live production `identifyListingParts`/`DATA_DIR` (only the `omp` runner stubbed): fixed code resolves a real `source='seed'` row (AMD RX 6800 XT) to a real existing file (`existsSync` true); reverted via a read/replace/test/restore mutation runner, the same real row resolved to the nonexistent `data/photos/amd-rx6800xt-reference.jpg` (`existsSync` false, exact original UAT failure reproduced against real data); restored byte-identical, re-confirmed both the real-data check and the full 56-test suite green again. Own scratch scripts (`_t10-mutation-check.ts`, `_t10-probe.ts`, a `/tmp` probe file) deleted after use — `git status` clean. | tester | T10 | complete | 2 | | 2026-10-05T23:11:59Z | 2026-10-05T23:26:12Z | 15 | 2026-10-05T23:11:59Z | 11200 | null | no |
| U2 | UAT (cycle 2): PASS. Re-ran the exact scenario that 502'd in U1 — `POST /api/listings/:id/identify-parts` with the real, unstubbed `omp` CLI against the existing ambiguous/unbranded GPU listing (zero listing photos, same listing/scenario U1 used) with real seed GPU reference photos available — twice: both calls returned HTTP 200 (first pass photoCount=0/partCount=1, eligibleCount=1, server logged "Starting AI visual comparison pass", then "AI visual comparison complete" with updatedCount=0; no 502 either time). Additionally ran a second real scenario (a new listing with a real seed-sourced GPU photo uploaded as its own listing photo) twice: both times the second pass genuinely filled in brand/partNumber from a confident reference match (`Gigabyte`/`GeForce RTX 3090 EAGLE OC`, updatedCount=1 both runs) — real Requirement 9(a) behavior, not just "didn't crash". Re-confirmed Requirements 1-7 live: seed library intact (10 `source='seed'` rows unchanged); Req 2/4 re-exercised fresh via a PUT giving an Expected Part a non-null brand then an identical re-save, producing exactly one new row plus an Info-level "Skipped reference photo already in database" dedup log on the re-save and zero duplicate rows afterward; Req 3's promotion hook grep-confirmed unchanged and untouched by T10; Req 7 re-confirmed live on the unbranded RAM listing (zero references in category, Info skip log, no second `omp` call, fast response). Cited feature-validate-lead's standing gate (384/384 tests, ESLint clean, 384 >= BaselineTests 313) rather than re-running the whole suite. Cleanup: server stopped, the one `data/photos/` file this pass created removed, `git status` clean (identical to pre-dispatch). See Cycle 2's Cycle Log for the full checks list. Feature closes out: every Requirement and Standing Check has a check against it. | uat | T1, T2, T3, T4, T5, T6, T7, T8, T9, T10 | complete | 2 | sonnet | 2026-10-05T23:27:46Z | 2026-10-05T23:55:00Z | 20 | 2026-10-05T23:27:46Z | 46600 | null | no |
| U1 | UAT (cycle 1): FAIL. Exercised the full feature end to end via real HTTP calls against a really-running apps/server (Node 22, no stubs) in this worktree, including the real, unstubbed `omp` CLI against the real seeded Wikimedia reference photos. Requirements 1-7 all confirmed live and working (seed library present, Expected-Part and Additional-Part promotion both fire and dedup correctly on re-save, the no-eligible-reference skip is real and logged at Info with no second omp call). But Requirement 8/9's actual point — a second pass that genuinely compares listing photos against reference photos — never completes against real seed data: every real second-pass call that selects a seed-sourced reference photo 502s, because `partIdentification.ts` resolves reference photo paths with `resolvePhotoPaths` (basename + PHOTOS_DIR), which is correct for a listing's own `photos/<file>` paths but wrong for a seed-sourced `reference-photos/seed/<file>` one — reproduced live (server log: 'Starting AI visual comparison pass' immediately followed by a real 502, `omp` exiting 1 on 'File not found'; independently reproduced the identical failure invoking `omp` directly against the same misresolved path). 1 must_fix routed back to feature-build-lead. See Cycle 1's Cycle Log for the full checks list. | uat | T1, T2, T3, T4, T5, T6, T7, T8, T9 | complete | 1 | sonnet | 2026-10-05T22:02:30Z | 2026-10-05T23:10:00Z | 30 | 2026-10-05T22:02:30Z | 52000 | null | no |

## Assumptions
- A1 (cycle 0): `MAX_REFERENCE_PHOTOS_PER_PART = 3` and `MAX_TOTAL_REFERENCE_PHOTOS_PER_CALL = 12` —
  engineering judgment balancing genuine visual signal against the second pass's added latency
  (attaching N more images to an already-observed ~9s/photo `omp` call); named constants, easy to
  retune later, not scattered magic numbers. Builders should adjust the two constants' *values* if
  real observed call timing during T5's build makes them clearly too slow or too thin, but should not
  change the round-robin/priority *mechanism* without flagging it back.
- A2 (cycle 0): Seed reference photos (T3) are fetched once to local disk under `data/` and never
  committed to the repository — consistent with how the user already treats their own real listing
  photos and database as local-only, copied manually between checkouts rather than tracked in git.
  This also means, same as the user's real production data, a fresh worktree or checkout starts with
  an empty reference-photo library until T3's seed script is run or the data is copied in manually.
- A3 (cycle 0): No new web UI is built. The existing identity/candidate display surfaces (Expected
  Parts editor, Purchase detail, Teardown checklist, Parts table, Record Sale heading) already render
  whatever `brand`/`partNumber`/`identityCandidates` a part carries, unchanged by this feature's
  `AiIdentifiedPart`/`ExpectedPart`/`Part` shapes — this feature only changes how those same three
  fields get *filled in*, not their shape or where they're shown. Nothing distinguishes, anywhere in
  the UI, an identification the second pass visually confirmed from one the first pass already
  settled from text alone; the existing `source: 'image'`/`'both'` value already communicates "based
  on a photo" and is not extended with a separate "visually compared against a reference" value, since
  the user's request was about the identification itself improving, not about labeling how it did.
- A4 (cycle 0): A reference photo promoted from a Listing/Additional Part later found to be
  mis-identified is never auto-corrected or removed — there is no mechanism that revisits an
  already-promoted reference when a user later fixes a wrong brand/model elsewhere. A few occasionally
  stale or misleading reference photos are an accepted tradeoff of fully automatic, zero-friction
  promotion (the chosen answer over a manual "flag as reference" step).
- A5 (cycle 0): Only genuinely new human confirmations promote a reference photo: an Expected Part
  being saved (Requirement 2) and an Additional Part being recorded at teardown (Requirement 3). A
  Part created at teardown by reconciling an existing Expected Part inherits that Expected Part's
  already-known brand/partNumber and is **not** separately promoted — its identity was already
  promoted once, when the Expected Part itself was saved; re-promoting the same photos under the same
  label a second time would only produce dedup-skipped no-op inserts.
- A6 (cycle 0): A reference photo needs at least a non-null `brand` to be promoted — `partNumber` may
  stay null (a brand-only reference is still useful for narrowing a part to that brand's visual
  design language even without pinning the exact model).
- A7 (cycle 0, build): `parseVisualComparisonResponse` was placed in a new sibling file
  `apps/server/src/ai/visualComparisonParser.ts` rather than folded directly into
  `identificationParser.ts` as T4's literal task text described — the Standing Checks explicitly name
  `identificationParser.ts` as one of three pre-existing files whose additions "must stay minimal,"
  and the full parser (77 lines) would have pushed it to 275 lines. The split still satisfies T4's
  actual intent (reuse `coerceIdentityField`/`coerceIdentityCandidates`, now exported) without
  breaching the line-count check; `coerceIdentityField`/`coerceIdentityCandidates` stayed exported
  from `identificationParser.ts` itself, which is now 199 lines (was 198 before this feature).
- A8 (cycle 0, build): T3 (seed data) is reported `blocked`, not `complete` — the seeding script
  (`apps/server/src/db/seedReferencePhotos.ts`), its 10-product GPU/Case/Cooler metadata list, and its
  dedup-safe insert logic are fully implemented and ready to run, but this build environment has no
  outbound network access, so the actual image downloads (and therefore `data/reference-photos/seed/`
  actually containing files, and the database actually holding seeded rows) could not be verified or
  completed here. Running `tsx src/db/seedReferencePhotos.ts` on a machine with real network access is
  the one remaining step to finish Requirement 1; nothing else in this feature depends on T3 having
  already run (Requirement 7 already makes "no eligible reference available" a normal, logged, no-op
  path for exactly this reason).
- A9 (cycle 0, build): This sandboxed build environment runs on Node 12, below the repo's declared
  `engines.node >=22`; all typecheck/lint/test verification for this cycle was run instead against a
  Node 22.23.3 binary available via `nvm` on the host. Several integration test files that boot a real
  HTTP server (`identifyPartsRoute.test.ts`, `gracefulShutdown.test.ts`, `purchases.test.ts`,
  `listings.test.ts`) flaked intermittently (`EADDRINUSE`, a `beforeAll` hook timeout, or a closed
  socket) only when run as part of one large concurrent `vitest` invocation under this sandbox's
  resource pressure; every one of them was re-run in isolation and passed cleanly, confirming the
  flakes are sandbox contention, not a regression from this feature's changes.
- A10 (cycle 0, orchestrator): T3 was re-opened and completed directly after build-lead's digest
  (not re-dispatched to a new builder sub-agent) because the one thing blocking it — outbound network
  access — was a property of that sub-agent's sandbox, not of this orchestrating session, which does
  have real network access. Before trusting the sub-agent's seed list, every one of its 10 URLs was
  checked directly (`curl`) and found to 404 — all fabricated. They were replaced with 10 photos
  sourced from Wikimedia Commons and individually verified (a real downloaded, decoded JPEG, not just
  an HTTP 200) before being wired into the script; Commons was chosen deliberately over a
  manufacturer/retailer CDN for this re-sourcing, since its content is explicitly freely licensed for
  this kind of reuse, which a manufacturer's own asset CDN is not. Two real bugs the sub-agent's
  version of the script had were fixed while actually running it: a missing `User-Agent` header
  (Wikimedia 403s requests without one) and `SEED_DIR` not honoring the `DUCKDB_DATA_DIR` override
  every sibling data-path constant in this codebase already does.
- A11 (cycle 0, validation): `measure-child-cost.py child-cost --tag "..."` was attempted for every one of
  the 10 reviewer/tester dispatches this cycle, per this role's own instructions. It is structurally
  incapable of working on this host: the script's own `_find_omp_transcript_by_tag` (confirmed by reading
  its source) only matches the literal substring `AGENT_TAG: <tag>` inside a child's transcript — a string
  OMP itself would have to embed, and this host's actual `task` dispatch tool has no field that does so (no
  `description` parameter, nothing equivalent). A probe against an unrelated tag ("review T1", chosen to
  resemble a real one) returned a real-looking number (177712) anyway, which traced back to a false match
  against *some other* transcript elsewhere under `~/.omp/agent/sessions/` that happens to contain that
  substring — not this cycle's own T1-REV dispatch — the exact false-positive failure mode ebay-scanning's
  A19 already documented on this same host. Every row above correctly carries `actual_tokens: null`, never
  a guessed or borrowed number; `estimated_tokens` is each sub-agent's own self-report, advisory only.
- A12 (cycle 0, validation): The Standing Checks' full-suite run surfaced `apps/server` test-file failures
  (`EADDRINUSE`, a `beforeAll` hook timeout, `ECONNREFUSED`, a closed socket) in `purchases.test.ts`,
  `saleListings.test.ts`, `listingPhotos.test.ts`, and one `gracefulShutdown.test.ts` scenario — the same
  category A9 already named from the sandboxed build environment, now reproduced independently on this
  validation host too. Re-running each of those 4 files fully isolated (separate `vitest` process per file)
  passed every one cleanly (purchases 5/5, saleListings 9/9); a further full-`apps/server`-suite re-run with
  `--pool=forks --poolOptions.forks.maxForks=4` (reduced from default, unbounded parallelism) also passed
  all 4 of those files with zero infra errors, leaving only the 2 real T1 bugs failing — confirming this
  category is genuine concurrent-worker resource contention on this host, not a regression, across two
  independent environments now (A9's sandbox and this one).
- A13 (cycle 0 retry 1, build-lead): T2's own builder's fix (hooking `promoteReferencesForExpectedParts`
  into the photo-upload route) left `const updated = await updateListing(...)` in
  `apps/server/src/routes/listingPhotos.ts` unguarded against `null` before passing `updated.photoPaths`
  to the promotion call — a real `tsc --noEmit` type error (`'updated' is possibly 'null'`), caught during
  build-lead's own post-dispatch integration check (not by T2's own builder, who ran `tsc` before adding
  this exact line). Fixed directly by build-lead with the same `if (!updated) throw new AppError(...)`
  guard the PUT handler in `listings.ts` already uses for the identical `updateListing` call, matching
  established pattern. Re-verified: `tsc --noEmit` clean, `listingPhotos.test.ts`/`referencePhotos.test.ts`/
  `visualComparison.test.ts` all pass (41 tests total).
- A14 (cycle 0 retry 1, build-lead): T5's own builder's partIndex-validation fix filtered
  `comparisonUpdates` against `referencesByPart.has(update.partIndex)` — but `referencesByPart` can still
  hold a key whose array was trimmed to zero length by `trimReferencePhotosRoundRobin` (when eligible-part
  count exceeds `MAX_TOTAL_REFERENCE_PHOTOS_PER_CALL`), even though that index is then excluded from the
  `eligibleParts` array actually sent to the model in the prompt. Tightened by build-lead to validate
  against a `Set` built from `eligibleParts.map(p => p.partIndex)` instead — the literal post-trim set
  "actually sent to the second pass," matching the MUST FIX item's own wording exactly. Re-verified: `tsc
  --noEmit` clean, `partIdentification.test.ts` 54/54 pass (unchanged by the tightening — no existing test
  exercised a part trimmed to zero references receiving a hallucinated update, so none regressed).
- A15 (cycle 0 retry 1, validation): The second validation pass's standing-gate full-suite run hit two
  EADDRINUSE-shaped failures of visibly different character, distinguished by direct re-reproduction
  rather than both being waved through as A9/A12-style contention: (1) `test/parts.test.ts`'s `beforeAll`
  hook timed out once (port 34_592, no duplicate anywhere in the suite) in a full-suite run, then passed
  9/9 cleanly in isolation on retry — a genuine instance of A9/A12's documented generic resource-pressure
  category, not a new defect. A second full-suite run (no production code changed in between) instead saw
  `test/gracefulShutdown.test.ts` fail to bind port 34_613 — which `test/identifyPartsRoute.test.ts` also
  hardcodes — but running just those two files together 3 times reproduced zero collisions, confirming
  this pairing only clashes under heavier full-suite scheduling pressure, the same timing-dependent
  category, and neither file was touched by this feature. (2) By contrast, `test/listingPhotos.test.ts`
  (`PHOTO_HOOK_PORT = 34_632`) and `test/teardown.test.ts` (`HOOK_PORT = 34_632`) — both new T2
  deliverables this cycle — reproduced the identical EADDRINUSE 3/3 times when run together alone with no
  other files competing for scheduling at all, proving the root cause is the literal duplicate constant
  itself, not contention; this is reported as a genuine T2 must_fix (see T2-REV's row), not folded into
  the inherited-flake category the way (1) was. Authoritative test count for this pass: `apps/server` 266
  tests across 29 files (`test/seedReferencePhotos.test.ts` is new, from T3-TST), `apps/web` 110/110 (17
  files), `packages/shared` 5/5 (1 file) — 381 total vs. `BaselineTests` 313: coverage rose, no shrinkage.
  `measure-child-cost.py` was not attempted this pass — A11 already established it is structurally
  incapable of keying on this host's dispatch tool, so every row's `actual_tokens` is `null` again,
  per that same precedent, not a fresh guess.
- A16 (cycle 1, build-lead): `measure-child-cost.py child-cost --tag "build <task id>"` was attempted for
  each of T6/T7/T8/T9 despite A11's prior finding, since each dispatch's task text this time did embed a
  literal `AGENT_TAG: build <task id>` line (the mechanism A11 found missing). It still produced the exact
  false-positive pattern A11/A19 document: T6, T7, and T9 — three different tags, three children of visibly
  different real duration (2m1s/4m22s/1m52s) and different `estimated_tokens` self-reports — all returned
  the identical number (79629), and T8's distinct tag returned a different-but-still-unverifiable number
  (92157). Identical output across genuinely different children proves the script is matching some shared
  transcript (most likely this build-lead's own session, which contains every one of these `AGENT_TAG` lines
  in its own dispatch calls) rather than each child's isolated one. All four rows above correctly carry
  `actual_tokens: null`, per A11/A15's same precedent, not either of these untrustworthy numbers.
- A17 (cycle 1, validation): `feature-pm` is not an agent this session's dispatch tool can spawn at
  all (its available-agent list names only `feature-reviewer-{small,medium,large,xlarge}` and
  `feature-tester-{small,medium,large,xlarge}` — no `feature-pm`), and
  `skills/feature/bin/measure-child-cost.py` does not exist anywhere relative to this worktree (a
  background `find` across the whole `/mnt/d/repositories` tree located only an unrelated
  `feature-pm.md` *agent definition* file in a different, sibling repo — not a script, and not in this
  repo at all). Both are structurally unavailable on this host for this repo, the same category A11/A16
  already document for `measure-child-cost.py`'s tag-matching mechanism. Dashboard refresh was skipped
  and every new row's `actual_tokens` is `null`, per that same precedent, not a guess or a borrowed
  number.
- A18 (cycle 1 retry 2, build-lead): T8's cycle-1-retry-1 review found 2 must_fix items (the
  `referencePhotos.ts` line-count split and the `'Motherboard'` test-pollution collision); both are
  now genuinely resolved (verified directly by build-lead, not just taken on the builder's word):
  `referencePhotos.ts`/`referencePhotoLookup.ts` re-counted at 135/90 lines, `tsc --noEmit` re-run
  clean, and `referencePhotos.test.ts` re-run as the whole file (not just the changed test) at 17/17,
  including the previously-broken `'returns empty array for category with no photos'` test now passing
  alongside the relocated `'Storage'`-category insert. `measure-child-cost.py child-cost --tag "build
  T8"` was attempted once more for this dispatch despite A17's prior finding that the script doesn't
  exist in this repo at all — re-confirmed absent (`ls skills/feature/bin/measure-child-cost.py` →
  No such file or directory), so T8's `actual_tokens` is `null` per that same precedent, not a guess;
  `estimated_tokens` (24000) is the builder's own self-report, advisory only.
- A19 (cycle 1, validation): T8's reviewer/tester dispatch reconfirmed `skills/feature/bin/measure-child-cost.py`
  does not exist anywhere in this repo (`ls` → No such file or directory) and this session's dispatch tool's
  available-agent list still names only `feature-reviewer-{small,medium,large,xlarge}`/
  `feature-tester-{small,medium,large,xlarge}` — no `feature-pm` — the same unavailability A17 already
  documented. T8-REV's and T8-TST's `actual_tokens` are both `null` per that same precedent (T8-REV's
  `estimated_tokens` 24000 and T8-TST's `estimated_tokens` are each self-reported, advisory only); no
  dashboard refresh was attempted. Standing gate (full suite + lint), re-run one more time this pass since
  T8 touched shared query/seed files: `npm run lint` (Node 22) produced zero output — clean, zero violations.
  `npm run test` (Node 22, normal unbounded-parallelism invocation, no isolation flags): `apps/server` 29
  files/268 tests, `apps/web` 17 files/110 tests, `packages/shared` 1 file/5 tests — 383 total, all green,
  zero failures and zero EADDRINUSE/contention flakes this run (unlike A9/A12/A15's prior runs — the
  previously-flaky `gracefulShutdown.test.ts`, `listings.test.ts`, `scan.test.ts`, `pagination.test.ts` all
  passed cleanly in the same single invocation this time). 383 vs `BaselineTests` 313: coverage rose, no
  shrinkage.
- A20 (cycle 2, build-lead): T10's own builder's mutation-proof (revert-the-fix, confirm the new test
  fails, restore) only exercised a synthetic file written by the test itself under an isolated
  DUCKDB_DATA_DIR override — not one of the real, already-seeded Wikimedia reference photos UAT's
  cycle-1 failure actually reproduced against. Since this exact bug (a plausible-looking fix that
  still mis-resolves against real seed data) already slipped through two full validation cycles
  undetected by the stubbed-omp test suite, build-lead independently re-verified beyond the builder's
  own test: read the real `photo_path` value (`reference-photos/seed/nzxt-h500i.jpg`) directly off a
  real `source='seed'` row in this worktree's actual `data/pc-parts-flipper.duckdb` via the `duckdb`
  CLI, confirmed the corresponding file is really present on disk at
  `data/reference-photos/seed/nzxt-h500i.jpg`, then ran the fixed production resolution logic itself
  (`path.join(DATA_DIR, photoPath)`, imported live from the real `photoStorage.ts`/`DATA_DIR`, not a
  reimplementation) against that real `photo_path` via a one-off `tsx` script: `fs.existsSync` on the
  fixed-logic result is `true` (the real file), while the same script's old
  `resolvePhotoPaths`-based logic resolves to `data/photos/nzxt-h500i.jpg`, which `fs.existsSync`
  confirms does **not** exist — reproducing UAT's exact cycle-1 failure mode one more time to prove
  the fix, not just the new test, actually closes it. Also independently re-ran `tsc --noEmit` (clean)
  and `vitest run test/partIdentification.test.ts` (56/56) from a fresh shell, not taking the
  builder's self-report on trust. `skills/feature/bin/measure-child-cost.py` re-confirmed absent in
  this repo (`ls` → No such file or directory), per A17/A19's same precedent — T10's `actual_tokens`
  is `null`, not a guess; `estimated_tokens` (10400) is the builder's own self-report, advisory only.
- A21 (cycle 2, validation): T10-REV/T10-TST dispatched for the sole cycle-2 task — no tester conflict
  (only one task this cycle). Both independently mutation-proved the fix against real, already-seeded
  data (not just the builder's own synthetic fixture or build-lead's A20 report), in both directions
  (revert reproduces UAT's exact failure; restore closes it again); see T10-REV/T10-TST rows. No
  must_fix. Standing gate re-run in full: `npm run lint` (Node 22.23.3) — zero output, clean. `npm run
  test` (Node 22.23.3, normal unbounded-parallelism full-suite invocation): `apps/server` showed one
  file (`test/profit.test.ts`) fail with a `beforeAll` hook timeout booting its own real HTTP server
  (29 files, 266 passed/3 skipped = 269) — the same A9/A12/A15-documented resource-contention category;
  re-run in isolation: the first isolated attempt transiently hit a just-released-socket `fetch failed`
  (the previous full-suite run's own server on the same port still releasing it), a second isolated
  attempt moments later passed cleanly 3/3 with zero code changes in between — confirming contention,
  not a regression (no file this cycle touches `profit.test.ts` or its route). Authoritative count:
  `apps/server` 269 tests/29 files, `apps/web` 110/110 tests/17 files, `packages/shared` 5/5 tests/1
  file — 384 total vs. `BaselineTests` 313: coverage rose, no shrinkage (+1 over cycle-1's A19 count of
  383, exactly T10's one new regression test). `skills/feature/bin/measure-child-cost.py` reconfirmed
  absent anywhere in this repo (`ls`/`find` → not found), per A11/A17/A19's same precedent —
  T10-REV/T10-TST's `actual_tokens` are both `null`, not a guess; `estimated_tokens` (9500/11200) are
  each sub-agent's own self-report, advisory only. `feature-pm` dashboard refresh skipped, same
  unavailability precedent as A17/A19.





## Cycle Log
### Cycle 0
Trigger: initial

Validation (cycle 0, initial): feature-reviewer-medium/feature-tester-medium dispatched in parallel for
T1-T5 (no conflicts found between testers — each owns a disjoint set of files). 3 of 5 tasks FAIL review:
T1 (Requirement 4 dedup broken for any null-partNumber reference — DuckDB's NULL-distinctness defeats the
unique index; Requirement 6 lookup ignores lead-preference order, sorts alphabetically by brand instead —
both independently reproduced by T1-TST as real failing tests, not just reasoned about), T2 (Requirement 2
is dead code on `POST /api/listings` — the creation handler always sends `photoPaths: []` since this API
has no way to attach photos at creation time, so a brand-new Listing's first photos never promote; 4
vacuous route-level tests that could not have caught this were replaced by T2-TST), T3 (new file is 288
lines, over the ~200-line Standing Check with no stated exception; `SEED_SCRIPT_NOTES.md` documents a
stale pre-A10 version of the script), T4 (`visualComparison.test.ts` references an unimported `PromptModule`
type, a real `tsc --noEmit` compile error vitest's own run doesn't surface), T5 (the second-pass merge loop
applies any `partIndex` the model returns with no validation that it was ever sent for comparison — a
hallucinated/out-of-range `partIndex` can mutate a fully-settled part or crash the request, the one thing
Requirement 5 explicitly promises never happens; one eligibility arm also untested in isolation). Every
tester mutation-proved its own new/strengthened tests; none of the five testers, working from well-behaved
fixtures, independently surfaced its sibling reviewer's bug — each pairing's reviewer and tester findings
are complementary, not redundant.

Standing gate: ESLint clean, zero violations (`npm run lint`, Node 22.23.3). Full suite initially run via
`npm run test` showed `apps/server` 4 files failing — `purchases.test.ts`, `saleListings.test.ts`,
`listingPhotos.test.ts`, and one `gracefulShutdown.test.ts` scenario — all `EADDRINUSE`/hook-timeout/
`ECONNREFUSED`/closed-socket shaped, the same category A9 already named from the sandboxed build
environment. Re-running each of those 4 files fully isolated passed every one cleanly; a reduced-concurrency
full-`apps/server` re-run (`--pool=forks --poolOptions.forks.maxForks=4`) also passed all 4 with zero infra
errors, leaving exactly 2 real failures — both T1's bugs, independently reproduced (`referencePhotos.test.ts`
Requirement-4 and Requirement-6 cases). Authoritative count: `apps/server` 258 tests (256 pass / 2 fail,
28 files), `apps/web` 110/110 pass (17 files), `packages/shared` 5/5 pass (1 file) — 373 total vs.
`BaselineTests` 313: coverage rose, no shrinkage. See Assumption A12 for the full isolation proof and A11
for why every row's `actual_tokens` is `null` (this host's dispatch tool carries no tag `measure-child-cost.py`
can key on; a probe returned a number that traced to an unrelated transcript, not this cycle's own children).

Verdict: FAIL. 5 must_fix items (T1 x2, T2 x1, T3 x2, T4 x1, T5 x1) plus the standing gate's 2 new
(non-inherited — `BaselineSuite` was `pass`) test failures, routed back to feature-build-lead.

Retries: T1, T2, T3, T4, T5 retried in place (cycle 0 retry 1) — each must_fix item traces back to
exactly one task's own files (T1's two bugs both in `referencePhotos.ts`; T2's in `listings.ts`'s
POST handler/the photo-upload route; T3's two in `seedReferencePhotos.ts`/`SEED_SCRIPT_NOTES.md`; T4's
in `visualComparison.test.ts`; T5's in `partIdentification.ts`'s merge loop), and this is each task's
first failure this cycle, so none of the five opens a new cycle — all five retry in place together,
the same multi-task-single-cycle-retry pattern `ai-identification-ranges` used for its own T1/T2/T3/T5.

Validation (cycle 0 retry 1): feature-reviewer-medium/feature-tester-medium re-dispatched for T1-T5 to
confirm each retry-1 MUST FIX item and fresh-check Requirements/Standing Checks. Tester-conflict check
(per this role's own rule): T1-TST and T2-TST both need break-run-restore access to `referencePhotos.ts`,
so T2-TST was deferred until T1-TST returned; T3-TST/T4-TST/T5-TST are disjoint and ran alongside all 5
reviewers (reviewers never conflict) in the first batch. All 10 retry-1 MUST FIX items are genuinely
resolved — none reopened as-is — but a fresh look surfaced 4 new must_fix items across 4 of the 5 tasks:
T1 (the null-partNumber dedup fix is a non-atomic check-then-insert, a TOCTOU race under real concurrency
that can still duplicate a brand-only reference row — the Standing Check's own concurrent-write guarantee,
just for the null-partNumber case the retry-1 fix itself introduced), T2 (`listingPhotos.test.ts` and
`teardown.test.ts` hardcode the identical port 34_632 for their own hook-server describe blocks — a
genuine, deterministically-reproduced collision, not contention; see A15), T3 (`seedReferencePhotos.ts`
bypasses T1's query module entirely with its own raw INSERT, reopening T1's just-fixed null-partNumber
dedup bug in a second, unreviewed path — T3-REV and T3-TST reached this independently, from review and
testability angles respectively), T4 (two of five `eligibleParts` declarations in
`visualComparison.test.ts` were missed when the retry-1 fix annotated the other three, still producing
the same class of invisible-to-vitest compile error the original item was about). T5 had one fresh
finding (a test-coverage gap distinguishing the retry-1 fix from its pre-fix behavior) but T5-TST closed
it within this same dispatch round with a mutation-proven test, so T5 carries no outstanding must_fix.

Standing gate: ESLint clean, zero violations (`npm run lint`, Node 22.23.3). Full suite (`npm run test`)
run twice; see A15 for the full breakdown distinguishing genuine A9/A12-category contention (`parts.test.ts`,
`gracefulShutdown.test.ts`/`identifyPartsRoute.test.ts`'s own shared port 34_613 — both pre-existing files
this feature never touched, confirmed to pass in isolation/reduced pairing) from T2's genuine, 3/3
deterministically-reproduced port-34632 collision, reported as a must_fix rather than waved through as
contention. Authoritative count: 381 total vs. `BaselineTests` 313 — coverage rose, no shrinkage.

Verdict: FAIL. 4 must_fix items (T1 x1, T2 x1, T3 x1, T4 x1) routed back to feature-build-lead; T5 clean.

### Cycle 1
Trigger: feature-validate-lead's second validation pass (cycle 0 retry 1) found 4 new must_fix items,
each on a task (T1, T2, T3, T4) already retried once in place this cycle — per the one-free-retry-
per-task-per-cycle rule, a task's second failure this cycle opens a new cycle rather than another
in-place retry, regardless of each item still being confined to its own single task.
Findings:
- [T1] must_fix: `promoteReferencePhotos`'s null-`part_number` dedup fix (cycle 0 retry 1) is a
  non-atomic SELECT-then-INSERT across two separate calls — a TOCTOU race where two concurrent
  requests promoting the identical (category, brand, partNumber=null, photoPath) combo can both pass
  the existence check before either inserts, producing duplicate rows. Fix: one atomic statement
  (`INSERT ... SELECT ... WHERE NOT EXISTS (...)`) instead of two serialized calls.
- [T2] must_fix: `apps/server/test/listingPhotos.test.ts` (`PHOTO_HOOK_PORT`) and
  `apps/server/test/teardown.test.ts` (`HOOK_PORT`) hardcode the identical port 34_632 — reproduced
  deterministically 3/3 times running just those two files together, not scheduling-pressure flakiness.
  Fix: give one file its own distinct port, matching this codebase's existing port-uniqueness
  convention.
- [T3] must_fix: `seedReferencePhotos.ts` never imports or calls T1's `promoteReferencePhotos`/
  `findReferencePhotosForLeads` — it issues its own raw `INSERT INTO part_reference_photos` with an
  independently-reimplemented unique-constraint check, bypassing the Standing Check that confines all
  DuckDB access for this table to `queries/referencePhotos.ts`, and reopening the null-partNumber dedup
  bug in a second, unreviewed path. Fix: add an exported seed-insert helper to `referencePhotos.ts`
  (reusing T6's atomic null-safe dedup logic) and call it from the script instead of raw SQL.
- [T4] must_fix: two of `visualComparison.test.ts`'s five `const eligibleParts = [];` declarations
  (lines ~87, ~97) were missed when the cycle 0 retry 1 fix annotated the other three with
  `PromptModule.EligiblePart[]` — still produce real `TS7034`/`TS7005` implicit-any errors under a
  `tsc --noEmit` run that includes the test directory. Fix: annotate both the same way as the other
  three.
UAT (cycle 1): feature-uat-tester-medium dispatched. Started apps/server for real (Node 22,
compiled dist/index.js so the shell's own login-profile `cd` on every spawned process — this host's
`~/.profile` unconditionally `cd`s to $HOME on shell init — couldn't reset the module-resolution cwd;
confirmed apps/web needs no exercise since this feature adds no UI, assumption A3). All HTTP calls
below are real requests against that running server, not in-process test helpers; the `omp` CLI calls
for both identify-parts exercises are the real, unstubbed binary (~/.local/bin/omp), never
setOmpRunnerOverride.

Checks performed:
- Confirmed via the `duckdb` CLI that `part_reference_photos` already held exactly 10 `source='seed'`
  rows spanning GPU/Case/Cooler before any UAT writes (Requirement 1).
- Confirmed all 10 seed photo files exist on disk under `data/reference-photos/seed/` and are real,
  decoded JPEGs (`file` reported real JPEG headers/dimensions for each), not placeholders
  (Requirement 1).
- Created a real Source and a real Listing via `POST /api/listings` with an Expected Part carrying
  `brand: "Sapphire"` in category GPU.
- Uploaded a real photo to that Listing via `POST /api/listings/:id/photos`.
- Confirmed a new `part_reference_photos` row appeared afterward with category=GPU, brand=Sapphire,
  source='confirmed_listing', listing_id set to the real Listing (Requirement 2).
- Re-saved the same Listing via `PUT /api/listings/:id` with the identical Expected Part and the same
  already-uploaded photo.
- Confirmed no duplicate row was created for that same category/brand/partNumber/photo_path
  combination after the re-save — a `GROUP BY ... HAVING count(*) > 1` query over the whole table
  returned zero rows (Requirement 4).
- Accepted the Listing, advanced the resulting Purchase through `shipped` -> `received` via
  `PATCH /api/purchases/:id/status`, and submitted a real teardown via
  `POST /api/purchases/:id/teardown` with an Additional Part carrying `brand: "NZXT"` in category Case.
- Confirmed a new `part_reference_photos` row appeared for category=Case, brand=NZXT,
  source='confirmed_listing', tagged with the originating Listing's photo (Requirement 3).
- Called `POST /api/listings/:id/identify-parts` with the real `omp` CLI on a Listing described as an
  unbranded, unmarked RAM stick.
- Confirmed via the live server log that the first pass returned one RAM part with brand=null
  (eligible per Requirement 5) and the whole request completed in 2.77s.
- Confirmed via the live server log the exact Info-level message "No reference photos available for
  eligible parts; skipping visual comparison" was emitted (Requirement 7, and the Standing Check's
  Info-logging convention for this skip path) — RAM has zero reference photos in any source.
- Confirmed the HTTP response for that call was the unmodified first-pass result (one part, brand
  null, empty identityCandidates) with no second `omp` invocation and no extra latency beyond the one
  real model call (Requirement 5/7).
- Called `POST /api/listings/:id/identify-parts` with the real `omp` CLI a second time, on a new
  Listing described as an unbranded GPU with a dual-fan open-air cooler (GPU has both seed and
  freshly-confirmed reference photos available).
- Confirmed via the live server log the first pass completed (partCount=1), the part was eligible, and
  the server then logged "Starting AI visual comparison pass" with eligibleCount=1 — the second pass
  genuinely started (Requirement 5/6: the lookup against GPU found eligible references).
- Confirmed this second-pass `omp` invocation failed with a real HTTP 502
  ("'omp' exited with code 1 during AI part identification...") about 400ms after starting, and the
  server's own structured error log recorded the same AppError.
- Reproduced the root cause by reading `partIdentification.ts`: the second pass's
  `referencePhotoPaths` is built via `resolvePhotoPaths([ref.photoPath])[0]`, which strips every path
  to its basename and resolves it under `PHOTOS_DIR` (`data/photos/`) — correct for a listing's own
  `photos/<file>` paths, but wrong for a seed-sourced reference photo stored as
  `reference-photos/seed/<file>`, whose real file lives under `data/reference-photos/seed/`.
- Confirmed `data/photos/` never contains any file matching a seed reference photo's basename — nothing
  in this feature copies seed images into PHOTOS_DIR, so the misresolved path is never a lucky
  coincidence; it is wrong every single time a seed-sourced photo is selected.
- Independently reproduced the exact failure by invoking the real `omp` CLI directly against the
  misresolved path (`omp -p --no-tools "..." @.../data/photos/<seed-filename>.jpg`) ->
  `Error: File not found`, exit code 1 — matching the server's own observed 502 exactly.
- Concluded Requirement 8/9 cannot be demonstrated working against real seeded (or any future
  seed-sourced) reference photos — the actual point of this feature — even though eligibility, lookup,
  prompt-building and parsing are all reached and exercised correctly up to the real model call.
- Requirement accounting: Req 1 MET (checks above); Req 2 MET; Req 3 MET; Req 4 MET; Req 5 MET for the
  "eligible when ambiguous" arm (both live calls); the "fully-settled part is never touched" arm was
  not independently re-exercised live (neither live model response happened to return a fully-settled
  part) — closed instead by citing T5-TST's existing mutation-proven unit coverage of that exact arm,
  not a live gap introduced by this pass. Req 6's priority/cap logic was reached live (a lookup against
  GPU found references) but its exact ordering/capping was not independently re-verified beyond "it
  found something," since the live call 502'd before the model could act on the specific set attached
  — citing T1-TST's/T5-TST's existing mutation-proven unit coverage for the ordering/cap logic itself.
  Req 7 MET, live, with the real omp CLI. Req 8 NOT MET live: the orchestrator reaches the second-pass
  call, but it never completes against real reference data. Req 9 UNVERIFIABLE live: the second pass
  never returns a result in a real run, since it always 502s before the model responds.
- Standing Check accounting: whole-suite-passes-and-coverage and ESLint-clean are both cited from
  feature-validate-lead's cycle-1 standing gate (383/383 tests passed, zero ESLint violations,
  383 >= BaselineTests 313) rather than re-run, per instruction, since no production code changed
  between that gate and this UAT pass. Block comments on new public functions: spot-checked
  (`referencePhotos.ts`'s exports both carry one). Logging convention: confirmed live for the
  second-pass-skip Info log (the RAM check above) and grep-confirmed in source for the promotion
  duplicate-skip Info log and the malformed-response Warn-coercion log in
  `visualComparisonParser.ts`. `apps/web` never imports `apps/server`: grep-confirmed, zero hits.
  DuckDB access confined to `apps/server/src/db` for the new table: grep-confirmed — the only
  non-`db/` file importing `@duckdb/node-api` is `scan/duplicateDetection.ts`, a pre-existing file from
  the unrelated ebay-scanning feature that never touches `part_reference_photos`. No new source file
  over ~200 lines: confirmed via `wc -l` on all 7 new files (max 174 lines). Tests stub the `omp`
  runner for both passes: grep-confirmed `setOmpRunnerOverride` used in `partIdentification.test.ts`/
  `identifyPartsRoute.test.ts`, and confirmed no real `spawn('omp', ...)` call anywhere under
  `apps/server/test`. Concurrent-write guarantee for `part_reference_photos`: not re-run by this pass —
  cited from T2-TST's and T6-TST's own real-concurrent-request proofs this cycle (`Promise.all` against
  the running server, mutation-proven), since no production code touched that path since those passes.
- Cleanup: stopped the server process after all live calls completed; confirmed port 3001 free and no
  server process running afterward. Removed the `data/photos/` directory created during this pass,
  restoring the exact pre-dispatch state (it did not exist before this dispatch either). Confirmed
  `git status` shows only the feature's own already-tracked-modified/untracked files, identical to the
  state observed before this pass started — no source file was edited by this UAT pass. Left the
  Sources/Listings/Purchases/Parts/reference-photo rows created during live HTTP testing in this
  worktree's real, gitignored, uncommitted `data/pc-parts-flipper.duckdb`, per this pass's own
  instruction to exercise the feature against the worktree's actual database.

Verdict: FAIL. 1 must_fix routed back to feature-build-lead:
- [second pass] must_fix: `apps/server/src/ai/partIdentification.ts`'s second-pass reference-photo
  path resolution (`referencePhotoPaths = Array.from(referencesByPart.values()).flat().map((ref) =>
  resolvePhotoPaths([ref.photoPath])[0])`) reuses `resolvePhotoPaths`, which strips to basename and
  resolves under `PHOTOS_DIR` — correct only for a listing's own `photos/<file>` paths. Every
  seed-sourced reference photo (`reference-photos/seed/<file>`) resolves to a nonexistent path under
  `data/photos/` instead of its real location under `data/reference-photos/seed/`, making the real
  `omp` CLI exit 1 ("File not found") and the whole `identify-parts` request 502 whenever a real second
  pass selects one — reproduced live against the real seeded Wikimedia photos. Fix: resolve reference
  photo paths relative to DATA_DIR using the photo's full stored `photo_path` (e.g.
  `path.join(DATA_DIR, ref.photoPath)`), not `resolvePhotoPaths`'s basename-plus-PHOTOS_DIR logic built
  for listing photos specifically — and add a real-filesystem regression test (attaching an actual
  seed-sourced reference photo and asserting the resolved path exists on disk) to this feature's suite,
  since the existing tests only ever stub the `omp` runner and never check that an attached image path
  resolves to a real file.

Validation (cycle 1): feature-reviewer-medium/feature-tester-medium dispatched for T6/T7/T8/T9 (each
closing exactly one cycle-1 must_fix item). Tester-conflict check: T6-TST and T8-TST both need
break-run-restore access to the shared `referencePhotos.ts` (T8's `insertSeedReferencePhoto` reuses
T6's atomic dedup helper, so proving the reuse is genuine — not a lookalike reimplementation — requires
mutating the same shared code T6-TST also mutates), so T8-TST was deferred until T6-TST returned;
T7-TST/T9-TST are disjoint from everything else and from each other, and ran alongside all 4 reviewers
(reviewers never conflict) in the first batch. 3 of 4 tasks PASS clean (T6, T7, T9 — every must_fix item
genuinely resolved, each independently mutation-proven by both reviewer and tester: revert-the-fix
reproduces the original bug, restore-the-fix is byte-identical and green again). T8 FAILS review: the
query-layer-bypass bug itself is genuinely closed, but T8's own extraction pushed `referencePhotos.ts`
to 217 lines, over this feature's explicit ~200-line Standing Check — that file was created by this
feature's own T1 and isn't on the cap's three-file pre-existing-file exemption list, so it's held to the
limit like any other new file in this feature (the same cap already enforced twice before, per T3-REV
and A7). T8-TST found no must_fix in T8's own correctness, but in strengthening its own test coverage
added a new test that, run as part of the full file, pollutes shared per-file DB state — see the
standing-gate finding below.

Standing gate: ESLint clean, zero violations (`npm run lint`, Node 22.23.3). Full suite (`npm run test`)
surfaced 2 `apps/server` failures. Re-reproduced each directly rather than assuming either was
contention: (1) `test/sales.test.ts` failed its `beforeAll` hook once (`fetch failed`/socket-closed,
right after the heaviest concurrent load this session — 7 parallel validation sub-agents plus the
full-suite run itself), then passed 2/2 cleanly on 3 consecutive isolated re-runs immediately after —
the same genuine A9/A12/A15-category resource-contention pattern, not a regression (`sales.test.ts` is
untouched by this feature). (2) `test/referencePhotos.test.ts` failed `'returns empty array for category
with no photos'` — re-run in isolation, it fails the *same* way deterministically, every time, not
flakiness: T8-TST's own new test (`'Reference Photos — insertSeedReferencePhoto'`, this validation
pass) inserts a `category: 'Motherboard'` row into the same per-file temp DB the `findReferencePhotos`
describe block shares, and `'returns empty array for category with no photos'` (a pre-existing test, not
touched by T8 or T8-TST) queries that exact category expecting zero rows — genuine new test pollution,
not inherited (`BaselineSuite` was `pass` and this test passed cleanly before this validation pass's own
test addition), reported as a must_fix below. Authoritative count: `apps/server` 268 tests (267 pass + 1
genuine fail, 2 transient-fail-then-pass not counted against it, 29 files), `apps/web` 110/110 (17
files), `packages/shared` 5/5 (1 file) — 383 total vs. `BaselineTests` 313: coverage rose, no shrinkage.
`measure-child-cost.py` was not attempted — see A17.

Findings:
- [T8] must_fix: `apps/server/src/db/queries/referencePhotos.ts` is 217 lines, over the feature's own
  ~200-line Standing Check — T8's extraction (`insertReferencePhotoRow`, `insertSeedReferencePhoto`)
  only moved/added logic, never shrank the file, and it isn't on the cap's three-file pre-existing
  exemption list (`listings.ts`/`parts.ts`/`identificationParser.ts`). Fix: split
  `findReferencePhotosForLeads` (its own ~60-line function, already logically separate from the
  insert-side helpers) into a new `referencePhotoLookup.ts`, mirroring the T4/A7 split — no external
  call site needs to change.
- [standing gate] must_fix: `apps/server/test/referencePhotos.test.ts`'s new
  `'Reference Photos — insertSeedReferencePhoto'` test block (added this validation pass, by T8-TST,
  verifying T8's fix) inserts a `category: 'Motherboard'` row into the file's shared per-suite temp DB
  with no cleanup, deterministically breaking the pre-existing
  `'returns empty array for category with no photos'` test later in the same file (confirmed
  reproducible in isolation, not scheduling-dependent). Fix: give the new test a category no other test
  in the file touches (e.g. `'PSU'`), or have `'returns empty array for category with no photos'` use a
  guaranteed-untouched category instead of `'Motherboard'`.
Verdict: FAIL. 2 must_fix items (T8 x1, standing gate x1) routed back to feature-build-lead; T6/T7/T9
clean.

Retries: T8 retried in place (cycle 1 retry 1) — both must_fix items trace back to T8's own files
(`referencePhotos.ts`'s line count, and the test pollution introduced by T8-TST's own new test in
`referencePhotos.test.ts`), and this is T8's first failure in cycle 1 (T6/T7/T9 passed clean, so the
one-free-retry-per-task-per-cycle budget is untouched for T8 so far) — retried in place, cycle stays 1.


### Cycle 2
Trigger: `feature-uat-tester-medium`'s UAT run (cycle 1) found the feature's actual core capability —
a real second-pass visual comparison against seed reference photos — broken end to end: every real
second-pass call selecting a seed-sourced reference photo 502s, because `partIdentification.ts`
resolves its path via `resolvePhotoPaths`'s basename-plus-`PHOTOS_DIR` logic (built for a listing's own
flat-layout photos), discarding the `reference-photos/seed/` prefix a seed photo's `photo_path` actually
carries. This was invisible to every prior cycle's full test suite because the Standing Check requiring
tests to stub the `omp` runner (so the suite stays deterministic/network-independent) also means no
existing test ever checked that an attached image path resolves to a real file on disk — only UAT's
explicit real, unstubbed `omp` call against real seed data could have caught this, which is exactly why
that was named the plan's top UAT priority. A UAT failure is about the feature as a whole, not confined
to one already-built task, so this opens a new cycle rather than an in-place retry on any existing task.
Findings:
- [second pass] must_fix: see Cycle 1's UAT verdict above for the full reproduction and root-cause
  detail. Fix: resolve reference photo paths via the photo's full `photo_path` relative to `DATA_DIR`,
  not `resolvePhotoPaths`'s basename-stripping logic; add a real-filesystem regression test proving the
  resolved path actually exists on disk.
UAT (cycle 2): feature-uat-tester-medium dispatched. Loaded Node 22.23.3 via the given nvm PATH prefix,
built `apps/server` (`npm run build`, clean), and started it for real (`node <absolute-path>/dist/index.js`
— the shell's own login-profile `cd`-to-$HOME on every spawned process, same quirk A9/U1 already
documented, required the absolute path rather than relying on `cwd`). Confirmed the real `omp` CLI is on
PATH (`omp/18.6.1`) before any call; every `identify-parts` call below used it unstubbed, never
`setOmpRunnerOverride`.

Checks performed:
- Confirmed via the `duckdb` CLI (server not yet started) that `part_reference_photos` held exactly 10
  `source='seed'` rows across GPU/Case/Cooler, unchanged since U1 (Requirement 1).
- Read `apps/server/src/ai/partIdentification.ts` directly and confirmed T10's fix is present in source:
  reference photo paths are resolved via `path.join(DATA_DIR, ref.photoPath)`, not `resolvePhotoPaths`.
- Called `POST /api/listings/:id/identify-parts` on the same ambiguous/unbranded GPU listing U1 used
  ("Graphics card pulled from old prebuilt - brand unknown", zero listing photos) with the real `omp` CLI.
- Confirmed the response was HTTP 200, not the 502 U1 reported.
- Confirmed via the live server log that the first pass logged `photoCount: 0` and `partCount: 1`.
- Confirmed the part was eligible (`brand: null`) and the server logged "Starting AI visual comparison
  pass" with `eligibleCount: 1` — the second pass genuinely started, selecting real seed GPU references.
- Confirmed the server then logged "AI visual comparison complete" with `updatedCount: 0` — the second
  pass ran to completion (not a crash) and honestly declined to guess with no listing photo to compare
  (Requirement 9c), returning `brand: null`, `identityCandidates: []` unchanged.
- Repeated the identical call a second time on the same listing: identical outcome (HTTP 200, eligible,
  second pass ran, `updatedCount: 0`, no 502) — the fix is reproducible, not a one-off.
- Created a new Listing with an ambiguous/contradictory text description (worn/illegible dual-fan GPU)
  and uploaded a real seed-sourced photo (`gigabyte-rtx3090-eagle-oc.jpg`) as its own listing photo via
  `POST /api/listings/:id/photos`.
- Called `POST /api/listings/:id/identify-parts` on that new listing with the real `omp` CLI.
- Confirmed the response was HTTP 200, first pass logged `photoCount: 1`, and the part was eligible
  (not fully settled after the first pass), with "Starting AI visual comparison pass" logged.
- Confirmed the server logged "AI visual comparison complete" with `updatedCount: 1` — a real update
  was applied — and the returned JSON showed `brand: "Gigabyte"`, `partNumber: "GeForce RTX 3090 EAGLE
  OC"`, `identityCandidates: []`, matching the exact seed reference photo attached — Requirement 9(a)'s
  "fill in a previously-null brand/partNumber from a confident visual match" demonstrated live, not
  merely "the call didn't crash".
- Repeated that identical call a second time: again HTTP 200, eligible, second pass ran, `updatedCount: 1`,
  resolving to the same Gigabyte/RTX 3090 EAGLE OC identity — reproducible, not a one-off.
- Across these 4 real second-pass invocations (2 per scenario), none 502'd; each took ~10-17s, consistent
  with real vision-model processing time, not a stubbed/instant response.
- Requirement 2/4 live re-check: `PUT` the second new listing's Expected Part with a fresh non-null
  brand (`UatReq2Brand`/`UAT-PN-1`) while a photo was already attached; confirmed via a direct re-`PUT`
  of the identical Expected Part that the server logged the Info-level "Skipped reference photo already
  in database" message on the re-save (Requirement 4's dedup-on-resave).
- Confirmed afterward (server stopped, direct `duckdb` query) that exactly one new `confirmed_listing`
  row exists for `UatReq2Brand`/`UAT-PN-1` (Requirement 2's promotion genuinely fired) and that a
  `GROUP BY` over the whole table for duplicate (category, brand, part_number, photo_path) combinations
  returned zero rows (Requirement 4 holds after this pass's own writes, not just U1's).
- Requirement 3 re-check: grep-confirmed `apps/server/src/routes/teardown.ts` still calls
  `promoteReferencePhotos` inside the `additionalParts` loop — this file was untouched by T10, so its
  Requirement 3 code path is unchanged since U1's own live confirmation; not re-exercised end-to-end
  this pass (lighter re-check, per instruction, since nothing in its path changed this cycle).
- Requirement 5's "fully-settled part is never touched" arm: not independently re-exercised live this
  pass either (every live first-pass result that reached eligibility checking this pass was itself
  non-fully-settled) — closed the same way U1 closed it, by citing T5-TST's existing mutation-proven
  unit coverage of that exact arm, not a live gap newly introduced by this pass.
- Requirement 5's "eligible when ambiguous" arm and Requirement 8 (second pass runs, attaches labeled
  references, instructs identifying-marks comparison): reconfirmed live by all 4 second-pass calls above.
- Requirement 6 (lookup priority/cap): reconfirmed live — the GPU category-only fallback (the listing's
  part carried no brand lead) is, by source, alphabetical-by-brand with a cap of 3, which excludes the
  4th GPU row (`Sapphire`, alphabetically last) from the pool the second pass could select from; the
  real match returned (`Gigabyte`) is consistent with being inside that capped set. Citing
  T1-TST's/T5-TST's existing mutation-proven unit coverage for the lookup's exact ordering/cap mechanism
  itself, same as U1's own precedent for this sub-point.
- Requirement 7 re-check: called `identify-parts` on the existing unbranded RAM listing (RAM has zero
  reference photos in any source). Confirmed HTTP 200, first pass `partCount: 1`, and the server logged
  "No reference photos available for eligible parts; skipping visual comparison" at Info — no second
  `omp` call, total response time ~3.8s (vs. ~16s when a second pass runs), the response being exactly
  the first pass's unmodified result.
- Standing Check accounting: whole-suite-passes-and-coverage and ESLint-clean cited from
  feature-validate-lead's cycle-2 standing gate (384/384 tests passed, zero ESLint violations,
  384 >= `BaselineTests` 313) per instruction, since no production code changed between that gate and
  this UAT pass. `apps/web` never imports `apps/server`: grep-confirmed directly this pass — every hit
  across `apps/web/src` is a comment referencing a server file path, not an import statement, zero
  actual import-statement hits. DuckDB access confined to `apps/server/src/db` for the new table:
  grep-confirmed directly this pass — the only non-`db/` file importing `@duckdb/node-api` is
  `scan/duplicateDetection.ts`, pre-existing from the unrelated ebay-scanning feature, untouched by this
  feature. No new source file over ~200 lines: re-counted via `wc -l` directly this pass on all 7 new
  files (max 174 lines, `seedReferencePhotos.ts`). Tests stub the `omp` runner for both passes:
  grep-confirmed directly this pass — `setOmpRunnerOverride` is used in both
  `identifyPartsRoute.test.ts` and `partIdentification.test.ts`, and the only `spawn('omp'` hit anywhere
  under `apps/server/test` is inside a comment, not a real call. Logging convention: confirmed live this
  pass for all three named paths — the promotion duplicate-skip Info log (Req 2/4 re-check above), the
  second-pass-skip Info log (Req 7 re-check above), and the second-pass-ran-to-completion log pair
  ("Starting"/"complete") on all 4 real second-pass calls; the malformed-response Warn-coercion path was
  not hit live this pass (every real model response this pass parsed cleanly) — not independently
  re-verified beyond citing the existing unit coverage already confirmed in prior cycles. Block comments
  on new public functions: spot-checked `referencePhotoLookup.ts` and `visualComparisonPrompt.ts`
  directly this pass, both carry one. Concurrent-write guarantee for `part_reference_photos`: not re-run
  by this pass (no file on that path changed since T6-T9's own mutation-proven concurrent-request
  proofs, and since T10-REV/T10-TST's cycle-2 validation) — cited from that existing proof, not
  re-exercised, per instruction to avoid a full from-scratch repeat.
- Cleanup: stopped the server process after all live calls completed; confirmed port 3001 free
  afterward. Removed the one file `data/photos/` held at pass end (the photo uploaded for the second
  scenario) and the now-empty `data/photos/` directory itself, restoring the exact state this directory
  was in before this dispatch (it did not exist either, same as U1 found). Confirmed `git status`
  afterward shows only the feature's own already-tracked-modified/untracked files, identical to the
  state observed before this pass started — no source file was edited by this UAT pass. Left the new
  Sources/Listings/reference-photo rows created during live HTTP testing in this worktree's real,
  gitignored, uncommitted `data/pc-parts-flipper.duckdb`, per this pass's own instruction to exercise the
  feature against the worktree's actual database, matching U1's own precedent.

Verdict: PASS. No must_fix items. The UAT-focus scenario that 502'd in U1 now completes end to end
against real seed reference data with the real, unstubbed `omp` CLI, reproduced twice; a second genuine
scenario additionally demonstrated the second pass actually filling in a correct identity from a real
visual match, reproduced twice. Every Requirement (1-9) and every Standing Check has a check against it
in this pass or an explicitly-cited prior pass. This closes out the feature — no further cycle is needed.


Validation (cycle 2): feature-reviewer-medium/feature-tester-medium dispatched for T10, the sole
cycle-2 task — no tester conflict (single task, nothing to conflict with). Both independently
mutation-proved T10's fix against real, already-seeded Wikimedia reference-photo data on this
worktree's real `data/pc-parts-flipper.duckdb`/`data/reference-photos/seed/`, in both directions
(revert reproduces the exact UAT-reported 'File not found' failure; restore closes it again,
byte-identical) — not trusting build-lead's own A20 report or the builder's synthetic-fixture test
alone. No must_fix. See T10-REV/T10-TST rows and Assumption A21 for the full detail.

Standing gate: ESLint clean, zero violations (`npm run lint`, Node 22.23.3). Full suite (`npm run
test`) showed one transient failure — `test/profit.test.ts`'s `beforeAll` hook timing out booting its
own real HTTP server — the same A9/A12/A15 resource-contention category; re-run in isolation passed
cleanly (3/3) on the second attempt (the first isolated attempt hit a residual closed-socket from the
immediately-preceding full-suite run's own server releasing the same port, not a code defect).
Authoritative count: `apps/server` 269 tests/29 files, `apps/web` 110/110 tests/17 files,
`packages/shared` 5/5 tests/1 file — 384 total vs. `BaselineTests` 313: coverage rose, no shrinkage.

Verdict: PASS. No must_fix items.
