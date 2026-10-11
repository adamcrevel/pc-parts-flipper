# Overview
The Listings table gets three plain-language column renames and a clearer "Pricing Status" badge
that now always says something, instead of showing a pill only in the unpriced case. Separately,
clicking a sortable header (or changing a filter or page) now visibly dims the table and disables
every header until the new data arrives, so a user can't accidentally double-click and queue a
second request — while the existing silent background poll for identify-parts status keeps working
exactly as before, with no new flicker.

## Column renames
Summary: Three column headers get clearer, user-facing names. Only the label changes — the sort
field identifiers the server receives, the computed values shown, and existing sort behavior are
all untouched.
Tasks: T1
Files:
- apps/web/src/features/listings/listing-list.tsx: `SORTABLE_COLUMNS`'s three labels change ("Difference" -> "Expected Profit", "Identify Parts" -> "Sourcing Status", "Unpriced" -> "Pricing Status"); the underlying `field` identifiers are untouched.
- apps/web/test/listing-list.test.tsx, apps/web/test/listings-page.test.tsx: header-label assertions and click targets updated to match the new names.

## Pricing Status badge
Summary: The old "Unpriced" badge only appeared for listings with an unpriced part and rendered
nothing otherwise. It's replaced with a badge that always shows one of two named states.
Tasks: T1
Flow:
- hasUnpricedParts: true -> "Partially Priced" (red)
- hasUnpricedParts: false -> "Fully Priced" (teal)
Files:
- apps/web/src/features/listings/unpriced-parts-badge.tsx: deleted — renamed into pricing-status-badge.tsx below.
- apps/web/src/features/listings/pricing-status-badge.tsx: new component `PricingStatusBadge`, replacing `UnpricedPartsBadge`; always renders a pill, never `null`.
- apps/web/src/features/listings/listing-list.tsx: imports and renders `PricingStatusBadge` in place of `UnpricedPartsBadge`.
- apps/web/test/listing-list.test.tsx: the old "badge or nothing" assertions become "Partially Priced" / "Fully Priced" assertions, both always present.

## Loading state during a refetch
Summary: A sort, filter, or page change now visibly blocks the table while its request is in
flight — rows stay on screen but dimmed, headers are genuinely disabled, and a second click during
that window has no effect. The 2-second silent background poll for identify-parts status is
deliberately excluded, so it keeps running without any new flicker.
Tasks: T1
Flow:
- User clicks header/filter/page: sets isLoadingListings true
- ListingList renders: rows dimmed, spinner shown, headers disabled
- Request resolves: isLoadingListings false, table re-enabled
- Background poll (silent: true): bypasses loading state entirely
Files:
- apps/web/src/routes/listings-page.tsx: adds `isLoadingListings` state; `loadListings` now accepts `{ silent?: boolean }`, toggling the loading flag around the fetch except when called silently; the 2-second poll's own call becomes `loadListings({ silent: true })`, every other call site unchanged.
- apps/web/src/features/listings/listing-list.tsx: adds an `isLoading` prop, threaded into every `SortableHeader`; disables each header's button, dims the table with a `pointer-events-none opacity-60` wrapper, and shows a `role="status"` spinner/"Loading…" indicator above the (still-visible) rows.
- apps/web/test/listing-list.test.tsx: new cases cover headers disabling their click while `isLoading`, the indicator appearing/disappearing, and rows staying mounted during loading.
- apps/web/test/listings-page.test.tsx: new cases cover the indicator and disabled headers during a pending sort-triggered fetch, and confirm the silent polling reload never toggles either.
