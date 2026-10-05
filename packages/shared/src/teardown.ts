// Teardown + Part domain types shared between apps/server (route
// request/response bodies) and apps/web (API client + UI state). Mirrors the
// DuckDB row shapes in apps/server/src/db/types.ts, plus the request/response
// bodies the HTTP layer (apps/server/src/routes/teardown.ts) adds on top
// (Req 6) — this file lives here (not apps/server) because apps/web may
// never import apps/server directly (standing check). Part is defined here,
// not a separate parts.ts, because the teardown submission is the only thing
// that creates Parts in this task's scope; T10 (the Parts screen) imports it
// from here rather than redefining it.
import type { ComponentCategory, ExpectedPart } from './listings.js';
import type { IdentityCandidate } from './aiIdentification.js';
import type { PurchaseStatus } from './purchases.js';

/** Outcome of reconciling one Expected Part (or an unexpected find) during teardown (Req 6). */
export type TeardownResultType = 'present_as_expected' | 'present_but_different' | 'missing' | 'additional';

/** One reconciliation line recorded against a Purchase during teardown (Req 6). */
export interface TeardownResult {
  id: string;
  purchaseId: string;
  /** Null when this row records an Additional Part not on the originating Listing. */
  expectedPartId: string | null;
  result: TeardownResultType;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Part lifecycle (Req 7); only `ready_to_list` is reachable from the teardown submission this task builds. */
export type PartStatus = 'ready_to_list' | 'listed' | 'sold' | 'unsellable';

/**
 * A physical part produced by a teardown, tracked through resale (Req 6-7).
 * `brand`/`partNumber` carry over from the Expected Part the teardown
 * reconciled (or from the Additional Part row the user filled in), and stay
 * null when the component was never identified — they drive the default
 * Sale Listing title, which is why a real "NVIDIA RTX 3060" beats a generic
 * "GPU: <prose>". `identityCandidates` likewise carries over the originating
 * Expected Part's alternate brand/partNumber pairings, when any exist.
 */
export interface Part {
  id: string;
  purchaseId: string;
  category: ComponentCategory;
  brand: string | null;
  partNumber: string | null;
  description: string;
  status: PartStatus;
  unsellableReason: string | null;
  identityCandidates: IdentityCandidate[];
  createdAt: string;
  updatedAt: string;
}

/**
 * `GET /api/purchases/:id/teardown` response: the originating Listing's
 * Expected Parts to reconcile against, plus any teardown_results already
 * recorded for this Purchase. This endpoint does not gate on Purchase status
 * itself (apps/web's Purchase detail screen only offers the "Start
 * Teardown" action once status is 'received'); `purchaseStatus` is included
 * so a caller that lands here some other way can still tell. Submission is
 * one atomic all-or-nothing POST (assumption, documented in teardown.ts) —
 * there is no partial-save, so `existingResults` is only ever non-empty when
 * re-opening the form after a completed submission already moved the
 * Purchase to `torn_down`.
 */
export interface TeardownFormResponse {
  purchaseId: string;
  purchaseStatus: PurchaseStatus;
  expectedParts: ExpectedPart[];
  existingResults: TeardownResult[];
}

/** One Expected Part row's reconciliation in a teardown submission (Req 6). */
export interface TeardownExpectedPartResultInput {
  expectedPartId: string;
  result: Exclude<TeardownResultType, 'additional'>;
  /** Required by the server when `result` is `present_but_different` or `missing`. */
  note?: string | null;
}

/** One Additional Part found during teardown that wasn't on the originating Listing (Req 6). `brand`/`partNumber` are null when the user did not identify the component. */
export interface TeardownAdditionalPartInput {
  category: ComponentCategory;
  brand: string | null;
  partNumber: string | null;
  description: string;
  note?: string | null;
}

/** Request body for `POST /api/purchases/:id/teardown`. */
export interface SubmitTeardownInput {
  results: TeardownExpectedPartResultInput[];
  additionalParts: TeardownAdditionalPartInput[];
}

/**
 * `POST /api/purchases/:id/teardown` response: the Purchase (now
 * `torn_down`), every teardown_results row written, and every Part the
 * submission created (one per `present_as_expected`/`present_but_different`/
 * `additional` result, none for `missing`).
 */
export interface SubmitTeardownResponse {
  purchaseId: string;
  purchaseStatus: PurchaseStatus;
  teardownResults: TeardownResult[];
  createdParts: Part[];
}
