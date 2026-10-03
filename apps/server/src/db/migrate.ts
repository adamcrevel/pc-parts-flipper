// Applies schema.ts against a live connection. Every statement in schema.ts
// is written with an IF NOT EXISTS guard, so running this on every server
// start (via client.ts) is safe and idempotent — there is no separate
// "migrations already applied" tracking table needed at this schema's size.
import type { DuckDBConnection } from '@duckdb/node-api';
import { ENUM_STATEMENTS, INDEX_STATEMENTS, TABLE_STATEMENTS } from './schema.js';

/**
 * Runs every DDL statement needed to bring the database up to the current
 * schema: enum types, then tables (in FK dependency order), then indexes.
 * Statements run sequentially (not in parallel) because later tables
 * reference earlier ones via FOREIGN KEY.
 */
export async function runMigrations(connection: DuckDBConnection): Promise<void> {
  // Info: flow-entry trace for startup — superseded by T3's pino logger once wired in.
  console.log('[db] running migrations');
  for (const statement of [...ENUM_STATEMENTS, ...TABLE_STATEMENTS, ...INDEX_STATEMENTS]) {
    await connection.run(statement);
  }
  console.log('[db] migrations complete');
}
