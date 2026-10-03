import type { SubmitTeardownInput, SubmitTeardownResponse, TeardownFormResponse } from '@pc-parts-flipper/shared';
import { apiClient } from '@/lib/api-client';

// Thin resource-specific wrapper around apiClient (T4) for the
// `/api/purchases/:id/teardown` endpoints (apps/server/src/routes/teardown.ts).
// Keeps the route paths and request/response typing in one place so the
// Teardown checklist screen never hand-writes a path string or `as` cast.

/** Fetches the Expected Parts to reconcile, plus any already-recorded teardown results, for a Purchase (Req 6). */
export function fetchTeardownForm(purchaseId: string): Promise<TeardownFormResponse> {
  return apiClient.get<TeardownFormResponse>(`/api/purchases/${purchaseId}/teardown`);
}

/** Submits the completed teardown checklist, creating Parts and moving the Purchase to `torn_down` (Req 6). */
export function submitTeardown(purchaseId: string, input: SubmitTeardownInput): Promise<SubmitTeardownResponse> {
  return apiClient.post<SubmitTeardownResponse>(`/api/purchases/${purchaseId}/teardown`, input);
}
