// Types for the async Identify-Parts job queue (identify-parts-queue
// feature): `POST /api/listings/:id/identify-parts` enqueues a job instead of
// blocking on the AI call, and the caller polls for it by id. Lives here
// (not apps/server) for the same reason as aiIdentification.ts — apps/web
// polls the job status directly and must never import apps/server.
import type { AiIdentifiedPart } from './aiIdentification.js';

/**
 * Where one job sits in the identify-parts pipeline. Mirrors the
 * synchronous pipeline's own phases (identify from listing text/photos,
 * source missing reference photos, compare against them) plus the terminal
 * `completed`/`failed` states, so a stuck job's stage alone tells you which
 * phase it died in without reading logs.
 */
export type IdentifyPartsJobStage =
  | 'queued'
  | 'identifying'
  | 'sourcing_references'
  | 'comparing'
  | 'completed'
  | 'failed';

/**
 * One row of the Identify-Parts job queue. `parts`/`notes` are the job's
 * `IdentifyPartsResponse` result split into its two fields and are null
 * until the job reaches `completed` — mirroring `result`'s "null until
 * completed" JSON column on the `identify_parts_jobs` table this maps from.
 * `errorMessage` is populated only when `stage` is `failed`. `delivered`
 * tracks whether a caller has already been handed the terminal result, so a
 * second poll for an already-delivered job knows not to repeat it.
 */
export interface IdentifyPartsJob {
  id: string;
  listingId: string;
  stage: IdentifyPartsJobStage;
  parts: AiIdentifiedPart[] | null;
  notes: string | null;
  errorMessage: string | null;
  delivered: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * The per-Listing result of a bulk Identify-Parts enqueue: `queued` means a
 * new job was started for that Listing, `already_active` means an
 * unfinished job already existed and the request was a no-op, and
 * `not_found` means the listing id did not resolve to a Listing at all.
 * Distinguishing these from a single HTTP status lets the bulk endpoint
 * report every listing's fate individually instead of failing the whole
 * batch on the first miss.
 */
export type IdentifyPartsBulkOutcome = 'queued' | 'already_active' | 'not_found';

/** One row of a bulk Identify-Parts enqueue response: which Listing, and what happened to it. */
export interface IdentifyPartsBulkResult {
  listingId: string;
  outcome: IdentifyPartsBulkOutcome;
}

/** `POST /api/listings/identify-parts` response: the per-Listing outcome of enqueueing a bulk Identify-Parts run. */
export interface IdentifyPartsBulkResponse {
  results: IdentifyPartsBulkResult[];
}
