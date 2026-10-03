import { useCallback, useEffect, useState } from 'react';
import type { SaleListing } from '@pc-parts-flipper/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ErrorBanner } from '@/components/error-banner';
import { PaginationControls } from '@/components/pagination-controls';
import { ApiError } from '@/lib/api-client';
import { fetchSaleListings } from '@/features/sale-listings/sale-listings-api';
import { SaleListingsList } from '@/features/sale-listings/sale-listings-list';

// One page of rows (Req 15); the Sale Listings list paginates past this
// rather than rendering an unbounded list.
const PAGE_SIZE = 20;

/**
 * Sale Listings screen (Req 8): every Sale Listing drafted or posted across
 * every Part, paginated. Drafting a new one starts from a `ready_to_list`
 * row on the Parts screen (SaleListingNewPage), not from here — this is a
 * read-oriented index into what already exists.
 */
export function SaleListingsPage() {
  const [saleListings, setSaleListings] = useState<SaleListing[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadSaleListings = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await fetchSaleListings({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
      setSaleListings(result.saleListings);
      setTotal(result.total);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load sale listings.');
    }
  }, [page]);

  useEffect(() => {
    void loadSaleListings();
  }, [loadSaleListings]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Sale Listings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Sale Listings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadError && <ErrorBanner message={loadError} />}
          {!loadError && saleListings === null && <LoadingSpinner />}
          {!loadError && saleListings !== null && (
            <>
              <SaleListingsList saleListings={saleListings} />
              <PaginationControls page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
