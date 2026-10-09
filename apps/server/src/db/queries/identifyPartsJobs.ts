// Typed CRUD for the `identify_parts_jobs` table (async identify-parts-queue
// feature). Backs the async job queue a single background worker drains:
// a route handler enqueues a job and hands back its id immediately instead
// of blocking on the AI call, and the worker (and the route's poll
// endpoint) use the functions below to move it through its stages.
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { computeNextRetryAt } from '../../retryBackoff.js';
import type { IdentifyPartsJob, IdentifyPartsJobStage, IdentifyPartsResponse } from '@pc-parts-flipper/shared';

// Converts one raw JSON row into the camelCase IdentifyPartsJob shape,
// parsing the JSON-encoded `result` column (an IdentifyPartsResponse) back
// into its `parts`/`notes` fields. `result` is null until the job reaches
// `completed`, so `parts`/`notes` are null for every other stage — same
// "null means not there yet" convention the column itself uses.
function mapRow(row: Record<string, unknown>): IdentifyPartsJob {
  const result = row.result != null ? (JSON.parse(row.result as string) as IdentifyPartsResponse) : null;
  return {
    id: row.id as string,
    listingId: row.listing_id as string,
    stage: row.stage as IdentifyPartsJobStage,
    parts: result?.parts ?? null,
    notes: result?.notes ?? null,
    errorMessage: row.error_message as string | null,
    delivered: row.delivered as boolean,
    createdAt: row.created_at as string,
    startedAt: row.started_at as string | null,
    completedAt: row.completed_at as string | null,
  };
}

/**
 * Enqueues a new `queued` job for `listingId`, unless that Listing already
 * has one in flight (any stage other than `completed`/`failed`), in which
 * case nothing is inserted. The existence check and the insert run as one
 * statement (`INSERT ... SELECT ... WHERE NOT EXISTS`) so two concurrent
 * requests for the same Listing can never both pass a separate "is there an
 * active job" check and each insert their own row — the same
 * check-and-insert-atomically pattern referencePhotos.ts's unique-index
 * approach solves for a different race, applied here via WHERE NOT EXISTS
 * because "any non-terminal stage" isn't expressible as a unique index.
 * Returns the new row, or null when an active job already existed.
 */
export async function insertQueuedJobIfNoneActive(listingId: string): Promise<IdentifyPartsJob | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `INSERT INTO identify_parts_jobs (id, listing_id, stage)
     SELECT $id, $listing_id, 'queued'
     WHERE NOT EXISTS (
       SELECT 1 FROM identify_parts_jobs
       WHERE listing_id = $listing_id AND stage NOT IN ('completed', 'failed')
     )
     RETURNING *`,
    { id: newId(), listing_id: listingId },
  );
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Fetches the Listing's in-flight job (any stage other than `completed`/`failed`), or null if there is none. */
export async function getActiveJobForListing(listingId: string): Promise<IdentifyPartsJob | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM identify_parts_jobs
     WHERE listing_id = $listing_id AND stage NOT IN ('completed', 'failed')
     LIMIT 1`,
    { listing_id: listingId },
  );
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Fetches one job by id, or null if no such row exists. */
export async function getJobById(jobId: string): Promise<IdentifyPartsJob | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(`SELECT * FROM identify_parts_jobs WHERE id = $id`, { id: jobId });
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Fetches the most recently created job for a Listing (any stage), or null if it has never had one. */
export async function getLatestJobForListing(listingId: string): Promise<IdentifyPartsJob | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM identify_parts_jobs WHERE listing_id = $listing_id ORDER BY created_at DESC LIMIT 1`,
    { listing_id: listingId },
  );
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/**
 * Atomically claims the oldest `queued` job for the single background
 * worker to process: the subselect that picks the row and the UPDATE that
 * flips its stage to `identifying` run as one statement, so two concurrent
 * worker ticks (there should only ever be one, but this makes that an
 * invariant rather than an assumption) can never both claim the same job.
 * Returns the claimed row, or null when no job is queued.
 */
export async function claimNextQueuedJob(): Promise<IdentifyPartsJob | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `UPDATE identify_parts_jobs
     SET stage = 'identifying', started_at = current_timestamp
     WHERE id = (
       SELECT id FROM identify_parts_jobs
       WHERE stage = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= current_timestamp)
       ORDER BY created_at LIMIT 1
     )
     RETURNING *`,
  );
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Advances a claimed job to the next intermediate stage (`sourcing_references` or `comparing`). */
export async function updateJobStage(
  jobId: string,
  stage: Extract<IdentifyPartsJobStage, 'sourcing_references' | 'comparing'>,
): Promise<void> {
  const connection = await getConnection();
  await connection.run(
    `UPDATE identify_parts_jobs SET stage = $stage, updated_at = current_timestamp WHERE id = $id`,
    { id: jobId, stage },
  );
}

