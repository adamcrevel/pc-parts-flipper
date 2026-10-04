import { Fragment } from 'react';
import { Image } from 'lucide-react';
import type { CreateListingInput, ListingDetail, ListingSummary, Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ListingForm } from '@/features/listings/listing-form';
import { cn } from '@/lib/utils';

interface ListingListProps {
  listings: ListingSummary[];
  sources: Source[];
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
}

// One table body plus, for whichever row is open, an extra full-width row
// directly beneath it holding the edit form — an inline "accordion" row
// rather than a separate top-of-page panel, so the form appears next to the
// Listing it edits regardless of scroll position.
const COLUMN_COUNT = 5;

/**
 * Basic table of every Listing (Req 2), each row showing the Req 3
 * comparison. Clicking a Listing's title (not a separate Edit button) opens
 * that Listing's edit form inline, directly below its row. Full queue UI —
 * filtering by status/Source, pagination, accept/reject — is T7's screen;
 * this just proves Listings exist and links into create/edit, per this
 * task's scope.
 */
export function ListingList({
  listings,
  sources,
  editingListingId,
  editingListing,
  editingLoading,
  onToggleEdit,
  onSubmitEdit,
  onCancelEdit,
  onSavedEdit,
}: ListingListProps) {
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
          </tr>
        </thead>
        <tbody>
          {listings.map((listing) => {
            const isOpen = listing.id === editingListingId;
            return (
              <Fragment key={listing.id}>
                <tr className={cn('border-b border-border last:border-0', isOpen && 'bg-muted/50')}>
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
                    </div>
                  </td>
                  <td className="px-4 py-3 capitalize">{listing.status}</td>
                  <td className="px-4 py-3">${listing.askingPrice.toFixed(2)}</td>
                  <td className="px-4 py-3">${listing.comparison.totalExpectedResaleValue.toFixed(2)}</td>
                  <td className={cn('px-4 py-3 font-medium', listing.comparison.difference >= 0 ? 'text-emerald-600' : 'text-destructive')}>
                    ${listing.comparison.difference.toFixed(2)}
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
