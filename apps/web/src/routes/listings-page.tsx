import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CreateListingInput, ListingDetail, ListingSortDirection, ListingSortField, ListingSummary, Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ErrorBanner } from '@/components/error-banner';
import { PaginationControls } from '@/components/pagination-controls';
import { ApiError } from '@/lib/api-client';
import { fetchSources } from '@/features/sources/sources-api';
import { acceptListing, createListing, fetchListing, fetchListingIds, fetchListings, rejectListing, updateListing } from '@/features/listings/listings-api';
import { ListingForm } from '@/features/listings/listing-form';
import { ListingList } from '@/features/listings/listing-list';
import { ListingFilters, type ListingsQueueFilterValue } from '@/features/listings/listing-filters';
import { BulkIdentifyPartsBar } from '@/features/listings/bulk-identify-parts-bar';

// Whether the top-of-page create form is open. Editing an existing Listing
// is no longer a top-of-page panel — ListingList renders that inline, right
// below the clicked row — so this only ever toggles the create form.
type PanelState = { mode: 'list' } | { mode: 'create' };

// One page of rows; the Listings paginates past this rather
// than rendering an unbounded list.
const PAGE_SIZE = 20;

/**
 * Listings screen (Req 2-3, 5, 6, 8, 9, 10, 12): create/edit a Listing with
 * its nested Expected Parts, photo upload, and the live comparison calculation,
 * plus a paginated, filterable table of existing Listings with accept/reject
 * actions, bulk-select checkboxes, and auto-refresh while identify-parts jobs
 * are running. The create/edit forms (top-of-page create, inline edit) work
 * exactly as before.
 */
