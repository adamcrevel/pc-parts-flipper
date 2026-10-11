# Feature: part-notes-and-unpriced-indicator

Status: done
Cycle: 1 / 3
FeatureStarted: 2026-10-11T02:29:55Z
FeatureCompletedAt: 2026-10-11T10:48:00Z
OrchestrationTokensActual: 878116
OrchestrationTokensBreakdown: input 0 + output 47,933 + cache-write 340,970 + cache-read 489,213, across 178 turns
Prototype: https://gist.githack.com/adamcrevel/d290adea9ebfd50299cdf276fa20ebc0/raw/prototype.html
BaselineTests: 900
BaselineSuite: pass
Walkthrough: https://gist.githack.com/adamcrevel/46d27e5b33a9f8011b9d833f8e00d037/raw/walkthrough.html

## Goal

This feature adds three related capabilities to the Listings page and its AI identification
pipeline, confirmed with the user across four clarifying questions before any plan was drafted.

1. **Per-part notes.** Each Expected Part gains a freeform `notes` field, editable in the Expected
   Parts editor the same way brand/partNumber/description already are. When `identify-parts`
   re-runs for a listing, the AI model is handed that listing's *current, live* Expected Parts
   (including any notes on them, and any manual edits made since the last run) as prompt context —
   not the raw stored result of whichever job ran previously. The model is instructed to take those
   notes into account as corrections or clarifications while forming its new identification, and to
   carry each one forward onto whichever of its own newly-identified parts it judges corresponds to
   the original. Confirmed explicitly with the user: this matching is the model's own judgment call,
   never a deterministic field-based rule — notes frequently exist *because* a brand or part number
   was wrong, so the very field a mechanical match would key on is exactly what the note is
   correcting. Because `identify-parts` is a full-replace operation (every existing Expected Part is
   deleted and the model's new output is inserted in its place — `identifyPartsWorkerPool.ts`'s
   `persistIdentifiedParts`), a note only survives a re-run if the model reproduces it on its new
   output; nothing else carries it forward.
2. **Unpriced-parts indicator.** A new "Unpriced" column on the Listings table shows whether a
   listing has at least one Expected Part with no estimated resale value, reusing the sortable-column
   infrastructure the `listings-sortable-columns` feature already built (`ListingSortField`,
   `SORT_KEYS`, `SortableHeader`). Confirmed with the user: ascending sort on this column should show
   unpriced listings first (finding work still needing pricing is the point of the column), the
   deliberate inverse of every existing column's plain-ascending order.
3. **Unpriced-row highlight.** The Expected Parts editor visually flags any row with no estimated
   resale value, using the same error-style visual language the editor already uses for a real
   validation failure (the `AlertCircle` indicator next to a row with a bad category/description/
   price). Confirmed with the user: this highlight appears only while editing an already-saved
   (existing) listing — never while creating a new one, where an unpriced row is simply the normal,
   expected state of every field not yet filled in.

## Requirements

1. `ExpectedPart` and `ExpectedPartInput` (`packages/shared/src/listings.ts`) gain a `notes` field:
   freeform text, editable in the Expected Parts editor the same way brand/partNumber/description
   are, round-tripping through both create and the full-replace update/save path.
2. When `POST /api/listings/:id/identify-parts` re-runs for a listing that already has Expected
   Parts, the AI prompt (`buildIdentificationPrompt`) includes that listing's *current, live*
   Expected Parts — fetched via `listExpectedPartsByListing` immediately before the prompt is built,
   not the stored result of any previous identify-parts job — including each part's own notes, as
   explicit context.
3. The prompt instructs the model to take each note into account as a correction or clarification
   when forming its new identification (not merely echo it back unread).
4. The prompt instructs the model to carry each note forward onto whichever of its own
   newly-identified parts it judges corresponds to the original part the note was on, writing it
   into that part's own `notes` output field. Matching which new part a note belongs to is the
   model's own judgment call; no deterministic field-matching logic (by category, brand, part
   number, or array position) is written in code anywhere in this change.
5. A newly-identified part the model judges has no corresponding previous note — including every
   part of a first-ever identification, where the listing had no previous Expected Parts at all —
   gets an empty `notes` value (`""`), never `null` and never a placeholder string.
6. The per-part `notes` the model returns is persisted to the database for every Expected Part the
   full-replace `identifyPartsWorkerPool.ts`'s `persistIdentifiedParts` creates, the same write path
   already used for the model's other per-part fields (brand, partNumber, confidence, source).
7. The second AI pass (visual comparison, `visualComparisonPrompt.ts`/`visualComparisonParser.ts`)
   never modifies a part's `notes` value — it updates only brand/partNumber/identityCandidates
   (confirmed: `VisualComparisonUpdate` carries no `notes` field today, and this change must not add
   one).
8. The Listings table (`listing-list.tsx`) gains a new sortable "Unpriced" column indicating whether
   a listing has at least one Expected Part with no estimated resale value (`estimatedResaleValue ===
   null`).
9. The Unpriced column follows the exact click-to-sort mechanics `listings-sortable-columns` already
   built: clicking it while inactive makes it the active sort field, ascending; clicking it again
   while active reverses direction; clicking a different header replaces it outright.
10. Ascending sort on the Unpriced column lists every listing with at least one unpriced Expected
    Part before every listing with none — the deliberate inverse of every other sortable column's
    plain-value ascending order, confirmed with the user as the direction they actually want.
11. A listing with zero Expected Parts at all is treated as *not* having an unpriced part (see
    Assumption A5) — stated here explicitly rather than left to whatever an implementation happens
    to default to.
12. In the Expected Parts editor, a row whose estimated resale value is empty is visually flagged
    with an error-style highlight (the same `AlertCircle` treatment already used for a genuine
    validation failure on that row).
13. The Requirement 12 highlight is shown only while editing an already-saved (existing) listing —
    it never appears while creating a new listing, where every row legitimately starts unpriced.

## Standing Checks

- The whole test suite passes, and the test count holds at or above `BaselineTests` (900: 656
  server + 234 web + 10 shared).
- `npm run lint` runs clean with no new violation.
- Any new public function, type, or component this feature adds carries the same kind of
  header/block-comment documentation already used elsewhere in the codebase, explaining its purpose
  and flow, not just a one-line label.
