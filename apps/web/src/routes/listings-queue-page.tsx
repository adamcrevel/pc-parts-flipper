import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ListingSummary, Source } from '@pc-parts-flipper/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ErrorBanner } from '@/components/error-banner';
import { PaginationControls } from '@/components/pagination-controls';
import { ApiError } from '@/lib/api-client';
import { fetchSources } from '@/features/sources/sources-api';
import { acceptListing, fetchListings, rejectListing } from '@/features/listings/listings-api';
import { ListingsQueueFilters, type ListingsQueueFilterValue } from '@/features/listings-queue/listings-queue-filters';
import { ListingsQueueTable } from '@/features/listings-queue/listings-queue-table';

// One page of rows (Req 15); the Listings queue paginates past this rather
// than rendering an unbounded list.
const PAGE_SIZE = 20;

/**
 * Listings Queue screen (Req 12): every Listing across all Sources,
 * filterable by status and Source, with Accept/Reject actions (Req 4) and
 * pagination (Req 15). Distinct from listings-page.tsx's create/edit
 * screen — this one is read/decide-only, built on the same `/api/listings`
 * endpoints.
 */
export function ListingsQueuePage() {
  const [listings, setListings] = useState<ListingSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [filters, setFilters] = useState<ListingsQueueFilterValue>({ status: '', sourceId: '' });
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acceptedMessage, setAcceptedMessage] = useState<{ text: string; purchaseId: string } | null>(null);
  // Req 4: tracks the single Listing row (if any) with an accept/reject
  // request in flight, so its buttons can be disabled the instant a click
  // fires — otherwise a user double-click (or a slow response) can send a
  // second accept/reject for the same row before the first one's reload
  // replaces the row.
  const [pendingListingId, setPendingListingId] = useState<string | null>(null);

  const loadListings = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await fetchListings({
        status: filters.status || undefined,
        sourceId: filters.sourceId || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      // An accept/reject action can shrink the filtered result set enough
      // that the current page no longer exists (e.g. the last row on the
      // last page was just accepted), stranding the user on an empty page
      // with no way back since PaginationControls renders nothing once
      // pageCount<=1. Clamp back to the new last page — using the same
      // Math.max(1, Math.ceil(total/pageSize)) formula PaginationControls
      // uses to compute pageCount — and let the effect below refetch.
      const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
      if (result.listings.length === 0 && result.total > 0 && page > lastPage) {
        setPage(lastPage);
        return;
      }
      setListings(result.listings);
      setTotal(result.total);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load listings.');
    }
  }, [filters, page]);

  useEffect(() => {
    void loadListings();
  }, [loadListings]);

  useEffect(() => {
    // Every Source (including inactive) populates the filter dropdown, since
    // a past Listing may belong to a Source that's since been deactivated.
    void fetchSources(false)
      .then(setSources)
      .catch((err: unknown) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load sources.'));
  }, []);

  const sourcesById = useMemo(() => new Map((sources ?? []).map((source) => [source.id, source])), [sources]);

  function handleFiltersChange(next: ListingsQueueFilterValue) {
    setFilters(next);
    // A changed filter can shrink the result set below the current offset,
    // so every filter change resets to page 1 rather than keeping it.
    setPage(1);
  }

  async function handleAccept(listing: ListingSummary) {
    setActionError(null);
    setAcceptedMessage(null);
    setPendingListingId(listing.id);
    try {
      const result = await acceptListing(listing.id);
      setAcceptedMessage({ text: `Accepted "${listing.title}" — created Purchase ${result.purchaseId}.`, purchaseId: result.purchaseId });
      await loadListings();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to accept listing.');
    } finally {
      setPendingListingId(null);
    }
  }

  async function handleReject(listing: ListingSummary) {
    setActionError(null);
    setAcceptedMessage(null);
    setPendingListingId(listing.id);
    try {
      await rejectListing(listing.id);
      await loadListings();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to reject listing.');
    } finally {
      setPendingListingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Listings Queue</h1>
        {sources !== null && <ListingsQueueFilters value={filters} sources={sources} onChange={handleFiltersChange} />}
      </div>

      {acceptedMessage && (
        <div className="rounded-md border border-emerald-600/50 bg-emerald-600/10 px-4 py-3 text-sm text-emerald-700">
          {acceptedMessage.text}{' '}
          <Link to={`/purchases/${acceptedMessage.purchaseId}`} className="font-medium underline underline-offset-4">
            View Purchase
          </Link>
        </div>
      )}
      {actionError && <ErrorBanner message={actionError} />}

      <Card>
        <CardHeader>
          <CardTitle>Listings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadError && <ErrorBanner message={loadError} />}
          {!loadError && listings === null && <LoadingSpinner />}
          {!loadError && listings !== null && (
            <>
              <ListingsQueueTable
                listings={listings}
                sourcesById={sourcesById}
                onAccept={handleAccept}
                onReject={handleReject}
                pendingListingId={pendingListingId}
              />
              <PaginationControls page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
