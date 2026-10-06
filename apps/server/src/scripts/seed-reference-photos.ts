// CLI entry point for the one-time reference photo seed:
// `npm run seed-reference-photos -w @pc-parts-flipper/server`.
//
// Deliberately thin — every decision lives in db/seedReferencePhotos.ts so the
// seed is testable without spawning a process. This file only runs it,
// reports the summary, closes the database, and picks an exit code.
//
// Lives under src/ (not a top-level scripts/ directory) because this
// package's tsconfig sets rootDir/include to src: anything outside it would
// be excluded from both `tsc --noEmit` and the build output.
import { closeConnection } from '../db/client.js';
import { runSeed } from '../db/seedReferencePhotos.js';
import { logger } from '../logger.js';

try {
  const result = await runSeed();
  logger.info(
    result,
    result.failed === 0
      ? 'Seed completed successfully'
      : `Seed completed with ${result.failed} failures`,
  );
  await closeConnection();
  process.exit(result.failed > 0 ? 1 : 0);
} catch (err) {
  logger.error({ err }, 'Seed aborted');
  await closeConnection();
  process.exit(1);
}