- No new code in `apps/web` imports directly from `apps/server` — the existing
  `import/no-restricted-paths` boundary (`eslint.config.mjs`), checked by
  `apps/web/test/eslint-import-boundary.test.ts`, holds for every file this feature adds or touches.
- No `ALTER COLUMN`/`DROP COLUMN`/`ADD CONSTRAINT` anywhere in this change. The new `expected_parts.notes`
  column is added only via `ALTER TABLE expected_parts ADD COLUMN IF NOT EXISTS notes VARCHAR` (no
  inline `NOT NULL`/`DEFAULT` — DuckDB rejects a constrained `ADD COLUMN`), matching the existing
  pattern already used for `brand`/`part_number`/`identity_candidates`/`ai_confidence`/`ai_source`/
  `price_source`/`working_status`.
- `apps/server/src/db/migrate.ts`'s one-time `expected_parts` rebuild
  (`migrateExpectedPartsNullablePrice`) has its own hardcoded column list duplicated in two places —
  the `CREATE TABLE expected_parts_new (...)` statement and the `INSERT INTO expected_parts_new (...)
  SELECT (...) FROM expected_parts` statement. Both lists must include the new `notes` column, or it
  is silently dropped on a fresh database — this is this project's own repeatedly-hit mistake
  (documented in that function's own header comment, having already happened twice with earlier
  columns), called out here as its own standing check rather than left folded into the general
  schema line above.

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| P0 | Prototype covering every `ui: yes` task (T6, T7): Expected Parts editor notes field, unpriced-row `AlertCircle` highlight gated on existing-vs-create, and the new sortable "Unpriced" Listings-table column with correct unpriced-first ascending direction. | prototype | | complete | 0 | | 2026-10-11T02:32:00Z | 2026-10-11T02:47:42Z | 15 | 2026-10-11T02:32:00Z | | null | yes | .claude/feature/part-notes-and-unpriced-indicator/prototype-url.txt |
| T1 | Shared types (Req 1, 5, 8, 10). `packages/shared/src/listings.ts`: add `notes: string \| null;` to `ExpectedPart` (nullable — existing persisted rows get `NULL` after the DB migration, never backfilled) placed near `workingStatus`, with a doc comment distinguishing it from `IdentifyPartsResponse.notes` (whole-identification caveats; this is a per-part field). Add `notes?: string \| null;` to `ExpectedPartInput` (optional, matching the backward-compatible pattern already used for `priceSource`/`workingStatus` when they were added — a client built before this feature simply omits it). Extend `export type ListingSortField` with a new `\| 'unpriced'` member, doc comment explaining it is a derived boolean column, not a raw stored field. Extend `ListingSummary` with `hasUnpricedParts: boolean;`, doc comment explaining it means "at least one Expected Part with `estimatedResaleValue === null`", false for a listing with zero Expected Parts (Req 11). `packages/shared/src/aiIdentification.ts`: add `notes: string;` to `AiIdentifiedPart` (non-nullable, matching `IdentifyPartsResponse.notes`'s own empty-string-not-null convention), with a doc comment explicitly distinguishing this per-part field from the existing response-level `notes` field right above it in the same file — name both in the comment so a future reader is never confused by the repeated name. | builder | | complete | 0 | | 2026-10-11T07:13:59Z | 2026-10-11T07:17:59Z | 25 | 2026-10-11T07:06:25Z | 2800 | 52825 | no | packages/shared/src/listings.ts;packages/shared/src/aiIdentification.ts |
| T2 | DB schema, one-time rebuild migration, and Expected Parts query layer (Req 1, 6). `apps/server/src/db/schema.ts`: add `ALTER TABLE expected_parts ADD COLUMN IF NOT EXISTS notes VARCHAR;` to the `expected_parts` ALTER_STATEMENTS block (same file/pattern as `working_status`'s own line). `apps/server/src/db/migrate.ts`: add `notes` to BOTH the `CREATE TABLE expected_parts_new (...)` column list AND the `INSERT INTO expected_parts_new (...) SELECT (...) FROM expected_parts` column list inside `migrateExpectedPartsNullablePrice` — read that function's own header comment first; it documents this exact column-list-completeness mistake having happened twice before. `apps/server/src/db/queries/expectedParts.ts`: add `notes?: string \| null;` to `CreateExpectedPartInput` and to `UpdateExpectedPartInput`; `mapRow` reads `notes: (row.notes as string \| null) ?? null,`; `createExpectedPart`'s INSERT statement and its params object both gain `notes` (`notes: input.notes ?? null`); `updateExpectedPart`'s dynamic SET-clause builder (read its current implementation first) is extended the same way its other optional patch fields already are, so a partial patch including `notes` works even though no current caller exercises that path yet. | builder | T1 | complete | 0 | | 2026-10-11T07:18:10Z | 2026-10-11T07:24:18Z | 30 | 2026-10-11T07:31:25Z | 10800 | 71191 | no | apps/server/src/db/schema.ts;apps/server/src/db/migrate.ts;apps/server/src/db/queries/expectedParts.ts;apps/server/src/db/types.ts |
| T3 | AI identification prompt + parser: prior-context injection and per-part notes (Req 2, 3, 4, 5, 7). `apps/server/src/ai/partIdentification.ts`: in `identifyListingParts`, before calling `buildIdentificationPrompt`, fetch `const existingParts = await listExpectedPartsByListing(listing.id);` and pass it through. `apps/server/src/ai/identificationPrompt.ts`: `buildIdentificationPrompt(listing: Listing, existingParts: ExpectedPart[] = [])` — when `existingParts` is non-empty, append a "PREVIOUS IDENTIFICATION" section to the prompt listing every existing part's category/brand/partNumber and its note (or "(none)" when its `notes` is null/empty) — all of them, not filtered to only the noted ones, so the model has the full previous breakdown to reason against. Add new numbered rule(s) instructing the model: (a) treat each note as a human correction or clarification for that specific part and prefer its guidance over what the listing text/photos alone would suggest when the two conflict; (b) for each part in its new identification that corresponds to one of the previous parts, carry that part's note forward — verbatim or lightly adapted — into its own `notes` output field; a part with no corresponding previous note, or a newly-identified part with no match above, gets `"notes":""`; (c) explicitly state this per-part `notes` field is distinct from the existing whole-response `notes` field (rule 7 in the current prompt, listing-level caveats) so the model never conflates the two. Update the JSON example(s) (both the working/non-working variants) to include `"notes":"..."` on every part. `apps/server/src/ai/identificationParser.ts`: `normalizePart` coerces `raw.notes` into the result's `notes: typeof raw.notes === 'string' ? raw.notes.trim() : ''` — always present, defaulting to `''` for anything non-string or absent, the same defensive-per-field style already used for `description`. | builder | T1 | complete | 0 | | 2026-10-11T07:18:10Z | 2026-10-11T07:24:18Z | 45 | 2026-10-11T08:01:25Z | 24000 | 71191 | no | apps/server/src/ai/partIdentification.ts;apps/server/src/ai/identificationPrompt.ts;apps/server/src/ai/identificationParser.ts |
| T4 | Persist the model's per-part notes through the identify-parts write path (Req 6). `apps/server/src/jobs/identifyPartsWorkerPool.ts`: `persistIdentifiedParts`'s `createExpectedPart` call gains `notes: part.notes.trim() \|\| null` (converts the AI parser's always-`''`-when-absent convention into the DB layer's null-when-absent convention established in T2). No other change in this file — `existingParts`/the delete step already there is unrelated to T3's own, separately-fetched prior-context read. | builder | T2;T3 | complete | 0 | | 2026-10-11T07:24:43Z | 2026-10-11T07:29:21Z | 15 | 2026-10-11T08:46:25Z | 4900 | 97344 | no | apps/server/src/jobs/identifyPartsWorkerPool.ts |
| T5 | Unpriced indicator computation and sort key, server side (Req 8, 10, 11). `apps/server/src/routes/listings.ts`: `toSummary` computes `hasUnpricedParts: expectedParts.some((part) => part.estimatedResaleValue === null)` from the `expectedParts` array it already fetches (no new query) — an empty `expectedParts` array makes `.some(...)` return `false` (Req 11, the zero-parts case), include this reasoning in a doc comment so it reads as a deliberate choice, not an accident of `Array.prototype.some`. Add `SORT_KEYS.unpriced = (listing) => (listing.hasUnpricedParts ? 0 : 1)` — doc comment explaining the `0`/`1` inversion is deliberate: it is what makes ascending sort (the existing comparator does `Number(keyA) - Number(keyB)`) put `hasUnpricedParts: true` rows first, matching Req 10's confirmed "unpriced ascending = unpriced first" direction, the deliberate mirror-image of every other column's extractor (which returns the column's own literal value). `VALID_SORT_FIELDS` is already derived from `Object.keys(SORT_KEYS)`, so no separate change is needed there. | builder | T1;T2 | complete | 0 | | 2026-10-11T07:24:43Z | 2026-10-11T07:29:21Z | 20 | 2026-10-11T09:01:25Z | 21000 | 97344 | no | apps/server/src/routes/listings.ts;apps/server/test/listings.test.ts |
| T6 | Expected Parts editor: notes field and unpriced-row highlight (Req 1, 12, 13). `apps/web/src/features/listings/expected-parts-editor.tsx`: add `notes: string` to `ExpectedPartRow`; `emptyExpectedPartRow()` includes `notes: ''`; render a new text input for notes (same styling as the existing description input) inside the row's expanded `CollapsibleContent` body, wired through the existing `updateRow` handler (`onChange={(e) => updateRow(index, { notes: e.target.value })}`), with an `aria-label` of `` `Expected part ${index + 1} notes` ``. Add a new `ExpectedPartsEditorProps` field `isExistingListing?: boolean`. Add a second highlight condition alongside the existing `rowHasError` (`const rowUnpriced = Boolean(isExistingListing) \&\& row.estimatedResaleValue.trim() === '';`) and render a second `AlertCircle` (same `text-destructive` styling as the existing one, a distinct `aria-label` such as `` `Expected part ${index + 1} is not priced` ``) next to the existing error icon when `rowUnpriced` is true — this never appears when `isExistingListing` is falsy (create flow), matching Req 13 exactly. `apps/web/src/features/listings/listing-form-state.ts`: `expectedPartToRow` carries `notes: part.notes ?? ''`. `apps/web/src/features/listings/listing-form.tsx`: pass `isExistingListing={Boolean(saved)}` to `<ExpectedPartsEditor>` (reusing the same `saved` state the file already tracks — `saved` is set once a listing has been created/loaded, matching this project's existing create-vs-edit convention from `listing-open-link-source-readonly`); `persistListing`'s `expectedParts` payload construction gains `notes: row.notes.trim() \|\| null` alongside its other per-field mappings. | builder | T1 | complete | 0 | | 2026-10-11T07:18:10Z | 2026-10-11T07:24:18Z | 35 | 2026-10-11T09:21:25Z | 46000 | 71191 | yes | apps/web/src/features/listings/expected-parts-editor.tsx;apps/web/src/features/listings/listing-form-state.ts;apps/web/src/features/listings/listing-form.tsx;apps/web/test/expected-parts-editor.test.tsx;apps/web/test/expected-parts-editor-working-status.test.tsx;apps/web/test/identity-candidates-picker.test.tsx;apps/web/test/price-source.test.tsx |
| T7 | Listings table: Unpriced column (Req 8, 9, 10). `apps/web/src/features/listings/unpriced-parts-badge.tsx` (new file): a small badge component following the exact styling convention of `non-working-badge.tsx` (a `cn`-composed `<span>` pill), styled with `text-destructive`/`border-destructive` tones (distinct from the amber/emerald/violet already used by `NonWorkingBadge`/`EbayScanBadge`/`AiSuggestedBadge`), rendering "Unpriced" when its `hasUnpricedParts` prop is true and nothing (`null`) when false. `apps/web/src/features/listings/listing-list.tsx`: add `{ field: 'unpriced', label: 'Unpriced' }` to `SORTABLE_COLUMNS` (placed last, immediately after the existing `identifyParts` entry); add a matching `<td>` cell to the table body in the same relative position (immediately after the existing Identify Parts cell, before the actions cell), rendering `<UnpricedPartsBadge hasUnpricedParts={listing.hasUnpricedParts} />`; update `COLUMN_COUNT` from `9` to `10` (the inline edit row's `colSpan` source) to account for the new column. | builder | T1;T5 | complete | 0 | | 2026-10-11T07:29:31Z | 2026-10-11T07:30:32Z | 20 | 2026-10-11T09:56:25Z | 29600 | 107994 | yes | apps/web/src/features/listings/unpriced-parts-badge.tsx;apps/web/src/features/listings/listing-list.tsx |
| R1 | Review T1 (`packages/shared/src/listings.ts`, `packages/shared/src/aiIdentification.ts`) against Req 1, 5, 8, 10, 11 as scoped to these files. Confirm: `ExpectedPart.notes`/`ExpectedPartInput.notes` are typed exactly as specified (nullable on the former, optional-nullable on the latter); `ListingSortField` gains exactly one new member (`'unpriced'`), none of the existing 7 removed or renamed; `ListingSummary.hasUnpricedParts` is `boolean`, not optional; `AiIdentifiedPart.notes` is non-nullable `string`; both files' doc comments clearly distinguish the new per-part `notes` concept from the pre-existing whole-response `notes` field. Also confirm the Standing Checks' doc-comment convention. PASS only if every one of these holds and nothing else in either file was touched. | reviewer | T1 | complete | 0 | | 2026-10-11T07:43:17Z | 2026-10-11T08:16:39Z | 10 | 2026-10-11T07:43:17Z | 6300 | 183347 | no | |
| TE1 | Test T1 (`packages/shared/src/listings.ts`, `packages/shared/src/aiIdentification.ts`). Type-level only (no runtime logic in this task): confirm the shared package builds clean (`npm run build -w packages/shared`) with the new fields present, and that a value assigned to `ListingSortField` of `'unpriced'` type-checks while an invalid string literal does not. Add/extend a type-only test (matching this package's existing `src/*.test.ts` convention, e.g. `bulkIdentifyPartsTypes.test.ts`'s style) asserting `ExpectedPart`/`ExpectedPartInput`/`AiIdentifiedPart` accept the new field with the exact nullability specified. PASS: build clean, new/extended type assertions pass, existing 10 shared tests still pass. | tester | T1 | complete | 0 | | 2026-10-11T07:43:17Z | 2026-10-11T08:16:39Z | 10 | 2026-10-11T07:43:17Z | 22500 | 116358 | no | packages/shared/src/partNotesAndUnpricedTypes.test.ts |
| R2 | Review T2 (`apps/server/src/db/schema.ts`, `apps/server/src/db/migrate.ts`, `apps/server/src/db/queries/expectedParts.ts`) against Req 1, 6 as scoped to these files, and the two DuckDB-specific Standing Checks. Specifically confirm: the new `ALTER TABLE` statement carries no inline constraint; `migrateExpectedPartsNullablePrice`'s `notes` column appears in BOTH its `CREATE TABLE expected_parts_new` list AND its `INSERT ... SELECT` list (read the actual diff, do not take a description's word for it); `mapRow`/`createExpectedPart`/`updateExpectedPart` all handle `notes` consistently with T1's nullability. Run a fresh-DB smoke check if feasible (delete/rename any existing worktree DB file, start the server, confirm `expected_parts.notes` exists and a round-trip write/read of a non-null notes value survives). PASS only if the rebuild's column-list completeness is independently confirmed, not merely asserted. | reviewer | T2 | complete | 0 | | 2026-10-11T07:43:17Z | 2026-10-11T08:16:39Z | 15 | 2026-10-11T07:43:17Z | 11600 | 250761 | no | |
| TE2 | Test T2. Add/extend `apps/server/test`'s Expected Parts query-layer tests (find the existing suite covering `createExpectedPart`/`updateExpectedPart`/`mapRow` first) to cover: creating a part with a non-null `notes` value and reading it back unchanged; creating a part with `notes` omitted and reading back `null` (not `''`, not `undefined`); updating only `notes` via `updateExpectedPart` leaves every other field unchanged. Also add a fresh-database migration smoke test if the project's existing migration tests have a pattern for one (search for `migrate` in `apps/server/test` first) — confirm a brand-new DB created via the full `runMigrations` path has a queryable `notes` column that round-trips a value, proving the rebuild's two column lists are actually complete, not just reviewed by eye. PASS: all new/extended cases pass, no regression in the existing Expected Parts query-layer suite. | tester | T2 | complete | 0 | | 2026-10-11T07:43:17Z | 2026-10-11T08:16:39Z | 20 | 2026-10-11T07:43:17Z | 18000 | 154259 | no | apps/server/test/db.test.ts |
| R3 | Review T3 (`apps/server/src/ai/partIdentification.ts`, `identificationPrompt.ts`, `identificationParser.ts`) against Req 2, 3, 4, 5, 7 as scoped to these files. Specifically confirm: `existingParts` is fetched via `listExpectedPartsByListing` (the live table), never from any stored job-result; the prior-identification prompt section is included only when `existingParts` is non-empty and lists every existing part (not filtered to noted-only); the new prompt rules clearly separate "use notes as correction guidance" (Req 3) from "carry notes forward onto the new output" (Req 4) as two distinct instructions, and explicitly disambiguate the new per-part `notes` field from the existing rule-7 whole-response `notes` field; `normalizePart` defaults a missing/non-string `notes` to `''`, never `null`/`undefined`; confirm by reading `visualComparisonParser.ts`/the merge step in `partIdentification.ts` that nothing added here lets the second pass touch `notes` (Req 7). PASS only if the prompt wording itself (not just the code structure) actually instructs both the correction-use and the carry-forward behavior as separate, explicit rules. | reviewer | T3 | complete | 0 | | 2026-10-11T07:43:17Z | 2026-10-11T08:16:39Z | 15 | 2026-10-11T07:43:17Z | 10900 | 183347 | no | |
| TE3 | Test T3. Add/extend `apps/server/test`'s identification-prompt and identification-parser tests (find the existing suites covering `buildIdentificationPrompt`/`parseIdentificationResponse` first): a prompt built with a non-empty `existingParts` argument includes the prior-identification section with each part's category/brand/partNumber/notes rendered; a prompt built with an empty/default `existingParts` is byte-for-byte unchanged from today's output (no regression for a first-ever identification); `normalizePart`/`parseIdentificationResponse` default a missing `notes` field to `''` and pass through a present string value unchanged, including trimming. Confirm `identifyListingParts`'s test suite (if one exists; search `partIdentification.test` first) exercises the fetch-existing-parts-before-building-the-prompt ordering with a mock/stub, not just an assertion about the final response shape. PASS: all new/extended cases pass, no regression in the existing identification prompt/parser suites. | tester | T3 | complete | 0 | | 2026-10-11T07:43:17Z | 2026-10-11T08:16:39Z | 20 | 2026-10-11T07:43:17Z | 68000 | 250761 | no | apps/server/test/partIdentification.test.ts |
| R4 | Review T4 (`apps/server/src/jobs/identifyPartsWorkerPool.ts`) against Req 6 as scoped to this file. Confirm `persistIdentifiedParts`'s `createExpectedPart` call carries the model's `part.notes` through to the DB with the exact empty-string-to-null conversion T2 established, and that no other field's existing handling (priceSource, workingStatus, estimatedResaleValue's $1 non-working override) was disturbed by this change. PASS only if a diff confirms the change is confined to the one new field. | reviewer | T4 | complete | 0 | | 2026-10-11T07:43:17Z | 2026-10-11T08:16:39Z | 10 | 2026-10-11T07:43:17Z | 36000 | 250761 | no | |
| TE4 | Test T4 (`apps/server/src/jobs/identifyPartsWorkerPool.ts`). Extend the existing `persistIdentifiedParts`/identify-parts-job integration test(s) (search `identifyPartsWorkerPool.test` / `identifyPartsConcurrency.test` first) to cover: a job whose AI result carries a non-empty per-part `notes` persists that value to the created Expected Part; a job whose AI result carries `notes: ''` persists `null` (not the empty string) to the DB. PASS: both cases pass, no regression in the existing worker-pool suite (isolate-and-rerun if a failure looks like this project's known environmental `startTestServer` flakiness rather than a real regression). | tester | T4 | complete | 0 | | 2026-10-11T07:43:17Z | 2026-10-11T08:16:39Z | 15 | 2026-10-11T07:43:17Z | 85000 | 250761 | no | apps/server/test/identifyPartsWorkerPool.test.ts;apps/server/test/identifyPartsPriceTrigger.test.ts;apps/server/test/workingStatusIdentifyParts.test.ts |
| R5 | Review T5 (`apps/server/src/routes/listings.ts`) against Req 8, 10, 11 as scoped to this file. Confirm `toSummary`'s `hasUnpricedParts` is computed from the same `expectedParts` array already fetched (no new query added), is `false` for a listing with zero Expected Parts, and `true` whenever at least one part has `estimatedResaleValue === null`; confirm `SORT_KEYS.unpriced`'s `0`/`1` inversion is correct against the existing generic numeric comparator (`Number(keyA) - Number(keyB)`) and genuinely produces "unpriced first" on ascending, not "unpriced last". PASS only if the inversion is verified against the actual comparator code, not merely read as plausible. | reviewer | T5 | complete | 0 | | 2026-10-11T07:43:17Z | 2026-10-11T08:16:39Z | 10 | 2026-10-11T07:43:17Z | | 250761 | no | |
| TE5 | Test T5 (`apps/server/src/routes/listings.ts`). Extend `apps/server/test/listings.test.ts`'s existing sort suite (the one `listings-sortable-columns` added) with an `unpriced` case: seed listings with a scrambled mix of (zero parts / all-priced parts / some-unpriced parts), confirm ascending sort lists every listing with at least one unpriced part before every listing with none (including the zero-parts listings grouped with the fully-priced ones, Req 11), confirm descending is the exact reverse, confirm it composes with pagination the same way the other 7 sort fields were already proven to (cross-page-boundary correctness). PASS: new cases pass, existing sort suite (all 7 prior fields) unaffected. | tester | T5 | complete | 0 | | 2026-10-11T07:43:17Z | 2026-10-11T08:16:39Z | 20 | 2026-10-11T07:43:17Z | 100000 | 250761 | no | apps/server/test/listings.test.ts |
| R6 | Review T6 (`apps/web/src/features/listings/expected-parts-editor.tsx`, `listing-form-state.ts`, `listing-form.tsx`) against Req 1, 12, 13 as scoped to these files. Confirm the notes input is wired through `updateRow` (so editing it also flips `aiSuggested`/claims `priceSource: 'manual'` consistently with every other field edit — read `updateRow`'s current logic and confirm notes is not accidentally exempted); confirm the unpriced highlight renders only when `isExistingListing` is true and never when it is false/undefined (the create-flow case); confirm `isExistingListing={Boolean(saved)}` is correct for both the initial-load-of-an-existing-listing case and the just-created-in-this-session case. PASS only if the create-vs-edit distinction is verified against actual rendered output in both states, not just the prop wiring. FAIL: Reviewer measured cyclomatic complexity (via an ad hoc `eslint --rule complexity:10` run, not a rule this project's own `eslint.config.mjs`/`npm run lint` actually configures) over threshold in listing-form.tsx's persistListing map callback (11) and two already-over-threshold functions in expected-parts-editor.tsx (15) and listing-form-state.ts's expectedPartToRow (12); validate-lead downgraded this to a non-blocking recommendation since it is not a correctness/safety defect and the project's real `npm run lint` passes clean with no complexity rule configured — see consolidated digest. | reviewer | T6 | complete | 0 | | 2026-10-11T07:43:17Z | 2026-10-11T08:16:39Z | 15 | 2026-10-11T07:43:17Z | 19300 | 250761 | no | |
| TE6 | Test T6. Extend `apps/web/test`'s existing Expected Parts editor test suite (search `expected-parts-editor.test` first) with cases: typing into the notes input updates the row's `notes` and clears `aiSuggested`, matching every other field's existing behavior; the unpriced `AlertCircle` renders when `isExistingListing` is true and the row's price is empty, and does not render when `isExistingListing` is false regardless of price; the existing validation-error `AlertCircle` and the new unpriced `AlertCircle` can both appear on the same row simultaneously without either suppressing the other. Also extend `listing-form.test` (or equivalent) confirming a newly-created listing's editor never shows the unpriced highlight and an existing listing's does. PASS: all new/extended cases pass, no regression in the existing editor/form suites. | tester | T6 | complete | 0 | | 2026-10-11T07:43:17Z | 2026-10-11T08:16:39Z | 20 | 2026-10-11T07:43:17Z | 42000 | 250761 | no | apps/web/test/listing-form.test.tsx |
| R7 | Review T7 (`apps/web/src/features/listings/unpriced-parts-badge.tsx`, `listing-list.tsx`) against Req 8, 9, 10 as scoped to these files. Confirm the new column's header is clickable via the existing `SortableHeader`/`onSortChange` plumbing with no new code path; confirm the new `<td>`'s position in the table body matches `SORTABLE_COLUMNS`' position for the header (both last, before actions); confirm `COLUMN_COUNT` is exactly `10` and the inline edit row's colSpan is visibly consistent with the new 10-column header row (no console warning, no misaligned row). PASS only if column alignment is checked against the actual rendered table, not just the two source edits in isolation. | reviewer | T7 | complete | 0 | | 2026-10-11T07:43:17Z | 2026-10-11T08:16:39Z | 10 | 2026-10-11T07:43:17Z | 34000 | 117981 | no | |
| TE7 | Test T7. Extend `apps/web/test/listing-list.test.tsx` with cases: the Unpriced header is clickable and sends `sortBy: 'unpriced'` on click, ascending first; the badge renders for a listing with `hasUnpricedParts: true` and renders nothing for `false`; the header row renders exactly 10 `<th>` cells (1 checkbox + 8 sortable + 1 actions). PASS: all new/extended cases pass, no regression in the existing listing-list suite (including the 7 pre-existing sortable-column cases). | tester | T7 | complete | 0 | | 2026-10-11T07:43:17Z | 2026-10-11T08:16:39Z | 15 | 2026-10-11T07:43:17Z | 46000 | 250761 | no | apps/web/test/listing-list.test.tsx |
| U0 | UAT pass over the whole feature (Req 1-13): start apps/server+apps/web in the worktree on isolated ports against the worktree's own isolated DuckDB file (never the main checkout's live data). Seed a listing, run identify-parts once, add a note to a part via the Expected Parts editor, re-run identify-parts, confirm the note is taken into account and carried forward onto the model's new output (not lost, not duplicated). Confirm the Unpriced column sorts ascending=unpriced-first and composes with pagination. Confirm the unpriced-row AlertCircle highlight appears only on an existing/saved listing's editor, never during create. | uat | T1;T2;T3;T4;T5;T6;T7 | complete | 0 | | 2026-10-11T08:43:49Z | 2026-10-11T09:08:43Z | 30 | 2026-10-11T08:43:49Z | | 165000 | yes | |
| T8 | Fix Requirement 1's notes round-trip at the HTTP route validation layer, found broken by UAT (U0). `apps/server/src/routes/listingValidation.ts`: add `notes?: unknown;` to the `ExpectedPartRequestBody` interface (alongside its other optional untrusted-input fields); add `notes: trimmedOrNull(body.notes),` to `validateExpectedPartInput`'s returned `ExpectedPartInput` object literal, reusing the file's own existing `trimmedOrNull` helper (already used for `brand`/`partNumber`) so a note typed in the Expected Parts editor actually reaches the db layer on both `POST /api/listings` and `PUT /api/listings/:id` instead of being silently dropped. No other change in this file. | builder | | complete | 1 | | 2026-10-11T09:09:10Z | 2026-10-11T09:15:35Z | 10 | 2026-10-11T09:08:43Z | 10500 | 33180 | no | apps/server/src/routes/listingValidation.ts |
| R8 | Review T8 (`apps/server/src/routes/listingValidation.ts`) against Req 1 as scoped to this file. Confirm `ExpectedPartRequestBody` declares `notes?: unknown;` alongside its other optional untrusted-input fields; confirm `validateExpectedPartInput`'s returned `ExpectedPartInput` object literal includes `notes: trimmedOrNull(body.notes),` reusing the file's own existing `trimmedOrNull` helper (same convention as `brand`/`partNumber`), so a note typed in the Expected Parts editor survives both `POST /api/listings` and `PUT /api/listings/:id`. Confirm the diff is confined to exactly these two additions and disturbs no other field's existing validation. PASS only if a diff read confirms both additions verbatim. | reviewer | T8 | complete | 1 | | 2026-10-11T09:17:52Z | 2026-10-11T09:33:29Z | 10 | 2026-10-11T09:17:52Z | 10900 | 25985 | no | |
| TE8 | Test T8 (`apps/server/src/routes/listingValidation.ts`). This is the same bug class UAT (U0) found — a unit-level check of `validateExpectedPartInput`'s return shape alone is not sufficient, since that is exactly the kind of check that missed the original drop. Add a direct HTTP-level regression test in `apps/server/test/listings.test.ts` (matching the file's existing `postJson`/`putJson`/`listingBody` pattern) proving: (1) a `notes` string sent on an Expected Part via `POST /api/listings` is actually persisted — assert it on the create response AND on a follow-up `GET /api/listings/:id`, not just the POST echo; (2) a `notes` string sent via `PUT /api/listings/:id` on an existing listing is actually persisted and round-trips the same way; (3) an absent/omitted `notes` field continues to normalize to `null` (regression guard against reintroducing the drop). PASS: all three new cases pass against the real running server, no regression in the existing CRUD suite. | tester | T8 | complete | 1 | | 2026-10-11T09:17:52Z | 2026-10-11T09:33:29Z | 15 | 2026-10-11T09:17:52Z | 36900 | 102015 | no | apps/server/test/listings.test.ts |
| U1 | Re-run UAT over the whole feature (Req 1-13) now that T8 fixed the Cycle 0 UAT failure. Repeat U0's full exercise, with particular attention to Requirement 1 (notes typed in the Expected Parts editor now actually persist across create and update, round-tripping through a real page reload), plus a fresh pass over every other requirement U0 already confirmed, since T8 touched shared route-validation code. | uat | T1;T2;T3;T4;T5;T6;T7;T8 | complete | 1 | | 2026-10-11T09:44:20Z | 2026-10-11T10:48:00Z | 25 | 2026-10-11T09:44:20Z | | 62000 | yes | |

