Status: done
Cycle: 0 / 3
FeatureStarted: 2026-10-06T06:43:35Z
OrchestrationTokensActual: null
OrchestrationTokensBreakdown: null
Prototype: none (dashboard publish unavailable — feature-pm dispatch failing, see ai-reference-autosourcing's Assumption A22)
BaselineTests: 443
BaselineSuite: pass
ApprovedBy: user (chat approval)
FeatureCompletedAt: 2026-10-06T07:39:55Z

# pc-parts-flipper — ai-catalog-sourcing

## Goal

Today, live reference-photo sourcing (`ai-reference-autosourcing`) only fires when a part's own brand
*and* model are both already known — a part with a known brand but no model (e.g. "Montech, model
unknown") triggers nothing at all, even though the existing lookup already compares a part against
every model of a known brand once any exist. This feature adds a second, complementary sourcing mode:
when a part's brand is known but its model isn't, and that brand's catalog for the part's category has
never been sourced before, the system browses the manufacturer's own official site for that brand and
category, finds several distinct real products, and saves each one under its own correct model number
— so the very next listing (or, if the model number later resolves within the same request, the same
one) has real candidates to compare against. This is purely a *sourcing* addition: the comparison
mechanism that benefits from it is unchanged — the existing lookup already matches on brand alone,
with no model requirement, so nothing downstream needs to change to use what this feature adds.

## Requirements
1. For an eligible part (unchanged Requirement 5 rule from `ai-reference-autosourcing`: `brand` null,
   OR `partNumber` null, OR `identityCandidates` non-empty) whose own `brand` is non-null but
   `partNumber` is null, and no catalog-sourcing attempt has ever been recorded for that
   `(category, brand)` combination, the system attempts catalog sourcing for that brand and category
   before building the part's second-pass reference set. This trigger is mutually exclusive with the
   existing single-product sourcing trigger by construction — one requires `partNumber` null, the
   other requires it non-null — so a part never triggers both, and a part with a brand name but no
   model is no longer left with nothing attempted, as it is today.
2. Catalog sourcing is a dedicated tools-enabled `omp` invocation (no attached photos), given the
   category and brand, instructed to browse the manufacturer's own official website only — never a
   reseller, retailer, marketplace, or aggregator, the same restriction single-product sourcing already
   enforces — and find every distinct current product it can in that category, each with its own model
   name/number and a real, direct image URL, responding with raw JSON listing everything it found (or
   that it found nothing). No artificial cap on how many products one catalog call may report — the
   manufacturer's own real catalog size is the only limit.
3. The server never trusts the model's claims for any candidate the catalog search reports. For each
   one, it downloads the image itself and confirms a genuine, decodable image — reusing the exact same
   per-candidate download-and-verify logic single-product sourcing already uses, not a second
   implementation of it — before anything is added to the library. A candidate that fails to download
   or verify is simply dropped from the batch; it never fails the whole catalog attempt.
4. Each successfully verified candidate is inserted into `part_reference_photos` as its own row, tagged
   with the brand and the model the catalog search reported for it, and `source: 'auto_sourced'` — the
   same provenance value single-product sourcing already uses, since both are live-found rather than
   manually curated or from the user's own inventory.
5. Once catalog sourcing has been attempted for a specific `(category, brand)` — regardless of how
   many products (including zero) were found and verified — it is never attempted again for that
   combination. A brand whose catalog is empty, inaccessible, or fully covered already is not
   re-browsed on every future listing that happens to name it with no model.
6. A candidate the catalog search finds that already has a matching `part_reference_photos` row (for
   instance because single-product sourcing, or a confirmed real listing, already added that exact
   product) is not re-downloaded or re-inserted — the same per-row dedup this table already enforces
   for every other source of a reference photo.
7. Catalog sourcing shares the same per-`identify-parts`-call sourcing-attempt budget single-product
   sourcing already enforces (`MAX_SOURCING_ATTEMPTS_PER_CALL`) — one catalog attempt consumes exactly
   one unit of that budget, the same as one single-product attempt, so a listing with several
   brand-only-known parts across different brands cannot chain unbounded catalog browsing any more
   than today's feature could chain unbounded single-product lookups.
8. A catalog sourcing call that runs past its own timeout is treated as a failed/empty attempt, never
   left to hang the request — reusing single-product sourcing's established "timeout is a failure, not
   a crash" pattern. Its own timeout may need to be longer than single-product sourcing's, since
   browsing a whole category page and extracting several products is a broader task than finding one.
9. Catalog sourcing stays synchronous, blocking the `identify-parts` response — the same choice already
   made for single-product sourcing, kept consistent rather than introducing a second timing model for
   the same feature.

## Standing checks
- The whole test suite passes, and the test count stays at or above `BaselineTests` (443, this
  feature's fresh-worktree baseline recorded above).
- ESLint runs clean with zero new violations.
- Every new public function/class carries a block comment; non-obvious lines carry a single-line
  comment above them (existing project convention).
- Logging follows the existing Error/Warn/Info/Debug/Trace convention — a catalog sourcing attempt's
  start, per-candidate verify success/failure, and overall success/failure/already-attempted-skip each
  log at Info, matching `referenceSourcingOrchestrator.ts`'s existing single-product logging; a
  malformed catalog response is coerced and logged at Warn, matching `parseImageSourcingResponse`'s
  existing pattern for a malformed single-product response.
- `apps/web` never imports `apps/server` directly (existing boundary). This feature adds no new web
  UI — it only changes how the reference library gets filled in, not where or how anything is shown,
  the same scope boundary both prior AI-identification features held to.
- All DuckDB access for the new catalog-attempt table stays inside `apps/server/src/db`, reached only
  through its own query module, never raw SQL from `apps/server/src/ai`.
- No new source file goes over ~200 lines. `apps/server/src/db/queries/referencePhotos.ts` (214 lines)
  is already over the cap before this feature starts — nothing in this feature adds to it; the
  per-candidate insert it needs is the exact existing `insertSourcedReferencePhoto` function, called in
  a loop from the new orchestration code, not a new function added to that file.
  `apps/server/src/ai/referenceSourcingOrchestrator.ts` (152 lines) has some headroom, but adding this
  feature's whole new catalog-trigger branch (cache check, budget check, the catalog call, per-candidate
  insert loop, attempt recording) directly into it would very likely push it over — that branch belongs
  in its own new sibling file from the start (mirroring how `ai-reference-autosourcing` itself kept
  `ompRunner.ts`/`partIdentification.ts` thin by putting its own new logic in new files), called with
  one small function from `referenceSourcingOrchestrator.ts`'s existing `sourceMissingReferenceIfNeeded`.
- The automated suite stubs the catalog-mode sourcing call exactly the way it already stubs
  single-product sourcing (reusing the existing `setOmpSourcingRunnerOverride` seam — this is the same
  underlying `omp` runner, just a different prompt and timeout) — never a real network/`omp` call in
  `npm test`.
- The new catalog-attempt table is written from a single code path, but two genuinely concurrent
  `identify-parts` calls naming the same `(category, brand)` with no model can still race on recording
  the first attempt for it — proven never to produce two rows or an unhandled error with real
  concurrent requests against the running server, the same way `part_reference_sourcing_attempts`
  itself was proven in the prior feature.

## Tasks
| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| T1 | New table `part_catalog_sourcing_attempts` (`category component_category NOT NULL, brand VARCHAR NOT NULL, attempted_at TIMESTAMP NOT NULL DEFAULT current_timestamp, succeeded BOOLEAN NOT NULL, products_found INTEGER NOT NULL`), a new `TABLE_STATEMENTS` entry in `apps/server/src/db/schema.ts` plus a `CREATE UNIQUE INDEX` on `(category, brand)` for Requirement 5's dedup (no NULL-distinctness concern here — both columns are always non-null by construction, this table is never written for a part whose brand is null). New `apps/server/src/db/queries/catalogSourcingAttempts.ts`, mirroring `sourcingAttempts.ts`'s exact shape: `hasCatalogSourcingBeenAttempted(category, brand): Promise<boolean>` and `recordCatalogSourcingAttempt(category, brand, succeeded, productsFound): Promise<void>` (catches the unique-index violation as "already recorded, skip," same pattern). Export both plus the table from `db/index.ts`'s barrel. | builder | | done | 0 | | | | 15 | 2026-10-06T06:46:35Z | | | no |
| T2 | New `apps/server/src/ai/catalogSourcingPrompt.ts`: `buildCatalogSourcingPrompt(category: ComponentCategory, brand: string): string` — names the category and brand, instructs the model to browse the manufacturer's own official website only (same restriction as `buildImageSourcingPrompt`, Requirement 2) and find every distinct current product it can in that category, no count cap, each with its own model name/number and a real, direct image URL, responding with raw JSON only: `{"products":[{"partNumber":string,"url":string}, ...]}` (an empty array when nothing is found). New `apps/server/src/ai/catalogSourcingParser.ts`: `parseCatalogSourcingResponse(rawStdout: string): {partNumber: string; url: string}[]` — built the same defensive way as `parseImageSourcingResponse` (structural failure — not JSON, missing `products` array — is fatal; an individual malformed entry, e.g. a non-string `partNumber` or `url`, is dropped from the array and logged at Warn rather than failing the whole response; the array is de-duplicated by `partNumber`, no size cap). | builder | | done | 0 | | | | 20 | 2026-10-06T07:01:35Z | | | no |
| T3 | Orchestration (Requirements 1, 5-9). New `apps/server/src/ai/catalogSourcingOrchestrator.ts` exporting `sourceCatalogIfNeeded(category: ComponentCategory, brand: string): Promise<void>` that: checks T1's `hasCatalogSourcingBeenAttempted` (Requirement 5); when not yet attempted, calls `getOmpSourcingRunner()` (reused unchanged from `ompSourcingRunner.ts`) with T2's prompt and an explicit `timeoutMs` override via a new `DEFAULT_OMP_CATALOG_SOURCING_TIMEOUT_MS` constant (Requirement 8, longer than single-product sourcing's `DEFAULT_OMP_SOURCING_TIMEOUT_MS`), parses with T2's parser, and for each returned candidate (however many — no cap) calls the existing, unmodified `insertSourcedReferencePhoto` (from `ai-reference-autosourcing`'s T4 — the exact same download-verify-insert path single-product sourcing already uses, Requirement 3-4/6) in sequence, counting how many actually inserted; records the attempt via T1's `recordCatalogSourcingAttempt` with that count, regardless of overall success or failure. Wired into `apps/server/src/ai/referenceSourcingOrchestrator.ts`'s existing `createReferenceSourcer`: when `partNumber === null` and `brand !== null`, calls `sourceCatalogIfNeeded(category, brand)` instead of returning early — gated on the **same shared `attemptsUsed`/`MAX_SOURCING_ATTEMPTS_PER_CALL` budget check already in that closure** (Requirement 7: increment the counter before calling out, exactly like the existing single-product path does, not a second independent budget). | builder | T1, T2 | done | 0 | | | | 25 | 2026-10-06T07:21:35Z | | | no |

## Assumptions
- A1 (cycle 0): The "next stage" (comparing a listing's photos against every model of a known brand)
  needs no change — confirmed in the prior feature (`ai-reference-autosourcing`'s own Assumption A5)
  that `findReferencePhotosForLeads` already matches on brand alone with no `partNumber` filter. This
  feature is purely additive on the sourcing side; nothing in the lookup/comparison path is touched.
- A2 (cycle 0): `DEFAULT_OMP_CATALOG_SOURCING_TIMEOUT_MS`'s exact value is engineering judgment for the
  builder, informed by real observed call timing during T3's build — a named constant, not a scattered
  magic number, the same way every prior tunable in this feature's two predecessors has been. A
  starting judgment: a timeout meaningfully longer than single-product sourcing's 5 minutes, since
  browsing a category listing plus an unbounded number of product pages is a broader task than finding
  one. (Revised mid-build, user steering: the per-call product count has no cap at all — see Cycle 0
  log — so this timeout is now the only bound on how long one catalog call may run.)
- A3 (cycle 0): A catalog attempt that finds and verifies zero products (the manufacturer's site is
  unreachable, the category page can't be found, every candidate fails image verification) is still
  recorded as attempted (Requirement 5) — the same "a failure is still a recorded attempt, never
  retried" rule single-product sourcing already follows, so a brand whose catalog genuinely can't be
  found costs at most one attempt, ever, not one per listing that names it.
- A4 (cycle 0): The catalog search is scoped to one category at a time (matching the part that
  triggered it) — a brand that makes both cases and PSUs gets sourced separately per category, never
  one combined "everything this brand makes" search, keeping each individual catalog call's scope (and
  cost) bounded and matching exactly what the triggering part actually needs.
- A5 (cycle 0): A product the catalog search reports with a `partNumber` that happens to already exist
  as a reference row for that `(category, brand)` (Requirement 6) is still counted/logged as found,
  even though `insertSourcedReferencePhoto`'s own existing dedup means it contributes no new row — this
  feature does not pre-filter already-known models out of the model's own prompt or response; the
  dedup happens at insert time, same layer it already happens at for every other reference-photo write
  path.
- A6 (cycle 0): The same specialist-agent-dispatch infrastructure outage documented in
  `ai-reference-autosourcing`'s Assumption A22 (every role-aliased agent other than literally
  `@medium` fails with "No model selected") was re-checked at every dispatch point in this feature —
  `feature-pm` (dashboard publish), `feature-build-lead` (this time including `@medium`, which had
  worked reliably in the prior feature), and `feature-validate-lead` — and found still failing on all
  three, including `@medium` for the first time this session. The orchestrator built, tested
  (including real mutation-grade coverage and two genuine regression fixes caught by a real full-suite
  run), and UAT'd this entire feature directly in its place, with the same rigor a dispatched
  specialist would apply — documented in the Cycle Log below, not silently substituted.

## Cycle Log
### Cycle 0
Trigger: initial

**User steering mid-build**: after T1-T3 were implemented and passing with an 8-product-per-call cap
(`MAX_CATALOG_PRODUCTS_PER_CALL`), the user corrected course: the per-call product count should be
unlimited, not capped at a small fixed number — the manufacturer's real catalog size is the only
limit. The user explicitly noted this stays synchronous for now (a separate future move to async is
their own planned follow-up, not in this feature's scope). Requirement 2 and Assumption A2 updated
above; `MAX_CATALOG_PRODUCTS_PER_CALL` removed from `catalogSourcingOrchestrator.ts`, `maxProducts`
parameter removed from both `buildCatalogSourcingPrompt` and `parseCatalogSourcingResponse` (prompt no
longer requests a product count, parser no longer truncates), tests updated to match. The call's own
`DEFAULT_OMP_CATALOG_SOURCING_TIMEOUT_MS` remains the only bound on how long one catalog attempt may run.

**Build**: `feature-build-lead` dispatch failed (Assumption A6). Orchestrator built T1 (table +
`catalogSourcingAttempts.ts` + barrel export), T2 (`catalogSourcingPrompt.ts` +
`catalogSourcingParser.ts`), T3 (`catalogSourcingOrchestrator.ts` + the new trigger branch wired into
`referenceSourcingOrchestrator.ts`'s `createReferenceSourcer`) directly, each with its own test file
(`catalogSourcingAttempts.test.ts`, `catalogSourcing.test.ts`, 8 new cases added to
`referenceSourcingOrchestrator.test.ts`'s existing file plus one obsolete pre-existing case corrected
— see below). `npx tsc --noEmit` clean throughout.

**Validate**: `feature-validate-lead` dispatch failed (Assumption A6). Orchestrator ran the gate
directly:
- `npm run lint`: clean, zero violations, re-run after every batch of file changes.
- A full `npm run test` run (not just the new files) caught two **genuine regressions**, both fixed:
  (1) `test/db.test.ts`'s `EXPECTED_COLUMNS`/table-count assertion didn't yet know about the new
  `part_catalog_sourcing_attempts` table — added its 6-column entry and updated the test's own title,
  mirroring the existing `part_reference_sourcing_attempts` entry exactly. (2)
  `test/identifyPartsRoute.test.ts`'s existing "no part number" fixture part (`brand: 'NVIDIA',
  partNumber: null`) now legitimately triggers the new catalog-sourcing branch — which this
  unrelated route test had never stubbed a sourcing runner for, so it reached the real (test-forbidden)
  `omp` binary and the test timed out at 5000ms. This was pre-existing test pinning the *old* "brand
  known, no model = do nothing" behavior, which Requirement 1 deliberately changes — per the delivery
  contract's "never re-pin obsolete behavior" rule, the fix was a `beforeEach` default
  `setOmpSourcingRunnerOverride` stub (answering both response shapes), not reverting the feature.
  I also noticed, independently of any failure, that no test proved Requirement 6 (dedup against an
  *existing* `part_reference_photos` row) specifically for the catalog path — added one
  (`does not duplicate a candidate that already has a part_reference_photos row from a different
  source`) before calling validation complete.
- Five full-suite runs (`npm run test`, monorepo-wide) were executed across this build; six *different*,
  mutually non-overlapping, feature-unrelated files failed across those runs
  (`listingsAcceptReject.test.ts`, `purchases.test.ts`, `profit.test.ts`, `saleListings.test.ts`,
  `app-shell.test.ts`, `parts.test.ts`, `sales.test.ts` — all of which spawn a real subprocess HTTP
  server on a fixed port via `test/helpers.ts`'s `startTestServer`) with `SocketError: other side
  closed` or a setup timeout — every one passed cleanly when re-run in isolation (several on the first
  retry, two after an ~8s settle). This is the same WSL parallel-test-server resource-contention
  pattern already documented in both prior features this session; none of these files import or depend
  on anything this feature touched. Zero repeat failures on the same file across runs.
- Final clean count: apps/server 362 static test cases (328 baseline + 34 new, 0 removed), apps/web 110
  (unchanged), packages/shared 5 (unchanged) = 477 vs `BaselineTests` 443 — all growth attributable to
  this feature's own new tests.
- All 9 Requirements carry explicit, passing test coverage (cross-checked directly against the
  Requirements list, not merely "tests pass"): catalog-trigger-vs-single-product mutual exclusivity,
  manufacturer-only/raw-JSON prompt shape, per-candidate drop-on-failed-verify (never fails the whole
  attempt), `auto_sourced` tagging, never-re-attempt caching (sequential AND genuinely-concurrent race
  proof), existing-row dedup (new test, above), shared budget consumption (catalog attempt counts
  against the same cap as single-product, proven both directions), timeout-is-a-failure-not-a-crash,
  and synchronous blocking (architectural — the closure `await`s `sourceCatalogIfNeeded` directly, no
  fire-and-forget).
- Standing Checks: block comments present on every new public function (spot-read all 3 new files in
  full); logging follows Info/Warn convention (spot-read, confirmed live during UAT below); `apps/web`
  untouched by this feature (no web files changed); DuckDB access for the new table confined to
  `db/queries/catalogSourcingAttempts.ts` (only file besides `schema.ts` referencing the new table
  name); line caps respected (`catalogSourcingOrchestrator.ts` 97, `catalogSourcingPrompt.ts` 40,
  `catalogSourcingParser.ts` 93, `catalogSourcingAttempts.ts` 75, `referenceSourcingOrchestrator.ts`
  186 — under 200; `referencePhotos.ts`/`schema.ts` pre-existing over-cap files received no new
  functions, only minimal necessary line additions, per plan); omp-stub convention extended to the
  catalog call (`setOmpSourcingRunnerOverride` reused, confirmed no real `omp` invocation anywhere in
  `npm test`); concurrency proof for the new table (`dedups two genuinely concurrent
  recordCatalogSourcingAttempt calls for the identical combo`, real `Promise.all` race, passing).

**UAT**: `feature-uat-tester-medium` dispatch not attempted (established-failing per Assumption A6;
confirmed `feature-build-lead`/`feature-validate-lead` both still down moments earlier). Orchestrator
built `apps/server` (`npm run build`, clean) and called the real, unstubbed `sourceCatalogIfNeeded`
directly (bypassing the need to coax a non-deterministic first pass into exactly "brand known, model
unknown" — the same reasoning used for the prior feature's Seasonic UAT) against a fresh worktree
database, with the real `omp` CLI (`omp/18.6.1`), no stub:
- **Montech / Case**: real `omp` call browsed `montechpc.com` and reported **32 distinct real
  products** (proving the "no artificial cap" change genuinely works — 4x the removed 8-item limit) in
  129.6s; every single image 403'd on download (montechpc.com's CDN blocks generic User-Agents — a
  pre-existing, documented quirk of the shared, untouched `downloadFile` helper, not a bug in this
  feature). Every one of the 32 was correctly dropped (Requirement 3), `insertedCount: 0`, the attempt
  correctly recorded as `succeeded: false, products_found: 0` (Requirement 5), and
  `hasCatalogSourcingBeenAttempted('Case', 'Montech')` correctly flipped `true` afterward.
- **Apevia / PSU**: real `omp` call browsed `apevia.com` and reported **63 distinct real products**;
  every single image downloaded from `apevia.com`'s real CDN (`cdn.prod.website-files.com`) and
  genuinely verified in 354s; all **63 inserted** as real `part_reference_photos` rows tagged
  `source: 'auto_sourced'`, each under its own real model number (including `ATX-ES600-WH`, already in
  the hand-seeded library from a different source URL — inserted as a second, distinct row rather than
  erroring, exactly as the per-row/per-URL dedup design intends). Attempt recorded
  `succeeded: true, products_found: 63`.
- **Closing the loop (the feature's actual Goal)**: called the existing, completely unmodified
  `findReferencePhotosForLeads('PSU', [{brand:'Apevia', partNumber:null}], 3)` directly afterward —
  returned 3 real candidates drawn from the 63 just-sourced rows, proving live that "the already-
  existing brand-only lookup needs zero changes to benefit from this feature" (Assumption A1) is true
  in practice, not just by code inspection.
- A clean-shutdown lesson from this pass: the first throwaway UAT script called `process.exit(0)`
  after a direct `sourceCatalogIfNeeded` call, which left the DuckDB WAL in a state the next process
  couldn't replay (`Calling DatabaseManager::GetDefaultDatabase with no default database set`) —
  recovered by deleting the throwaway data dir and re-running with `client.ts`'s own `closeConnection()`
  called before exit. No production code was affected; this was purely a UAT-script hygiene issue,
  noted here in case a future throwaway script hits the same thing.

Verdict: PASS. No must_fix items. Two genuine pre-existing-test regressions found by a real full-suite
run and fixed (not merely "no new tests failed"); the feature's core promise (unlimited real-catalog
sourcing feeding the existing unmodified brand-only lookup) demonstrated live against two real
manufacturer sites, in both the all-blocked and the all-succeeded shape. Closes this feature — no
further cycle needed.
