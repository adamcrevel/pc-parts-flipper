import { useCallback, useEffect, useRef, useState } from 'react';
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

// Whether the top-of-page create form is open. Editing an existing Listing
// is no longer a top-of-page panel — ListingList renders that inline, right
// below the clicked row — so this only ever toggles the create form.
type PanelState = { mode: 'list' } | { mode: 'create' };

/**
 * Listings screen (Req 2-3): create/edit a Listing with its nested Expected
 * Parts, photo upload, and the live comparison calculation, plus a basic
 * table of existing Listings. The full filterable/paginated queue (Req 12,
 * 15) with accept/reject actions is T7's screen, built on top of this one's
 * API and form. Editing happens inline in the table (ListingList); creating
 * still opens a form above it.
 */
export function ListingsPage() {
  const [listings, setListings] = useState<ListingSummary[] | null>(null);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelState>({ mode: 'list' });

  // Which Listing's inline edit row is open, and its full ListingDetail
  // (fetched, with Expected Parts, once a row opens) — mirrors the old
  // top-of-page edit panel's data, just rendered by ListingList instead.
  const [editingListingId, setEditingListingId] = useState<string | null>(null);
  const [editingListing, setEditingListing] = useState<ListingDetail | null>(null);
  const [editingLoading, setEditingLoading] = useState(false);
  // Bumped on every click that opens or closes a row, so an in-flight
  // fetchListing — whether for a different listing (A, then B, before A's
  // slower response lands) or the SAME listing re-clicked while its own
  // earlier request is still pending — can tell it's no longer the most
  // recent request and skip applying its stale result once it resolves.
  const editRequestTokenRef = useRef(0);

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

  // Clicking a Listing's title: closes it if it's already the open row,
  // otherwise closes whichever other row was open and opens this one,
  // fetching its full detail (Expected Parts included) before the form can
  // render.
  async function handleToggleEdit(summary: ListingSummary) {
    if (editingListingId === summary.id) {
      editRequestTokenRef.current += 1;
      setEditingListingId(null);
      setEditingListing(null);
      return;
    }

    const requestToken = (editRequestTokenRef.current += 1);
    setEditingListingId(summary.id);
    setEditingListing(null);
    setEditingLoading(true);
    try {
      const detail = await fetchListing(summary.id);
      if (editRequestTokenRef.current !== requestToken) return;
      setEditingListing(detail);
    } catch (err) {
      if (editRequestTokenRef.current !== requestToken) return;
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load listing.');
      setEditingListingId(null);
    } finally {
      if (editRequestTokenRef.current === requestToken) {
        setEditingLoading(false);
      }
    }
  }

  function handleEditCancel() {
    editRequestTokenRef.current += 1;
    setEditingListingId(null);
    setEditingListing(null);
  }

  // After a successful create, the form stays open (showing the Photos
  // section) rather than snapping back to the list — ListingForm tracks
  // that itself via its own `saved` state, so this just refreshes the
  // table so the new Listing shows up in it.
  function handleCreateSaved() {
    void loadListings();
  }

  function handleEditSaved(listing: ListingDetail) {
    setEditingListing(listing);
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
        <ListingForm sources={sources} onSubmit={(input: CreateListingInput) => createListing(input)} onCancel={() => setPanel({ mode: 'list' })} onSaved={handleCreateSaved} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Listings</CardTitle>
        </CardHeader>
        <CardContent>
          {loadError && <ErrorBanner message={loadError} />}
          {!loadError && listings === null && <LoadingSpinner />}
          {!loadError && listings !== null && sources && (
            <ListingList
              listings={listings}
              sources={sources}
              editingListingId={editingListingId}
              editingListing={editingListing}
              editingLoading={editingLoading}
              onToggleEdit={(summary) => void handleToggleEdit(summary)}
              onSubmitEdit={(input: CreateListingInput) => updateListing(editingListingId as string, input)}
              onCancelEdit={handleEditCancel}
              onSavedEdit={handleEditSaved}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
