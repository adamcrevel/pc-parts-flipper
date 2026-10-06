Status: proposed
Cycle: 0 / 3
FeatureStarted: 2026-10-05T16:46:02Z
OrchestrationTokensActual: null
OrchestrationTokensBreakdown: null
Prototype: .claude/feature/ai-visual-identification/dashboard.html (local file — no hosted-publish capability on this host, so there is no live URL)
BaselineTests: 313
BaselineSuite: pass

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
| T1 | New table `part_reference_photos` (`id UUID PK, category component_category NOT NULL, brand VARCHAR NOT NULL, part_number VARCHAR, photo_path VARCHAR NOT NULL, source VARCHAR NOT NULL` — `'seed'` or `'confirmed_listing'` — `, listing_id UUID REFERENCES listings(id)` nullable (null for seed rows), `created_at TIMESTAMP NOT NULL DEFAULT current_timestamp`), added as a new `TABLE_STATEMENTS` entry in `apps/server/src/db/schema.ts` (after `listings`, since it FK-references it) plus two new `INDEX_STATEMENTS`: `idx_reference_photos_category_brand ON part_reference_photos(category, brand)` for lookup, and a `CREATE UNIQUE INDEX` on `(category, brand, part_number, photo_path)` for Requirement 4's dedup (DuckDB treats multiple NULLs as distinct per the existing `external_item_id` precedent, so two different photos for the same category/brand/null-partNumber stay distinct rows). Add `ReferencePhoto` to `apps/server/src/db/types.ts`. New `apps/server/src/db/queries/referencePhotos.ts` exporting: `promoteReferencePhotos(listingId: string, photoPaths: readonly string[], category: ComponentCategory, brand: string, partNumber: string \| null): Promise<void>` — inserts one row per photo path, catching the unique-index violation per row and treating it as "already promoted, skip" (same pattern as the eBay connector's duplicate-listing insert, Requirement 4); and `findReferencePhotosForLeads(category: ComponentCategory, leads: {brand: string \| null; partNumber: string \| null}[], limit: number): Promise<ReferencePhoto[]>` — when `leads` has at least one non-null-brand entry, prefers rows matching one of those brand/partNumber pairs (partNumber match optional), else returns any rows in that category, ordered most-recent-first, de-duplicated to at most one row per distinct brand+partNumber pair, capped at `limit`. Export both plus `ReferencePhoto` from `db/index.ts`'s barrel. | builder | | not_started | 0 | | | | 20 | | | | no |
| T2 | Hook `promoteReferencePhotos` (T1) into the two places a non-null-brand identity is actually confirmed by a human (Requirements 2-3): in `apps/server/src/routes/listings.ts`, after each `createExpectedPart` call in both the `POST /api/listings` and `PUT /api/listings/:id` handlers, call it once per created Expected Part whose `brand` is non-null, passing the just-created Listing's `photoPaths`. In `apps/server/src/routes/teardown.ts`, after the `createPart` call inside the `additionalParts` loop, call it once per Additional Part whose `brand` is non-null, passing the already-in-scope `listing.photoPaths` (the reconciled-Expected-Part branch of that same handler is deliberately **not** hooked — that identity was already promoted when its Expected Part was first saved, so hooking it too would only ever produce exact-duplicate, dedup-skipped inserts for no benefit). Both call sites run after their existing create succeeds and never block or fail the request if promotion itself throws (log Error and continue — a reference-library write failure must never break saving a Listing or submitting a teardown). | builder | T1 | not_started | 0 | | | | 15 | | | | no |
| T3 | Seed data (Requirement 1): fetch a small curated set (roughly 8-12 photos total) of real product photos from manufacturers'/retailers' own public product pages, for specific, common models across GPU (e.g. a couple of distinct blower-style reference shrouds), Case (e.g. one or two common mid-tower models), and Cooler (e.g. the stock coolers bundled with common CPUs) — the same three categories the planning example found hardest to identify from recall alone. Save the files under `data/reference-photos/seed/` (new directory; `data/` is already gitignored, so these — like the user's own real listing photos — are never committed to the repo, only ever present on a machine that fetched them). New one-time script `apps/server/src/db/seedReferencePhotos.ts`, run manually (`tsx src/db/seedReferencePhotos.ts`) rather than from `migrate.ts`'s automatic boot sequence, since it needs outbound network access that a normal server boot must not depend on; it downloads the images and inserts one `part_reference_photos` row per photo via direct use of T1's query functions (`source: 'seed'`, `listingId: null`). | builder | T1 | not_started | 0 | | | | 25 | | | | no |
| T4 | Second-pass prompt and parser (Requirement 8-9). New `apps/server/src/ai/visualComparisonPrompt.ts`: `buildVisualComparisonPrompt(listing: Listing, eligibleParts: { partIndex: number; category: ComponentCategory; description: string; references: ReferencePhoto[] }[]): string` — for each eligible part, restates its category/description from the first pass and numbers/labels each of its attached reference photos with the confirmed identity it represents and its `source` (seeded vs. a previously confirmed real listing); instructs the model to compare the listing's own photos against the labeled references using identifying marks (shape, color, pattern, connector layout, badge/sticker design) and to return, per `partIndex`, either an updated `brand`/`partNumber`/`identityCandidates`, or an explicit "no change" when nothing attached genuinely matches — raw JSON only, same convention as the first pass's prompt. In `apps/server/src/ai/identificationParser.ts`, change `coerceIdentityField` and `coerceIdentityCandidates` from module-private to exported, so the new parser reuses them instead of duplicating their coercion logic; add `parseVisualComparisonResponse(rawStdout: string): { partIndex: number; brand: string \| null; partNumber: string \| null; identityCandidates: IdentityCandidate[] }[]` to the same file, built the same defensive way as `parseIdentificationResponse` (structural failure is fatal, a single malformed entry is coerced and logged at Warn, never dropped silently). | builder | T1 | not_started | 0 | | | | 20 | | | | no |
| T5 | Orchestration (Requirements 5-9): extend `apps/server/src/ai/partIdentification.ts`'s `identifyListingParts`. After the existing first pass parses, compute the eligible-part set per Requirement 5 (by index into the `parts` array, since nothing else is a stable identifier at this point). When empty, return the first pass's result unchanged (Requirement 5's last sentence). Otherwise, for each eligible part call T1's `findReferencePhotosForLeads` with its own brand/partNumber plus its `identityCandidates` as leads (category-only fallback when every lead's brand is null), capped at a new named constant `MAX_REFERENCE_PHOTOS_PER_PART = 3`; if the combined total across all eligible parts would exceed a new `MAX_TOTAL_REFERENCE_PHOTOS_PER_CALL = 12`, trim round-robin (take one from each eligible part's own list in turn) until the total fits, rather than letting one part's references crowd out another's. When the trimmed total is zero (Requirement 7), return the first pass's result unchanged — no second `omp` call is made. Otherwise build T4's prompt, resolve each reference photo's `photo_path` the same way `resolvePhotoPaths` already resolves listing photos (both are relative to the same data directory), call `getOmpRunner()` a second time with the listing's own photos plus the selected reference photos, parse with T4's `parseVisualComparisonResponse`, and merge each returned entry onto the first pass's `parts[entry.partIndex]` by overwriting `brand`/`partNumber`/`identityCandidates` with the second pass's values (Requirement 9) — a part the second pass didn't return an entry for (e.g. it was eligible but got zero references of its own) is left exactly as the first pass reported it. | builder | T1, T4 | not_started | 0 | | | | 25 | | | | no |

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

## Cycle Log
### Cycle 0
Trigger: initial
