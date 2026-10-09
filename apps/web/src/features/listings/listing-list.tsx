import { Fragment, useEffect, useRef } from 'react';
import { Image } from 'lucide-react';
import type { CreateListingInput, ListingDetail, ListingSummary, Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ListingForm } from '@/features/listings/listing-form';
import { EbayScanBadge } from '@/features/listings/ebay-scan-badge';
import { NonWorkingBadge } from '@/features/listings/non-working-badge';
import { IdentifyPartsStatusBadge } from '@/features/listings/identify-parts-status-badge';
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
}

// One table body plus, for whichever row is open, an extra full-width row
// directly beneath it holding the edit form — an inline "accordion" row
// rather than a separate top-of-page panel, so the form appears next to the
// Listing it edits regardless of scroll position.
const COLUMN_COUNT = 9;

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
      <table className="w-full border-collapse text-left text-sm">
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
            <th className="px-4 py-2 font-medium">Title</th>
            <th className="px-4 py-2 font-medium">Source</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Asking Price</th>
            <th className="px-4 py-2 font-medium">Expected Resale</th>
            <th className="px-4 py-2 font-medium">Difference</th>
            <th className="px-4 py-2 font-medium">Identify Parts</th>
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
