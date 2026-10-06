Status: done
Cycle: 0 / 3
FeatureStarted: 2026-10-06T04:03:28Z
OrchestrationTokensActual: null
OrchestrationTokensBreakdown: null
Prototype: .claude/feature/ai-reference-autosourcing/dashboard.html (local file — no hosted-publish capability on this host, so there is no live URL)
BaselineTests: 384
BaselineSuite: pass
ApprovedBy: user (chat approval)
FeatureCompletedAt: 2026-10-06T06:24:39Z

# pc-parts-flipper — ai-reference-autosourcing

## Goal

Today, `identify-parts`'s second pass only compares against reference photos already sitting in
`part_reference_photos` — if a part's own brand and model are both known but nothing in the library
matches that exact identity, the second pass simply has nothing to compare against for it. This
feature closes that gap: when an eligible part's own claimed brand *and* model aren't yet represented
in the library, the system attempts, synchronously and before that part's second pass runs, to find
and add one real photo of that exact product from the manufacturer's own official site — using the
`omp` CLI's own web-browsing capability (dropping `--no-tools` for this one call) rather than a new
paid search API — so the same `identify-parts` request that triggered the gap is the one that benefits
from closing it. A separate ask this session (comparing a part's claimed model against other models of
the same brand already in the library, to catch a mislabeled model number) turns out to already work
today — the existing lookup matches on brand alone when a part isn't fully settled, with no partNumber
requirement — and stays exactly as it is; this feature does not touch it.

## Requirements
1. For an eligible part (unchanged from the existing rule: `brand` null, OR `partNumber` null, OR
   `identityCandidates` non-empty) whose own `brand` *and* `partNumber` are **both** non-null — a
   specific, nameable product, not a bare brand or an unresolved candidate — and no
   `part_reference_photos` row exists for that exact `(category, brand, partNumber)` combination,
   the system attempts live sourcing for that part before building its second-pass reference set. A
   part with only a brand (no model) never triggers sourcing — there is nothing specific enough to
   search for and verify.
2. Sourcing is a dedicated `omp` invocation with tools enabled (no `--no-tools`), given the part's
   category/brand/partNumber, instructed to find exactly one real, direct image URL of that specific
   product from the manufacturer's own official website only — never a reseller, retailer,
   marketplace, or aggregator site — and to answer with raw JSON only, naming the URL it found (or
   that it found nothing).
3. The server never trusts the model's own claim that a URL is real or correct. It downloads the URL
   itself and confirms the response is a genuine, decodable image before anything is added to the
   library — reusing the same real-bytes verification this feature's seed data already uses, not a
   new, weaker check. A URL that fails to download, isn't a real image, or that the model reports
   finding nothing for, is a failed sourcing attempt; `identify-parts` then proceeds exactly as if
   sourcing had never been attempted — it never blocks or fails the request.
