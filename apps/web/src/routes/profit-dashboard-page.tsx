import { useCallback, useEffect, useState } from 'react';
import type { PurchaseProfit } from '@pc-parts-flipper/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ErrorBanner } from '@/components/error-banner';
import { PaginationControls } from '@/components/pagination-controls';
import { ApiError } from '@/lib/api-client';
import { fetchProfit } from '@/features/profit/profit-api';
import { ProfitFilters, type ProfitFilterValue } from '@/features/profit/profit-filters';
import { ProfitTable } from '@/features/profit/profit-table';

// One page of rows (Req 15); the Profit dashboard paginates past this rather
// than rendering an unbounded list.
const PAGE_SIZE = 20;

/**
 * Profit dashboard screen (Req 10-11): every Purchase with its net profit
 * (running/partial vs final, visually distinct), price paid, sale revenue,
 * and fees/shipping, sortable (net profit / price paid / purchase date) and
 * filterable (status, partial/final), paginated (Req 15). This is the one
 * screen that satisfies Requirement 11 in full — purchases-page.tsx remains
 * the simpler per-purchase browsing list with no profit aggregation.
 */
export function ProfitDashboardPage() {
  const [purchases, setPurchases] = useState<PurchaseProfit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<ProfitFilterValue>({ status: '', partial: 'all', sortBy: 'purchaseDate', sortDir: 'desc' });
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadProfit = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await fetchProfit({
        status: filters.status || undefined,
        partial: filters.partial === 'all' ? undefined : filters.partial === 'partial',
        sortBy: filters.sortBy,
        sortDir: filters.sortDir,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      setPurchases(result.purchases);
      setTotal(result.total);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load the profit dashboard.');
    }
  }, [filters, page]);

  useEffect(() => {
    void loadProfit();
  }, [loadProfit]);

  function handleFiltersChange(next: ProfitFilterValue) {
    setFilters(next);
    // A changed filter/sort can shrink or reorder the result set below the
    // current offset, so every change resets to page 1 rather than keeping it.
    setPage(1);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Profit Dashboard</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Per-Purchase Profit</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ProfitFilters value={filters} onChange={handleFiltersChange} />
          {loadError && <ErrorBanner message={loadError} />}
          {!loadError && purchases === null && <LoadingSpinner />}
          {!loadError && purchases !== null && (
            <>
              <ProfitTable purchases={purchases} />
              <PaginationControls page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
