import type { CreateSaleInput, RecordSaleResponse } from '@pc-parts-flipper/shared';
import { apiClient } from '@/lib/api-client';

// Thin resource-specific wrapper around apiClient (T4) for the
// `/api/parts/:partId/sale` endpoint (apps/server/src/routes/sales.ts).
// Keeps the route path and request/response typing in one place so the
// Record Sale screen never hand-writes a path string or `as` cast.

/** Records a Sale against a `listed` Part (Req 9), which also advances that Part's status `listed -> sold` (Req 7). */
export function recordSale(partId: string, input: CreateSaleInput): Promise<RecordSaleResponse> {
  return apiClient.post<RecordSaleResponse>(`/api/parts/${partId}/sale`, input);
}
