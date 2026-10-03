import type { ListingSummary, Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { EbayScanBadge } from '@/features/listings/ebay-scan-badge';

interface ListingsQueueTableProps {
  listings: ListingSummary[];
  sourcesById: Map<string, Source>;
  onAccept: (listing: ListingSummary) => void;
  onReject: (listing: ListingSummary) => void;
  // Req 4: the Listing id with an accept/reject request currently in
  // flight, if any — its row's buttons are disabled so a user can't fire a
  // second request against the same row before the first one resolves.
  pendingListingId: string | null;
}

/**
 * The Req 12 queue table: every Listing across all Sources, each row
 * showing title, Source name, status, asking price, and the Req 3
 * comparison figures, with Accept/Reject actions that only render while
 * the row is still 'open' — an accepted or rejected Listing is a closed
 * decision this screen never lets the user re-apply.
 */
export function ListingsQueueTable({ listings, sourcesById, onAccept, onReject, pendingListingId }: ListingsQueueTableProps) {
  if (listings.length === 0) {
    return <p className="text-sm text-muted-foreground">No listings match the current filters.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="px-4 py-2 font-medium">Title</th>
            <th className="px-4 py-2 font-medium">Source</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Asking Price</th>
            <th className="px-4 py-2 font-medium">Expected Resale</th>
            <th className="px-4 py-2 font-medium">Difference</th>
            <th className="px-4 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {listings.map((listing) => (
            <tr key={listing.id} className="border-b border-border last:border-0">
              <td className="px-4 py-3 font-medium">
                <div className="flex items-center gap-2">
                  <span>{listing.title}</span>
                  {listing.externalItemId !== null && <EbayScanBadge />}
                </div>
              </td>
              <td className="px-4 py-3">{sourcesById.get(listing.sourceId)?.name ?? 'Unknown source'}</td>
              <td className="px-4 py-3 capitalize">{listing.status}</td>
              <td className="px-4 py-3">${listing.askingPrice.toFixed(2)}</td>
              <td className="px-4 py-3">${listing.comparison.totalExpectedResaleValue.toFixed(2)}</td>
              <td className={cn('px-4 py-3 font-medium', listing.comparison.difference >= 0 ? 'text-emerald-600' : 'text-destructive')}>
                ${listing.comparison.difference.toFixed(2)}
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
