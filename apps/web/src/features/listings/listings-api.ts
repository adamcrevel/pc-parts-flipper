import type {
  AcceptListingResponse,
  CreateListingInput,
  IdentifyPartsJob,
  IdentifyPartsBulkResponse,
  IdentifyPartsBulkResult,
  ListingDetail,
  ListingStatus,
  ListingSortDirection,
  ListingSortField,
  ListListingsResponse,
  ListListingIdsResponse,
  UpdateListingInput,
} from '@pc-parts-flipper/shared';
import { ApiError, apiClient } from '@/lib/api-client';

// Thin resource-specific wrapper around apiClient (T4) for the `/api/listings`
// endpoints (apps/server/src/routes/listings.ts). Keeps the route paths and
// request/response typing in one place so listings-page.tsx and its
// sub-components never hand-write a path string or `as` cast.

/**
 * Optional filters/pagination matching the GET /api/listings query support
 * (Req 12, 15), plus the optional sort field/direction the sortable column
 * headers drive. Both sort fields are omitted entirely when no header has
 * been clicked yet, which is what leaves the server on its default
 * newest-first ordering.
 */
export interface FetchListingsOptions {
  status?: ListingStatus;
  sourceId?: string;
  limit?: number;
  offset?: number;
  sortBy?: ListingSortField;
  sortDirection?: ListingSortDirection;
}

/** Fetches one page of Listings (each annotated with its Req 3 comparison) plus the total matching count, for pagination (Req 15). */
export function fetchListings(options: FetchListingsOptions = {}): Promise<ListListingsResponse> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.sourceId) params.set('sourceId', options.sourceId);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  if (options.sortBy) params.set('sortBy', options.sortBy);
  if (options.sortDirection) params.set('sortDirection', options.sortDirection);
  const query = params.toString();
  return apiClient.get<ListListingsResponse>(`/api/listings${query.length > 0 ? `?${query}` : ''}`);
}

/** Fetches all Listing IDs matching the given filters, without pagination. */
export async function fetchListingIds(options: Pick<FetchListingsOptions, 'status' | 'sourceId'> = {}): Promise<string[]> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.sourceId) params.set('sourceId', options.sourceId);
  const query = params.toString();
  const response = await apiClient.get<ListListingIdsResponse>(`/api/listings/ids${query.length > 0 ? `?${query}` : ''}`);
  return response.ids;
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

/** Enqueues a new Identify-Parts job for the given Listing (201 on success; 409 if a job is already active for this listing). */
export function enqueueIdentifyPartsJob(listingId: string): Promise<IdentifyPartsJob> {
  return apiClient.post<IdentifyPartsJob>(`/api/listings/${listingId}/identify-parts`);
}

/** Fetches an Identify-Parts job by id to check its current stage and results. */
export function fetchIdentifyPartsJob(jobId: string): Promise<IdentifyPartsJob> {
  return apiClient.get<IdentifyPartsJob>(`/api/identify-parts-jobs/${jobId}`);
}

/** Fetches the latest Identify-Parts job for a given Listing, or null if none exists (catches 404). */
export async function fetchLatestIdentifyPartsJob(listingId: string): Promise<IdentifyPartsJob | null> {
  try {
    return await apiClient.get<IdentifyPartsJob>(`/api/listings/${listingId}/identify-parts-jobs/latest`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

/** Marks an Identify-Parts job as delivered so its result is not repeated to the caller. */
export async function ackIdentifyPartsJob(jobId: string): Promise<void> {
  await apiClient.post<void>(`/api/identify-parts-jobs/${jobId}/ack`);
}

/** Enqueues a bulk Identify-Parts job for the given Listing IDs, returning the outcome for each. */
export async function enqueueBulkIdentifyParts(listingIds: string[]): Promise<IdentifyPartsBulkResult[]> {
  const response = await apiClient.post<IdentifyPartsBulkResponse>('/api/listings/identify-parts/bulk', { listingIds });
  return response.results;
}
