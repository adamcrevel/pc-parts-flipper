import type {
  AcceptListingResponse,
  CreateListingInput,
  IdentifyPartsResponse,
  ListingDetail,
  ListingStatus,
  ListListingsResponse,
  UpdateListingInput,
} from '@pc-parts-flipper/shared';
import { apiClient } from '@/lib/api-client';

// Thin resource-specific wrapper around apiClient (T4) for the `/api/listings`
// endpoints (apps/server/src/routes/listings.ts). Keeps the route paths and
// request/response typing in one place so listings-page.tsx and its
// sub-components never hand-write a path string or `as` cast.

/** Optional filters/pagination matching the GET /api/listings query support (Req 12, 15). */
export interface FetchListingsOptions {
  status?: ListingStatus;
  sourceId?: string;
  limit?: number;
  offset?: number;
}

/** Fetches one page of Listings (each annotated with its Req 3 comparison) plus the total matching count, for pagination (Req 15). */
export function fetchListings(options: FetchListingsOptions = {}): Promise<ListListingsResponse> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.sourceId) params.set('sourceId', options.sourceId);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  const query = params.toString();
  return apiClient.get<ListListingsResponse>(`/api/listings${query.length > 0 ? `?${query}` : ''}`);
}

/** Fetches one Listing with its full Expected Parts set and comparison. */
export function fetchListing(id: string): Promise<ListingDetail> {
  return apiClient.get<ListingDetail>(`/api/listings/${id}`);
}

/** Creates a new Listing together with its nested Expected Parts (Req 2). */
export function createListing(input: CreateListingInput): Promise<ListingDetail> {
  return apiClient.post<ListingDetail>('/api/listings', input);
}

/** Edits a Listing's fields and replaces its Expected Parts set. */
export function updateListing(id: string, input: UpdateListingInput): Promise<ListingDetail> {
  return apiClient.put<ListingDetail>(`/api/listings/${id}`, input);
}

/** Uploads one or more photo files onto an existing Listing. */
export function uploadListingPhotos(id: string, files: File[]): Promise<ListingDetail> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('photos', file);
  }
  return apiClient.postForm<ListingDetail>(`/api/listings/${id}/photos`, formData);
}

/** Accepts an open Listing, transitioning it to 'accepted' and creating a linked Purchase pre-filled from its asking price (Req 4). */
export function acceptListing(id: string): Promise<AcceptListingResponse> {
  return apiClient.post<AcceptListingResponse>(`/api/listings/${id}/accept`);
}

/** Rejects an open Listing, transitioning it to 'rejected'. */
export function rejectListing(id: string): Promise<ListingDetail> {
  return apiClient.post<ListingDetail>(`/api/listings/${id}/reject`);
}

/** Asks the AI vision model to suggest Expected Parts from an existing Listing's text and photos (on-demand only; can take 30s+). */
export function identifyListingParts(id: string): Promise<IdentifyPartsResponse> {
  return apiClient.post<IdentifyPartsResponse>(`/api/listings/${id}/identify-parts`);
}