## Assumptions

- A1 (cycle 0): "Previous identification" context for a re-run is the listing's current, live
  Expected Parts table state (including any manual edits made since the last identify-parts run),
  not the raw stored result of whichever job ran previously. Confirmed directly with the user.
- A2 (cycle 0): Matching which new AI-identified part a previous note belongs to is left entirely to
  the model's own judgment inside the prompt; no deterministic field-based matching code (by
  category, brand, part number, or array position) exists anywhere in this change. Confirmed
  directly with the user, who explicitly rejected three proposed deterministic-matching alternatives
  for exactly this reason: a note frequently exists *because* a field like brand/partNumber was
  wrong, so that field cannot double as a stable matching key.
- A3 (cycle 0): Ascending sort on the new Unpriced column lists unpriced-listings first — the
  deliberate inverse of every other sortable column's plain ascending order. Confirmed directly with
  the user.
- A4 (cycle 0): The Requirement 12 unpriced-row highlight appears only while editing an
  already-saved (existing) listing, never during create. Confirmed directly with the user.
- A5 (cycle 0): A listing with zero Expected Parts counts as *not* having an unpriced part (a vacuous
  "no" under the literal reading of "has at least one unpriced part" — there is no part to be
  unpriced, only an absent set) rather than being flagged as if every part were unpriced. This was
  not put to the user as one of the four clarifying questions; it is a reasonable default read of
  the requirement's own wording, stated here explicitly (Requirement 11) rather than left to
  whichever behavior `Array.prototype.some` happens to produce on an empty array.