/** Marks a job `completed`, storing its IdentifyPartsResponse result as JSON. */
export async function completeJob(jobId: string, result: IdentifyPartsResponse): Promise<void> {
  const connection = await getConnection();
  await connection.run(
    `UPDATE identify_parts_jobs
     SET stage = 'completed', result = $result, completed_at = current_timestamp, updated_at = current_timestamp
     WHERE id = $id`,
    { id: jobId, result: JSON.stringify(result) },
  );
}

/** Marks a job `failed`, recording the error message a poller can surface to the user. */
export async function failJob(jobId: string, errorMessage: string): Promise<void> {
  const connection = await getConnection();
  await connection.run(
    `UPDATE identify_parts_jobs
     SET stage = 'failed', error_message = $error_message, completed_at = current_timestamp, updated_at = current_timestamp
     WHERE id = $id`,
    { id: jobId, error_message: errorMessage },
  );
}

/**
 * Re-queues a job after an infrastructure failure instead of permanently
 * failing it (Req 5, 7): every identify-parts job failure besides the
 * Listing having been deleted (handled by the untouched `failJob` above,
 * called directly by the one permanent-failure branch outside this
 * function) is retry-eligible. Reads the job's current `retry_count`,
 * increments it, and computes the next retry window via
 * `computeNextRetryAt` (T1) — the same growing, uncapped-count backoff
 * schedule used everywhere else this feature retries. Returns the job to
 * `queued` with the new `retry_count`/`next_retry_at`/`error_message` in
 * one statement; `started_at`/`completed_at` are deliberately left
 * untouched, since `claimNextQueuedJob` re-stamps `started_at` itself on
 * the next successful claim, and the job hasn't actually completed.
 * `claimNextQueuedJob`'s backoff guard (`next_retry_at IS NULL OR
 * next_retry_at <= current_timestamp`) keeps this job un-claimable from the
 * outside — indistinguishable from a normal `queued` job once its window
 * reopens — until the computed instant passes.
 */
export async function retryOrFailJob(jobId: string, errorMessage: string): Promise<void> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT retry_count FROM identify_parts_jobs WHERE id = $id`,
    { id: jobId },
  );
  const rows = reader.getRowObjectsJson();
  const currentRetryCount = rows.length > 0 ? Number(rows[0].retry_count ?? 0) : 0;
  const newRetryCount = currentRetryCount + 1;
  const nextRetryAt = computeNextRetryAt(newRetryCount);
  await connection.run(
    `UPDATE identify_parts_jobs
     SET stage = 'queued', retry_count = $retry_count,
         next_retry_at = CAST(CAST($next_retry_at AS TIMESTAMPTZ) AS TIMESTAMP),
         error_message = $error_message, updated_at = current_timestamp
     WHERE id = $id`,
    { id: jobId, retry_count: newRetryCount, next_retry_at: nextRetryAt.toISOString(), error_message: errorMessage },
  );
}

/** Marks a terminal job as delivered, so a second poll for it knows not to hand back its result again. */
export async function markDelivered(jobId: string): Promise<void> {
  const connection = await getConnection();
  await connection.run(
    `UPDATE identify_parts_jobs SET delivered = true, updated_at = current_timestamp WHERE id = $id`,
    { id: jobId },
  );
}

/**
 * Resets every job stuck in a non-terminal, in-progress stage
 * (`identifying`/`sourcing_references`/`comparing`) back to `queued`,
 * clearing `started_at`. Run once at server startup: a job left in one of
 * these stages means the process crashed or was restarted mid-processing,
 * since the single worker only ever holds one job in these stages at a
 * time and always moves it to a terminal stage before picking up the next.
 * Returns the ids of every job reset, for startup logging.
 */
export async function resetOrphanedJobsToQueued(): Promise<string[]> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `UPDATE identify_parts_jobs
     SET stage = 'queued', started_at = NULL, updated_at = current_timestamp
     WHERE stage IN ('identifying', 'sourcing_references', 'comparing')
     RETURNING id`,
  );
  return reader.getRowObjectsJson().map((row) => row.id as string);
}
