// Small helpers shared by every queries/*.ts file in this module. Kept here
// (rather than duplicated eight times) because the SET-clause construction
// below encodes a non-obvious rule — `undefined` means "leave unchanged",
// which a plain object spread can't express — and because DuckDB returns
// DECIMAL columns as strings via getRowObjectsJson(), a conversion every
// money-bearing row needs identically.

/**
 * Builds a parameterized `SET` clause for an UPDATE statement from a patch
 * object, skipping any key whose value is `undefined` (meaning "leave this
 * column unchanged" — distinct from `null`, which explicitly clears it).
 * Always appends `updated_at = current_timestamp`, so the returned clause is
 * never empty even when every other field is unchanged.
 */
export function buildSetClause(patch: Record<string, unknown>): {
  setSql: string;
  params: Record<string, unknown>;
} {
  const assignments: string[] = [];
  const params: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(patch)) {
    // Skip untouched fields — see function doc above for why this can't be a COALESCE.
    if (value === undefined) continue;
    assignments.push(`${column} = $${column}`);
    params[column] = value;
  }
  assignments.push('updated_at = current_timestamp');
  return { setSql: assignments.join(', '), params };
}

/** Converts a DuckDB DECIMAL's JSON string form (e.g. "12.50") to a number. */
export function toNumber(value: string): number {
  return Number(value);
}

/** Converts a nullable DuckDB DECIMAL's JSON string form to a number, or null when the column itself is null (an Expected Part not yet priced). */
export function toNullableNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}
