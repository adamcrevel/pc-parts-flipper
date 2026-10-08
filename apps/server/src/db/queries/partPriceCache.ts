// Typed CRUD for the `part_price_cache` table (part-price-estimation
// feature T3). Caches an AI-researched resale-value estimate per
// (component_category, brand, part_number) combo so a part identified a
// second time with the same combo reuses the prior research instead of
// re-querying the AI price-research module, and backs the daily refresh
// sweep that re-prices every cached combo.
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { toNullableNumber } from '../sqlHelpers.js';
import type { ComponentCategory, PartPriceCacheEntry } from '../types.js';

// Same pattern as referencePhotos.ts's / sourcingAttempts.ts's
// UNIQUE_CONSTRAINT_MESSAGE: matches the DuckDB error text raised when the
// unique index on (component_category, brand, part_number) is violated by a
// second insert for the same combo.
const UNIQUE_CONSTRAINT_MESSAGE = /constraint error.*violates unique constraint/i;

// Converts one raw JSON row into the camelCase PartPriceCacheEntry shape.
function mapRow(row: Record<string, unknown>): PartPriceCacheEntry {
  return {
    id: row.id as string,
    category: row.component_category as ComponentCategory,
    brand: row.brand as string,
    partNumber: row.part_number as string,
    estimatedResaleValue: toNullableNumber(row.estimated_resale_value as string | null),
    lastResearchedAt: row.last_researched_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Fetches the cached price-research entry for one (category, brand,
 * partNumber) combo, or null if that combo has never been queued for
 * research.
 */
export async function findPriceCacheEntry(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
): Promise<PartPriceCacheEntry | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM part_price_cache
     WHERE component_category = $category AND brand = $brand AND part_number = $part_number`,
    { category, brand, part_number: partNumber },
  );
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/**
 * Inserts a new, as-yet-unresearched cache row for a (category, brand,
 * partNumber) combo (estimated_resale_value and last_researched_at both left
 * null — the first successful research fills them in via
 * updatePriceCacheEntryValue). Relies on the unique index on
 * (component_category, brand, part_number) to make a concurrent double-
 * insert for the identical combo impossible; a caught unique-constraint
 * violation is treated as "already queued, skip" rather than thrown — same
 * pattern as referencePhotos.ts's insertReferencePhotoRow and
 * sourcingAttempts.ts's recordSourcingAttempt.
 */
export async function insertPriceCacheEntry(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
): Promise<{ inserted: boolean }> {
  const connection = await getConnection();
  try {
    await connection.runAndReadAll(
      `INSERT INTO part_price_cache
         (id, component_category, brand, part_number)
       VALUES
         ($id, $category, $brand, $part_number)`,
      {
        id: newId(),
        category,
        brand,
        part_number: partNumber,
      },
    );
    return { inserted: true };
  } catch (err) {
    if (err instanceof Error && UNIQUE_CONSTRAINT_MESSAGE.test(err.message)) {
      return { inserted: false };
    }
    throw err;
  }
}

/**
 * Records the outcome of researching one (category, brand, partNumber)
 * combo. When `value` is a number, sets both `estimated_resale_value` and
 * `last_researched_at` (a priced combo). When `value` is null (research ran
 * but couldn't price the combo), only `last_researched_at` is touched —
 * `estimated_resale_value` is deliberately left out of that SET clause so a
 * later null-finding refresh can never regress a prior successful cached
 * value back down to null.
 */
export async function updatePriceCacheEntryValue(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
  value: number | null,
): Promise<void> {
  const connection = await getConnection();
  const setSql =
    value === null
      ? `last_researched_at = current_timestamp`
      : `estimated_resale_value = $value, last_researched_at = current_timestamp`;
  await connection.run(
    `UPDATE part_price_cache
     SET ${setSql}, updated_at = current_timestamp
     WHERE component_category = $category AND brand = $brand AND part_number = $part_number`,
    value === null
      ? { category, brand, part_number: partNumber }
      : { category, brand, part_number: partNumber, value },
  );
}

/** Lists every cached price-research entry — feeds the daily refresh sweep. */
export async function listAllPriceCacheEntries(): Promise<PartPriceCacheEntry[]> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(`SELECT * FROM part_price_cache`);
  return reader.getRowObjectsJson().map(mapRow);
}

/**
 * Propagates a freshly cached (or refreshed) price onto every Expected Part
 * sharing this exact (category, brand, partNumber) combo whose
 * `price_source` is `'auto'`. Three-state semantics (assumption A22,
 * correcting A8): null is *undecided* — nobody has claimed the price yet,
 * so it's still eligible for the server's first auto-claim, not touched by
 * this propagation; `'auto'` means the background pipeline currently owns
 * the figure, which is exactly the state this UPDATE is allowed to
 * overwrite; `'manual'` means the user has explicitly taken ownership (by
 * typing a value, or by clearing one the pipeline had filled in), and must
 * never be auto-overwritten again. Restricting this UPDATE's WHERE clause
 * to `price_source = 'auto'` is what keeps a background cache refresh from
 * ever touching a `'manual'` row.
 */
export async function propagateCachedPriceToExpectedParts(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
  value: number,
): Promise<void> {
  const connection = await getConnection();
  await connection.run(
    `UPDATE expected_parts
     SET estimated_resale_value = $value, updated_at = current_timestamp
     WHERE component_category = $category AND brand = $brand AND part_number = $part_number
       AND price_source = 'auto'
       AND working_status = 'working'`,
    { category, brand, part_number: partNumber, value },
  );
}
