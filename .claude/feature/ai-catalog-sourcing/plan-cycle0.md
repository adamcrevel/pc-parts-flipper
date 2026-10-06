Status: proposed
Cycle: 0 / 3
FeatureStarted: 2026-10-06T06:43:35Z
OrchestrationTokensActual: null
OrchestrationTokensBreakdown: null
Prototype: none (dashboard publish unavailable — feature-pm dispatch failing, see ai-reference-autosourcing's Assumption A22)
BaselineTests: 443
BaselineSuite: pass

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
   enforces — and find up to a small fixed number of distinct current products in that category, each
   with its own model name/number and a real, direct image URL, responding with raw JSON listing
   everything it found (or that it found nothing).
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
| T1 | New table `part_catalog_sourcing_attempts` (`category component_category NOT NULL, brand VARCHAR NOT NULL, attempted_at TIMESTAMP NOT NULL DEFAULT current_timestamp, succeeded BOOLEAN NOT NULL, products_found INTEGER NOT NULL`), a new `TABLE_STATEMENTS` entry in `apps/server/src/db/schema.ts` plus a `CREATE UNIQUE INDEX` on `(category, brand)` for Requirement 5's dedup (no NULL-distinctness concern here — both columns are always non-null by construction, this table is never written for a part whose brand is null). New `apps/server/src/db/queries/catalogSourcingAttempts.ts`, mirroring `sourcingAttempts.ts`'s exact shape: `hasCatalogSourcingBeenAttempted(category, brand): Promise<boolean>` and `recordCatalogSourcingAttempt(category, brand, succeeded, productsFound): Promise<void>` (catches the unique-index violation as "already recorded, skip," same pattern). Export both plus the table from `db/index.ts`'s barrel. | builder | | not_started | 0 | | | | 15 | | | | no |
| T2 | New `apps/server/src/ai/catalogSourcingPrompt.ts`: `buildCatalogSourcingPrompt(category: ComponentCategory, brand: string, maxProducts: number): string` — names the category and brand, instructs the model to browse the manufacturer's own official website only (same restriction as `buildImageSourcingPrompt`, Requirement 2) and find up to `maxProducts` distinct current products in that category, each with its own model name/number and a real, direct image URL, responding with raw JSON only: `{"products":[{"partNumber":string,"url":string}, ...]}` (an empty array when nothing is found). New `apps/server/src/ai/catalogSourcingParser.ts`: `parseCatalogSourcingResponse(rawStdout: string, maxProducts: number): {partNumber: string; url: string}[]` — built the same defensive way as `parseImageSourcingResponse` (structural failure — not JSON, missing `products` array — is fatal; an individual malformed entry, e.g. a non-string `partNumber` or `url`, is dropped from the array and logged at Warn rather than failing the whole response; the array is capped at `maxProducts` and de-duplicated by `partNumber`, logging a Warn if the model returned more than the cap). | builder | | not_started | 0 | | | | 20 | | | | no |
| T3 | Orchestration (Requirements 1, 5-9). New `apps/server/src/ai/catalogSourcingOrchestrator.ts` exporting `sourceCatalogIfNeeded(category: ComponentCategory, brand: string): Promise<void>` that: checks T1's `hasCatalogSourcingBeenAttempted` (Requirement 5); when not yet attempted, calls `getOmpSourcingRunner()` (reused unchanged from `ompSourcingRunner.ts`) with T2's prompt and an explicit `timeoutMs` override via a new `DEFAULT_OMP_CATALOG_SOURCING_TIMEOUT_MS` constant (Requirement 8, longer than single-product sourcing's `DEFAULT_OMP_SOURCING_TIMEOUT_MS`), parses with T2's parser, and for each returned candidate calls the existing, unmodified `insertSourcedReferencePhoto` (from `ai-reference-autosourcing`'s T4 — the exact same download-verify-insert path single-product sourcing already uses, Requirement 3-4/6) in sequence, counting how many actually inserted; records the attempt via T1's `recordCatalogSourcingAttempt` with that count, regardless of overall success or failure. Wire this into `apps/server/src/ai/referenceSourcingOrchestrator.ts`'s existing `createReferenceSourcer`: where `sourceMissingReferenceIfNeeded` currently returns early when `partNumber === null` (its line 110-112 guard), call `sourceCatalogIfNeeded(category, brand)` instead when `brand !== null` — gated on the **same shared `attemptsUsed`/`MAX_SOURCING_ATTEMPTS_PER_CALL` budget check already in that closure** (Requirement 7: increment the counter before calling out, exactly like the existing single-product path does, not a second independent budget). | builder | T1, T2 | not_started | 0 | | | | 25 | | | | no |

## Assumptions
- A1 (cycle 0): The "next stage" (comparing a listing's photos against every model of a known brand)
  needs no change — confirmed in the prior feature (`ai-reference-autosourcing`'s own Assumption A5)
  that `findReferencePhotosForLeads` already matches on brand alone with no `partNumber` filter. This
  feature is purely additive on the sourcing side; nothing in the lookup/comparison path is touched.
- A2 (cycle 0): `maxProducts` (the per-catalog-call product cap) and
  `DEFAULT_OMP_CATALOG_SOURCING_TIMEOUT_MS`'s exact values are engineering judgment for the builder,
  informed by real observed call timing during T3's build — named constants, not scattered magic
  numbers, the same way every prior tunable in this feature's two predecessors has been. A starting
  judgment: 8 products, and a timeout meaningfully longer than single-product sourcing's 5 minutes,
  since browsing a category listing plus several product pages is a broader task than finding one.
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
  as a reference row for that `(category, brand)` (Requirement 6) is still counted toward
  `maxProducts`/logged as found, even though `insertSourcedReferencePhoto`'s own existing dedup means it
  contributes no new row — this feature does not pre-filter already-known models out of the model's own
  prompt or response; the dedup happens at insert time, same layer it already happens at for every
  other reference-photo write path.

## Cycle Log
### Cycle 0
Trigger: initial
