# Overview
On the Listings page's edit/create form, two small changes to existing fields: an "Open Link"
button now sits to the left of the Listing URL input so a reviewer can jump straight to the live
listing in a new tab, and the Source selector becomes read-only once a Listing is already saved
(it still shows the chosen Source, but can't be changed) — since the source is fixed at creation
time and only needed as a free choice while a Listing is still brand-new. Everything else on the
form is untouched.

## Open Link button
Summary: Adds a button next to the Listing URL input that opens the current URL in a new tab,
disabled when the field is empty so there's never a dead click target.
Tasks: T1, R1, TE1
Flow:
- Listing URL typed: user edits the input
- trim() check: empty vs non-empty
- Disabled button: no URL to open
- Live anchor (`asChild`, `target="_blank"`): opens in new tab
Files:
- apps/web/src/features/listings/listing-fields.tsx: wraps the Listing URL input and the new Button in a shared flex row; the Button renders as a disabled plain button when `listingUrl.trim()` is empty, or as an `asChild`-wrapped `<a target="_blank" rel="noreferrer">` otherwise — the Listing URL input itself keeps its existing value/onChange/label/error rendering unchanged.
- apps/web/test/listing-form.test.tsx: covers the button's empty-vs-populated states, live tracking as the URL is typed, and a regression check that the Listing URL input's value/onChange/required-validation behavior is unaffected by the new button.

## Read-only Source on existing Listings
Summary: Disables the Source selector once a Listing has been saved at least once, while leaving
it fully editable while creating a new one, reusing the form's existing `saved` state as the
create-vs-edit signal.
Tasks: T1, R1, TE1
Files:
- apps/web/src/features/listings/listing-fields.tsx: accepts a new `sourceReadOnly` prop and passes it straight to the `<select id="listing-source">`'s `disabled` attribute; the selected Source still renders, it just can't be changed.
- apps/web/src/features/listings/listing-form.tsx: passes `sourceReadOnly={Boolean(saved)}` down to `ListingFields` — `saved` is the same state the form already uses elsewhere to tell a brand-new draft apart from an already-persisted Listing.
- apps/web/test/listing-form.test.tsx: asserts the Source select is enabled with no `initialValue` (creating) and disabled with one (editing an existing Listing).
