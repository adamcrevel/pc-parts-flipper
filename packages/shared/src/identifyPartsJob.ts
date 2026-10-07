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