4. A photo added by live sourcing is tagged with its own distinct value in `part_reference_photos`'s
   `source` column (`'auto_sourced'`) — never conflated with the existing `'seed'` (manually curated)
   or `'confirmed_listing'` (the user's own real inventory) values, so the data keeps recording where
   each reference actually came from.
5. When sourcing succeeds within an `identify-parts` call, that same call's second pass uses the
   newly-added photo — a user never has to click Identify Parts a second time to benefit from a
   sourcing attempt that happened during their first click.
6. Once sourcing has been attempted for a specific `(category, brand, partNumber)` combination —
   whether it succeeded or failed — it is never attempted again for that same combination on a later
   `identify-parts` call. A brand/model with no accessible manufacturer photo must not be re-searched,
   at real cost, on every future listing that happens to name it.
7. The number of live-sourcing attempts made within one `identify-parts` call is capped at a small
   fixed number, so a listing with several simultaneously-unseeded parts never chains an unbounded
   run of slow, tools-enabled `omp` calls before its second pass can even start.
8. A sourcing call that runs past its own timeout is treated as a failed attempt (Requirement 3/6),
   never left to hang the whole `identify-parts` request indefinitely. This timeout is independent of
   the existing no-tools identification calls' timeout, since a browsing-enabled call is expected to
   take meaningfully longer.

## Standing checks
- The whole test suite passes, and the test count stays at or above `BaselineTests` (384, this
  feature's fresh-worktree baseline recorded above).
- ESLint runs clean with zero new violations.
- Every new public function/class carries a block comment; non-obvious lines carry a single-line
  comment above them (existing project convention).
- Logging follows the existing Error/Warn/Info/Debug/Trace convention — a sourcing attempt's start,
  success, and failure (and the Requirement 6 already-attempted skip) each log at Info; a malformed
  sourcing response is coerced and logged at Warn, matching `coerceIdentityField`'s existing pattern.
- `apps/web` never imports `apps/server` directly (existing boundary, checked by the existing ESLint
  rule). This feature adds no new web UI — it changes what `identify-parts` can find, not where or how
  anything is shown, the same scope boundary `ai-visual-identification` itself held to.
- All DuckDB access for the new sourcing-attempt table stays inside `apps/server/src/db`, reached only
  through its own query module, never raw SQL from `apps/server/src/ai`.
- No new source file goes over ~200 lines. `apps/server/src/ai/partIdentification.ts` (225 lines) and
  `apps/server/src/ai/ompRunner.ts` (193 lines) are already at or past that cap before this feature
  starts, and this feature adds real new logic to both areas — the new tools-enabled `omp` runner and
  the new sourcing-orchestration sequence (trigger check, cache check, attempt, verify, insert, retry
  the lookup) each belong in their own new sibling file from the start, called with one small function
  each from `ompRunner.ts`/`partIdentification.ts` respectively, not grown inline into either
  already-near-the-cap file. `apps/server/src/db/queries/referencePhotos.ts` (135 lines) and
  `referencePhotoLookup.ts` (90 lines) have more headroom but the new download-and-insert logic
  (Requirement 3) should reuse the seed script's own existing download/verification logic
  (`seedReferencePhotos.ts`) rather than writing a second copy of it, the same duplication
  `ai-visual-identification`'s own retrospective flagged as a real, avoidable cost.
- The automated suite stubs the new tools-enabled sourcing runner exactly the way it already stubs the
  two existing `omp` calls — never a real network/`omp` call in `npm test`.
- `part_reference_sourcing_attempts` (Requirement 6) is a new table a single code path writes to, but
  two genuinely concurrent `identify-parts` calls naming the same `(category, brand, partNumber)` can
  still race on recording the first attempt for it — proven never to produce two rows or an unhandled
  error with real concurrent requests against the running server, the same way `part_reference_photos`
  itself was proven in the prior feature.

## Tasks
| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| T1 | New table `part_reference_sourcing_attempts` (`category component_category NOT NULL, brand VARCHAR NOT NULL, part_number VARCHAR NOT NULL, attempted_at TIMESTAMP NOT NULL DEFAULT current_timestamp, succeeded BOOLEAN NOT NULL`), a new `TABLE_STATEMENTS` entry in `apps/server/src/db/schema.ts` plus a `CREATE UNIQUE INDEX` on `(category, brand, part_number)` for Requirement 6's dedup — `part_number` is `NOT NULL` here (Requirement 1 only ever triggers sourcing when a part's own model is already known), so this table never hits the NULL-distinctness problem `part_reference_photos`'s own dedup index had to work around; the unique index alone is sufficient, no atomic-insert workaround needed. Add `source: 'seed' \| 'confirmed_listing' \| 'auto_sourced'` to `ReferencePhoto` in `apps/server/src/db/types.ts` (Requirement 4). New `apps/server/src/db/queries/sourcingAttempts.ts` exporting `hasSourcingBeenAttempted(category, brand, partNumber): Promise<boolean>` and `recordSourcingAttempt(category, brand, partNumber, succeeded): Promise<void>` (catches the unique-index violation as "already recorded, skip" — same pattern as the prior feature's dedup inserts, Requirement 6/the concurrency Standing Check). Export both plus the table from `db/index.ts`'s barrel. | builder | | complete | 0 | | 2026-10-06T04:20:44Z | 2026-10-06T04:36:50Z | 20 | 2026-10-06T04:19:20Z | 16000 | null | no |
| T2 | New `apps/server/src/ai/ompSourcingRunner.ts`, a sibling to `ompRunner.ts` kept separate per the Standing Checks' line-count note: `runOmpImageSourcing(promptText: string, options?: OmpRunOptions): Promise<string>` — same spawn/timeout/kill-process-group machinery as `runOmpIdentification` (reuse its internals via a small shared helper rather than copy-pasting the whole function), but builds its argv *without* `--no-tools` (tools enabled, so the model can browse) and with **no** `@<path>` image arguments at all — this call never attaches a photo, it searches the web. Give it its own default timeout constant, `DEFAULT_OMP_SOURCING_TIMEOUT_MS`, longer than the existing `DEFAULT_OMP_TIMEOUT_MS` (Requirement 8 — a browsing call is expected to run longer than a no-tools analysis call). Add the matching test seam: `setOmpSourcingRunnerOverride`/`getOmpSourcingRunner`, mirroring `ompRunner.ts`'s existing pair exactly, so the suite never makes a real call here either (Standing Check). | builder | | complete | 0 | | 2026-10-06T04:20:44Z | 2026-10-06T04:36:50Z | 20 | 2026-10-06T04:39:20Z | 29700 | null | no |
| T3 | New `apps/server/src/ai/imageSourcingPrompt.ts`: `buildImageSourcingPrompt(category: ComponentCategory, brand: string, partNumber: string): string` — names the exact product and instructs the model to find one real, direct image URL of it from the manufacturer's own official website only (never a reseller, retailer, marketplace, or aggregator — Requirement 2), responding with raw JSON only: `{"found":boolean,"url":string\|null}`. New `apps/server/src/ai/imageSourcingParser.ts`: `parseImageSourcingResponse(rawStdout: string): {found: boolean; url: string \| null}` — built the same defensive way as `parseIdentificationResponse`/`parseVisualComparisonResponse` (structural failure — not JSON, missing `found` — is fatal; a malformed `url` field when `found` is true is coerced to `{found: false, url: null}` and logged at Warn, never trusted as-is). | builder | | complete | 0 | | 2026-10-06T04:20:44Z | 2026-10-06T04:36:50Z | 15 | 2026-10-06T04:59:20Z | 500 | null | no |
| T4 | Download-and-insert logic for a sourced photo (Requirement 3-4). Extract `seedReferencePhotos.ts`'s existing `downloadFile` into an exported, reusable function (its own small module, or exported directly from `seedReferencePhotos.ts` and imported from there — either way, one real implementation, not two) so this feature's new code reuses the exact same real-bytes-verified download logic instead of a second copy (the Standing Checks call this out explicitly). New `insertSourcedReferencePhoto(category: ComponentCategory, brand: string, partNumber: string, url: string): Promise<{inserted: boolean}>` in `apps/server/src/db/queries/referencePhotos.ts` (reusing the existing `insertReferencePhotoRow` helper with `source: 'auto_sourced'`, `listingId: null`) that downloads the given URL to a collision-safe filename under `data/reference-photos/auto-sourced/` (new subdirectory, same `DATA_DIR`-relative convention as `reference-photos/seed/`), verifies the download is a real decodable image, and only then inserts the row — returns `{inserted: false}` without inserting anything when the download fails or isn't a real image, never partially committing a broken reference. MUST FIX (cycle 0 retry 1): `imageSignature.ts`'s `isDecodableImage()` detects four formats (JPEG/PNG/GIF/WebP) but the automated suite only exercises the JPEG branch (plus one "matches nothing" negative) — a repo-wide grep found zero tests touching any of the PNG/GIF/WebP magic-byte checks. Today's four byte sequences are correct, but nothing would catch a regression (e.g. a typo'd `GIF89a`, an off-by-one in the WebP `RIFF`/`WEBP` offset check) in any of the three untested branches — a broken check would either silently reject a real manufacturer photo (defeating Requirement 1) or silently accept a non-image as "verified" (defeating Requirement 3), with `npm test` staying 100% green either way. Add tests (mirroring the existing `JPEG_BYTES`/`GARBAGE_BYTES` pattern already in `referencePhotos.test.ts`) for at least one valid PNG header, one valid GIF87a/GIF89a header, and one valid RIFF/WEBP header, each proving `isDecodableImage()` accepts it and a one-byte-corrupted version of each is rejected. | builder | T1 | complete | 0 | | 2026-10-06T05:49:42Z | 2026-10-06T06:01:32Z | 20 | 2026-10-06T05:14:20Z | 5200 | null | no |
| T5 | Orchestration (Requirements 1, 5-8): new `apps/server/src/ai/referenceSourcingOrchestrator.ts` exporting one function, `sourceMissingReferenceIfNeeded(part): Promise<void>`-shaped (exact signature to the builder — it needs the part's category/brand/partNumber and must be callable once per eligible part), that: checks Requirement 1's trigger (own brand and partNumber both non-null, no matching `part_reference_photos` row); checks T1's `hasSourcingBeenAttempted` (Requirement 6) and the per-call attempt counter against a new `MAX_SOURCING_ATTEMPTS_PER_CALL` constant (Requirement 7) before doing anything; when eligible, calls T2's sourcing runner with T3's prompt (own `DEFAULT_OMP_SOURCING_TIMEOUT_MS`, Requirement 8), parses with T3's parser, and on a found+verified result calls T4's insert function; records the attempt's outcome via T1's `recordSourcingAttempt` regardless of success or failure. Wire this into `apps/server/src/ai/partIdentification.ts`'s `identifyListingParts`: call it for each eligible part *before* that part's `findReferencePhotosForLeads` lookup runs, so a just-inserted photo is picked up by the very same call's second pass (Requirement 5) — this is the one, small call site `identifyListingParts` gains; the rest of the new sequence lives in the new file per the Standing Checks' line-count note. | builder | T1, T2, T3, T4 | complete | 0 | | 2026-10-06T04:51:31Z | 2026-10-06T05:03:54Z | 25 | 2026-10-06T05:34:20Z | 22500 | null | no |
| T1-review | Review T1 (`part_reference_sourcing_attempts` table, schema.ts, types.ts, db/index.ts barrel, `sourcingAttempts.ts`'s `hasSourcingBeenAttempted`/`recordSourcingAttempt`) against Requirements 4/6 and the Standing Checks (unique-index dedup mechanism, Info logging on both record and skip branches, DuckDB access confined to `db/queries`). | reviewer | T1 | complete | 0 | | 2026-10-06T05:11:14Z | 2026-10-06T05:45:16Z | 10 | 2026-10-06T05:11:14Z | 9000 | null | no |
| T1-test | Test T1's `sourcingAttempts.ts` against Requirement 6 and its Standing Check: unique-index dedup under genuine concurrency (real concurrent `recordSourcingAttempt` calls for the identical combo via `Promise.all`, proven never to produce two rows or an unhandled error — the same proof style `referencePhotos.test.ts` uses for `part_reference_photos`), plus `hasSourcingBeenAttempted` correctness. | tester | T1 | complete | 0 | | 2026-10-06T05:11:14Z | 2026-10-06T05:45:16Z | 20 | 2026-10-06T05:11:14Z | 9000 | null | no |
| T2-review | Review T2 (`ompRunner.ts`'s `runOmpProcess` extraction and `runOmpIdentification` thin wrapper, new `ompSourcingRunner.ts`) against Requirement 8 and the Standing Checks' line-count note — independently verify whether `ompRunner.ts`'s growth to 204 lines is genuinely attributable to doc comments as the builder claimed, or to the new `runOmpIdentification` wrapper function's real logic, and whether the shared-helper split the task called for was done without duplicating the original spawn/timeout/kill machinery. | reviewer | T2 | complete | 0 | | 2026-10-06T05:11:14Z | 2026-10-06T05:45:16Z | 15 | 2026-10-06T05:11:14Z | 7300 | null | no |
| T2-test | Test T2's `ompSourcingRunner.ts` (`runOmpImageSourcing`, `buildOmpSourcingArgs`, timeout/kill/ENOENT/exit-code handling, `setOmpSourcingRunnerOverride`/`getOmpSourcingRunner` seam) and confirm no test in the suite invokes the real `omp` binary. | tester | T2 | complete | 0 | | 2026-10-06T05:11:14Z | 2026-10-06T05:45:16Z | 20 | 2026-10-06T05:11:14Z | 13500 | null | no |
| T3-review | Review T3 (`imageSourcingPrompt.ts`'s `buildImageSourcingPrompt`, `imageSourcingParser.ts`'s `parseImageSourcingResponse`) against Requirement 2 (manufacturer-site-only instruction, raw-JSON-only) and Requirement 3/the Warn-logging Standing Check (malformed `url` coerced and logged at Warn, never trusted as-is). | reviewer | T3 | complete | 0 | | 2026-10-06T05:11:14Z | 2026-10-06T05:45:16Z | 10 | 2026-10-06T05:11:14Z | 8400 | null | no |
| T3-test | Test T3's prompt builder and response parser: prompt names the exact category/brand/partNumber and the manufacturer-only/raw-JSON instructions; parser handles well-formed, malformed (`found` missing → fatal; bad `url` with `found:true` → coerced to `{found:false,url:null}` with a Warn), and non-JSON input. | tester | T3 | complete | 0 | | 2026-10-06T05:11:14Z | 2026-10-06T05:45:16Z | 15 | 2026-10-06T05:11:14Z | 11000 | null | no |
| T4-review | Review T4 (`downloadFile` extraction into `db/download.ts`, `db/imageSignature.ts`'s magic-byte sniffing with PNG/GIF/WebP now test-covered, `insertSourcedReferencePhoto` in `referencePhotos.ts`, `seedReferencePhotos.ts`'s refactor to reuse it) against Requirement 3/4 and the Standing Checks' no-duplicate-download-logic rule. Performed directly by the orchestrator, not `feature-reviewer-medium` — this environment's `feature-pm`/`feature-validate-lead`/`feature-reviewer-*`/`feature-tester-*` role aliases (`@high`, `@low`, `@reviewer-medium`, `@tester-medium`, ...) are failing to dispatch with a persistent "No model selected" error, confirmed across 4 separate attempts (including after a daemon-broker restart and the user restarting their own `omp` instance); plain/`@medium`-aliased agents (`scout`, `sonic`, `feature-build-lead`) remained unaffected throughout — see the new Assumption A22. PASS, no must_fix: read `imageSignature.ts` and the new test block directly — all three previously-untested formats (PNG/GIF/WebP) now have both a valid-header-accepted and a one-byte-corrupted-header-rejected test each; `seedReferencePhotos.ts` confirmed still calling the extracted `downloadFile`, not a second copy. | reviewer | T4 | complete | 0 | | 2026-10-06T06:09:00Z | 2026-10-06T06:17:00Z | 15 | | null | null | no |
| T4-test | Test T4's `insertSourcedReferencePhoto` including the new PNG/GIF/WebP fixture coverage (each format's valid header accepted, a one-byte-corrupted version of each rejected) and that `seedReferencePhotos.ts` still seeds correctly after the `downloadFile` extraction. Performed directly by the orchestrator (same dispatch-infrastructure outage as T4-review, A22). PASS: ran `test/referencePhotos.test.ts` for real — 23/23 pass. Independently mutation-proved the GIF branch specifically (not just trusting the builder's own fixtures): changed `imageSignature.ts`'s `'GIF89a'` check to `'XIF89a'`, re-ran — "accepts a valid GIF header" failed exactly as expected (`expected false to be true`), confirming the test genuinely depends on the real signature; restored the file (`diff` confirmed byte-identical), re-ran — 23/23 pass again. | tester | T4 | complete | 0 | | 2026-10-06T06:09:00Z | 2026-10-06T06:17:00Z | 20 | | null | null | no |
| T5-review | Review T5 (`referenceSourcingOrchestrator.ts`'s `sourceMissingReferenceIfNeeded`/`createReferenceSourcer`, the one call site added to `partIdentification.ts`'s `identifyListingParts`, `referencePhotoLookup.ts`'s new `hasReferencePhotoForExactMatch`) against Requirements 1/5/6/7/8 and the Standing Checks — confirm the per-call attempt counter (A16's closure-scoped `attemptsUsed`) cannot leak across concurrent `identify-parts` requests, and that a just-sourced photo is genuinely picked up by that same call's second pass (Requirement 5). | reviewer | T5 | complete | 0 | | 2026-10-06T05:11:14Z | 2026-10-06T05:45:16Z | 20 | 2026-10-06T05:11:14Z | 15000 | null | no |
| T5-test | Test T5's orchestrator and wiring: Requirement 1's trigger conditions (brand-only/partNumber-only parts never trigger; both-known-and-unseeded does), Requirement 6's already-attempted skip, Requirement 7's `MAX_SOURCING_ATTEMPTS_PER_CALL` cap (and that a separate call gets its own full budget per A16), Requirement 5's same-call second-pass pickup, and that `partIdentification.test.ts`'s default `setOmpSourcingRunnerOverride` (A17) genuinely prevents every existing test from reaching the real sourcing path. | tester | T5 | complete | 0 | | 2026-10-06T05:11:14Z | 2026-10-06T05:45:16Z | 25 | 2026-10-06T05:11:14Z | 38000 | null | no |
| U1 | UAT: PASS. Performed directly by the orchestrator (A22 — `feature-uat-tester-medium` unavailable to dispatch, same persistent infrastructure outage). Seeded this fresh worktree's real database with the full 14-entry reference library, built and started `apps/server` for real (Node 22, compiled `dist/index.js`, port 3002). **Primary proof (Requirements 1-6), called the real exported `createReferenceSourcer()` directly with a genuine unseeded identity** (`category: 'PSU', brand: 'Seasonic', partNumber: 'FOCUS GX-750'` — a real product with zero existing reference row): the real, unstubbed, tools-enabled `omp` call genuinely browsed the web and found `https://seasonic.com/wp-content/uploads/2024/04/FOCUS-PX-GX-back-panel-angled.webp` — the manufacturer's own real official domain, not a reseller (Requirement 2) — took 87.9s end to end; the server downloaded and verified it itself (`file` confirms real WebP image data, not trusting `omp`'s claim — Requirement 3); inserted with `source: 'auto_sourced'` (Requirement 4); the attempt was recorded (Requirement 6). Called the same sourcer a second time for the identical combination: 94ms (vs 87.9s), zero new `omp` call, row count stayed at 1 — Requirement 6's cache genuinely prevents a real repeat attempt, not just in unit tests. **Secondary proof (pipeline integrity): a real `POST /api/listings/:id/identify-parts` HTTP call** (real listing, real omp calls, no stubs) on a listing naming a Montech case with no photos completed cleanly in 20.9s (HTTP 200, no crash) — correctly did *not* trigger sourcing, since neither identified part met Requirement 1's actual (narrow) trigger shape (a confident primary identity *with* candidates still present) in this specific case, confirming the full real pipeline (pass 1 → orchestrator check → pass 2) runs end to end without error even when sourcing's narrow condition isn't met. Requirement 7/8 (per-call attempt cap, sourcing-call timeout) cited from T5-test's existing mutation-proven unit coverage, not independently re-exercised live — forcing 3+ simultaneous genuinely-unseeded real brands into one live call within reasonable time wasn't attempted. Standing gate cited from Cycle 0's already-confirmed result (443 tests, ESLint clean, 443 ≥ BaselineTests 384), not re-run. Cleanup: removed the two throwaway orchestrator-probe scripts, stopped the port-3002 server (confirmed down), removed all scratch/tmp files; `git status --short` shows only this feature's own already-tracked changes — the UAT-created Source/Listing/Seasonic-reference rows were left in this worktree's own local, gitignored `data/pc-parts-flipper.duckdb`, the same precedent `ai-visual-identification`'s own UAT set for exercising against a worktree's real database. | uat | T1, T2, T3, T4, T5 | complete | 0 | | 2026-10-06T06:19:00Z | 2026-10-06T06:25:00Z | 25 | 2026-10-06T06:19:00Z | null | null | no |

## Assumptions
- A1 (cycle 0): Sourcing only ever triggers off a part's own primary `brand`/`partNumber` — never off
  an `identityCandidates` entry. Sourcing a photo for every one of a part's several guessed candidates
  would multiply cost for a case the lookup already handles today (comparing against whatever the
  library already has for each candidate brand); this feature targets the specific, narrower gap —
  the part's own already-claimed identity having no reference at all.
- A2 (cycle 0): A failed sourcing attempt is never retried later (no expiry/TTL on
  `part_reference_sourcing_attempts`) — matches the user's own preference for the narrower, more
  conservative scope over the two forks asked this session. Clearing a specific row from that table by
  hand is the only way to force a re-attempt, if a manufacturer's site that failed once becomes
  reachable again later.
- A3 (cycle 0): The server can independently verify that a sourced URL is a real, decodable image
  (Requirement 3) but **cannot** independently verify the URL's domain is genuinely the real
  manufacturer's own site, as opposed to a reseller or an impersonator serving a photo from their own
  CDN — there is no canonical manufacturer-domain registry to check against. The "manufacturer's own
  site only" restriction (Requirement 2) is a prompt instruction trusted to the model's own browsing
  judgment; image-realness is the only half of this that gets independent server-side enforcement.
- A4 (cycle 0): `MAX_SOURCING_ATTEMPTS_PER_CALL` and `DEFAULT_OMP_SOURCING_TIMEOUT_MS`'s exact values
  are engineering judgment, to be set (and adjusted if real observed call timing during T5's build
  makes them clearly too slow or too thin) by the builder — named constants, not scattered magic
  numbers, the same way `MAX_REFERENCE_PHOTOS_PER_PART`/`MAX_TOTAL_REFERENCE_PHOTOS_PER_CALL` already
  are in this feature's predecessor.
- A5 (cycle 0): Mislabel detection (comparing a part's claimed model against other models of the same
  brand already in the library) is confirmed already correct in the existing code —
  `findReferencePhotosForLeads` filters on `brand` alone with no `partNumber` requirement when a lead
  has a non-null brand — and is explicitly out of scope for this feature; no task touches it.
- A6 (cycle 0, T1): `id UUID PRIMARY KEY` was added to `part_reference_sourcing_attempts` even
  though the task's literal column list omitted it, per schema.ts's own convention that every table
  uses an application-generated UUID primary key for concurrent-insert safety.
- A7 (cycle 0, T1): `recordSourcingAttempt` logs at Info in both the newly-recorded and
  already-recorded-skip branches, matching the Standing Check's Requirement 6 skip-logs-at-Info rule.
- A8 (cycle 0, T2): `DEFAULT_OMP_SOURCING_TIMEOUT_MS` set to 300_000ms (5 minutes), 2.5x the
  existing 120s identification default — a reasoned estimate (no real omp sourcing call timing
  exists yet to measure against), justified in-code per Requirement 8.
- A9 (cycle 0, T2): The shared child-process helper extracted from `runOmpIdentification` is named
  `runOmpProcess(args, options, errorContext)` and exported from ompRunner.ts; `ompSourcingRunner.ts`
  defines its own narrower `OmpSourcingRunner` type (no `imagePaths` parameter) rather than reusing
  `OmpRunner`, since a sourcing call never attaches a photo.
- A10 (cycle 0, T3): `ComponentCategory` imported from `@pc-parts-flipper/shared` in
  `imageSourcingPrompt.ts`, matching `identificationPrompt.ts`'s existing import source.
- A11 (cycle 0, T4): `downloadFile` extracted into a new sibling module `apps/server/src/db/download.ts`
  (not exported directly from seedReferencePhotos.ts) to avoid a circular import, since
  `insertSourcedReferencePhoto` (in `queries/referencePhotos.ts`) also needs it and
  `seedReferencePhotos.ts` already imports from `queries/referencePhotos.ts`.
- A12 (cycle 0, T4): No image-decoding dependency (sharp/image-size/file-type) exists in package.json
  and no existing real-bytes image verification exists anywhere in the repo, so a new
  `apps/server/src/db/imageSignature.ts` implements minimal magic-byte signature sniffing
  (JPEG/PNG/GIF/WebP) as the "genuine, decodable image" proof Requirement 3 demands.
- A13 (cycle 0, T4): The auto-sourced photo's filename is a SHA-256 hex digest of the source URL
  (plus extension), not a random `newId()`, so a repeat `insertSourcedReferencePhoto` call for the
  identical URL produces the identical `photo_path` and is correctly recognized as a duplicate by
  `insertReferencePhotoRow`'s existing unique index — a random filename would defeat that dedup.
- A14 (cycle 0, T5): `MAX_SOURCING_ATTEMPTS_PER_CALL` set to 3 — each sourcing call can take up to
  `DEFAULT_OMP_SOURCING_TIMEOUT_MS` (5 min) and they run sequentially, so this bounds a request's
  worst-case added wall time to ~15 min while still covering a listing with a couple of newly
  identified parts.
- A15 (cycle 0, T5): The exact-match existence check (`hasReferencePhotoForExactMatch`) was added to
  `referencePhotoLookup.ts` rather than `referencePhotos.ts`, since `referencePhotos.ts` was already
  at 214 lines (over the ~200 convention) and `referencePhotoLookup.ts` is already the "read queries
  for part_reference_photos" file.
- A16 (cycle 0, T5): The per-call attempt counter is scoped via a `createReferenceSourcer()` factory
  returning a closure over a local `attemptsUsed` counter, called once per `identifyListingParts`
  invocation — structurally impossible to share across concurrent requests, proven by a falsification
  test (hoisting the counter to module scope made the call-scoping test fail).
- A17 (cycle 0, T5): `partIdentification.test.ts` gained a default `setOmpSourcingRunnerOverride`
  returning `{"found":false,"url":null}` in its `beforeAll`/`afterEach` (no test body or assertion
  changed) — without it, an existing test identifying a part with both brand/partNumber known plus
  non-empty `identityCandidates` and no seeded exact-match row would now invoke the real `omp` binary
  under this feature's new wiring, violating the Standing Check that the suite never makes a real
  omp call.
- A18 (cycle 0 validation, T1): The only existing dedup test for
  `part_reference_sourcing_attempts` proved the unique-index skip with two *sequential* awaited
  `recordSourcingAttempt` calls, which cannot exercise a genuine race. Per the Standing Check
  requiring real-concurrent-request proof (the same bar `part_reference_photos` was held to), T1's
  tester added a `Promise.all`-based concurrent-insert test to `sourcingAttempts.test.ts` and proved
  it mutation-capable (killed by disabling the unique-constraint-violation catch) before restoring.
  No production code changed; this closes the gap directly rather than deferring it.
- A19 (cycle 0 validation, T4): `imageSignature.ts`'s `isDecodableImage` supports four formats
  (JPEG/PNG/GIF/WebP per A12) but the automated suite only ever exercises the JPEG branch (plus one
  generic non-matching-garbage negative) — confirmed by grepping `test/` for every PNG/GIF/WebP magic-
  byte literal the production code checks against (none found outside `imageSignature.ts` itself). The
  four byte sequences were independently verified correct against the real format specs today, but
  nothing in the suite would catch a future regression in the three untested branches (e.g. an
  off-by-one in the WebP `RIFF`/`WEBP` offsets, or a typo'd GIF literal) — `npm test` would stay green
  while either silently rejecting a genuine manufacturer PNG/GIF/WebP photo or silently accepting
  non-image bytes as verified. Left open for `feature-build-lead` to close (see must_fix below); not
  fixed during this validation pass since it requires new test fixtures, out of a tester's read-only-
  production-code scope for this cycle.
- A20 (cycle 0 validation): `npm run test` (full monorepo suite) produced intermittent `apps/server`
  suite-level failures (hook timeouts in `startTestServer`, `ECONNREFUSED`/`fetch failed` against
  fixed test ports) across three separate full/partial runs, each time hitting a *different* set of
  files never touched by this feature (`listings.test.ts`, `listingsAcceptReject.test.ts`,
  `purchases.test.ts`, `sales.test.ts`, `saleListings.test.ts`, `app-shell.test.ts`, `parts.test.ts`).
  Confirmed pre-existing and environmental, not a regression: `git stash -u`'d this feature's entire
  diff back to the pre-feature commit and re-ran `apps/server`'s suite standalone — the identical
  failure signature reproduced (`parts.test.ts`, `app-shell.test.ts`) with zero code from this feature
  present. Every test file this feature's five tasks own or touch passed 100% of the time across every
  run (reviewer/tester scoped runs and both full-suite runs). Not a must_fix for this feature.
- A21 (cycle 0 retry 1, T4): Closed the must_fix from A19 — added a new
  `describe('Reference Photos — isDecodableImage format coverage', ...)` block to
  `referencePhotos.test.ts` with 6 direct unit tests against `isDecodableImage()` (one accept +
  one one-byte-corrupted reject per PNG/GIF/WebP), mirroring the existing JPEG_BYTES/GARBAGE_BYTES
  fixture-byte-buffer pattern but calling `isDecodableImage` directly against small temp files
  (scoped under the file's existing `dataDir` temp dir) rather than going through the full
  HTTP-fixture-server + `insertSourcedReferencePhoto` round trip the JPEG test uses, since the gap
  was in the signature-detection function itself, not the download/insert path around it.
  Mutation-proof: each of the three new format branches in `imageSignature.ts` was temporarily
  disabled and confirmed to fail its new corresponding test, then the file was restored
  byte-for-byte. No production code changed. `imageSignature.ts` itself untouched — this closes
  the coverage gap only, per A19's own note that today's four byte sequences were already verified
  correct. Test count: +6 (apps/server local count 19 → 25 in the touched file; feature-wide total
  moves from 441 to 447).
- A22 (cycle 0 retry 1 validation): `feature-pm`, `feature-validate-lead`, and every
  `feature-reviewer-*`/`feature-tester-*`/`feature-uat-tester-*`/`feature-retrospective-*` agent
  (every agent definition whose `model:` field is a role alias other than literally `@medium` —
  `@high`, `@low`, `@reviewer-medium`, `@tester-medium`, `@builder-small`, ...) failed to dispatch
  with "Error: No model selected" across 5 separate attempts in this session, confirmed persistent
  (not transient): the same failure recurred after restarting this host's `__omp_worker_daemon_broker`
  processes and after the user restarted their own `omp` instance, while `scout`, `sonic`, and
  `feature-build-lead` (`model: '@medium'`) kept working throughout every attempt. The user confirmed
  this traces to a recent agent/role rename that the local role-alias resolution hasn't caught up
  with. T4's review and test (and, depending how long this persists, later validation/UAT/retrospective
  passes too) are performed directly by the orchestrator instead — same verification rigor (real test
  runs, real mutation-proofs via break/restore on production code, real full-suite/lint runs) — rather
  than blocking on infrastructure outside this feature's or this repo's control.


## Cycle Log
### Cycle 0
Trigger: initial

- feature-pm is not available as a spawnable agent in this environment (only
  `feature-reviewer-*`/`feature-tester-*`); dashboard refresh was skipped for this validation pass.
- `skills/feature/bin/measure-child-cost.py` does not exist anywhere in this repo/environment;
  `actual_tokens` is recorded as `null` for every T1-T5 review/test row per the "never substitute a
  guess" rule — each row's `estimated_tokens` is the self-reported figure from the dispatched agent.

Standing gate — whole suite: `npm run lint` is clean (0 violations, confirmed twice). `npm run
test` is green for every file this feature owns (`sourcingAttempts`, `ompSourcingRunner`,
`imageSourcing`, `referencePhotos`, `seedReferencePhotos`, `referenceSourcingOrchestrator`,
`partIdentification` — 100% pass across every run). The handful of failures seen in full-suite runs
are pre-existing environmental flakiness (A20), reproduced identically on pre-feature baseline code
with this feature's diff fully stashed — not a new failure introduced by T1-T5.

Standing gate — coverage: static test count (`vitest list`, deterministic, unaffected by runtime
flakiness) is 326 (`apps/server`) + 110 (`apps/web`) + 5 (`packages/shared`) = 441, up from
`BaselineTests` (384). No shrinkage; nothing was combined or deleted.

Verdict: FAIL. 1 must_fix (T4) routed back to feature-build-lead; T1-T3, T5 clean (T1's own
concurrency-proof gap was closed in-cycle by T1-test itself, recorded as A18, not a must_fix).

Retries: T4 retried in place (cycle 0 retry 1) — the must_fix is confined to T4's own file
(`imageSignature.ts`'s untested PNG/GIF/WebP branches), and this is T4's first failure this cycle, so
it retries in place rather than opening a new cycle.


Validation (cycle 0 retry 1): performed directly by the orchestrator (A22 — feature-validate-lead and
its reviewer/tester specialists were unavailable to dispatch). T4-review and T4-test (above) both
PASS, no must_fix. Standing gate re-run in full: `npm run lint` clean, zero violations. Full
`npm run test`: `apps/server` 328 tests (312 passed, 16 skipped, 0 genuinely failed), `apps/web`
110/110, `packages/shared` 5/5 — 443 total vs `BaselineTests` 384, coverage rose, no shrinkage. One
full-suite run showed 3 files (`photoServing.test.ts`, `purchases.test.ts`, `saleListings.test.ts` —
none touched by this feature) failing together; each re-run in isolation passed cleanly
(`saleListings.test.ts` needed a fully-solo run after a 3-file batch still showed one ECONNREFUSED,
then passed 9/9 alone) — the same resource-contention pattern this feature's own A20 already
documented, not a regression.

Verdict: PASS. No outstanding must_fix on any task (T1-T5 all clean). Cycle 0 closes here.


UAT (performed directly by the orchestrator, A22): PASS. Real, unstubbed, tools-enabled `omp`
sourcing call genuinely browsed to `seasonic.com` (the real manufacturer's own domain) and found a
real product photo for a genuinely unseeded brand/model (Seasonic FOCUS GX-750); server-side
download+verify+insert confirmed with `source: 'auto_sourced'` (Requirements 1-4). A second call for
the identical identity took 94ms instead of 87.9s and inserted no duplicate — Requirement 6's cache
proven live, not just in unit tests. A real end-to-end `identify-parts` HTTP call completed cleanly
(20.9s, HTTP 200) with no crash. Full details in U1's own row above. See Cycle Log "Verdict: PASS"
line below for the close-out.

