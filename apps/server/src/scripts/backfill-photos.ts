// CLI entry point for the one-time eBay photo backfill:
// `npm run backfill-photos -w @pc-parts-flipper/server`.
//
// Deliberately thin — every decision lives in photos/photoBackfill.ts so the
// backfill is testable without spawning a process. This file only runs it,
// reports the summary, closes the database, and picks an exit code.
//
// Lives under src/ (not a top-level scripts/ directory) because this
// package's tsconfig sets rootDir/include to src: anything outside it would
// be excluded from both `tsc --noEmit` and the build output.
import { closeConnection } from '../db/client.js';
import { logger } from '../logger.js';
import { runPhotoBackfill } from '../photos/photoBackfill.js';

try {
  const summary = await runPhotoBackfill();
  logger.info(summary, 'Photo backfill summary');
  await closeConnection();
  // A run that failed on some Listings exits non-zero so an operator (or a
  // shell loop) can tell a clean run from a partial one without reading logs.
  process.exit(summary.failed > 0 ? 1 : 0);
} catch (err) {
  logger.error({ err }, 'Photo backfill aborted');
  await closeConnection();
  process.exit(1);
}
