Status: proposed
Cycle: 0 / 3
FeatureStarted: 2026-10-06T04:03:28Z
OrchestrationTokensActual: null
OrchestrationTokensBreakdown: null
Prototype: .claude/feature/ai-reference-autosourcing/dashboard.html (local file — no hosted-publish capability on this host, so there is no live URL)
BaselineTests: 384
BaselineSuite: pass

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
| T1 | New table `part_reference_sourcing_attempts` (`category component_category NOT NULL, brand VARCHAR NOT NULL, part_number VARCHAR NOT NULL, attempted_at TIMESTAMP NOT NULL DEFAULT current_timestamp, succeeded BOOLEAN NOT NULL`), a new `TABLE_STATEMENTS` entry in `apps/server/src/db/schema.ts` plus a `CREATE UNIQUE INDEX` on `(category, brand, part_number)` for Requirement 6's dedup — `part_number` is `NOT NULL` here (Requirement 1 only ever triggers sourcing when a part's own model is already known), so this table never hits the NULL-distinctness problem `part_reference_photos`'s own dedup index had to work around; the unique index alone is sufficient, no atomic-insert workaround needed. Add `source: 'seed' \| 'confirmed_listing' \| 'auto_sourced'` to `ReferencePhoto` in `apps/server/src/db/types.ts` (Requirement 4). New `apps/server/src/db/queries/sourcingAttempts.ts` exporting `hasSourcingBeenAttempted(category, brand, partNumber): Promise<boolean>` and `recordSourcingAttempt(category, brand, partNumber, succeeded): Promise<void>` (catches the unique-index violation as "already recorded, skip" — same pattern as the prior feature's dedup inserts, Requirement 6/the concurrency Standing Check). Export both plus the table from `db/index.ts`'s barrel. | builder | | not_started | 0 | | | | 20 | | | | no |
| T2 | New `apps/server/src/ai/ompSourcingRunner.ts`, a sibling to `ompRunner.ts` kept separate per the Standing Checks' line-count note: `runOmpImageSourcing(promptText: string, options?: OmpRunOptions): Promise<string>` — same spawn/timeout/kill-process-group machinery as `runOmpIdentification` (reuse its internals via a small shared helper rather than copy-pasting the whole function), but builds its argv *without* `--no-tools` (tools enabled, so the model can browse) and with **no** `@<path>` image arguments at all — this call never attaches a photo, it searches the web. Give it its own default timeout constant, `DEFAULT_OMP_SOURCING_TIMEOUT_MS`, longer than the existing `DEFAULT_OMP_TIMEOUT_MS` (Requirement 8 — a browsing call is expected to run longer than a no-tools analysis call). Add the matching test seam: `setOmpSourcingRunnerOverride`/`getOmpSourcingRunner`, mirroring `ompRunner.ts`'s existing pair exactly, so the suite never makes a real call here either (Standing Check). | builder | | not_started | 0 | | | | 20 | | | | no |
| T3 | New `apps/server/src/ai/imageSourcingPrompt.ts`: `buildImageSourcingPrompt(category: ComponentCategory, brand: string, partNumber: string): string` — names the exact product and instructs the model to find one real, direct image URL of it from the manufacturer's own official website only (never a reseller, retailer, marketplace, or aggregator — Requirement 2), responding with raw JSON only: `{"found":boolean,"url":string\|null}`. New `apps/server/src/ai/imageSourcingParser.ts`: `parseImageSourcingResponse(rawStdout: string): {found: boolean; url: string \| null}` — built the same defensive way as `parseIdentificationResponse`/`parseVisualComparisonResponse` (structural failure — not JSON, missing `found` — is fatal; a malformed `url` field when `found` is true is coerced to `{found: false, url: null}` and logged at Warn, never trusted as-is). | builder | | not_started | 0 | | | | 15 | | | | no |
| T4 | Download-and-insert logic for a sourced photo (Requirement 3-4). Extract `seedReferencePhotos.ts`'s existing `downloadFile` into an exported, reusable function (its own small module, or exported directly from `seedReferencePhotos.ts` and imported from there — either way, one real implementation, not two) so this feature's new code reuses the exact same real-bytes-verified download logic instead of a second copy (the Standing Checks call this out explicitly). New `insertSourcedReferencePhoto(category: ComponentCategory, brand: string, partNumber: string, url: string): Promise<{inserted: boolean}>` in `apps/server/src/db/queries/referencePhotos.ts` (reusing the existing `insertReferencePhotoRow` helper with `source: 'auto_sourced'`, `listingId: null`) that downloads the given URL to a collision-safe filename under `data/reference-photos/auto-sourced/` (new subdirectory, same `DATA_DIR`-relative convention as `reference-photos/seed/`), verifies the download is a real decodable image, and only then inserts the row — returns `{inserted: false}` without inserting anything when the download fails or isn't a real image, never partially committing a broken reference. | builder | T1 | not_started | 0 | | | | 20 | | | | no |
| T5 | Orchestration (Requirements 1, 5-8): new `apps/server/src/ai/referenceSourcingOrchestrator.ts` exporting one function, `sourceMissingReferenceIfNeeded(part): Promise<void>`-shaped (exact signature to the builder — it needs the part's category/brand/partNumber and must be callable once per eligible part), that: checks Requirement 1's trigger (own brand and partNumber both non-null, no matching `part_reference_photos` row); checks T1's `hasSourcingBeenAttempted` (Requirement 6) and the per-call attempt counter against a new `MAX_SOURCING_ATTEMPTS_PER_CALL` constant (Requirement 7) before doing anything; when eligible, calls T2's sourcing runner with T3's prompt (own `DEFAULT_OMP_SOURCING_TIMEOUT_MS`, Requirement 8), parses with T3's parser, and on a found+verified result calls T4's insert function; records the attempt's outcome via T1's `recordSourcingAttempt` regardless of success or failure. Wire this into `apps/server/src/ai/partIdentification.ts`'s `identifyListingParts`: call it for each eligible part *before* that part's `findReferencePhotosForLeads` lookup runs, so a just-inserted photo is picked up by the very same call's second pass (Requirement 5) — this is the one, small call site `identifyListingParts` gains; the rest of the new sequence lives in the new file per the Standing Checks' line-count note. | builder | T1, T2, T3, T4 | not_started | 0 | | | | 25 | | | | no |

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

## Cycle Log
### Cycle 0
Trigger: initial
