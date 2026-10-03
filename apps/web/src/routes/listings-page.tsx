import { useCallback, useEffect, useState } from 'react';
import type { CreateListingInput, ListingDetail, ListingSummary, Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError } from '@/lib/api-client';
import { fetchSources } from '@/features/sources/sources-api';
import { createListing, fetchListing, fetchListings, updateListing } from '@/features/listings/listings-api';
import { ListingForm } from '@/features/listings/listing-form';
import { ListingList } from '@/features/listings/listing-list';

// Which panel renders below the toolbar: the table alone, the create form,
// or the edit form for one specific Listing (fetched in full, with its
// Expected Parts, before the form opens).
type PanelState = { mode: 'list' } | { mode: 'create' } | { mode: 'edit'; listing: ListingDetail };

/**
 * Listings screen (Req 2-3): create/edit a Listing with its nested Expected
 * Parts, photo upload, and the live comparison calculation, plus a basic
 * table of existing Listings. The full filterable/paginated queue (Req 12,
 * 15) with accept/reject actions is T7's screen, built on top of this one's
 * API and form.
 */
export function ListingsPage() {
  const [listings, setListings] = useState<ListingSummary[] | null>(null);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelState>({ mode: 'list' });

  const loadListings = useCallback(async () => {
    setLoadError(null);
    try {
      // This screen's basic table shows every Listing regardless of status
      // (create/edit scope, not the Req 12 queue), so it requests a large
      // page rather than wiring up pagination controls here — that's the
      // Listings Queue screen's job (listings-queue-page.tsx).
      const result = await fetchListings({ limit: 1000 });
      setListings(result.listings);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load listings.');
    }
  }, []);

  useEffect(() => {
    void loadListings();
    // The Source picker needs every active Source regardless of which panel
    // is open, so it's loaded once up front rather than per-form-open.
    void fetchSources(true)
      .then(setSources)
      .catch((err: unknown) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load sources.'));
  }, [loadListings]);

  async function handleEditClick(summary: ListingSummary) {
    try {
      const detail = await fetchListing(summary.id);
      setPanel({ mode: 'edit', listing: detail });
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load listing.');
    }
  }

  // After a successful create or edit save, the form stays open (showing
  // the Photos section) rather than snapping back to the list — matches
  // listing-form.tsx's "upload right after create" choice.
  function handleSaved(listing: ListingDetail) {
    setPanel({ mode: 'edit', listing });
    void loadListings();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Listings</h1>
        <Button onClick={() => setPanel({ mode: 'create' })} disabled={panel.mode === 'create'}>
          Add Listing
        </Button>
      </div>

      {sources && panel.mode === 'create' && (
        <ListingForm sources={sources} onSubmit={(input: CreateListingInput) => createListing(input)} onCancel={() => setPanel({ mode: 'list' })} onSaved={handleSaved} />
      )}
      {sources && panel.mode === 'edit' && (
        <ListingForm
          initialValue={panel.listing}
          sources={sources}
          onSubmit={(input: CreateListingInput) => updateListing(panel.listing.id, input)}
          onCancel={() => setPanel({ mode: 'list' })}
          onSaved={handleSaved}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Listings</CardTitle>
        </CardHeader>
        <CardContent>
          {loadError && <ErrorBanner message={loadError} />}
          {!loadError && listings === null && <LoadingSpinner />}
          {!loadError && listings !== null && <ListingList listings={listings} onEdit={handleEditClick} />}
        </CardContent>
      </Card>
    </div>
  );
}
