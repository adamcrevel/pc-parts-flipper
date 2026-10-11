# Overview
Expected Parts gain a freeform `notes` field that survives manual edits, round-trips through
create/update, and gets handed back to the AI as live context on every re-run of Identify Parts so
a human correction ("wrong brand", "missing a screw") isn't lost — the model folds it in and carries
it forward onto whichever new part it judges corresponds, on its own judgment, never a mechanical
field match. Separately, the Listings table gets a new sortable "Unpriced" column (ascending =
unpriced-first, the deliberate inverse of every other column) and the Expected Parts editor flags an
unpriced row with the existing error-style icon, but only once a listing is already saved. A UAT
pass in Cycle 0 caught the notes field being silently dropped at the HTTP validation layer before it
ever reached the database; Cycle 1 fixed that one gap and re-confirmed everything else.

## Per-part notes: schema and persistence
Summary: Adds a nullable `notes` column to `expected_parts` and threads it through every layer that
reads or writes an Expected Part, including the fresh-database rebuild migration that has twice
before silently dropped a new column.
Tasks: T1, T2, T8
Flow:
- Shared types: `notes?: string | null` on ExpectedPart/ExpectedPartInput
- DB schema: `ALTER TABLE ... ADD COLUMN notes VARCHAR`
- Migration rebuild: `notes` added to both hardcoded column lists
- Query layer: create/update/mapRow carry `notes` through
- HTTP validation: `notes` parsed and passed to the DB layer
Files:
- packages/shared/src/listings.ts: adds `notes` to `ExpectedPart`/`ExpectedPartInput` and the new `unpriced` sort field/`hasUnpricedParts` summary field, with doc comments distinguishing this per-part notes from the pre-existing whole-response notes.
- apps/server/src/db/schema.ts: adds the single `ALTER TABLE ... ADD COLUMN IF NOT EXISTS notes VARCHAR` line, no inline constraint (DuckDB requirement).
- apps/server/src/db/migrate.ts: adds `notes` to both the `CREATE TABLE expected_parts_new` and `INSERT ... SELECT` column lists inside `migrateExpectedPartsNullablePrice` — the exact spot this project has silently dropped a new column twice before.
- apps/server/src/db/types.ts, apps/server/src/db/queries/expectedParts.ts: `ExpectedPart.notes` type, plus `notes` wired through `CreateExpectedPartInput`/`UpdateExpectedPartInput`/`mapRow`/the INSERT and UPDATE statements.
- apps/server/src/routes/listingValidation.ts: the Cycle 1 fix — `notes` was missing from `ExpectedPartRequestBody` and `validateExpectedPartInput`'s return, so a note typed in the editor was silently discarded before reaching the DB on both POST and PUT. Added using the file's existing `trimmedOrNull` helper.
- apps/server/test/db.test.ts, apps/server/test/listings.test.ts: fresh-database migration smoke test proving `notes` survives the rebuild from scratch, plus HTTP-level regression tests proving POST/PUT actually persist and round-trip `notes` (the exact bug class the Cycle 0 UAT found).

## AI identification: live context, correction, and carry-forward
Summary: When Identify Parts re-runs, the prompt now includes the listing's current, live Expected
Parts (not a stale stored job result) so the model can use each part's note as a correction and
carry it forward onto its own new output — entirely the model's judgment, with no deterministic
field-matching code anywhere in this change.
Tasks: T3, T4
Flow:
- Fetch: live Expected Parts fetched via listExpectedPartsByListing right before the prompt is built
- Prompt: a "PREVIOUS IDENTIFICATION" section lists every part and its note (or "(none)")
- Instruct: two new rules — treat notes as correction, carry them forward onto the matching new part
- Parse: `notes` defaults to `''` when absent, never a placeholder
- Persist: the worker pool writes the model's `notes` to the DB, empty string becomes null
Files:
- apps/server/src/ai/partIdentification.ts: fetches the listing's live Expected Parts before building the prompt, replacing what would otherwise be no context at all on a re-run.
- apps/server/src/ai/identificationPrompt.ts: renders the PREVIOUS IDENTIFICATION section and adds two numbered rules (use-as-correction, carry-forward), explicitly distinguished from the pre-existing whole-response `notes` field so the model never conflates the two; only activates when `existingParts` is non-empty, so a first-ever identification's prompt is unchanged.
- apps/server/src/ai/identificationParser.ts: `normalizePart` defaults `notes` to `''` for anything non-string or absent, matching the file's existing per-field defensive style.
- apps/server/src/jobs/identifyPartsWorkerPool.ts: `persistIdentifiedParts` writes the model's `notes` to the newly-created Expected Part (empty string converted to `null`), the one write path a note has to survive since Identify Parts is a full delete-and-replace.
- apps/server/test/partIdentification.test.ts, apps/server/test/identifyPartsWorkerPool.test.ts, apps/server/test/identifyPartsPriceTrigger.test.ts, apps/server/test/workingStatusIdentifyParts.test.ts: cover the prompt's prior-context section and rule wording, the empty-string-to-null persistence conversion, and confirm no regression in the existing non-working/price-trigger suites this file's rule-numbering shift touches.

