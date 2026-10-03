import type { ListPartsResponse, PartStatus, PartSummary } from '@pc-parts-flipper/shared';
import { apiClient } from '@/lib/api-client';

// Thin resource-specific wrapper around apiClient (T4) for the
// `/api/parts` endpoints (apps/server/src/routes/parts.ts). Keeps the
// route paths and request/response typing in one place so the Parts list
// screen never hand-writes a path string or `as` cast.

/** Optional filter/pagination matching the GET /api/parts query support (Req 7, 15). */
export interface FetchPartsOptions {
  status?: PartStatus;
  purchaseId?: string;
  limit?: number;
  offset?: number;
}

/** Fetches one page of Parts (each annotated with its Purchase/Listing summary) plus the total matching count, for pagination (Req 15). */
export function fetchParts(options: FetchPartsOptions = {}): Promise<ListPartsResponse> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.purchaseId) params.set('purchaseId', options.purchaseId);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  const query = params.toString();
  return apiClient.get<ListPartsResponse>(`/api/parts${query.length > 0 ? `?${query}` : ''}`);
}

/** Fetches one Part by id, annotated with its Purchase/Listing context — the Record Sale screen's context header (Req 9). */
export function fetchPart(id: string): Promise<PartSummary> {
  return apiClient.get<PartSummary>(`/api/parts/${id}`);
}

/** Marks a `ready_to_list` Part `unsellable` with a required reason note (Req 7, 13) — the only status transition this screen drives; `listed`/`sold` are driven by T11's Sale Listing flow and T12's Sale-recording flow respectively. */
export function markPartUnsellable(id: string, reason: string): Promise<PartSummary> {
  return apiClient.patch<PartSummary>(`/api/parts/${id}/status`, { status: 'unsellable', reason });
}
