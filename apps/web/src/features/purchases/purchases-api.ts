import type { ListPurchasesResponse, PurchaseDetail, PurchaseStatus, UpdatePurchaseInput } from '@pc-parts-flipper/shared';
import { apiClient } from '@/lib/api-client';

// Thin resource-specific wrapper around apiClient (T4) for the
// `/api/purchases` endpoints (apps/server/src/routes/purchases.ts). Keeps
// the route paths and request/response typing in one place so the
// Purchases list/detail screens never hand-write a path string or `as` cast.

/** Optional filter/pagination matching the GET /api/purchases query support (Req 5, 15). */
export interface FetchPurchasesOptions {
  status?: PurchaseStatus;
  limit?: number;
  offset?: number;
}

/** Fetches one page of Purchases (each annotated with its Listing summary) plus the total matching count, for pagination (Req 15). */
export function fetchPurchases(options: FetchPurchasesOptions = {}): Promise<ListPurchasesResponse> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  const query = params.toString();
  return apiClient.get<ListPurchasesResponse>(`/api/purchases${query.length > 0 ? `?${query}` : ''}`);
}

/** Fetches one Purchase with its full originating Listing (including Expected Parts). */
export function fetchPurchase(id: string): Promise<PurchaseDetail> {
  return apiClient.get<PurchaseDetail>(`/api/purchases/${id}`);
}

/** Edits a Purchase's price paid / purchase date (Req 5, 13). */
export function updatePurchase(id: string, input: UpdatePurchaseInput): Promise<PurchaseDetail> {
  return apiClient.put<PurchaseDetail>(`/api/purchases/${id}`, input);
}

/** Advances a Purchase's status exactly one step forward (Req 5). */
export function updatePurchaseStatus(id: string, status: PurchaseStatus): Promise<PurchaseDetail> {
  return apiClient.patch<PurchaseDetail>(`/api/purchases/${id}/status`, { status });
}
