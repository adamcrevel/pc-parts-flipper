// Manages an async worker pool that claims queued identify-parts jobs and
// processes them to completion (or failure). Jobs transition through stages
// as they run: 'queued' → 'identifying' (via claim), then optionally to
// 'sourcing_references' and 'comparing' (stage callbacks from
// identifyListingParts), then finally to 'completed' or 'failed'. The pool
// size is configurable via IDENTIFY_PARTS_POOL_SIZE (default 1) so the
// number of concurrent AI identify passes can be tuned for available
// resources — each pass takes ~15–45s depending on photo availability, so
// production should be set higher than 1 to keep the queue flowing.
// On startup, any jobs left in identifying/sourcing_references/comparing
// stages (e.g., from a previous server crash) are reset to 'queued' so they
// re-enter the queue and are re-processed by the new pool instance.

import { logger } from '../logger.js';
import {
  claimNextQueuedJob,
  completeJob,
  createExpectedPart,
  failJob,
  resetOrphanedJobsToQueued,
  updateJobStage,
  getListingById,
} from '../db/index.js';
import { identifyListingParts } from '../ai/partIdentification.js';
import type { IdentifyPartsJob, IdentifyPartsResponse } from '@pc-parts-flipper/shared';

/**
 * Maximum number of identify-parts jobs to process concurrently, parsed
 * from IDENTIFY_PARTS_POOL_SIZE. A missing, empty, or non-numeric value
 * falls back to the default of 1 — `Number(process.env.X ?? 1)` alone only
 * catches a strictly-nullish env var: an empty string parses to 0 and a
 * non-numeric string parses to NaN, and either one made pump()'s
 * `activeCount < POOL_SIZE` always false, so jobs enqueued but silently
 * never processed. 0 itself is a valid, intentional value — the test suite
 * sets IDENTIFY_PARTS_POOL_SIZE=0 to disable the pool entirely so the real
 * `omp` binary is never invoked (see identifyPartsRoute.test.ts,
 * identifyPartsJobsRoute.test.ts) — so only a negative or non-finite parse
 * falls back, not 0.
 */
function parsePoolSize(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

const POOL_SIZE = parsePoolSize(process.env.IDENTIFY_PARTS_POOL_SIZE);

/** Number of jobs currently being processed. */
let activeCount = 0;

/**
 * Attempts to claim and process queued identify-parts jobs up to the pool
 * size limit. Runs in the background (never awaited by callers); the caller
 * fires it off and pump continues asynchronously, starting background work
 * and returning immediately. On each invocation, pump claims jobs until
 * activeCount reaches POOL_SIZE or no more jobs are available, then returns.
 * Each claimed job is handed to processJob (which runs async but never
 * awaited), and on completion or rejection, processJob decrements activeCount
 * and calls pump again, so a freed slot immediately tries to fill itself.
 */
async function pump(): Promise<void> {
  while (activeCount < POOL_SIZE) {
    const job = await claimNextQueuedJob();
    if (job === null) {
      break;
    }
    activeCount += 1;
    // Fire off processJob without awaiting. The job runs to completion or
    // rejection, then decrements activeCount and calls pump again.
    void processJob(job);
  }
}

/**
 * Inserts every part `result` identified as a real Expected Part on the
 * Listing, directly — not routed through any client. Saving an
 * identify-parts job's result is a server-side side effect of the job
 * completing, same as any other background job writing its own output;
 * it must never depend on a browser being open (or ever reopened) to
 * notice the job finished and submit a save on its behalf. Estimated
 * resale value is always null here: the model is never asked to price
 * parts, and that's a real "not yet priced" state the column accepts
 * (nullable), not a placeholder 0. `aiConfidence`/`aiSource` are carried
 * straight across from the model's own output: this is the one write path
 * where they're genuinely known, and persisting them here is what lets
 * the "AI suggested" badge survive the Listing being reopened later,
 * instead of only showing for the one poll that saw the job complete.
 */
async function persistIdentifiedParts(listingId: string, result: IdentifyPartsResponse): Promise<void> {
  await Promise.all(
    result.parts.map((part) =>
      createExpectedPart({
        listingId,
        componentCategory: part.category,
        brand: part.brand,
        partNumber: part.partNumber,
        description: part.description,
        estimatedResaleValue: null,
        identityCandidates: part.identityCandidates,
        aiConfidence: part.confidence,
        aiSource: part.source,
      }),
    ),
  );
}

/**
 * Processes a single identify-parts job: looks up its listing, runs the AI
 * identification two-pass flow (with stage callbacks wired to
 * updateJobStage), persists every identified part as a real Expected Part
 * (persistIdentifiedParts, above — happens here, unconditionally, not left
 * to the UI), and either completes the job with the result or fails it
 * with an error message. If persistence itself throws, the job is failed
 * (not completed) rather than reporting success over data that didn't
 * actually save. Always decrements activeCount and calls pump again in a
 * finally block, so a freed slot tries to fill itself immediately. If the
 * listing is deleted (getListingById returns null), fails the job without
 * calling identifyListingParts.
 */
async function processJob(job: IdentifyPartsJob): Promise<void> {
  try {
    const listing = await getListingById(job.listingId);
    if (listing === null) {
      await failJob(job.id, 'Listing no longer exists');
      return;
    }

    const result = await identifyListingParts(listing, undefined, (stage) =>
      updateJobStage(job.id, stage),
    );
    await persistIdentifiedParts(job.listingId, result);
    await completeJob(job.id, result);
  } catch (err) {
    // Derive error message the same way other error paths in this codebase
    // do, so the message is always a string.
    const message = err instanceof Error ? err.message : String(err);
    await failJob(job.id, message);
  } finally {
    activeCount -= 1;
    // Fire off pump without awaiting; it continues its background loop.
    void pump();
  }
}

/**
 * Starts the identify-parts worker pool: resets any jobs left in
 * intermediate stages (identifying/sourcing_references/comparing) from
 * a prior crash back to 'queued', logs the reset count, pumps once to
 * start background work, and sets up a 1000ms polling interval to
 * periodically retry claiming work. Returns a handle with a stop() method
 * that clears the interval, mirroring node-cron's ScheduledTask.stop()
 * pattern already used by the scan scheduler (scheduler.ts).
 */
export function startIdentifyPartsWorkerPool(): { stop(): void } {
  // Recover any jobs left in intermediate stages from a prior crash.
  void (async () => {
    const resetJobIds = await resetOrphanedJobsToQueued();
    logger.info({ resetCount: resetJobIds.length }, 'Recovered orphaned identify-parts jobs');
  })();

  // Pump once synchronously (without awaiting) to start background work.
  void pump();

  // Poll periodically to claim work. The interval runs pump every 1000ms.
  const intervalHandle = setInterval(() => {
    void pump();
  }, 1000);

  return {
    stop(): void {
      clearInterval(intervalHandle);
    },
  };
}
