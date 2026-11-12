// Applies schema.ts against a live connection. Every statement in schema.ts
// is written with an IF NOT EXISTS guard, so running this on every server
// start (via client.ts) is safe and idempotent — there is no separate
// "migrations already applied" tracking table needed at this schema's size.
import type { DuckDBConnection } from '@duckdb/node-api';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  await migratePlatformTypeAddMercari(connection);
  await migrateListingStatusAddRemoved(connection);
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
 * ai_confidence/ai_source/price_source/working_status must already exist on
 * expected_parts to carry across) and before INDEX_STATEMENTS (both tables'
 * indexes are IF NOT EXISTS and freshly recreated against the rebuilt
 * tables every boot, same as always). Real production DBs already passed
 * this rebuild once (a no-op on every later boot, see the guard below) and
 * never notice a missed column here — only a *fresh* database (every test
 * run, any new deploy environment) runs this path and would silently lose
 * any column ALTER_STATEMENTS added after this function's own column lists
 * were written, with a Binder Error surfacing on the first query that
 * touches it. Add new expected_parts columns to expected_parts_new's CREATE
 * TABLE and both column lists in the INSERT below too, not just
 * ALTER_STATEMENTS (confirmed the hard way: ai_confidence/ai_source landed
 * in ALTER_STATEMENTS without this update first, and every fresh-DB
 * integration test immediately 500'd on the first Expected Part insert —
 * working_status repeated the exact same mistake, confirmed the same way:
 * every fresh-DB POST /api/listings with a workingStatus field 500'd with
 * `Binder Error: Table "expected_parts" does not have a column with name
 * "working_status"` until this rebuild's own column lists were updated).
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
    ai_source VARCHAR,
    price_source VARCHAR,
    working_status VARCHAR DEFAULT 'working',
    notes VARCHAR
  )`);
  await connection.run(
    `INSERT INTO expected_parts_new (id, listing_id, component_category, description, estimated_resale_value, created_at, updated_at, brand, part_number, identity_candidates, ai_confidence, ai_source, price_source, working_status, notes)
     SELECT id, listing_id, component_category, description, estimated_resale_value, created_at, updated_at, brand, part_number, identity_candidates, ai_confidence, ai_source, price_source, working_status, notes FROM expected_parts`,
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

/**
 * Works around a DuckDB catalog bug confirmed against the real upgrade path
 * (any database that already ran migrateExpectedPartsNullablePrice's own
 * CREATE-new/DROP-old/RENAME-into-place rebuild above — i.e. every real
 * production database, and the standing gate's own whole-suite run):
 * DuckDB's catalog keeps a stale FOREIGN KEY dependency entry under a
 * table's *pre-rename* name (here, "expected_parts_new", the transient name
 * expected_parts briefly held during that earlier rebuild) and never
 * updates it when the table is later renamed or even dropped. That phantom
 * entry permanently blocks migratePlatformTypeAddMercari's own `DROP TABLE
 * listings` below with "Catalog Error: Could not drop the table because
 * this table is main key table of the table 'expected_parts_new'" —
 * confirmed to persist across reconnects (it's written into the catalog,
 * not just in-memory session state) and unaffected by `DROP TABLE ...
 * CASCADE` (confirmed empirically; CASCADE still hits the same phantom
 * dependency check first).
 *
 * The fix is DuckDB's own documented technique for rebuilding a catalog
 * from scratch: EXPORT DATABASE writes every table's current data and
 * current schema (not the stale rename history) out as Parquet + a
 * generated schema.sql, independent of whatever phantom dependency entries
 * the live catalog carries. Detaching the live database, replacing its
 * backing file with an empty one, and IMPORTing the export back into that
 * empty file produces a catalog built fresh from today's actual table
 * definitions, with no rename history left to leave a phantom entry behind
 * — confirmed empirically to turn the exact `DROP TABLE listings` that
 * failed above into one that succeeds immediately afterward, against the
 * same on-disk database, with every row of data intact.
 *
 * Called unconditionally from migratePlatformTypeAddMercari the one time
 * its own guard below decides a rebuild is needed (never on a fresh
 * database, where that guard already returns early) — cheap insurance
 * against this exact phantom-dependency history regardless of which past
 * migration happened to leave it, not just migrateExpectedPartsNullablePrice
 * specifically. An in-memory database (no on-disk path — only possible in
 * ad hoc scripts, never client.ts's real DB_PATH-backed connection) is
 * handled by reattaching a fresh ':memory:' catalog instead of touching any
 * file.
 */
async function rebuildCorruptedCatalog(connection: DuckDBConnection): Promise<void> {
  const [{ name: dbName }] = (
    await connection.runAndReadAll(`SELECT current_database() AS name`)
  ).getRowObjectsJson() as { name: string }[];
  const [dbRow] = (
    await connection.runAndReadAll(`SELECT path FROM duckdb_databases() WHERE database_name = current_database()`)
  ).getRowObjectsJson() as { path: string | null }[];
  const dbPath = dbRow?.path ?? null;

  const exportDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-catalog-rebuild-'));
  try {
    await connection.run(`EXPORT DATABASE '${exportDir}' (FORMAT PARQUET)`);

    // A scratch catalog to USE while the real one is detached — DuckDB
    // requires some database to be current at all times.
    await connection.run(`ATTACH ':memory:' AS __catalog_rebuild_scratch`);
    await connection.run(`USE __catalog_rebuild_scratch`);
    await connection.run(`DETACH "${dbName}"`);

    if (dbPath) {
      await rm(dbPath, { force: true });
      await rm(`${dbPath}.wal`, { force: true });
      await connection.run(`ATTACH '${dbPath}' AS "${dbName}"`);
    } else {
      await connection.run(`ATTACH ':memory:' AS "${dbName}"`);
    }
    await connection.run(`USE "${dbName}"`);
    await connection.run(`IMPORT DATABASE '${exportDir}'`);
    await connection.run(`DETACH __catalog_rebuild_scratch`);
  } finally {
    await rm(exportDir, { recursive: true, force: true });
  }
}

/**
 * One-off structural migration: adds 'mercari' to the platform_type enum
 * used by sources.platform_type and sale_listings.platform
 * (marketplace-sources feature, Req 7). DuckDB has no `ALTER TYPE` statement
 * at all — confirmed empirically against this project's own installed
 * DuckDB build (the @duckdb/node-api 1.4.4-r.4 bindings this server runs on,
 * and independently against the standalone duckdb CLI 1.5.3): both reject
 * `ALTER TYPE platform_type ADD VALUE 'mercari'` outright with "Parser
 * Error: syntax error at or near TYPE", before ever reaching catalog
 * validation — unlike PostgreSQL, which this migration's original plan
 * assumed DuckDB matched (it doesn't; there is no ADD VALUE, and no ALTER
 * TYPE ... RENAME TO either, confirmed the same way).
 *
 * The usual DuckDB workaround — create a new enum type with the extra value
 * and `ALTER TABLE ... ALTER COLUMN ... TYPE` the column onto it — works
 * for sale_listings.platform, which nothing else references by FOREIGN KEY.
 * It fails for sources.platform_type the same "Dependency Error: Cannot
 * alter entry ... because there are entries that depend on it" way
 * migrateExpectedPartsNullablePrice above already found: `listings`
 * references `sources(id)`, and DuckDB refuses to touch *any* column on
 * `sources` while `listings` exists — confirmed directly, altering the
 * unrelated platform_type column fails purely because of that one FK.
 * `listings` is itself the root of this schema's entire downstream FOREIGN
 * KEY tree (part_reference_photos, expected_parts, purchases,
 * teardown_results, parts, sale_listings, sales, identify_parts_jobs — every
 * `REFERENCES listings(id)`/`REFERENCES purchases(id)`/`REFERENCES
 * expected_parts(id)`/`REFERENCES parts(id)` clause in TABLE_STATEMENTS
 * above). There is no DuckDB setting to disable FK enforcement (confirmed
 * against `duckdb_settings()` — no foreign_keys/constraint toggle exists)
 * and no `ALTER TABLE ... DROP CONSTRAINT` (confirmed: "Not implemented
 * Error: No support for that ALTER TABLE option yet!").
 *
 * So, same idea as migrateExpectedPartsNullablePrice, but for the whole
 * ten-table subtree rooted at `sources` instead of just two tables: first
 * calls rebuildCorruptedCatalog() above (see its own doc comment — a real,
 * already-migrated database has a DuckDB catalog bug that otherwise crashes
 * the very first `DROP TABLE listings` below with a Catalog Error),  then
 * backs every one of those tables up with `CREATE TABLE ... AS SELECT *`
 * (casting the two platform_type-typed columns to VARCHAR first, so the old
 * enum type ends this step with zero remaining dependents), drops them
 * children-before-parent, drops the old enum type, then recreates
 * everything by re-running this file's own imported ENUM_STATEMENTS[0] (now
 * including 'mercari'), TABLE_STATEMENTS, and ALTER_STATEMENTS — the exact
 * same statements a fresh database runs, so there is no second,
 * hand-maintained column list to drift out of sync the way
 * migrateExpectedPartsNullablePrice's own doc comment above warns about —
 * followed by migrateExpectedPartsNullablePrice() itself again (expected_
 * parts comes back from TABLE_STATEMENTS with its original NOT NULL
 * estimated_resale_value; this re-applies the nullable rebuild to the
 * fresh, still-empty table before any backed-up row — which may carry a
 * NULL in that column on a real database — is restored into it). Finally
 * restores every table's data with `INSERT INTO ... BY NAME`
 * (parent-before-child order, so every FOREIGN KEY is satisfied the moment
 * its row lands; `BY NAME` makes the EXCLUDE/cast column reordering in the
 * two platform_type-typed backups irrelevant), and drops the ten holding
 * tables.
 *
 * Guarded by an `enum_range()` check so this runs exactly once, not on
 * every boot like everything else in this file — a no-op on both a fresh
 * database (schema.ts's own ENUM_STATEMENTS already created platform_type
 * with 'mercari' in it) and an already-migrated one.
 */
async function migratePlatformTypeAddMercari(connection: DuckDBConnection): Promise<void> {
  const reader = await connection.runAndReadAll(
    `SELECT list_contains(enum_range(NULL::platform_type), 'mercari') AS has_mercari`,
  );
  const rows = reader.getRowObjectsJson() as { has_mercari: boolean }[];
  if (rows.length > 0 && rows[0].has_mercari) {
    return;
  }

  console.log('[db] migrating platform_type enum to add mercari (one-time rebuild of sources and its full FK subtree)');

  // Clears any phantom FOREIGN KEY catalog entry left behind by an earlier
  // rebuild (e.g. migrateExpectedPartsNullablePrice's own RENAME dance)
  // before this function's own DROP TABLE sequence below can run into it.
  // See rebuildCorruptedCatalog's own doc comment above.
  await rebuildCorruptedCatalog(connection);

  // Backup: nothing is dropped yet, so order doesn't matter here — only the
  // two platform_type-typed columns need casting to VARCHAR.
  await connection.run(`CREATE TABLE sources_mercari_backup AS SELECT * EXCLUDE (platform_type), platform_type::VARCHAR AS platform_type FROM sources`);
  await connection.run(`CREATE TABLE listings_mercari_backup AS SELECT * FROM listings`);
  await connection.run(`CREATE TABLE part_reference_photos_mercari_backup AS SELECT * FROM part_reference_photos`);
  await connection.run(`CREATE TABLE expected_parts_mercari_backup AS SELECT * FROM expected_parts`);
  await connection.run(`CREATE TABLE purchases_mercari_backup AS SELECT * FROM purchases`);
  await connection.run(`CREATE TABLE teardown_results_mercari_backup AS SELECT * FROM teardown_results`);
  await connection.run(`CREATE TABLE parts_mercari_backup AS SELECT * FROM parts`);
  await connection.run(`CREATE TABLE sale_listings_mercari_backup AS SELECT * EXCLUDE (platform), platform::VARCHAR AS platform FROM sale_listings`);
  await connection.run(`CREATE TABLE sales_mercari_backup AS SELECT * FROM sales`);
  await connection.run(`CREATE TABLE identify_parts_jobs_mercari_backup AS SELECT * FROM identify_parts_jobs`);

  // Drop children before the parent they reference via FOREIGN KEY, ending
  // with the old platform_type type itself (now unreferenced by any column).
  for (const table of [
    'sales',
    'sale_listings',
    'teardown_results',
    'identify_parts_jobs',
    'part_reference_photos',
    'parts',
    'expected_parts',
    'purchases',
    'listings',
    'sources',
  ]) {
    await connection.run(`DROP TABLE ${table}`);
  }
  await connection.run(`DROP TYPE platform_type`);

  // Recreate everything via this file's own single source of truth — the
  // exact statements a fresh database runs — rather than a second,
  // hand-written copy of every column.
  await connection.run(ENUM_STATEMENTS[0]);
  for (const statement of TABLE_STATEMENTS) {
    await connection.run(statement);
  }
  for (const statement of ALTER_STATEMENTS) {
    await connection.run(statement);
  }
  await migrateExpectedPartsNullablePrice(connection);

  // Restore data, parents before children.
  await connection.run(`INSERT INTO sources BY NAME SELECT * EXCLUDE (platform_type), platform_type::platform_type AS platform_type FROM sources_mercari_backup`);
  await connection.run(`INSERT INTO listings BY NAME SELECT * FROM listings_mercari_backup`);
  await connection.run(`INSERT INTO part_reference_photos BY NAME SELECT * FROM part_reference_photos_mercari_backup`);
  await connection.run(`INSERT INTO expected_parts BY NAME SELECT * FROM expected_parts_mercari_backup`);
  await connection.run(`INSERT INTO purchases BY NAME SELECT * FROM purchases_mercari_backup`);
  await connection.run(`INSERT INTO teardown_results BY NAME SELECT * FROM teardown_results_mercari_backup`);
  await connection.run(`INSERT INTO parts BY NAME SELECT * FROM parts_mercari_backup`);
  await connection.run(`INSERT INTO sale_listings BY NAME SELECT * EXCLUDE (platform), platform::platform_type AS platform FROM sale_listings_mercari_backup`);
  await connection.run(`INSERT INTO sales BY NAME SELECT * FROM sales_mercari_backup`);
  await connection.run(`INSERT INTO identify_parts_jobs BY NAME SELECT * FROM identify_parts_jobs_mercari_backup`);

  // Drop the ten holding tables now that every row has been restored.
  for (const table of [
    'sources_mercari_backup',
    'listings_mercari_backup',
    'part_reference_photos_mercari_backup',
    'expected_parts_mercari_backup',
    'purchases_mercari_backup',
    'teardown_results_mercari_backup',
    'parts_mercari_backup',
    'sale_listings_mercari_backup',
    'sales_mercari_backup',
    'identify_parts_jobs_mercari_backup',
  ]) {
    await connection.run(`DROP TABLE ${table}`);
  }

  console.log('[db] platform_type mercari migration complete');
}

/**
 * One-off structural migration: adds 'removed' to the listing_status enum
 * (Requirement 1) using the exact same technique as
 * migratePlatformTypeAddMercari above — DuckDB has no
 * `ALTER TYPE ... ADD VALUE` statement at all, so the enum can only grow by
 * dropping and recreating it, which first requires dropping every table
 * that depends on it (directly or transitively via FOREIGN KEY) and
 * recreating them from schema.ts's own statements afterward.
 *
 * listing_status is used by exactly one column, listings.status — but
 * dropping `listings` itself still requires first dropping every table
 * that references it, directly (expected_parts, purchases,
 * identify_parts_jobs, part_reference_photos) or transitively
 * (teardown_results references purchases and expected_parts, parts
 * references purchases, sale_listings and sales both reference parts).
 * `sources` (listings' own parent, unaffected since nothing about it is
 * listing_status-typed) and the four tables with no FK path to listings at
 * all (part_price_cache, price_parts_jobs,
 * part_reference_sourcing_attempts, part_catalog_sourcing_attempts) are
 * left untouched — a narrower subtree than migratePlatformTypeAddMercari's
 * own rebuild, which also had to touch sources/sale_listings because
 * platform_type is used by columns on both of those.
 *
 * Runs after migratePlatformTypeAddMercari (so a database needing both
 * migrations does the platform_type rebuild first, then this one against
 * the now-current schema) and before INDEX_STATEMENTS, same ordering
 * rationale as that function.
 */
async function migrateListingStatusAddRemoved(connection: DuckDBConnection): Promise<void> {
  const reader = await connection.runAndReadAll(
    `SELECT list_contains(enum_range(NULL::listing_status), 'removed') AS has_removed`,
  );
  const rows = reader.getRowObjectsJson() as { has_removed: boolean }[];
  if (rows.length > 0 && rows[0].has_removed) {
    return;
  }

  console.log('[db] migrating listing_status enum to add removed (one-time rebuild of listings and its FK subtree)');

  // Clears any phantom FOREIGN KEY catalog entry left behind by an earlier
  // rebuild (e.g. migrateExpectedPartsNullablePrice's own RENAME dance, or
  // migratePlatformTypeAddMercari's own DROP/ATTACH dance if it already ran)
  // before this function's own DROP TABLE sequence below can run into it.
  // See rebuildCorruptedCatalog's own doc comment above.
  await rebuildCorruptedCatalog(connection);

  // Backup: nothing is dropped yet, so order doesn't matter here — only
  // listings.status is listing_status-typed.
  await connection.run(`CREATE TABLE listings_status_backup AS SELECT * EXCLUDE (status), status::VARCHAR AS status FROM listings`);
  await connection.run(`CREATE TABLE part_reference_photos_status_backup AS SELECT * FROM part_reference_photos`);
  await connection.run(`CREATE TABLE expected_parts_status_backup AS SELECT * FROM expected_parts`);
  await connection.run(`CREATE TABLE purchases_status_backup AS SELECT * FROM purchases`);
  await connection.run(`CREATE TABLE teardown_results_status_backup AS SELECT * FROM teardown_results`);
  await connection.run(`CREATE TABLE parts_status_backup AS SELECT * FROM parts`);
  await connection.run(`CREATE TABLE sale_listings_status_backup AS SELECT * FROM sale_listings`);
  await connection.run(`CREATE TABLE sales_status_backup AS SELECT * FROM sales`);
  await connection.run(`CREATE TABLE identify_parts_jobs_status_backup AS SELECT * FROM identify_parts_jobs`);

  // Drop children before the parent they reference via FOREIGN KEY, ending
  // with the old listing_status type itself (now unreferenced by any
  // column). sources and the four tables with no FK path to listings are
  // left in place.
  for (const table of [
    'sales',
    'sale_listings',
    'teardown_results',
    'identify_parts_jobs',
    'part_reference_photos',
    'parts',
    'expected_parts',
    'purchases',
    'listings',
  ]) {
    await connection.run(`DROP TABLE ${table}`);
  }
  await connection.run(`DROP TYPE listing_status`);

  // Recreate everything via this file's own single source of truth. The
  // TABLE_STATEMENTS/ALTER_STATEMENTS entries for tables never dropped
  // above (sources, part_price_cache, price_parts_jobs,
  // part_reference_sourcing_attempts, part_catalog_sourcing_attempts) are
  // IF NOT EXISTS/ADD COLUMN IF NOT EXISTS no-ops.
  await connection.run(ENUM_STATEMENTS[1]);
  for (const statement of TABLE_STATEMENTS) {
    await connection.run(statement);
  }
  for (const statement of ALTER_STATEMENTS) {
    await connection.run(statement);
  }
  await migrateExpectedPartsNullablePrice(connection);

  // Restore data, parents before children.
  await connection.run(`INSERT INTO listings BY NAME SELECT * EXCLUDE (status), status::listing_status AS status FROM listings_status_backup`);
  await connection.run(`INSERT INTO part_reference_photos BY NAME SELECT * FROM part_reference_photos_status_backup`);
  await connection.run(`INSERT INTO expected_parts BY NAME SELECT * FROM expected_parts_status_backup`);
  await connection.run(`INSERT INTO purchases BY NAME SELECT * FROM purchases_status_backup`);
  await connection.run(`INSERT INTO teardown_results BY NAME SELECT * FROM teardown_results_status_backup`);
  await connection.run(`INSERT INTO parts BY NAME SELECT * FROM parts_status_backup`);
  await connection.run(`INSERT INTO sale_listings BY NAME SELECT * FROM sale_listings_status_backup`);
  await connection.run(`INSERT INTO sales BY NAME SELECT * FROM sales_status_backup`);
  await connection.run(`INSERT INTO identify_parts_jobs BY NAME SELECT * FROM identify_parts_jobs_status_backup`);

  // Drop the nine holding tables now that every row has been restored.
  for (const table of [
    'listings_status_backup',
    'part_reference_photos_status_backup',
    'expected_parts_status_backup',
    'purchases_status_backup',
    'teardown_results_status_backup',
    'parts_status_backup',
    'sale_listings_status_backup',
    'sales_status_backup',
    'identify_parts_jobs_status_backup',
  ]) {
    await connection.run(`DROP TABLE ${table}`);
  }

  console.log('[db] listing_status removed migration complete');
}
