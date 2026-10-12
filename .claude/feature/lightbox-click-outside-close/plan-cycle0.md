# Feature: lightbox-click-outside-close

Status: proposed
Cycle: 0 / 3
FeatureStarted: 2026-10-12T18:00:00Z
OrchestrationTokensActual: null
OrchestrationTokensBreakdown: null
Prototype: https://gist.githack.com/adamcrevel/7916dd1ca70c6abcef0452df61d57434/raw/prototype.html
BaselineTests: 962
BaselineSuite: pass

## Goal

The full-screen photo viewer a Listing's photo thumbnails open
(`apps/web/src/features/listings/photo-lightbox.tsx`) only closes via its own X button today —
clicking the empty space around the photo does nothing, even though the component's own doc
comment says it is "built on the shared Dialog primitive (Radix), which already owns ... click-
outside-to-close." Root cause, confirmed by reading the component: `DialogContent`'s own
`className` sets `h-screen w-screen` with `flex items-center justify-center`, so its DOM bounding
box covers the entire viewport — there is no pixel on screen actually "outside" `DialogContent` for
Radix's own outside-click detection to ever fire against. The empty-looking space around the
centered photo is visually background, but structurally still inside `DialogContent`.

This fixes that: clicking anywhere in that empty space (not the photo, not the Close/Previous/Next
buttons) closes the lightbox, the way a user expects a click on an image lightbox's backdrop to
behave.

## Requirements

1. Clicking anywhere in the lightbox's visible area that is not the photo itself and not one of its
   three buttons (Close, Previous, Next) closes the lightbox.
2. Clicking the photo itself does not close the lightbox — this is the one thing a user is actually
   looking at; an accidental click on it should not dismiss the view, matching the conventional
   lightbox pattern (click the image to inspect it, click away from it to leave).
3. Clicking Close continues to close the lightbox exactly as it does today (and does not fire the
   close logic twice).
4. Clicking Previous or Next continues to navigate to the adjacent photo exactly as today, and does
   not also close the lightbox — a navigation click must never be mistaken for a backdrop click.
5. Everything else about the lightbox is unchanged: Escape still closes it (unaffected, since this
   is Radix's own keyboard handling, untouched by this fix), Left/Right arrow-key navigation and
   wraparound are unchanged, the photo counter badge's own appearance/position is unchanged.

## Standing Checks

- The whole test suite passes, and the test count holds at or above `BaselineTests` (962: 24 shared
  + 248 web + 690 server). `BaselineSuite` is recorded `pass` for this baseline run, but
  `apps/server`'s `startTestServer`-based integration tests have shown confirmed,
  resource-contention-driven flakiness under concurrent load across multiple features this session
  (a different random file each time) — isolate-and-rerun before treating any single failure there
  as a regression, not an automatic fail. This feature touches only `apps/web`, so no server test
  should plausibly be affected regardless.
- `npm run lint` is clean.
- No change to `apps/server` or `packages/shared` — this is a pure `apps/web` UI fix, one component
  file plus its test file.

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Prototype the fix for T1: the photo lightbox opened from a Listing's photo thumbnails, modified so clicking the backdrop (empty space around the centered photo, not the photo itself, not the Close/Previous/Next buttons) closes the lightbox — the photo and the three buttons keep their current exact behavior unchanged. | prototype | | complete | 0 | peter-gibbons | 2026-10-12T18:05:00Z | 2026-10-12T18:10:00Z | 15 | 2026-10-12T18:05:00Z | 24300 | 49272 | yes | |
| T1 | In `apps/web/src/features/listings/photo-lightbox.tsx`: add `onClick={onClose}` to the `DialogContent` element (this is the backdrop region per Requirement 1). Add `onClick={(event) => event.stopPropagation()}` to the `<img>` element (Requirement 2 — a click landing on the photo must never bubble up to the new backdrop handler). Add `event.stopPropagation()` as the first line inside the Close button's existing `onClick` handler, and the same inside the Previous and Next buttons' existing `onClick` handlers (Requirements 3-4 — none of the three buttons' clicks may bubble to the new backdrop handler, which would otherwise double-fire close on the Close button or wrongly close instead of navigate on Previous/Next). Update `apps/web/test/photo-upload.test.tsx`'s `PhotoUpload lightbox navigation` describe block: add a new test asserting a click on the dialog's own root element (the backdrop, not the image or any button) closes the lightbox; add an assertion (new test or extend an existing one) that a click directly on the `<img>` does NOT close it; confirm the existing Next/Previous/Close tests still pass unmodified (proving Requirements 3-4 hold, not just Requirement 1). | builder | | not_started | 0 | | | | 30 | | | | yes | |
| R1 | Review T1 against Requirements 1-5. Confirm the backdrop `onClick` is placed on `DialogContent` itself (the element whose bounding box is the thing Requirement 1 describes), not on some inner wrapper that would miss part of the empty space. Confirm every one of the three buttons' `stopPropagation()` calls actually run before (or regardless of) their own existing logic, not accidentally short-circuiting it. Confirm the image's `stopPropagation()` is on the image element itself, not a wrapper that would also catch clicks meant for the backdrop around it. Confirm the new/updated tests in `photo-upload.test.tsx` actually exercise a real backdrop click (dispatched on the dialog root, not the image or a button) and a real image click, not just re-asserting the same prior button-click tests under a new name. Confirm Escape-to-close and arrow-key navigation are untouched (`git diff` should show only the targeted additions, no restructuring of the keydown effect or the Dialog's `onOpenChange` wiring). | reviewer | T1 | not_started | 0 | | | | 15 | | | | no | |
| TE1 | Test T1. Run `apps/web`'s test suite and confirm the new/updated `photo-upload.test.tsx` cases pass: a backdrop click closes the lightbox; a click on the image itself does not; the existing Close/Previous/Next button tests still pass exactly as before (proving the added `stopPropagation()` calls didn't change their own behavior). Mutation-check at least one of these: temporarily removing the new backdrop `onClick` should make the new backdrop-click test fail; temporarily removing the image's `stopPropagation()` should make the new image-click test fail. Confirm no other `apps/web` test regressed. | tester | T1 | not_started | 0 | | | | 15 | | | | no | |

## Assumptions

- A1 (cycle 0): "Anywhere outside the image" is read literally per the user's own words — the photo
  itself stays click-to-keep-open (Requirement 2), only the surrounding backdrop space (including
  the area the photo counter badge sits over, which is not interactive) closes on click. The three
  control buttons are a given exception, since they already have their own specific, different
  behavior (Requirement 3-4) and the user's report never mentioned them misbehaving.
- A2 (cycle 0): No change to the shared `Dialog`/`DialogContent`/`DialogOverlay` primitives
  themselves (`apps/web/src/components/ui/dialog.tsx`) — `PhotoLightbox` is their only caller
  (confirmed by a repo-wide grep), so the fix is scoped to `PhotoLightbox`'s own JSX rather than
  changing a shared primitive's default behavior that could affect a future second caller in an
  unreviewed way.

## Cycle Log

### Cycle 0
Trigger: initial
UAT: not_run
