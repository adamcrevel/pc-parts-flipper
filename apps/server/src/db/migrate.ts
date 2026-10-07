// Applies schema.ts against a live connection. Every statement in schema.ts
// is written with an IF NOT EXISTS guard, so running this on every server
// start (via client.ts) is safe and idempotent — there is no separate
// "migrations already applied" tracking table needed at this schema's size.
import type { DuckDBConnection } from '@duckdb/node-api';
import { ALTER_STATEMENTS, ENUM_STATEMENTS, INDEX_STATEMENTS, TABLE_STATEMENTS } from './schema.js';

/**
 * Runs every DDL statement needed to bring the database up to the current
 * schema: enum types, then tables (in FK dependency order), then indexes.
 * Statements run sequentially (not in parallel) because later tables
 * reference earlier ones via FOREIGN KEY.
 */
export async function runMigrations(connection: DuckDBConnection): Promise<void> {
  // Info: flow-entry trace for startup — superseded by T3's pino logger once wired in.
  console.log('[db] running migrations');
  for (const statement of [...ENUM_STATEMENTS, ...TABLE_STATEMENTS, ...ALTER_STATEMENTS]) {
    await connection.run(statement);
  }
  await migrateExpectedPartsNullablePrice(connection);
  for (const statement of INDEX_STATEMENTS) {
    await connection.run(statement);
  }
  console.log('[db] migrations complete');
}

/**
 * One-off structural migration: makes expected_parts.estimated_resale_value
 * nullable — "not yet priced" is a real state (an AI-identified part is
 * never priced by the model), distinct from priced-at-$0. Not expressible
 * as a plain ALTER_STATEMENTS string like the rest of this file: DuckDB
 * refuses ALTER COLUMN, DROP COLUMN, and ADD CONSTRAINT outright on any
 * table another table references via FOREIGN KEY (confirmed empirically
 * against a live connection, three different ways, all rejected with
 * "Dependency Error: Cannot alter entry ... because there are entries that
 * depend on it") — and teardown_results.expected_part_id does exactly that.
 *
 * So this rebuilds both tables instead: copies expected_parts into a
 * nullable-column replacement, copies teardown_results into a plain holding
 * table (so dropping the real teardown_results below doesn't lose data),
 * drops teardown_results (safe — nothing references it), drops the old
 * expected_parts (now safe, since teardown_results, its only referencer,
 * is gone), renames the replacement into place, recreates teardown_results
 * under its real name with its FK now pointing at the renamed table, and
 * restores its data. Every step was proven first against a synthetic copy
 * of this exact schema (same columns, same FKs, same UNIQUE constraint).
 *
 * Runs after ALTER_STATEMENTS (brand/part_number/identity_candidates/
 * ai_confidence/ai_source must already exist on expected_parts to carry
 * across) and before INDEX_STATEMENTS (both tables' indexes are IF NOT
 * EXISTS and freshly recreated against the rebuilt tables every boot, same
 * as always). Real production DBs already passed this rebuild once (a
 * no-op on every later boot, see the guard below) and never notice a
 * missed column here — only a *fresh* database (every test run, any new
 * deploy environment) runs this path and would silently lose any column
 * ALTER_STATEMENTS added after this function's own column lists were
 * written, with a Binder Error surfacing on the first query that touches
 * it. Add new expected_parts columns to expected_parts_new's CREATE TABLE
 * and both column lists in the INSERT below too, not just ALTER_STATEMENTS
 * (confirmed the hard way: ai_confidence/ai_source landed in
 * ALTER_STATEMENTS without this update first, and every fresh-DB
 * integration test immediately 500'd on the first Expected Part insert).
 *
 * Guarded by information_schema so the ten-statement sequence runs exactly
 * once, not on every boot like everything else in this file: a second run
 * would rebuild two tables' worth of data for nothing once already done.
 */
async function migrateExpectedPartsNullablePrice(connection: DuckDBConnection): Promise<void> {
  const reader = await connection.runAndReadAll(
    `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'expected_parts' AND column_name = 'estimated_resale_value'`,
  );
  const rows = reader.getRowObjectsJson() as { is_nullable: string }[];
  const alreadyNullable = rows.length > 0 && rows[0].is_nullable === 'YES';
  if (alreadyNullable) {
    return;
  }

  console.log('[db] migrating expected_parts.estimated_resale_value to nullable (one-time table rebuild)');

  await connection.run(`CREATE TABLE expected_parts_new (
    id UUID PRIMARY KEY,
    listing_id UUID NOT NULL REFERENCES listings(id),
    component_category component_category NOT NULL,
    description VARCHAR NOT NULL,
    estimated_resale_value DECIMAL(10, 2) CHECK (estimated_resale_value >= 0),
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    brand VARCHAR,
    part_number VARCHAR,
    identity_candidates VARCHAR DEFAULT '[]',
    ai_confidence VARCHAR,
    ai_source VARCHAR
  )`);
  await connection.run(
    `INSERT INTO expected_parts_new (id, listing_id, component_category, description, estimated_resale_value, created_at, updated_at, brand, part_number, identity_candidates, ai_confidence, ai_source)
     SELECT id, listing_id, component_category, description, estimated_resale_value, created_at, updated_at, brand, part_number, identity_candidates, ai_confidence, ai_source FROM expected_parts`,
  );

  await connection.run(`CREATE TABLE teardown_results_backup (
    id UUID, purchase_id UUID, expected_part_id UUID, result VARCHAR, note VARCHAR,
    created_at TIMESTAMP, updated_at TIMESTAMP
  )`);
  await connection.run(
    `INSERT INTO teardown_results_backup (id, purchase_id, expected_part_id, result, note, created_at, updated_at)
     SELECT id, purchase_id, expected_part_id, result, note, created_at, updated_at FROM teardown_results`,
  );

  await connection.run(`DROP TABLE teardown_results`);
  await connection.run(`DROP TABLE expected_parts`);
  await connection.run(`ALTER TABLE expected_parts_new RENAME TO expected_parts`);

  await connection.run(`CREATE TABLE teardown_results (
    id UUID PRIMARY KEY,
    purchase_id UUID NOT NULL REFERENCES purchases(id),
    expected_part_id UUID REFERENCES expected_parts(id),
    result teardown_result_type NOT NULL,
    note VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
    UNIQUE (purchase_id, expected_part_id)
  )`);
  await connection.run(
    `INSERT INTO teardown_results (id, purchase_id, expected_part_id, result, note, created_at, updated_at)
     SELECT id, purchase_id, expected_part_id, result, note, created_at, updated_at FROM teardown_results_backup`,
  );
  await connection.run(`DROP TABLE teardown_results_backup`);

  console.log('[db] expected_parts/teardown_results rebuild complete');
}