export function ListingsPage() {
  const [listings, setListings] = useState<ListingSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [filters, setFilters] = useState<ListingsQueueFilterValue>({ status: '', sourceId: '' });
  const [page, setPage] = useState(1);
  // The column the table is sorted by and its direction, or `undefined` for
  // both until a header is clicked: no sort param is sent then, which is
  // what leaves the server on its existing default (newest listingDate
  // first) ordering. Only one field is ever active at a time.
  const [sortBy, setSortBy] = useState<ListingSortField | undefined>(undefined);
  const [sortDirection, setSortDirection] = useState<ListingSortDirection | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [acceptedMessage, setAcceptedMessage] = useState<{ text: string; purchaseId: string } | null>(null);
  // Req 4: tracks the single Listing row (if any) with an accept/reject
  // request in flight, so its buttons can be disabled the instant a click
  // fires — otherwise a user double-click (or a slow response) can send a
  // second accept/reject for the same row before the first one's reload
  // replaces the row.
  const [pendingListingId, setPendingListingId] = useState<string | null>(null);
  // Req 1/4: the Listing ids ticked for a bulk Identify-Parts run. Held at
  // the page's top level, outside the page/filter-driven reload effect, so
  // a selection made on page 1 (or under one filter) survives paging and
  // filter changes for the rest of the visit — nothing but an explicit
  // toggle or a completed bulk request clears it.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Req 2: every Listing id matching the current filters across *all*
  // pages, which is what "select all" has to resolve to — the current
  // page's rows are only a window onto it.
  const [allFilteredIds, setAllFilteredIds] = useState<string[]>([]);

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
  // Whether the top-of-page create form is open. Editing an existing Listing
  // is no longer a top-of-page panel — ListingList renders that inline, right
  // below the clicked row — so this only ever toggles the create form.
  const [panel, setPanel] = useState<PanelState>({ mode: 'list' });

  const loadListings = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await fetchListings({
        status: filters.status || undefined,
        sourceId: filters.sourceId || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        sortBy,
        sortDirection,
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
  }, [filters, page, sortBy, sortDirection]);

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

  useEffect(() => {
    // Req 2: keyed on `filters` alone, never `page` — the filtered id set
    // is page-independent, so paging must not refetch it (and must not
    // narrow it to the visible rows).
    void fetchListingIds({ status: filters.status || undefined, sourceId: filters.sourceId || undefined })
      .then(setAllFilteredIds)
      .catch((err: unknown) => setLoadError(err instanceof ApiError ? err.message : 'Failed to load listing ids.'));
  }, [filters]);

  useEffect(() => {
    // Req 12: while any *visible* row still has a non-terminal
    // identify-parts job, re-poll the page every 2000ms — the same
    // interval identify-parts-button.tsx polls a single job at — so the
    // status badges advance on their own. Re-evaluated every time
    // `listings` changes, so the interval is torn down by this effect's
    // own cleanup as soon as no visible row is still running.
    const hasPendingStatus = (listings ?? []).some(
      (listing) =>
        listing.identifyPartsStatus !== null &&
        listing.identifyPartsStatus.stage !== 'completed' &&
        listing.identifyPartsStatus.stage !== 'failed',
    );
    if (!hasPendingStatus) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadListings();
    }, 2000);
    return () => clearInterval(intervalId);
  }, [listings, loadListings]);

  // Req 1: add the id if it isn't selected, drop it if it is.
  function handleToggleOne(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  // Req 3/4: the header checkbox acts on the filtered id set only. When
  // every filtered id is already selected it deselects exactly those ids,
  // leaving any selection made under a different filter untouched;
  // otherwise it adds them all to whatever is already selected.
  function handleToggleAllFiltered() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allFilteredIds.every((id) => current.has(id))) {
        for (const id of allFilteredIds) {
          next.delete(id);
        }
        return next;
      }
      for (const id of allFilteredIds) {
        next.add(id);
      }
      return next;
    });
  }

  const sourcesById = useMemo(() => new Map((sources ?? []).map((source) => [source.id, source])), [sources]);

  function handleFiltersChange(next: ListingsQueueFilterValue) {
    setFilters(next);
    // A changed filter can shrink the result set below the current offset,
    // so every filter change resets to page 1 rather than keeping it.
    setPage(1);
  }

  // Clicking a sortable column header. Clicking the column that is already
  // active only reverses its direction; clicking any other column replaces
  // the active field outright, starting ascending — so exactly one field is
  // ever sorted by, never a combination. Either way the sorted order is
  // computed server-side across the whole filtered dataset, so the result's
  // first page is a different set of rows than before: reset to page 1, the
  // same way a filter change does. Note this deliberately leaves `filters`
  // alone, just as handleFiltersChange leaves the sort alone — the two
  // compose rather than clearing each other.
  function handleSortChange(field: ListingSortField) {
    if (sortBy === field) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDirection('asc');
    }
    setPage(1);
  }

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
        <h1 className="text-2xl font-semibold">Listings</h1>
        <div className="flex items-center gap-4">
          {sources !== null && <ListingFilters value={filters} sources={sources} onChange={handleFiltersChange} />}
          <Button onClick={() => setPanel({ mode: 'create' })} disabled={panel.mode === 'create'}>
            Add Listing
          </Button>
        </div>
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

      {sources && panel.mode === 'create' && (
        <ListingForm sources={sources} onSubmit={(input: CreateListingInput) => createListing(input)} onCancel={() => setPanel({ mode: 'list' })} onSaved={handleCreateSaved} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Listings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadError && <ErrorBanner message={loadError} />}
          {!loadError && listings === null && <LoadingSpinner />}
          {!loadError && listings !== null && sources && (
            <>
              <ListingList
                listings={listings}
                sources={sources}
                sourcesById={sourcesById}
                editingListingId={editingListingId}
                editingListing={editingListing}
                editingLoading={editingLoading}
                onToggleEdit={(summary) => void handleToggleEdit(summary)}
                onSubmitEdit={(input: CreateListingInput) => updateListing(editingListingId as string, input)}
                onCancelEdit={handleEditCancel}
                onSavedEdit={handleEditSaved}
                onAccept={handleAccept}
                onReject={handleReject}
                pendingListingId={pendingListingId}
                allFilteredIds={allFilteredIds}
                selectedIds={selectedIds}
                onToggleOne={handleToggleOne}
                sortBy={sortBy}
                sortDirection={sortDirection}
                onSortChange={handleSortChange}
                onToggleAllFiltered={handleToggleAllFiltered}
              />
              <PaginationControls page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
            </>
          )}
        </CardContent>
      </Card>

      <BulkIdentifyPartsBar selectedIds={selectedIds} onCleared={() => { setSelectedIds(new Set()); void loadListings(); }} />
    </div>
  );
}