import type { ListProfitResponse, ProfitSortBy, ProfitSortDir, PurchaseStatus } from '@pc-parts-flipper/shared';
import { apiClient } from '@/lib/api-client';

// Thin resource-specific wrapper around apiClient (T4) for the
// `GET /api/purchases/profit` endpoint (apps/server/src/routes/profit.ts).
// Keeps the route path and request/response typing in one place so the
// Profit dashboard screen never hand-writes a path string or `as` cast.

/** Filter/sort/pagination matching the GET /api/purchases/profit query support (Req 10-11, 15). */
export interface FetchProfitOptions {
  status?: PurchaseStatus;
  partial?: boolean;
  sortBy?: ProfitSortBy;
  sortDir?: ProfitSortDir;
  limit?: number;
  offset?: number;
}

/** Fetches one page of the per-Purchase profit rollup plus the total matching count, for pagination (Req 15). */
export function fetchProfit(options: FetchProfitOptions = {}): Promise<ListProfitResponse> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.partial !== undefined) params.set('partial', String(options.partial));
  if (options.sortBy) params.set('sortBy', options.sortBy);
  if (options.sortDir) params.set('sortDir', options.sortDir);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  const query = params.toString();
  return apiClient.get<ListProfitResponse>(`/api/purchases/profit${query.length > 0 ? `?${query}` : ''}`);
}
