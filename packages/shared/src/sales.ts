// Sale HTTP types for the Sale-recording screen (Req 9) — the final outcome
// of selling a `listed` Part, which also advances that Part's status
// `listed -> sold` (Req 7). Lives here (not apps/server) because apps/web
// may never import apps/server directly (standing check); mirrors the
// DuckDB row shape in apps/server/src/db/types.ts.
import type { PartSummary } from './parts.js';

/** The recorded outcome of selling a Part (Req 9). */
export interface Sale {
  id: string;
  partId: string;
  soldPrice: number;
  soldDate: string;
  platformFee: number;
  shippingCost: number;
  buyerNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Request body for `POST /api/parts/:partId/sale`. Requirement 13: sold
 * price/platform fee/shipping cost must each be a non-negative number, sold
 * date is required; buyer note is optional free text.
 */
export interface CreateSaleInput {
  soldPrice: number;
  soldDate: string;
  platformFee: number;
  shippingCost: number;
  buyerNote?: string | null;
}

/** `GET /api/sales` response: one page of Sales plus the total matching count, so apps/web can paginate without an unbounded fetch (Req 9, 15). */
export interface ListSalesResponse {
  sales: Sale[];
  total: number;
}

/** `POST /api/parts/:partId/sale` response: the recorded Sale plus its Part, whose status has just moved `listed -> sold` (Req 7, 9). */
export interface RecordSaleResponse {
  sale: Sale;
  part: PartSummary;
}
