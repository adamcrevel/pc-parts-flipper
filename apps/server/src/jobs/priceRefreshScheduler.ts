// Registers and runs the once-daily automated price-refresh sweep (Req 8,
// part-price-estimation feature): walks every (category, brand,
// partNumber) combo already sitting in part_price_cache and re-queues a
// price_parts_job for each one that doesn't already have a non-terminal job
// in flight, so T5's worker pool re-researches every cached combo — whether
// or not it currently has a price — without a user having to trigger it.
// runScheduledPriceRefresh is exported separately (rather than inlined as
// the cron callback) so it can be unit-tested directly without waiting on a
// real cron tick (test/priceRefreshScheduler.test.ts). Fires at 3am, one
// hour after scan/scheduler.ts's own 2am scan job, so the two background
// jobs never compete for AI/web-call resources at the same time
// (assumption A4).
import { schedule, type ScheduledTask } from 'node-cron';
import { logger } from '../logger.js';
import {
  createQueuedPriceJob,
  hasNonTerminalPriceJob,
  listAllPriceCacheEntries,
} from '../db/index.js';

// Once daily at 3am local time — low-traffic hours, and distinct from
// scan/scheduler.ts's 2am scan job so the two never run concurrently.
const SCHEDULE_EXPRESSION = '0 3 * * *';

/**
 * Runs one scheduled price-refresh pass across every (category, brand,
 * partNumber) combo currently in part_price_cache (Req 8). For each combo,
 * enqueues a new price_parts_job only when no non-terminal (queued or
 * pricing) job already exists for that combo (T4's hasNonTerminalPriceJob
 * dedup check) — this sweep must never pile up duplicate jobs behind one
 * already in flight. Every cache entry is swept regardless of whether it
 * currently holds a price, since the point of the sweep is to refresh
 * stale values, not merely to backfill missing ones. Logs an Info line when
 * the run starts and an Info summary (how many combos were enqueued,
 * skipped as already in flight, or errored) when it completes. Each
 * entry's own dedup-check-and-enqueue is isolated in its own try/catch —
 * mirroring scanService.ts's scanAllEligibleSources — so a transient
 * failure on one combo (a DB error, for instance) is logged by combo and
 * skipped rather than throwing once and silently aborting every remaining
 * entry for the night (Req 8: every combo must still be re-researched).
 * The outer try/catch remains to guard listAllPriceCacheEntries itself and
 * any other failure outside the per-entry loop from crashing the cron
 * callback / the server process.
 */
export async function runScheduledPriceRefresh(): Promise<void> {
  logger.info('Scheduled price refresh starting');
  try {
    const entries = await listAllPriceCacheEntries();

    let enqueuedCount = 0;
    let skippedCount = 0;
    let erroredCount = 0;
    for (const entry of entries) {
      try {
        const alreadyQueued = await hasNonTerminalPriceJob(entry.category, entry.brand, entry.partNumber);
        if (alreadyQueued) {
          skippedCount += 1;
          continue;
        }
        await createQueuedPriceJob(entry.category, entry.brand, entry.partNumber);
        enqueuedCount += 1;
      } catch (err) {
        // One combo's dedup-check or enqueue failing must never block the
        // rest of the sweep (Req 8); log which combo was skipped and move
        // on to the next entry.
        const message = err instanceof Error ? err.message : String(err);
        erroredCount += 1;
        logger.error(
          { category: entry.category, brand: entry.brand, partNumber: entry.partNumber, err: message },
          'Scheduled price refresh failed for one cache entry; continuing with the rest',
        );
      }
    }

    logger.info(
      { enqueuedCount, skippedCount, erroredCount, totalCount: entries.length },
      'Scheduled price refresh completed',
    );
  } catch (err) {
    // A rejection outside the per-entry loop (e.g. listAllPriceCacheEntries
    // itself failing) must still never crash the process.
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Scheduled price refresh run failed unexpectedly');
  }
}

/**
 * Registers the once-daily scheduled price-refresh job (Req 8) via
 * node-cron and returns the resulting ScheduledTask handle. Called once
 * during server bootstrap (index.ts); the cron job then lives for the
 * lifetime of the process, firing runScheduledPriceRefresh() on each tick.
 */
export function startPriceRefreshScheduler(): ScheduledTask {
  logger.info({ schedule: SCHEDULE_EXPRESSION }, 'Registering scheduled price refresh job');
  return schedule(SCHEDULE_EXPRESSION, () => {
    void runScheduledPriceRefresh();
  });
}
