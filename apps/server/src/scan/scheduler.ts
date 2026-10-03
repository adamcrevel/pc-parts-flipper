// Registers and runs the once-daily automated scan job (Req 6, 9): wires
// scanAllEligibleSources into a node-cron schedule so every eligible Source
// is re-scanned without a user having to trigger T7's manual scan route.
// runScheduledScan is exported separately (rather than inlined as the cron
// callback) so it can be unit-tested directly without waiting on a real
// cron tick (test/scheduler.test.ts).
import { schedule, type ScheduledTask } from 'node-cron';
import { logger } from '../logger.js';
import { scanAllEligibleSources } from './scanService.js';

// Once daily at 2am local time — low-traffic hours, well clear of any
// interactive use of the app.
const SCHEDULE_EXPRESSION = '0 2 * * *';

/**
 * Runs one scheduled scan pass across every eligible Source (Req 6, 9).
 * Logs an Info line when the run starts and an Info summary (aggregate
 * found/new counts plus how many Sources were scanned) when it completes.
 * Any individual Source outcome carrying an `error` (scanAllEligibleSources
 * already caught that Source's own failure) is logged here at Error level
 * with the Source's id, so scheduled failures are never silently lost. The
 * whole call is wrapped in try/catch so even a rejection of
 * scanAllEligibleSources itself (as opposed to a per-Source error, which
 * scanAllEligibleSources already catches internally) is caught and logged
 * instead of crashing the cron callback / the server process.
 */
export async function runScheduledScan(): Promise<void> {
  logger.info('Scheduled scan starting');
  try {
    const result = await scanAllEligibleSources();

    // Surface every per-Source failure individually so none are lost in
    // the aggregate summary line below.
    for (const outcome of result.sources) {
      if (outcome.error) {
        logger.error({ sourceId: outcome.sourceId, error: outcome.error }, 'Scheduled scan failed for Source');
      }
    }

    logger.info(
      { totalFound: result.totalFound, totalNew: result.totalNew, scannedCount: result.sources.length },
      'Scheduled scan completed',
    );
  } catch (err) {
    // scanAllEligibleSources rejecting outright (distinct from a per-Source
    // error it already catches) must still never crash the process.
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Scheduled scan run failed unexpectedly');
  }
}

/**
 * Registers the once-daily scheduled scan job (Req 6, 9) via node-cron and
 * returns the resulting ScheduledTask handle. Called once during server
 * bootstrap (index.ts); the cron job then lives for the lifetime of the
 * process, firing runScheduledScan() on each tick.
 */
export function startScheduler(): ScheduledTask {
  logger.info({ schedule: SCHEDULE_EXPRESSION }, 'Registering scheduled scan job');
  return schedule(SCHEDULE_EXPRESSION, () => {
    void runScheduledScan();
  });
}
