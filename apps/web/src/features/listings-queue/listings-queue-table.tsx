import { useEffect, useRef } from 'react';
import type { ListingSummary, Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { EbayScanBadge } from '@/features/listings/ebay-scan-badge';
import { NonWorkingBadge } from '@/features/listings/non-working-badge';
import { IdentifyPartsStatusBadge } from '@/features/listings/identify-parts-status-badge';

interface ListingsQueueTableProps {
  listings: ListingSummary[];
  sourcesById: Map<string, Source>;
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

/**
 * The Req 12 queue table: every Listing across all Sources, each row
 * showing title, Source name, status, asking price, and the Req 3
 * comparison figures, with Accept/Reject actions that only render while
 * the row is still 'open' — an accepted or rejected Listing is a closed
 * decision this screen never lets the user re-apply.
 */
export function ListingsQueueTable({
  listings,
  sourcesById,
  onAccept,
  onReject,
  pendingListingId,
  allFilteredIds,
  selectedIds,
  onToggleOne,
  onToggleAllFiltered,
}: ListingsQueueTableProps) {
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
    return <p className="text-sm text-muted-foreground">No listings match the current filters.</p>;
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
          {listings.map((listing) => (
            <tr key={listing.id} className="border-b border-border last:border-0">
              <td className="px-4 py-3">
                <input
                  type="checkbox"
                  aria-label={`Select ${listing.title}`}
                  checked={selectedIds.has(listing.id)}
                  onChange={() => onToggleOne(listing.id)}
                />
              </td>
              <td className="px-4 py-3 font-medium">
                <div className="flex items-center gap-2">
                  <span>{listing.title}</span>
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
          ))}
        </tbody>
      </table>
    </div>
  );
}
