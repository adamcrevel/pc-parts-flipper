import { Fragment, useEffect, useRef } from 'react';
import { ArrowDown, ArrowUp, Image } from 'lucide-react';
import type { CreateListingInput, ListingDetail, ListingSortDirection, ListingSortField, ListingSummary, Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ListingForm } from '@/features/listings/listing-form';
import { EbayScanBadge } from '@/features/listings/ebay-scan-badge';
import { NonWorkingBadge } from '@/features/listings/non-working-badge';
import { IdentifyPartsStatusBadge } from '@/features/listings/identify-parts-status-badge';
import { PricingStatusBadge } from '@/features/listings/pricing-status-badge';
import { cn } from '@/lib/utils';

interface ListingListProps {
  listings: ListingSummary[];
  sources: Source[];
  sourcesById: Map<string, Source>;
  // Which Listing's inline edit row is currently open, if any (owned by
  // ListingsPage, which is also the thing fetching the full ListingDetail
  // once a row opens).
  editingListingId: string | null;
  editingListing: ListingDetail | null;
  editingLoading: boolean;
  // Clicking a Listing's title toggles its inline row: opens it (and closes
  // whichever other row was open), or closes it if it's already the open one.
  onToggleEdit: (listing: ListingSummary) => void;
  onSubmitEdit: (input: CreateListingInput) => Promise<ListingDetail>;
  onCancelEdit: () => void;
  onSavedEdit: (listing: ListingDetail) => void;
  onAccept: (listing: ListingSummary) => void;
  onReject: (listing: ListingSummary) => void;
  // Req 4: the Listing id with an accept/reject request currently in
  // flight, if any — its row's buttons are disabled so a user can't fire a
  // second request against the same row before the first one resolves.
  pendingListingId: string | null;
  // Req 2: every Listing id matching the currently-applied filters, across
  // every page — not just the ids of `listings`, the current page's rows.
  // The header checkbox's tri-state is computed against this whole set, so
  // selecting "all" on page 1 reads as checked on page 5 too.
  allFilteredIds: string[];
  // Req 1/3: the ids currently selected. Owned by the page above, so the
  // selection outlives this component's page/filter-driven remounts.
  selectedIds: Set<string>;
  onToggleOne: (id: string) => void;
  onToggleAllFiltered: () => void;
  // The column currently sorted by and its direction, or `undefined` when
  // nothing has been sorted yet (the server's default newest-first order).
  // Only ever one field at a time — clicking a different header replaces it.
  sortBy?: ListingSortField;
  sortDirection?: ListingSortDirection;
  // Clicking a sortable header's label asks the page above to make that
  // field active (ascending) or, when it is already active, to flip its
  // direction. This component holds no sort state of its own.
  onSortChange: (field: ListingSortField) => void;
  // Req 8: true while the page above has a listings fetch in flight that
  // should visibly block interaction with the currently-displayed (now
  // stale) rows — every sortable header disables its click handler and the
  // whole table reads as inert, while the rows themselves stay visible
  // underneath rather than being replaced by a full-page spinner.
  isLoading?: boolean;
}

// One table body plus, for whichever row is open, an extra full-width row
// directly beneath it holding the edit form — an inline "accordion" row
// rather than a separate top-of-page panel, so the form appears next to the
// Listing it edits regardless of scroll position.
const COLUMN_COUNT = 10;

// Every sortable column, in the left-to-right order the table renders them:
// the shared `ListingSortField` value sent to the server paired with the
// header label shown to the user. The two non-comparable columns (the
// leading selection checkbox and the trailing Accept/Reject actions) carry
// no comparable value, so they have no entry here and stay plain `<th>`s.
const SORTABLE_COLUMNS: { field: ListingSortField; label: string }[] = [
  { field: 'title', label: 'Title' },
  { field: 'source', label: 'Source' },
  { field: 'status', label: 'Status' },
  { field: 'askingPrice', label: 'Asking Price' },
  { field: 'expectedResale', label: 'Expected Resale' },
  { field: 'difference', label: 'Expected Profit' },
  { field: 'identifyParts', label: 'Sourcing Status' },
  { field: 'unpriced', label: 'Pricing Status' },
];

/**
 * One clickable column header. Its label is a button that reports the
 * click up to the page (which owns the sort state and the refetch); the
 * header renders a direction arrow — up for ascending, down for
 * descending — only when its own field is the active one, so exactly one
 * header in the table ever shows an indicator. `aria-sort` carries the same
 * information for assistive tech, reading `none` on every inactive column.
 * Req 8: `isLoading` disables the button while a fetch for the table's own
 * rows is in flight, so a click can't queue a second sort change against
 * data that's already stale and about to be replaced.
 */
function SortableHeader({
  field,
  label,
  sortBy,
  sortDirection,
  onSortChange,
  isLoading,
}: {
  field: ListingSortField;
  label: string;
  sortBy?: ListingSortField;
  sortDirection?: ListingSortDirection;
  onSortChange: (field: ListingSortField) => void;
  isLoading?: boolean;
}) {
  const isActive = sortBy === field;
  // A field can only ever be active ascending or descending; an active
  // field with no direction yet reads as ascending, matching the page's own
  // first-click behaviour.
  const isDescending = isActive && sortDirection === 'desc';
  const Arrow = isDescending ? ArrowDown : ArrowUp;

  return (
    <th className="px-4 py-2 font-medium" aria-sort={isActive ? (isDescending ? 'descending' : 'ascending') : 'none'}>
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-medium transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => onSortChange(field)}
        disabled={isLoading}
      >
        {label}
        {isActive && <Arrow className="h-3.5 w-3.5 shrink-0" aria-label={`Sorted ${isDescending ? 'descending' : 'ascending'}`} />}
      </button>
    </th>
  );
}

