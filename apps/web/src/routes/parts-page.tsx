import { useCallback, useEffect, useState } from 'react';
import type { PartStatus, PartSummary } from '@pc-parts-flipper/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ErrorBanner } from '@/components/error-banner';
import { PaginationControls } from '@/components/pagination-controls';
import { ApiError } from '@/lib/api-client';
import { fetchParts, markPartUnsellable } from '@/features/parts/parts-api';
import { PartsFilters } from '@/features/parts/parts-filters';
import { PartsTable } from '@/features/parts/parts-table';

// One page of rows (Req 15); the Parts list paginates past this rather
// than rendering an unbounded list.
const PAGE_SIZE = 20;

/**
 * Parts screen (Req 7): every Part recovered from a teardown, with its
 * category, description, status badge, and the owning Purchase's Listing
 * for context, filterable by status and paginated. The only status-update
 * action offered here is the `ready_to_list -> unsellable` side-branch
 * (Req 13: requires a non-blank reason note) — the forward
 * `listed`/`sold` transitions are driven by T11's Sale Listing flow and
 * T12's Sale-recording flow instead, which own the richer forms that
 * should trigger them.
 */
export function PartsPage() {
  const [parts, setParts] = useState<PartSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<PartStatus | ''>('');
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadParts = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await fetchParts({ status: status || undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
      setParts(result.parts);
      setTotal(result.total);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load parts.');
    }
  }, [status, page]);

  useEffect(() => {
    void loadParts();
  }, [loadParts]);

  function handleStatusChange(next: PartStatus | '') {
    setStatus(next);
    // A changed filter can shrink the result set below the current offset,
    // so every filter change resets to page 1 rather than keeping it.
    setPage(1);
  }

  // Marks a Part unsellable, then re-fetches the current page so its badge
  // and reason note reflect the server's confirmed state rather than an
  // optimistic local patch.
  async function handleMarkUnsellable(id: string, reason: string) {
    await markPartUnsellable(id, reason);
    await loadParts();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Parts</h1>
        <PartsFilters value={status} onChange={handleStatusChange} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Parts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadError && <ErrorBanner message={loadError} />}
          {!loadError && parts === null && <LoadingSpinner />}
          {!loadError && parts !== null && (
            <>
              <PartsTable parts={parts} onMarkUnsellable={handleMarkUnsellable} />
              <PaginationControls page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