- A6 (cycle 0): The name `notes` is reused for two genuinely different concepts that already existed
  side by side before this feature (`IdentifyPartsResponse.notes`, whole-identification caveats) and
  that this feature adds (`AiIdentifiedPart.notes`/`ExpectedPart.notes`, one specific part's
  correction/clarification). There is no actual type collision — they are different interfaces at
  different JSON scopes — but both the shared-type doc comments (T1) and the prompt wording itself
  (T3) explicitly call out the distinction, so neither a future reader nor the model itself conflates
  the two.
- A7 (cycle 0): `ExpectedPart.notes`/`ExpectedPartInput.notes` are nullable/optional, matching the
  backward-compatible pattern already used when `priceSource`/`workingStatus` were added to this same
  interface — the project's 185 existing real Expected Parts get `NULL` for `notes` after the
  migration (no backfill), rendered as an empty string by the client the same way every other
  optional/nullable field already is. `AiIdentifiedPart.notes`/`IdentifyPartsResponse.notes` stay
  plain non-nullable `string`, matching the pre-existing response-level field's own
  empty-string-not-null convention.
- A8 (cycle 0): The second AI pass (visual comparison) never touches `notes` — confirmed by reading
  `visualComparisonParser.ts`'s `VisualComparisonUpdate` shape (`partIndex`/`brand`/`partNumber`/
  `identityCandidates` only) and `partIdentification.ts`'s merge step (lines mutating only
  `brand`/`partNumber`/`identityCandidates` on a matched part). This change adds nothing to either,
  so the invariant holds by construction, not merely by the reviewer's say-so.
