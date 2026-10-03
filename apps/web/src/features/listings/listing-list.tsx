import type { ListingSummary } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ListingListProps {
  listings: ListingSummary[];
  onEdit: (listing: ListingSummary) => void;
}

/**
 * Basic table of every Listing (Req 2), each row showing the Req 3
 * comparison. Full queue UI — filtering by status/Source, pagination,
 * accept/reject — is T7's screen; this just proves Listings exist and
 * links into create/edit, per this task's scope.
 */
export function ListingList({ listings, onEdit }: ListingListProps) {
  if (listings.length === 0) {
    return <p className="text-sm text-muted-foreground">No listings yet. Add one to get started.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="px-4 py-2 font-medium">Title</th>
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
              <td className="px-4 py-3 font-medium">{listing.title}</td>
              <td className="px-4 py-3 capitalize">{listing.status}</td>
              <td className="px-4 py-3">${listing.askingPrice.toFixed(2)}</td>
              <td className="px-4 py-3">${listing.comparison.totalExpectedResaleValue.toFixed(2)}</td>
              <td className={cn('px-4 py-3 font-medium', listing.comparison.difference >= 0 ? 'text-emerald-600' : 'text-destructive')}>
                ${listing.comparison.difference.toFixed(2)}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right">
                <Button variant="ghost" size="sm" onClick={() => onEdit(listing)}>
                  Edit
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
