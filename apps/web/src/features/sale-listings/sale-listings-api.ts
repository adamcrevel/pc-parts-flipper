import type { CreateSaleListingInput, ListSaleListingsResponse, MarkSaleListingListedResponse, SaleListing, UpdateSaleListingInput } from '@pc-parts-flipper/shared';
import { apiClient } from '@/lib/api-client';

// Thin resource-specific wrapper around apiClient (T4) for the
// `/api/parts/:partId/sale-listings` and `/api/sale-listings` endpoints
// (apps/server/src/routes/saleListings.ts). Keeps the route paths and
// request/response typing in one place so the Sale Listings screens never
// hand-write a path string or `as` cast.

/** Optional filter/pagination matching the GET /api/sale-listings query support (Req 8, 15). */
export interface FetchSaleListingsOptions {
  partId?: string;
  limit?: number;
  offset?: number;
}

/** Fetches one page of Sale Listings plus the total matching count, for pagination (Req 8, 15). */
export function fetchSaleListings(options: FetchSaleListingsOptions = {}): Promise<ListSaleListingsResponse> {
  const params = new URLSearchParams();
  if (options.partId) params.set('partId', options.partId);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  const query = params.toString();
  return apiClient.get<ListSaleListingsResponse>(`/api/sale-listings${query.length > 0 ? `?${query}` : ''}`);
}

/** Fetches one Sale Listing by id. */
export function fetchSaleListing(id: string): Promise<SaleListing> {
  return apiClient.get<SaleListing>(`/api/sale-listings/${id}`);
}

/** Drafts a new Sale Listing for a `ready_to_list` Part (Req 8); every field is optional and server-pre-filled when omitted. */
export function createSaleListing(partId: string, input: CreateSaleListingInput = {}): Promise<SaleListing> {
  return apiClient.post<SaleListing>(`/api/parts/${partId}/sale-listings`, input);
}

/** Edits a draft Sale Listing's fields; rejected once it has already been marked listed (Req 8). */
export function updateSaleListing(id: string, input: UpdateSaleListingInput): Promise<SaleListing> {
  return apiClient.put<SaleListing>(`/api/sale-listings/${id}`, input);
}

/** Marks a draft Sale Listing as posted, which also advances its Part's status `ready_to_list -> listed` (Req 7, 8). */
export function markSaleListingListed(id: string): Promise<MarkSaleListingListedResponse> {
  return apiClient.post<MarkSaleListingListedResponse>(`/api/sale-listings/${id}/mark-listed`);
}
