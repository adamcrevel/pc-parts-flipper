// Detects DuckDB's unique-constraint-violation error shape so scanService.ts
// can tell "this exact item was already inserted by a concurrent scan" apart
// from any other insert failure. The @duckdb/node-api driver throws a plain
// Error with no structured error code — confirmed empirically (T6: inserting
// a duplicate row under a UNIQUE INDEX against a real in-memory DuckDB
// instance threw `Error: Constraint Error: Duplicate key "..." violates
// unique constraint.`, no extra properties) — so matching on the message
// text is the only option this driver version offers.
const UNIQUE_CONSTRAINT_MESSAGE = /constraint error.*violates unique constraint/i;

/**
 * Returns true when `err` is DuckDB's unique-constraint-violation error —
 * e.g. thrown by createListing when a race loses to a concurrent scan
 * inserting the same (source_id, external_item_id) pair first — so the
 * caller can treat it as "already exists, skip" rather than a real failure.
 */
export function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Error && UNIQUE_CONSTRAINT_MESSAGE.test(err.message);
}
