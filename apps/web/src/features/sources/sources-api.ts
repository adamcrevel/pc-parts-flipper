import type { CreateSourceInput, Source, UpdateSourceInput } from '@pc-parts-flipper/shared';
import { apiClient } from '@/lib/api-client';

// Thin resource-specific wrapper around apiClient (T4) for the `/api/sources`
// endpoints (apps/server/src/routes/sources.ts). Keeps the route paths and
// request/response typing in one place so sources-page.tsx and its
// sub-components never hand-write a path string or `as` cast.

/** Fetches every Source, or only active ones when `activeOnly` is true. */
export function fetchSources(activeOnly: boolean): Promise<Source[]> {
  const query = activeOnly ? '?activeOnly=true' : '';
  return apiClient.get<Source[]>(`/api/sources${query}`);
}

/** Creates a new Source. */
export function createSource(input: CreateSourceInput): Promise<Source> {
  return apiClient.post<Source>('/api/sources', input);
}

/** Edits an existing Source's fields. */
export function updateSource(id: string, input: UpdateSourceInput): Promise<Source> {
  return apiClient.put<Source>(`/api/sources/${id}`, input);
}

/** Deactivates a Source (soft — never hard-deletes). */
export function deactivateSource(id: string): Promise<Source> {
  return apiClient.patch<Source>(`/api/sources/${id}/deactivate`);
}

/** Triggers an automated scan for one Source (T9, matching POST /api/sources/:id/scan's response shape). */
export function scanSource(id: string): Promise<{ foundCount: number; newCount: number }> {
  return apiClient.post<{ foundCount: number; newCount: number }>(`/api/sources/${id}/scan`);
}
