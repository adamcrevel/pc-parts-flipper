// Typed CRUD for the `part_reference_sourcing_attempts` table
// (ai-reference-autosourcing feature T1). Records every attempt — successful
// or not — to auto-source a reference photo for one (category, brand,
// partNumber) combo, so identify-parts' second pass never re-attempts the
// same combo twice (Requirement 6).
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { logger } from '../../logger.js';
import type { ComponentCategory } from '../types.js';

// Same pattern as referencePhotos.ts's UNIQUE_CONSTRAINT_MESSAGE: matches the
// DuckDB error text raised when the unique index on
// (category, brand, part_number) is violated by a second attempt row.
const UNIQUE_CONSTRAINT_MESSAGE = /constraint error.*violates unique constraint/i;

/**
 * Reports whether a sourcing attempt (successful or not) has already been
 * recorded for this exact (category, brand, partNumber) combo, so a caller
 * can skip re-attempting it (Requirement 6).
 */
export async function hasSourcingBeenAttempted(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
): Promise<boolean> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT 1 FROM part_reference_sourcing_attempts
     WHERE category = $category AND brand = $brand AND part_number = $part_number`,
    { category, brand, part_number: partNumber },
  );
  return reader.getRowObjectsJson().length > 0;
}

/**
 * Records one sourcing attempt for a (category, brand, partNumber) combo.
 * Relies on the unique index on (category, brand, part_number) to make a
 * concurrent double-insert for the identical combo impossible; a caught
 * unique-constraint violation is treated as "already recorded, skip" rather
 * than thrown (same pattern as referencePhotos.ts's insertReferencePhotoRow).
 * Logs at Info whether the attempt was newly recorded or already present.
 */
export async function recordSourcingAttempt(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
  succeeded: boolean,
): Promise<void> {
  const connection = await getConnection();
  try {
    await connection.runAndReadAll(
      `INSERT INTO part_reference_sourcing_attempts
         (id, category, brand, part_number, succeeded)
       VALUES
         ($id, $category, $brand, $part_number, $succeeded)`,
      {
        id: newId(),
        category,
        brand,
        part_number: partNumber,
        succeeded,
      },
    );
    logger.info(
      { category, brand, partNumber, succeeded },
      'Recorded reference photo sourcing attempt',
    );
  } catch (err) {
    // A second attempt for the identical combo hit the unique index: already
    // recorded by a prior (or racing-concurrent) call, nothing to do.
    if (err instanceof Error && UNIQUE_CONSTRAINT_MESSAGE.test(err.message)) {
      logger.info(
        { category, brand, partNumber },
        'Reference photo sourcing attempt already recorded, skipping',
      );
      return;
    }
    throw err;
  }
}
