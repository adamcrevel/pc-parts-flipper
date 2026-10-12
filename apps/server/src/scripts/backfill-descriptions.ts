// CLI entry point for the one-time eBay description backfill:
// `npm run backfill-descriptions -w @pc-parts-flipper/server`.
//
// Deliberately thin — every decision lives in scan/descriptionBackfill.ts so
// the backfill is testable without spawning a process. This file only runs
// it, reports the summary, closes the database, and picks an exit code.
//
// Lives under src/ (not a top-level scripts/ directory) because this
// package's tsconfig sets rootDir/include to src: anything outside it would
// be excluded from both `tsc --noEmit` and the build output.
import { closeConnection } from '../db/client.js';
import { logger } from '../logger.js';
import { runDescriptionBackfill } from '../scan/descriptionBackfill.js';

try {
  const summary = await runDescriptionBackfill();
  logger.info(summary, 'Description backfill summary');
  await closeConnection();
  process.exit(summary.failed > 0 ? 1 : 0);
} catch (err) {
  logger.error({ err }, 'Description backfill aborted');
  await closeConnection();
  process.exit(1);
}
