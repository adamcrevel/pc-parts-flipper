// Manages an async worker pool that claims queued price-research jobs and
// processes them to completion, or back to 'queued' for an automatic
// retry. Jobs transition through stages as they run: 'queued' → 'pricing'
// (via claim), then to a terminal stage. Unlike identify-parts jobs, a
// price job has only one terminal *success* shape to distinguish from
// retry, not several intermediate stages (see types.ts's
// PricePartsJobStage doc) — "no confident price" is itself a successful,
// completed outcome (Req 11), not a failure, so completed vs retried here
// tracks "did the AI call itself run" rather than "did it find a price".
// If the pipeline itself throws (any error caught in processJob's
// try/catch — a runner crash, timeout, or parse failure), the job is NOT
// permanently marked 'failed' — it is returned to 'queued' via
// retryOrFailPriceJob (T3/sourcing-resilience), with its retry_count
// incremented and a future next_retry_at computed by computeNextRetryAt's
// growing backoff, so claimNextQueuedPriceJob won't reclaim it again until
// that window passes. Unlike identifyPartsWorkerPool.ts, this file has no
// permanent-failure branch at all (A3) — every caught exception here is
// retry-eligible by construction, so `failPriceJob` is never called from
// this pool. The pool size is configurable via PRICE_PARTS_POOL_SIZE
// (default 1) so the number of concurrent AI pricing passes can be tuned
// for available resources, same convention as identifyPartsWorkerPool.ts's
// own IDENTIFY_PARTS_POOL_SIZE.
// On startup, any jobs left in the 'pricing' stage (e.g., from a previous
// server crash) are reset to 'queued' so they re-enter the queue and are
// re-processed by the new pool instance.
import { logger } from '../logger.js';
import {
  claimNextQueuedPriceJob,
  completePriceJob,
  propagateCachedPriceToExpectedParts,
  resetOrphanedPriceJobsToQueued,
  retryOrFailPriceJob,
  updatePriceCacheEntryValue,
} from '../db/index.js';
import type { PricePartsJob } from '../db/index.js';
import { buildPriceEstimationPrompt, DEFAULT_PRICE_ESTIMATION_TIMEOUT_MS } from '../ai/priceEstimationPrompt.js';
import { parsePriceEstimationResponse, parsePriceComps } from '../ai/priceEstimationParser.js';
import { verifyAndResolveComps } from '../ai/compLinkVerifier.js';
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
 *
 * activeCount is incremented BEFORE calling claimNextQueuedPriceJob(), not
 * after it resolves (R5/T5 retry-1 fix): the claim commits 'queued' →
 * 'pricing' in the DB as soon as it finds a row, which can happen well
 * before this await returns. Incrementing after resolution would leave a
 * window where a job's claim is already durably committed but
 * activeCount still reads as if nothing is in flight — exactly the
 * window startPricePartsWorkerPool's stop() drain loop (below) relies on
 * being accurate, so a shutdown landing in that window could close the
 * DB connection while the claimed job is about to run, stranding it in
 * 'pricing' until the next restart's orphan recovery. If the claim finds
 * no job, the increment is rolled back immediately below, since
 * processJob's finally block — the usual decrementer — never runs for an
 * iteration that claimed nothing. The same rollback applies if the claim
 * itself rejects (R5's second cycle-1 finding against T5): a transient
 * DuckDB error, I/O hiccup, or lock contention surfaces as a rejection
 * rather than a resolved null, and claimNextQueuedPriceJob
 * (db/queries/pricePartsJobs.ts) has no internal try/catch of its own, so
 * without this catch the increment above would leak permanently — no
 * processJob call ever happens to decrement it via its finally block, and
 * no job===null branch runs either. The error is logged and this pump()
 * iteration simply ends (same log-and-continue convention as
 * priceRefreshScheduler.ts's per-entry catch) rather than being rethrown
 * through the fire-and-forget `void pump()` call sites below, which would
 * otherwise surface as an unhandled rejection with no one left to catch
 * it; the next poll-interval tick (or job completion) calls pump() again
 * and retries the claim.
 */
async function pump(): Promise<void> {
  while (activeCount < POOL_SIZE) {
    activeCount += 1;
    let job: PricePartsJob | null;
    try {
      job = await claimNextQueuedPriceJob();
    } catch (err) {
      activeCount -= 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'claimNextQueuedPriceJob failed; activeCount rolled back');
      break;
    }
    if (job === null) {
      activeCount -= 1;
      break;
    }
    // Fire off processJob without awaiting. The job runs to completion or
    // rejection, then decrements activeCount (already incremented above)
    // and calls pump again.
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
 * either case, carrying both the parsed price and the parsed comps
 * (pricing-comps feature T2) — comps are recorded even when no confident
 * price was found (Req 3), since the supporting evidence the model cited
 * is worth keeping on its own, but only after each comp's link has been
 * checked for liveness and, if dead, resolved to an archived snapshot or
 * dropped (pricing-comps feature T7/T8 — see compLinkVerifier.ts), so a
 * stored comp never points the user at a confirmed-dead listing.
 * Propagation onto matching auto-managed
 * Expected Parts only happens for a non-null value, since null has
 * nothing to push.
 * `retryOrFailPriceJob` is reserved for a genuine runner failure — a spawn
 * error, a timeout, or any other rejection from getOmpSourcingRunner()
 * itself, or from parsing its output — returning the job to 'queued' with
 * an incremented retry_count and a future next_retry_at (T3) rather than
 * permanently failing it, mirroring identifyPartsWorkerPool.ts's own
 * completed-vs-retried split between "the pipeline ran and returned a
 * result" and "the pipeline itself threw".
 */
async function processJob(job: PricePartsJob): Promise<void> {
  try {
    const prompt = buildPriceEstimationPrompt(job.category, job.brand, job.partNumber);
    const rawStdout = await getOmpSourcingRunner()(prompt, { timeoutMs: DEFAULT_PRICE_ESTIMATION_TIMEOUT_MS });
    const value = parsePriceEstimationResponse(rawStdout);
    const comps = parsePriceComps(rawStdout);
    const verifiedComps = await verifyAndResolveComps(comps);

    await updatePriceCacheEntryValue(job.category, job.brand, job.partNumber, value, verifiedComps);
    if (value !== null) {
      await propagateCachedPriceToExpectedParts(job.category, job.brand, job.partNumber, value);
    }
    await completePriceJob(job.id);
  } catch (err) {
    // Derive error message the same way other error paths in this codebase
    // do, so the message is always a string.
    const message = err instanceof Error ? err.message : String(err);
    await retryOrFailPriceJob(job.id, message);
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
 * stop() method that clears the interval AND waits for activeCount to
 * drain to 0 before resolving (mirroring identifyPartsWorkerPool.ts's own
 * startIdentifyPartsWorkerPool shape except for this drain — see below).
 *
 * stop() returning a Promise<void> that only resolves once no job is
 * still mid-flight matters for graceful shutdown (index.ts): a price job
 * spends most of its time awaiting the AI runner in processJob, entirely
 * before it ever reaches a DB run/runAndReadAll call, so client.ts's own
 * queueTail has no visibility into it. Without this drain, index.ts could
 * call closeConnection() (and disconnect the DuckDB connection) while a
 * job was still awaiting the AI runner, so its eventual
 * updatePriceCacheEntryValue/completePriceJob calls would land on a
 * closing (or, pre-shutdown-guard, freshly reopened) connection — either
 * losing the write or silently reopening the database mid-shutdown. The
 * drain is polled on a short interval rather than an event, matching this
 * file's own existing polling convention (the 1000ms pump interval right
 * above) rather than introducing a second synchronization primitive.
 */
export function startPricePartsWorkerPool(): { stop(): Promise<void> } {
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
    async stop(): Promise<void> {
      clearInterval(intervalHandle);
      // Poll activeCount down to 0 rather than relying on a one-shot
      // event: processJob's finally block decrements activeCount from
      // whatever call stack it happens to be running on, and a job
      // started just before stop() was called may not finish for a long
      // time (it's awaiting the AI runner) — polling at a short interval
      // costs nothing while idle and reliably observes the drain whenever
      // it happens, with no extra promise/resolver bookkeeping threaded
      // through processJob itself.
      // Uses a `new Promise` executor rather than `Promise.withResolvers`
      // deliberately, matching ai/sourcingConcurrencyLimiter.ts's/
      // db/download.ts's own precedent: this package's tsconfig pins
      // `lib: ["ES2022"]` (tsconfig.base.json), which doesn't declare
      // `Promise.withResolvers` (ES2024) and fails `tsc` build even though
      // vitest's transpile-only runner doesn't catch it.
      while (activeCount > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}
