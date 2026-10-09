// Typed CRUD for the `price_parts_jobs` table (part-price-estimation
// feature). Backs the async price-research queue the price worker pool
// drains: the trigger (jobs/pricePartsTrigger.ts) enqueues one job per
// (category, brand, partNumber) combo that has no cached value yet and
// returns immediately instead of blocking a request on the AI call, and the
// pool uses the functions below to move each job through its stages.
// Keyed by the combo rather than by an Expected Part or Listing id
// (assumption A1): Expected Part ids are recreated on every Listing save,
// and one researched value serves every row sharing the combo.
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { computeNextRetryAt } from '../../retryBackoff.js';
import type { ComponentCategory, PricePartsJob, PricePartsJobStage } from '../types.js';

// Converts one raw JSON row into the camelCase PricePartsJob shape.
function mapRow(row: Record<string, unknown>): PricePartsJob {
  return {
    id: row.id as string,
    category: row.component_category as ComponentCategory,
    brand: row.brand as string,
    partNumber: row.part_number as string,
    stage: row.stage as PricePartsJobStage,
    errorMessage: (row.error_message as string | null) ?? null,
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

/** Enqueues a new `queued` price-research job for one (category, brand, partNumber) combo and returns the row as stored. */
export async function createQueuedPriceJob(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
): Promise<PricePartsJob> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `INSERT INTO price_parts_jobs (id, component_category, brand, part_number, stage)
     VALUES ($id, $category, $brand, $part_number, 'queued')
     RETURNING *`,
    { id: newId(), category, brand, part_number: partNumber },
  );
  return mapRow(reader.getRowObjectsJson()[0]);
}

/**
 * Atomically enqueues a new `queued` price-research job for one (category,
 * brand, partNumber) combo unless a job for that combo is already `queued`
 * or `pricing` — the INSERT and the non-terminal-job check run as one
 * statement (INSERT ... SELECT ... WHERE NOT EXISTS), the same pattern
 * referencePhotos.ts's insertReferencePhotoRow uses for its own
 * nullable-part-number dedup case. This replaces the separate
 * hasNonTerminalPriceJob-then-createQueuedPriceJob pair at the trigger's
 * enqueue gate (Node G): two genuinely concurrent first-encounters of the
 * same combo could both observe "no job yet" from the separate SELECT
 * before either INSERT landed, producing two rows for one combo (Req 13).
 * Folding the check into the INSERT's own WHERE clause closes that window
 * — DuckDB evaluates the subquery and performs the insert as one atomic
 * step, so a second concurrent caller for the same combo always sees the
 * first caller's row (or lack of it) consistently. Returns whether a row
 * was actually inserted, so callers can tell a real enqueue apart from a
 * dedup-skip.
 */
export async function createQueuedPriceJobIfAbsent(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
): Promise<{ inserted: boolean }> {
  const connection = await getConnection();
  const result = await connection.runAndReadAll(
    `INSERT INTO price_parts_jobs (id, component_category, brand, part_number, stage)
     SELECT $id, $category, $brand, $part_number, 'queued'
     WHERE NOT EXISTS (
       SELECT 1 FROM price_parts_jobs
       WHERE component_category = $category AND brand = $brand AND part_number = $part_number
         AND stage IN ('queued', 'pricing')
     )`,
    { id: newId(), category, brand, part_number: partNumber },
  );
  const [{ Count: rowsAffected }] = result.getRowObjectsJson() as Array<{ Count: string }>;
  return { inserted: Number(rowsAffected) > 0 };
}

/**
 * Atomically claims the oldest `queued` job for a price worker to process:
 * the subselect that picks the row and the UPDATE that flips its stage to
 * `pricing` run as one statement, so two concurrent workers can never both
 * claim the same job. Returns the claimed row, or null when nothing is
 * queued. Same shape as identifyPartsJobs.ts's claimNextQueuedJob, for the
 * same reason.
 */
export async function claimNextQueuedPriceJob(): Promise<PricePartsJob | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `UPDATE price_parts_jobs
     SET stage = 'pricing', started_at = current_timestamp, updated_at = current_timestamp
     WHERE id = (
       SELECT id FROM price_parts_jobs
       WHERE stage = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= current_timestamp)
       ORDER BY created_at LIMIT 1
     )
     RETURNING *`,
  );
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Sets a job's stage directly — the generic setter behind the recovery/transition paths. */
export async function updatePriceJobStage(jobId: string, stage: PricePartsJobStage): Promise<void> {
  const connection = await getConnection();
  await connection.run(
    `UPDATE price_parts_jobs SET stage = $stage, updated_at = current_timestamp WHERE id = $id`,
    { id: jobId, stage },
  );
}

