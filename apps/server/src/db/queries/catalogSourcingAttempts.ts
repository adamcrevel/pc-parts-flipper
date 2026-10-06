// Typed CRUD for the `part_catalog_sourcing_attempts` table
// (ai-catalog-sourcing feature T1). Records every catalog-mode sourcing
// attempt — successful or not — for one (category, brand) combo, so
// identify-parts' second pass never re-browses the same brand's catalog
// twice (Requirement 5). Deliberately separate from sourcingAttempts.ts's
// (category, brand, part_number)-keyed table: that one records a single-
// product attempt for an already-known model; this one records a whole-
// catalog attempt for a brand whose model isn't known yet — the two never
// overlap (Requirement 1 is mutually exclusive by construction) and so never
// share a cache.
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { logger } from '../../logger.js';
import type { ComponentCategory } from '../types.js';

// Same pattern as sourcingAttempts.ts's UNIQUE_CONSTRAINT_MESSAGE: matches
// the DuckDB error text raised when the unique index on (category, brand) is
// violated by a second attempt row for the same combo.
const UNIQUE_CONSTRAINT_MESSAGE = /constraint error.*violates unique constraint/i;

/**
 * Reports whether a catalog-sourcing attempt (successful or not) has already
 * been recorded for this exact (category, brand) combo, so a caller can skip
 * re-attempting it (Requirement 5).
 */
export async function hasCatalogSourcingBeenAttempted(category: ComponentCategory, brand: string): Promise<boolean> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT 1 FROM part_catalog_sourcing_attempts WHERE category = $category AND brand = $brand`,
    { category, brand },
  );
  return reader.getRowObjectsJson().length > 0;
}

/**
 * Records one catalog-sourcing attempt for a (category, brand) combo,
 * including how many products were found and verified (0 for a failed or
 * empty catalog). Relies on the unique index on (category, brand) to make a
 * concurrent double-insert for the identical combo impossible; a caught
 * unique-constraint violation is treated as "already recorded, skip" rather
 * than thrown — same pattern as sourcingAttempts.ts's recordSourcingAttempt.
 * Logs at Info whether the attempt was newly recorded or already present.
 */
export async function recordCatalogSourcingAttempt(
  category: ComponentCategory,
  brand: string,
  succeeded: boolean,
  productsFound: number,
): Promise<void> {
  const connection = await getConnection();
  try {
    await connection.runAndReadAll(
      `INSERT INTO part_catalog_sourcing_attempts
         (id, category, brand, succeeded, products_found)
       VALUES
         ($id, $category, $brand, $succeeded, $products_found)`,
      {
        id: newId(),
        category,
        brand,
        succeeded,
        products_found: productsFound,
      },
    );
    logger.info({ category, brand, succeeded, productsFound }, 'Recorded catalog sourcing attempt');
  } catch (err) {
    // A second attempt for the identical combo hit the unique index: already
    // recorded by a prior (or racing-concurrent) call, nothing to do.
    if (err instanceof Error && UNIQUE_CONSTRAINT_MESSAGE.test(err.message)) {
      logger.info({ category, brand }, 'Catalog sourcing attempt already recorded, skipping');
      return;
    }
    throw err;
  }
}