- A9 (cycle 0): R6's reviewer flagged three functions in T6's files exceeding a cyclomatic-complexity
  threshold of 10, measured via an ad hoc `npx eslint --rule '{"complexity":["error",10]}'` override
  it ran itself. Validate-lead independently confirmed `eslint-plugin-complexity` is listed in
  `package.json`'s devDependencies but never imported or wired into any rule in `eslint.config.mjs`,
  and that the project's real `npm run lint` command passes with zero violations against the actual
  post-T6 code (the Standing Check this feature is held to). Since cyclomatic complexity crossing an
  un-enforced, self-invented threshold is not a correctness or safety defect with a concrete failure
  case — and TE6 independently proved the same code correct via mutation testing — this finding is
  carried in the consolidated digest as a non-blocking recommendation, not a `must_fix`, and R6's
  `FAIL` verdict is not treated as blocking Cycle 0.

## Cycle Log

### Cycle 0
Trigger: initial
UAT: failed
UAT checks:
- Isolation: started apps/server on PORT=3091 and apps/web (Vite) on --port 5183 --strictPort, apps/web pointed at the server via VITE_API_BASE_URL=http://localhost:3091, both distinct from the live main-checkout dev service's default 3001/5173.
- Isolation: ran with DUCKDB_DATA_DIR=/tmp/uat-pnu-data (never the worktree's own data/ dir and never the main checkout's data/pc-parts-flipper.duckdb).
- Isolation: confirmed GET /api/listings and GET /api/sources against the isolated DB both returned empty before any seeding.
- Build: `npm run build -w packages/shared` completed with no errors.
- Req 13 (create-form never highlights unpriced rows): confirmed via DOM query, zero unpriced AlertCircle elements on the not-yet-saved create form despite two genuinely unpriced rows.
- Req 12 (existing-listing highlight tracks live pricing state): confirmed the highlight count on a reopened saved listing exactly matched its live empty-price-field count.
- Req 1 (notes round-trip): BROKEN — typed a note in the Expected Parts editor, saved, reloaded: the note was gone. Confirmed via GET /api/listings/:id the persisted notes column was null. Confirmed via direct POST and PUT calls with an explicit notes string that both the create and update HTTP routes silently drop it before it reaches the db layer (root cause isolated to apps/server/src/routes/listingValidation.ts).
- Req 2 (live current Expected Parts used as prior context, not a stale job result): confirmed via a captured prompt from a stubbed identify-parts run.
- Req 2/3 (every existing part listed, not filtered to noted-only): confirmed via a second captured prompt after injecting a real note directly at the db layer (bypassing the broken route).
- Req 3/4 (two separate instructions: use-as-correction vs carry-forward, each distinct from the whole-response notes field): confirmed present as two separate numbered rules in the captured prompt.
- Req 4 (carry-forward actually happens): confirmed the AI's persisted output note was non-null and clearly derived from the injected note's content.
- Req 5 (no corresponding note -> null, not empty string or placeholder): confirmed on the unnoted GPU part across two separate identify-parts runs.
- Req 6 (full-replace, no duplication): confirmed old-id rows gone and new-id rows present after two separate identify-parts runs.
- Req 7 (second AI pass never touches notes): confirmed by direct source read of visualComparisonParser.ts/visualComparisonPrompt.ts — neither references notes.
- Req 8/9/10 (Unpriced column sortable, ascending = unpriced-first, descending = exact reverse, composes with pagination): confirmed across 28 seeded listings spanning 2 pages; the true unpriced/non-unpriced boundary fell at the correct position across the page-2 boundary in both directions.
- Req 11 (zero-Expected-Parts listings grouped as not-unpriced): confirmed live for 3 zero-parts listings under both sort directions.
- Standing check (doc comments, import boundary, ALTER TABLE no inline constraint, migrate.ts dual column-list completeness): all confirmed via direct source read.
- Standing check (suite + lint, cited from validate-lead's same-cycle gate, not re-run): shared 23/23, web 243/243, server 669 total with every scattered failure confirmed environmental-flaky in isolation; combined 935 vs baseline 900 (+35); lint clean.
- Cleanup: both UAT dev servers stopped, throwaway scripts and the isolated DuckDB directory removed, worktree confirmed to show exactly the pre-UAT feature diff afterward.
UAT failure: Requirement 1 is broken at the HTTP route validation layer — apps/server/src/routes/listingValidation.ts's `ExpectedPartRequestBody` never declares a `notes` field and `validateExpectedPartInput` never includes one in its returned `ExpectedPartInput`, so any `notes` value sent via POST /api/listings or PUT /api/listings/:id is silently discarded before reaching the db layer, on both create and update. The identify-parts AI write path (T4) is unaffected (it bypasses this route layer entirely).

### Cycle 1
Trigger: UAT (U0) found Requirement 1's manual-editor notes save path silently dropped at the HTTP route validation layer.
Findings:
- apps/server/src/routes/listingValidation.ts: add `notes?: unknown;` to `ExpectedPartRequestBody`, and a `notes: typeof body.notes === 'string' ? (body.notes.trim() || null) : null` (or equivalent, matching this file's existing trimmed-or-null convention) field to `validateExpectedPartInput`'s returned object, so a note typed in the Expected Parts editor survives both POST /api/listings and PUT /api/listings/:id.
UAT: passed
UAT checks:
- Req 1 (create path, exact U0 repro): created a listing with two Expected Part rows, typed a note into one, saved (POST 201) — note held immediately after save.
- Req 1 (create path, continued): a full page reload (not a client re-render) and reopening the listing showed the exact same note text — the precise scenario U0 found broken is now fixed.
- Req 1 (create path, DB-level): GET /api/listings/:id confirmed the noted part's notes held the full text server-side, and the untouched part's notes was null (not empty string).
- Req 1 (update path): edited both rows' notes on the saved listing and saved again (PUT 200).
- Req 1 (update path, continued): a full page reload showed both rows' updated notes correctly, confirming PUT round-trips the same as POST.
- Req 2 (live Expected Parts used as context, not stale): confirmed via source read and empirically — updating a note immediately before a second identify-parts run changed the model's output per the new note, which only a live fetch could produce.
- Req 3 (prompt instructs correction-use): confirmed rule 9's wording via source read, and empirically — a real identify-parts run with a corrective note produced a brand matching the note.
- Req 4 (prompt instructs carry-forward, model's own judgment): confirmed rule 10's wording via source read; grepped for deterministic field-matching code and found none.
- Req 4 (empirical, two separate real runs): the correct note carried onto the correct category's new part both times, including after the note's own content changed between runs.
- Req 5 (unmatched part gets null, never placeholder): confirmed via source read and empirically across both real runs — parts with no corresponding note persisted as null.
- Req 6 (full-replace, same write path): confirmed via source read; empirically, three successive states (manual, run 1, run 2) never repeated an id.
- Req 7 (second AI pass never touches notes): grepped visualComparisonParser.ts/visualComparisonPrompt.ts — zero references to notes in either file.
- Req 8 (Unpriced badge matches real per-listing state): across 31 listings, every row's badge presence matched its actual Expected Parts pricing state.
- Req 9 (click-to-sort mechanics): confirmed first click sets ascending, second click on the same header flips to descending, clicking a different header resets the first back to none — all via aria-sort, not just the visual arrow.
- Req 10 (ascending = unpriced-first): confirmed over the full 31-listing set via direct API that every unpriced listing preceded every non-unpriced one with no interleaving, and the UI's first page matched.
- Req 10 (descending = exact reverse): confirmed the boolean sequence was the exact reverse of ascending.
- Req 10 (pagination composition, both directions): confirmed across a 28-listing, 2-page dataset that the unpriced/non-unpriced boundary composed correctly across the page-2 boundary in both sort directions.
- Req 11 (zero-parts listings grouped as not-unpriced): confirmed for 3 zero-parts listings across both sort directions and the unsorted view.
- Req 12 (existing-listing editor shows the highlight): reopening a saved listing with 2 genuinely-unpriced rows showed exactly 2 highlight icons.
- Req 13 (create-form never shows the highlight): the same 2 genuinely-unpriced rows showed 0 highlight icons before the first save.
- Standing check (doc comments): every new/changed public symbol carries a genuine explanatory comment.
- Standing check (import boundary): zero apps/web -> apps/server imports across every file this feature touched or added.
- Standing check (ALTER TABLE no inline constraint; migrate.ts dual column-list completeness): confirmed via direct source read, and live-smoke-proved against a brand-new, never-before-existing DuckDB file — the notes column round-tripped correctly from a from-scratch migration.
- Standing check (suite + lint, cited from validate-lead's Cycle 1 gate, not re-run): 948 total vs baseline 900 (+48, no shrinkage); lint clean; two environmentally-flaky beforeAll timeouts isolated-and-rerun clean, confirmed unrelated to this feature.
- Cleanup: both UAT dev servers and all temp artifacts removed; worktree confirmed to show exactly the pre-UAT feature diff afterward, including its own data/ directory untouched.