/** Marks a job `completed`. The researched value itself lives in part_price_cache, not on the job. */
export async function completePriceJob(jobId: string): Promise<void> {
  const connection = await getConnection();
  await connection.run(
    `UPDATE price_parts_jobs
     SET stage = 'completed', completed_at = current_timestamp, updated_at = current_timestamp
     WHERE id = $id`,
    { id: jobId },
  );
}

/** Marks a job `failed`, recording the error message for later diagnosis. */
export async function failPriceJob(jobId: string, errorMessage: string): Promise<void> {
  const connection = await getConnection();
  await connection.run(
    `UPDATE price_parts_jobs
     SET stage = 'failed', error_message = $error_message, completed_at = current_timestamp, updated_at = current_timestamp
     WHERE id = $id`,
    { id: jobId, error_message: errorMessage },
  );
}

/**
 * Re-queues a job after an infrastructure failure instead of permanently
 * failing it (Req 6, 7): price-research jobs have no genuine-business-
 * failure outcome at all (A3) — every caught exception at the call site is
 * retry-eligible by construction, so every failure here goes through this
 * function, never `failPriceJob` (left in place, per the plan, but no
 * longer called once T7 lands). Reads the job's current `retry_count`,
 * increments it, and computes the next retry window via
 * `computeNextRetryAt` (T1) — the same growing, uncapped-count backoff
 * schedule used everywhere else this feature retries. Returns the job to
 * `queued` with the new `retry_count`/`next_retry_at`/`error_message` in
 * one statement; `started_at`/`completed_at` are deliberately left
 * untouched, since `claimNextQueuedPriceJob` re-stamps `started_at` itself
 * on the next successful claim, and the job hasn't actually completed.
 * `claimNextQueuedPriceJob`'s backoff guard (`next_retry_at IS NULL OR
 * next_retry_at <= current_timestamp`) keeps this job un-claimable from the
 * outside — indistinguishable from a normal `queued` job once its window
 * reopens — until the computed instant passes.
 */
export async function retryOrFailPriceJob(jobId: string, errorMessage: string): Promise<void> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT retry_count FROM price_parts_jobs WHERE id = $id`,
    { id: jobId },
  );
  const rows = reader.getRowObjectsJson();
  const currentRetryCount = rows.length > 0 ? Number(rows[0].retry_count ?? 0) : 0;
  const newRetryCount = currentRetryCount + 1;
  const nextRetryAt = computeNextRetryAt(newRetryCount);
  await connection.run(
    `UPDATE price_parts_jobs
     SET stage = 'queued', retry_count = $retry_count, next_retry_at = $next_retry_at,
         error_message = $error_message, updated_at = current_timestamp
     WHERE id = $id`,
    { id: jobId, retry_count: newRetryCount, next_retry_at: nextRetryAt.toISOString(), error_message: errorMessage },
  );
}

/**
 * True when a job for this combo is still `queued` or `pricing` — i.e. the
 * combo already has research in flight. The trigger gates every enqueue on
 * this being false, which is what keeps two writers racing on the same
 * combo from queueing two duplicate jobs (Req 13).
 */
export async function hasNonTerminalPriceJob(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
): Promise<boolean> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT 1 FROM price_parts_jobs
     WHERE component_category = $category AND brand = $brand AND part_number = $part_number
       AND stage IN ('queued', 'pricing')
     LIMIT 1`,
    { category, brand, part_number: partNumber },
  );
  return reader.getRowObjectsJson().length > 0;
}

/**
 * Resets every job stuck in the non-terminal, in-progress `pricing` stage
 * back to `queued`, clearing `started_at`. Run once at pool startup, same
 * reasoning as identifyPartsJobs.ts's own resetOrphanedJobsToQueued: a job
 * left in `pricing` means the process crashed or was restarted mid-call,
 * since a worker always moves a claimed job to a terminal stage
 * (`completed`/`failed`) before picking up the next one. Returns the ids
 * of every job reset, for startup logging.
 */
export async function resetOrphanedPriceJobsToQueued(): Promise<string[]> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `UPDATE price_parts_jobs
     SET stage = 'queued', started_at = NULL, updated_at = current_timestamp
     WHERE stage = 'pricing'
     RETURNING id`,
  );
  return reader.getRowObjectsJson().map((row) => row.id as string);
}
