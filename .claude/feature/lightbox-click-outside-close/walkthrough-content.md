# Overview
A Listing's photo lightbox only closed via its own X button — clicking the empty space around the
photo did nothing, because the dialog's own content element is sized to the full viewport, so
there was never actually a pixel "outside" it for click-outside detection to fire against. The fix
adds a backdrop click handler directly to that element, then explicitly stops that click from
reaching the photo itself and the three control buttons (Close, Previous, Next) so each keeps its
exact current behavior.

## Backdrop closes, photo and buttons stay exempt
Summary: `DialogContent` gets an `onClick={onClose}` handler so a click anywhere on it (which is
everywhere, since it fills the screen) closes the lightbox. The photo and all three buttons each
get `event.stopPropagation()` added to their own click handling so that same bubbling click never
reaches the new backdrop handler.
Tasks: P1, T1
Flow:
- Click lands: anywhere inside DialogContent's full-viewport box
- Image or button?: stopPropagation() stops the bubble
- Otherwise: bubbles up to onClick={onClose}, lightbox closes
Files:
- apps/web/src/features/listings/photo-lightbox.tsx: adds the backdrop `onClick={onClose}` on `DialogContent`, and `event.stopPropagation()` to the image's click handler and to the Close/Previous/Next button handlers, so a bubbling click is caught before it can double-fire close or misfire navigation.

## Proving the backdrop click and the exempt clicks actually work
Summary: covers clicking the real dialog root (the backdrop, since there's no separate outside
region), clicking the photo, and clicking Close/Previous/Next — confirming the new backdrop click
closes the lightbox while every exempted click still does only its own thing.
Tasks: T1
Files:
- apps/web/test/photo-upload.test.tsx: adds a test that opens the lightbox, clicks the photo (stays open), then dispatches a click on the dialog root itself (closes it), plus a `waitFor` helper added to absorb Radix's async teardown so the assertion isn't a timing race.

## Closing the one gap the first pass missed: no double-close on Close
Summary: review found that `PhotoUpload`'s own `onClose` is idempotent, so no test mounted through
`PhotoUpload` could tell a single Close click from a double-fire (the backdrop handler + the
button's own handler both reaching `onClose`). This cycle adds that missing coverage without
touching the source again — the Close handler's `stopPropagation()` was already correct.
Tasks: T2
Files:
- apps/web/test/photo-upload.test.tsx: adds a second test that mounts `PhotoLightbox` directly with a `vi.fn()` spy as `onClose`, clicks the real Close button, and asserts the spy was called exactly once — a test that would fail at a call count of 2 if the button's `stopPropagation()` ever regressed.
