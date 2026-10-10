# Feature: listing-open-link-source-readonly

Status: proposed
Cycle: 0 / 3
FeatureStarted: 2026-10-10T02:26:00Z
OrchestrationTokensActual: 71092
OrchestrationTokensBreakdown: input 0 + output 8,079 + cache-write 20,420 + cache-read 42,593, across 46 turns
Prototype: .claude/feature/listing-open-link-source-readonly/prototype.html
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
| T1 | Add the "Open Link" button and the read-only Source behavior (Req 1-7). `apps/web/src/features/listings/listing-fields.tsx`: restructure the Listing URL field's wrapper into a flex row containing a new `Button` (imported from `@/components/ui/button`, `type="button"`, `variant="outline"`, `size="sm"`, text "Open Link") immediately to the left of the existing `<input id="listing-url">`, which keeps its current `value`/`onChange`/className/label/error-message exactly as today. The button opens `listingUrl` in a new tab/window: when `listingUrl.trim()` is non-empty, render it via the `Button`'s existing `asChild` prop wrapping an `<a href={listingUrl} target="_blank" rel="noreferrer">` (the exact `target`/`rel` pair `ebay-scan-badge.tsx` already uses for the same purpose in this codebase); when empty, render a plain disabled `<button>` (no `asChild`, `disabled`) so there is no dead/no-op link target (Req 4). `ListingFieldsProps` gains `sourceReadOnly: boolean`; the existing `<select id="listing-source">` gets `disabled={sourceReadOnly}` added (Req 5) — value/onChange/options list otherwise unchanged. `apps/web/src/features/listings/listing-form.tsx`: pass `sourceReadOnly={Boolean(saved)}` into `<ListingFields>` — `saved` is the same state this file already uses to gate the Photos-upload section (`saved ? <PhotoUpload .../> : ...`), so a brand-new, not-yet-saved Listing (Req 6) and an existing/already-saved one (Req 5) are distinguished the exact same way the rest of this component already does, not a new concept. Add/extend tests in `apps/web/test/listing-form.test.tsx` (reusing its existing `mount`/`mockSource`/`mockListingDetail` helpers): the Source select is enabled with no `initialValue` (create) and disabled with one (edit); the Open Link button is absent/disabled when `listingUrl` is empty and, when non-empty, renders as a real anchor whose `href` matches the field's current value and carries `target="_blank"`/`rel="noreferrer"`; the Listing URL input's own value/onChange/validation-error rendering is unchanged (a plain regression check, not new behavior). | builder | | not_started | 0 | | | | 25 | | | | yes | apps/web/src/features/listings/listing-fields.tsx, apps/web/src/features/listings/listing-form.tsx, apps/web/test/listing-form.test.tsx |

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
UAT: not_run
