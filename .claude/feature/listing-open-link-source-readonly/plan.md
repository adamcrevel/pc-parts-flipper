# Feature: listing-open-link-source-readonly

Status: done
Cycle: 0 / 3
FeatureStarted: 2026-10-10T02:26:00Z
FeatureCompletedAt: 2026-10-10T04:58:39Z
OrchestrationTokensActual: 229162
OrchestrationTokensBreakdown: input 0 + output 20,293 + cache-write 73,551 + cache-read 135,318, across 113 turns
Prototype: https://gist.githack.com/adamcrevel/5cb68275a04f3fbe4081861db9021d39/raw/prototype.html
BaselineTests: 871
BaselineSuite: pass

## Goal

On the Listings page's create/edit form (`ListingForm` / `ListingFields`, shown inline when a row is
clicked or a new Listing is being created), two changes to the existing field layout:

1. An **"Open Link" button** appears immediately to the left of the existing **Listing URL** input.
   Clicking it opens that URL in a new browser window/tab. The Listing URL input itself is
   untouched — same label, same element, same editability, same validation — this is a new control
   placed next to it, not a replacement for it (the user explicitly reverted an earlier "make the
   URL itself a clickable link" direction in favor of this).
2. The **Source** field becomes **read-only once a Listing already exists** (editing a saved
   Listing) — it still shows which Source the Listing came from, but the user can no longer change
   it from this form. It stays a normal, editable selector while **creating** a brand-new Listing,
   since a Source must still be chosen to create one in the first place (Assumption A1).

## Requirements

1. The inline edit form's Listing URL field keeps its current label, input element, value binding,
   and validation exactly as they are today — no part of the existing Listing URL field changes.
2. A new "Open Link" button appears immediately to the left of the Listing URL input, in the same
   row.
3. Clicking "Open Link" opens the Listing's current URL value in a new browser window/tab (not the
   current tab), without submitting or otherwise altering the form.
4. The "Open Link" button is disabled when the Listing URL field is empty — there is nothing to
   open, and the previous behavior (no link, no button) must not regress into a dead click target.
5. The Source selector is **disabled (read-only)** whenever the form is editing a Listing that
   already exists on the server — the currently-selected Source still renders, visibly, but cannot
   be changed through this control.
6. The Source selector remains a normal, enabled, editable selector while creating a new Listing
   (no existing saved record yet) — Requirement 5 never blocks choosing a Source for a brand-new
   Listing.
7. Every other field, button, and existing validation/behavior on this form (title, description,
   asking price, listing date, acquisition fees, Expected Parts editor, photo upload, Save/Cancel)
   is unchanged.

## Standing Checks

- The whole test suite passes, and the test count stays at or above `BaselineTests` (871).
- `npm run lint` runs clean with no new violation.
- Any new public function or component this feature adds carries the same kind of header/block
  comment documentation already used elsewhere in the codebase, explaining its purpose and flow,
  not just a one-line label.
