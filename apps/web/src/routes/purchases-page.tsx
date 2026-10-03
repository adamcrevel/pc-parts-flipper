import { useCallback, useEffect, useState } from 'react';
import type { PurchaseStatus, PurchaseSummary } from '@pc-parts-flipper/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ErrorBanner } from '@/components/error-banner';
import { PaginationControls } from '@/components/pagination-controls';
import { ApiError } from '@/lib/api-client';
import { fetchPurchases } from '@/features/purchases/purchases-api';
import { PurchasesFilters } from '@/features/purchases/purchases-filters';
import { PurchasesTable } from '@/features/purchases/purchases-table';

// One page of rows (Req 15); the Purchases list paginates past this rather
// than rendering an unbounded list.
const PAGE_SIZE = 20;

/**
 * Purchases list screen (Req 5): every Purchase with its status, linked
 * Listing title, price paid, and purchase date, filterable by status and
 * paginated, each row linking through to the detail screen. The aggregated
 * profit dashboard (Req 10-11) is T13's separate screen.
 */
export function PurchasesPage() {
  const [purchases, setPurchases] = useState<PurchaseSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<PurchaseStatus | ''>('');
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadPurchases = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await fetchPurchases({ status: status || undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
      setPurchases(result.purchases);
      setTotal(result.total);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load purchases.');
    }
  }, [status, page]);

  useEffect(() => {
    void loadPurchases();
  }, [loadPurchases]);

  function handleStatusChange(next: PurchaseStatus | '') {
    setStatus(next);
    // A changed filter can shrink the result set below the current offset,
    // so every filter change resets to page 1 rather than keeping it.
    setPage(1);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Purchases</h1>
        <PurchasesFilters value={status} onChange={handleStatusChange} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Purchases</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadError && <ErrorBanner message={loadError} />}
          {!loadError && purchases === null && <LoadingSpinner />}
          {!loadError && purchases !== null && (
            <>
              <PurchasesTable purchases={purchases} />
              <PaginationControls page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