/**
 * Table of every Listing (Req 2), each row showing the Req 3 comparison,
 * Source, Identify-Parts status, and Accept/Reject actions, plus a
 * selection checkbox column. Clicking a Listing's title (not a separate
 * Edit button) opens that Listing's edit form inline, directly below its
 * row.
 */
export function ListingList({
  listings,
  sources,
  sourcesById,
  editingListingId,
  editingListing,
  editingLoading,
  onToggleEdit,
  onSubmitEdit,
  onCancelEdit,
  onSavedEdit,
  onAccept,
  onReject,
  pendingListingId,
  allFilteredIds,
  selectedIds,
  onToggleOne,
  onToggleAllFiltered,
  sortBy,
  sortDirection,
  onSortChange,
  isLoading,
}: ListingListProps) {
  const headerCheckboxRef = useRef<HTMLInputElement>(null);

  // Req 3: none/some/all of the *filtered* ids selected. With no filtered
  // ids at all nothing can be selected, so the header reads unchecked.
  const selectedFilteredCount = allFilteredIds.reduce((count, id) => (selectedIds.has(id) ? count + 1 : count), 0);
  const allFilteredSelected = allFilteredIds.length > 0 && selectedFilteredCount === allFilteredIds.length;
  const someFilteredSelected = selectedFilteredCount > 0 && selectedFilteredCount < allFilteredIds.length;

  // `indeterminate` is a DOM property with no JSX attribute, so it can only
  // be set imperatively on the element itself after each render that
  // changes it.
  useEffect(() => {
    if (headerCheckboxRef.current !== null) {
      headerCheckboxRef.current.indeterminate = someFilteredSelected;
    }
  }, [someFilteredSelected]);

  if (listings.length === 0) {
    return <p className="text-sm text-muted-foreground">No listings yet. Add one to get started.</p>;
  }

  return (
    <div className="overflow-x-auto">
      {isLoading && (
        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground" role="status">
          {/* Decorative spinner glyph, matching LoadingSpinner's own markup; the text label carries the accessible status */}
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
          <span>Loading…</span>
        </div>
      )}
      <table className={cn('w-full border-collapse text-left text-sm', isLoading && 'pointer-events-none opacity-60')}>
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="w-8 px-4 py-2 font-medium">
              <input
                ref={headerCheckboxRef}
                type="checkbox"
                aria-label="Select all filtered listings"
                checked={allFilteredSelected}
                onChange={onToggleAllFiltered}
              />
            </th>
            {SORTABLE_COLUMNS.map((column) => (
              <SortableHeader
                key={column.field}
                field={column.field}
                label={column.label}
                sortBy={sortBy}
                sortDirection={sortDirection}
                onSortChange={onSortChange}
                isLoading={isLoading}
              />
            ))}
            <th className="px-4 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {listings.map((listing) => {
            const isOpen = listing.id === editingListingId;
            return (
              <Fragment key={listing.id}>
                <tr className={cn('border-b border-border last:border-0', isOpen && 'bg-muted/50')}>
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${listing.title}`}
                      checked={selectedIds.has(listing.id)}
                      onChange={() => onToggleOne(listing.id)}
                    />
                  </td>
                  <td className="px-4 py-3 font-medium">
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto whitespace-normal p-0 text-left font-medium"
                        onClick={() => onToggleEdit(listing)}
                      >
                        {listing.title}
                      </Button>
                      {listing.photoPaths.length > 0 && <Image className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Has photos" />}
                      {listing.externalItemId !== null && <EbayScanBadge />}
                      {listing.nonWorking && <NonWorkingBadge />}
                    </div>
                  </td>
                  <td className="px-4 py-3">{sourcesById.get(listing.sourceId)?.name ?? 'Unknown source'}</td>
                  <td className="px-4 py-3 capitalize">{listing.status}</td>
                  <td className="px-4 py-3">${listing.askingPrice.toFixed(2)}</td>
                  <td className="px-4 py-3">${listing.comparison.totalExpectedResaleValue.toFixed(2)}</td>
                  <td className={cn('px-4 py-3 font-medium', listing.comparison.difference >= 0 ? 'text-emerald-600' : 'text-destructive')}>
                    ${listing.comparison.difference.toFixed(2)}
                  </td>
                  <td className="px-4 py-3">
                    <IdentifyPartsStatusBadge status={listing.identifyPartsStatus} />
                  </td>
                  <td className="px-4 py-3">
                    <PricingStatusBadge hasUnpricedParts={listing.hasUnpricedParts} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {listing.status === 'open' && (
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => onAccept(listing)} disabled={listing.id === pendingListingId}>
                          Accept
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => onReject(listing)} disabled={listing.id === pendingListingId}>
                          Reject
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-border bg-muted/50 last:border-0">
                    <td colSpan={COLUMN_COUNT} className="px-4 py-3">
                      {editingLoading || editingListing === null ? (
                        <LoadingSpinner />
                      ) : (
                        <ListingForm initialValue={editingListing} sources={sources} onSubmit={onSubmitEdit} onCancel={onCancelEdit} onSaved={onSavedEdit} />
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