- No new code in `apps/server` imports from `apps/web` or vice versa — the existing
  `import/no-restricted-paths` boundary (`eslint.config.mjs`), checked by
  `apps/web/test/eslint-import-boundary.test.ts`, holds for every file this feature adds or
  touches (this feature is apps/web only).

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| P0 | Prototype for the Open Link button and read-only Source select (Req 1-7). | prototype | | complete | 0 | | 2026-10-10T02:39:58Z | 2026-10-10T02:43:16Z | 15 | 2026-10-10T02:39:58Z | | null | yes | .claude/feature/listing-open-link-source-readonly/prototype.html |
| T1 | Add the "Open Link" button and the read-only Source behavior (Req 1-7). `apps/web/src/features/listings/listing-fields.tsx`: restructure the Listing URL field's wrapper into a flex row containing a new `Button` (imported from `@/components/ui/button`, `type="button"`, `variant="outline"`, `size="sm"`, text "Open Link") immediately to the left of the existing `<input id="listing-url">`, which keeps its current `value`/`onChange`/className/label/error-message exactly as today. The button opens `listingUrl` in a new tab/window: when `listingUrl.trim()` is non-empty, render it via the `Button`'s existing `asChild` prop wrapping an `<a href={listingUrl} target="_blank" rel="noreferrer">` (the exact `target`/`rel` pair `ebay-scan-badge.tsx` already uses for the same purpose in this codebase); when empty, render a plain disabled `<button>` (no `asChild`, `disabled`) so there is no dead/no-op link target (Req 4). `ListingFieldsProps` gains `sourceReadOnly: boolean`; the existing `<select id="listing-source">` gets `disabled={sourceReadOnly}` added (Req 5) — value/onChange/options list otherwise unchanged. `apps/web/src/features/listings/listing-form.tsx`: pass `sourceReadOnly={Boolean(saved)}` into `<ListingFields>` — `saved` is the same state this file already uses to gate the Photos-upload section (`saved ? <PhotoUpload .../> : ...`), so a brand-new, not-yet-saved Listing (Req 6) and an existing/already-saved one (Req 5) are distinguished the exact same way the rest of this component already does, not a new concept. Add/extend tests in `apps/web/test/listing-form.test.tsx` (reusing its existing `mount`/`mockSource`/`mockListingDetail` helpers): the Source select is enabled with no `initialValue` (create) and disabled with one (edit); the Open Link button is absent/disabled when `listingUrl` is empty and, when non-empty, renders as a real anchor whose `href` matches the field's current value and carries `target="_blank"`/`rel="noreferrer"`; the Listing URL input's own value/onChange/validation-error rendering is unchanged (a plain regression check, not new behavior). | builder | | complete | 0 | | 2026-10-10T03:11:56Z | 2026-10-10T03:29:00Z | 25 | 2026-10-10T03:11:03Z | 6300 | 24605 | yes | apps/web/src/features/listings/listing-fields.tsx, apps/web/src/features/listings/listing-form.tsx, apps/web/test/listing-form.test.tsx |
| R1 | Review the "Open Link" button and read-only Source behavior (Req 1-7) in `apps/web/src/features/listings/listing-fields.tsx` and `apps/web/src/features/listings/listing-form.tsx`. FAIL: reviewer flagged ListingForm's pre-existing cyclomatic complexity (13, eslint `complexity` threshold 10) as a must_fix because the diff's one added line falls inside that function; validate-lead overruled this (pre-existing debt, confirmed unchanged by T1's own diff, not a correctness/safety issue) — see validation digest. | reviewer | T1 | complete | 0 | | 2026-10-10T03:40:30Z | 2026-10-10T04:20:42Z | 15 | 2026-10-10T03:40:30Z | 31000 | 183347 | no | |
| TE1 | Test the "Open Link" button and read-only Source behavior (Req 1-7) in `apps/web/src/features/listings/listing-fields.tsx`, `apps/web/src/features/listings/listing-form.tsx`, and `apps/web/test/listing-form.test.tsx`. | tester | T1 | complete | 0 | | 2026-10-10T03:40:30Z | 2026-10-10T04:20:42Z | 15 | 2026-10-10T03:40:30Z | 32500 | 116358 | no | |
| U0 | UAT pass over the whole feature (Req 1-7): start the app in the worktree, open the Listings page, create a new Listing and confirm Source stays enabled/no Open Link needed with no URL yet, save it, reopen it for edit and confirm Source is now disabled showing its chosen value, enter a Listing URL, confirm Open Link appears enabled immediately to its left and actually opens that URL in a new tab when clicked, confirm every other field/button on the form still behaves exactly as before. | uat | T1;R1;TE1 | complete | 0 | | 2026-10-10T04:43:45Z | 2026-10-10T04:57:45Z | 20 | 2026-10-10T04:43:45Z | 25400 | null | yes | |

## Assumptions

- A1 (cycle 0): "Read only — it shouldn't be possible to change this" is read as applying to
  **editing an already-saved Listing**, not to creating a brand-new one — a Source is a required
  field validated on save (`fieldErrors.sourceId`), so a new Listing with no Source choice available
  at all would have no way to ever get one. The same `saved` state `listing-form.tsx` already uses
  to gate the Photos section (present once a Listing exists on the server, undefined/absent while
  still drafting a new one) is reused as the read-only gate, rather than inventing a second concept
  for the same create-vs-edit distinction this file already tracks.
- A2 (cycle 0): "Opens in a new window" is implemented as a new browser **tab** via
  `target="_blank"` (the only mechanism available from a plain anchor without invoking
  `window.open` and its popup-blocker exposure), matching the exact pattern this codebase's own
  `ebay-scan-badge.tsx` already uses for an outbound Listing URL link — not a literal separate OS
  window, which most browsers render as a tab by default regardless of how the link is opened.
- A3 (cycle 0): The "Open Link" button is disabled rather than hidden when the Listing URL is
  empty — visible-but-inert communicates "there's a button here, it just has nothing to open yet"
  more clearly than the layout shifting depending on whether a URL is present, and avoids the
  Listing URL input's own position jumping left/right as the button appears/disappears.

## Cycle Log

### Cycle 0
Trigger: initial
UAT: passed
UAT checks:
- Started apps/server (tsx watch, PORT=3011) and apps/web (vite --port 5273) in the worktree, each on ports distinct from the main checkout's running 3001/5173 instance, confirmed via `ss -ltnp` before starting.
- Confirmed the worktree's own data/pc-parts-flipper.duckdb is what the server opened (log line shows the worktree's own path).
- Confirmed via GET /api/sources and GET /api/listings that the worktree DB started empty (0 sources, 0 listings), genuinely isolated from the main checkout's 185-listing DB.
- Seeded one throwaway Source via POST /api/sources as the one prerequisite a Listing requires to exist.
- Navigated to the Listings page in a real Chromium browser (Playwright) and landed there successfully.
- Clicked "Add Listing" and the create form appeared with #listing-title visible.
- Req 6: Source selector is enabled, not disabled, while creating a brand-new Listing.
- Listing URL input starts empty on a fresh create form.
- Req 4: Open Link button renders as a disabled plain button (not a live anchor) while the Listing URL field is empty on the create form.
- Req 1: the Listing URL field's label text is unchanged ("Listing URL").
- Filled title, source, description, listing URL, asking price, listing date, acquisition fees on the create form.
- Open Link button becomes enabled live, before any save, the instant a Listing URL is typed into the create form.
- Create-form Save submitted POST /api/listings, returned 201, with a new Listing id.
- No submit-error banner appeared after the create-form Save.
- Clicked the new Listing's title in the table to open its inline edit row.
- Req 5: Source selector is disabled when reopening an already-saved Listing for edit.
- The disabled Source selector still visibly shows the Listing's actual chosen Source name.
- Listing URL field on the reopened edit form shows the exact URL saved at create time.
- Req 2: Open Link button is present, enabled, on the edit form.
- Req 2: Open Link control is the first DOM child in the shared row, immediately to the left of the Listing URL input.
- Req 3: clicking Open Link opened a brand-new browser tab whose URL is exactly the Listing's saved URL.
- Req 3: the original tab/page was not navigated away by clicking Open Link.
- Open Link stays enabled live after editing the Listing URL field to a new value, with no submit.
- Req 3: clicking Open Link again opens the newly-typed URL, exactly, in a new tab, with no form submission in between.
- Req 4: Open Link becomes disabled again immediately if the Listing URL is cleared back to empty.
- Req 7 (title): Title input on the edit form accepts and reflects a new value.
- Req 7 (description): Description textarea on the edit form accepts and reflects a new value.
- Req 7 (asking price): Asking Price input on the edit form accepts and reflects a new value.
- Req 7 (listing date): Listing Date input on the edit form accepts and reflects a new value.
- Req 7 (acquisition fees): Acquisition Fees input on the edit form accepts and reflects a new value.
- Req 7 (Expected Parts editor): category select on the starter row accepts a selection.
- Req 7 (Expected Parts editor): description input on the starter row accepts text.
- Req 7 (Expected Parts editor): estimated resale value input on the starter row accepts a number.
- Req 7 (Expected Parts editor): "Add Part" adds a new row.
- Req 7 (Save): Edit-form Save submitted PUT /api/listings/<id>, returned 200, with no submit-error banner.
- Source selector remained disabled throughout the entire edit session, confirmed again immediately before Save.
- Direct GET /api/listings/<id> after save returned 200.
- Persisted sourceId is unchanged from the one chosen at create time, confirmed by reading the actual stored record.
- Persisted listingUrl matches the value typed into the edit form's Listing URL input.
- Persisted title, askingPrice, and acquisitionFees match the edited values.
- Persisted expectedParts includes the row entered in the Expected Parts editor.
- Req 7 (photo upload): uploaded a real photo via the hidden file input behind "Choose Photos", no upload-error banner appeared.
- Req 7 (photo upload): a thumbnail for the uploaded photo appeared in the Photos section.
- Req 7 (photo upload): persisted photoPaths count increased by exactly 1 after the upload, confirmed server-side.
- Req 7 (Cancel, create form): clicking Cancel after typing a title closes the form without submitting.
- "Add Listing" is enabled again immediately after Cancel.
- The title typed before clicking Cancel was never persisted to the server.
- Req 1: saving with the Listing URL field blanked out on the edit form still shows the pre-existing "Listing URL is required." validation message, unchanged by this feature.
- Standing check (lint): ran `npm run lint` directly in the worktree — exited clean, zero violations.
- Standing check (import boundary): every import in the three touched files is a `@/...` alias scoped to apps/web; none reaches into apps/server.
- Standing check (doc comments): the new Open Link/disabled-button logic carries a multi-line block comment matching this codebase's existing style.
- Standing gate (cited from validate-lead's PASS digest, not re-run): apps/web 222/222 tests, packages/shared 10/10 tests, 0 failures; current count 878 vs BaselineTests 871 (+7, no shrinkage).
- Stopped both worktree dev-server processes before returning; confirmed ports 3011/5273 no longer listening.
