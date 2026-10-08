// Manages an async worker pool that claims queued price-research jobs and
// processes them to completion (or failure). Jobs transition through
// stages as they run: 'queued' → 'pricing' (via claim), then to a terminal
// stage. Unlike identify-parts jobs, a price job has only one terminal
// *success* shape to distinguish from failure, not several intermediate
// stages (see types.ts's PricePartsJobStage doc) — "no confident price" is
// itself a successful, completed outcome (Req 11), not a failure, so
// completed vs failed here tracks "did the AI call itself run" rather than
// "did it find a price". The pool size is configurable via
// PRICE_PARTS_POOL_SIZE (default 1) so the number of concurrent AI pricing
// passes can be tuned for available resources, same convention as
// identifyPartsWorkerPool.ts's own IDENTIFY_PARTS_POOL_SIZE.
// On startup, any jobs left in the 'pricing' stage (e.g., from a previous
// server crash) are reset to 'queued' so they re-enter the queue and are
// re-processed by the new pool instance.
import { logger } from '../logger.js';
import {
  claimNextQueuedPriceJob,
  completePriceJob,
  failPriceJob,
  propagateCachedPriceToExpectedParts,
  resetOrphanedPriceJobsToQueued,
  updatePriceCacheEntryValue,
} from '../db/index.js';
import type { PricePartsJob } from '../db/index.js';
import { buildPriceEstimationPrompt, DEFAULT_PRICE_ESTIMATION_TIMEOUT_MS } from '../ai/priceEstimationPrompt.js';
import { parsePriceEstimationResponse } from '../ai/priceEstimationParser.js';
import { getOmpSourcingRunner } from '../ai/ompSourcingRunner.js';

/**
 * Maximum number of price-research jobs to process concurrently, parsed
 * from PRICE_PARTS_POOL_SIZE. A missing, empty, or non-numeric value falls
 * back to the default of 1 — same `parsePoolSize` convention as
 * identifyPartsWorkerPool.ts's own fix: `Number(raw ?? 1)` alone only
 * catches a strictly-nullish env var, since an empty string parses to 0
 * and a non-numeric string parses to NaN, and either one makes pump()'s
 * `activeCount < POOL_SIZE` always false, so jobs enqueue but are silently
 * never processed. 0 itself is a valid, intentional value (disables the
 * pool entirely so the real `omp` binary is never invoked in tests), so
 * only a negative or non-finite parse falls back, not 0.
 */
function parsePoolSize(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

const POOL_SIZE = parsePoolSize(process.env.PRICE_PARTS_POOL_SIZE);

/** Number of jobs currently being processed. */
let activeCount = 0;

/**
 * Attempts to claim and process queued price-research jobs up to the pool
 * size. Called once at startup, once per job completion (to immediately
 * refill the freed slot), and once per poll interval tick as a safety net
 * in case a claim silently stalled.
 */
async function pump(): Promise<void> {
  while (activeCount < POOL_SIZE) {
    const job = await claimNextQueuedPriceJob();
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
 * Processes a single price-research job: builds the estimation prompt for
 * its (category, brand, partNumber) combo, runs it through the
 * tools-enabled `omp` sourcing runner (no photo attached — the model
 * browses for comparables itself), and parses the raw output into a
 * confident price or null. Both outcomes — a number or null — are a
 * successful completion (Req 11): "no confident price" is the AI's own
 * honest answer, not a pipeline failure, so it is cached and the job is
 * completed exactly like a found price. The cache is updated first in
 * either case; propagation onto matching auto-managed Expected Parts only
 * happens for a non-null value, since null has nothing to push.
 * `failPriceJob` is reserved for a genuine runner failure — a spawn error,
 * a timeout, or any other rejection from getOmpSourcingRunner() itself —
 * mirroring identifyPartsWorkerPool.ts's own completed-vs-failed split
 * between "the pipeline ran and returned a result" and "the pipeline
 * itself threw".
 */
async function processJob(job: PricePartsJob): Promise<void> {
  try {
    const prompt = buildPriceEstimationPrompt(job.category, job.brand, job.partNumber);
    const rawStdout = await getOmpSourcingRunner()(prompt, { timeoutMs: DEFAULT_PRICE_ESTIMATION_TIMEOUT_MS });
    const value = parsePriceEstimationResponse(rawStdout);

    await updatePriceCacheEntryValue(job.category, job.brand, job.partNumber, value);
    if (value !== null) {
      await propagateCachedPriceToExpectedParts(job.category, job.brand, job.partNumber, value);
    }
    await completePriceJob(job.id);
  } catch (err) {
    // Derive error message the same way other error paths in this codebase
    // do, so the message is always a string.
    const message = err instanceof Error ? err.message : String(err);
    await failPriceJob(job.id, message);
  } finally {
    activeCount -= 1;
    // Fire off pump without awaiting; it continues its background loop.
    void pump();
  }
}

/**
 * Starts the price-research worker pool: resets any jobs left in the
 * 'pricing' stage (a prior crash) back to 'queued', logs the reset count,
 * pumps once to start background work, and sets up a 1000ms polling
 * interval to periodically retry claiming work. Returns a handle with a
 * stop() method that clears the interval, mirroring
 * identifyPartsWorkerPool.ts's own startIdentifyPartsWorkerPool.
 */
export function startPricePartsWorkerPool(): { stop(): void } {
  // Recover any jobs left in the 'pricing' stage from a prior crash.
  void (async () => {
    const resetJobIds = await resetOrphanedPriceJobsToQueued();
    logger.info({ resetCount: resetJobIds.length }, 'Recovered orphaned price-parts jobs');
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