## Unpriced-parts indicator (server + table)
Summary: Listings now carry a derived `hasUnpricedParts` boolean and a matching sortable "Unpriced"
column, with ascending sort deliberately showing unpriced listings first.
Tasks: T5, T7
Flow:
- Compute: `hasUnpricedParts` derived from the already-fetched Expected Parts array
- Sort key: inverted 0/1 extractor so ascending sorts unpriced-first
- Badge: a destructive-styled pill rendered in the table, nothing when priced
- Column: wired into the existing SortableHeader click-to-sort plumbing
Files:
- apps/server/src/routes/listings.ts: `toSummary`/`toDetail` compute `hasUnpricedParts` from the `expectedParts` array already fetched (no new query); a zero-parts listing is `false` by `Array.prototype.some`'s own semantics. `SORT_KEYS.unpriced` returns `0`/`1` inverted against the normal ascending comparator so "unpriced" ascending puts unpriced listings first, unlike every other column.
- apps/web/src/features/listings/unpriced-parts-badge.tsx (new): a small destructive-toned pill, following `non-working-badge.tsx`'s styling convention, rendering nothing when the listing has no unpriced parts.
- apps/web/src/features/listings/listing-list.tsx: adds the "Unpriced" entry to `SORTABLE_COLUMNS` and a matching `<td>` rendering the badge, bumping `COLUMN_COUNT` from 9 to 10 for the inline-edit row's colspan.
- apps/server/test/listings.test.ts, apps/web/test/listing-list.test.tsx: sort-order tests (ascending-first, descending-reverse, pagination composition, zero-parts grouping) and UI tests (header click sends `sortBy: 'unpriced'`, badge presence matches the prop, header-cell count).

## Expected Parts editor: notes input and unpriced-row highlight
Summary: The editor gains a notes text input per row and a second `AlertCircle` flagging an unpriced
row, shown only when editing an already-saved listing — never while creating a new one.
Tasks: T6
Files:
- apps/web/src/features/listings/expected-parts-editor.tsx: adds a `notes` field to `ExpectedPartRow`, a notes input wired through the existing `updateRow` handler, and a second `AlertCircle` (`rowUnpriced`) gated on the new `isExistingListing` prop, rendered alongside — never suppressing — the existing validation-error icon.
- apps/web/src/features/listings/listing-form-state.ts: `expectedPartToRow` carries `part.notes ?? ''` into the row.
- apps/web/src/features/listings/listing-form.tsx: passes `isExistingListing={Boolean(saved)}` (the file's existing create-vs-edit signal) to the editor, and includes `notes: row.notes.trim() || null` in the save payload.
- apps/web/test/expected-parts-editor.test.tsx, apps/web/test/expected-parts-editor-working-status.test.tsx, apps/web/test/identity-candidates-picker.test.tsx, apps/web/test/price-source.test.tsx, apps/web/test/listing-form.test.tsx: cover notes input behavior, both AlertCircles coexisting on one row, and that the highlight never appears on a not-yet-saved listing's form regardless of price.

## Type-level proofs
Summary: A new shared-package test file asserts the exact nullability of every new/changed type by
hand, since this package's test runner strips type annotations without checking them.
Tasks: T1
Files:
- packages/shared/src/aiIdentification.ts: adds non-nullable `notes: string` to `AiIdentifiedPart`, with a doc comment distinguishing it from the response-level `notes` field in the same file.
- packages/shared/src/partNotesAndUnpricedTypes.test.ts (new): type-shape assertions (checked via a separate `tsc --noEmit` pass, following `bulkIdentifyPartsTypes.test.ts`'s existing convention) proving `ExpectedPart.notes`, `ExpectedPartInput.notes`, `AiIdentifiedPart.notes`, and the new `ListingSortField`/`ListingSummary.hasUnpricedParts` members carry exactly the nullability specified, not merely "probably fine."
