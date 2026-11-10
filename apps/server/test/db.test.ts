// T2 proof: the data-access module (apps/server/src/db/**) creates every
// table named in the Requirements with its expected columns, and every
// exported query function round-trips data correctly (create, then read
// back the identical values).
//
// Uses a per-run isolated DuckDB file via DUCKDB_DATA_DIR — the same escape
// hatch client.ts documents for tests/tooling — rather than the shared dev
// database under data/. client.ts reads DUCKDB_DATA_DIR once into a
// module-scoped singleton at first `getConnection()` call, so the dynamic
// imports below (see the beforeAll's exception comment) are what let this
// test set that env var before any db module is evaluated.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { ALTER_STATEMENTS, ENUM_STATEMENTS, INDEX_STATEMENTS, TABLE_STATEMENTS } from '../src/db/schema.js';

let dataDir: string;
let db: typeof DbModule;
let getConnection: typeof ClientModule.getConnection;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-db-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import): client.ts's DATA_DIR is computed once,
  // from DUCKDB_DATA_DIR, at module-evaluation time into a file-scoped
  // const. A static top-of-file import would evaluate before this
  // beforeAll sets the env var and would therefore open the shared dev
  // database instead of this test's isolated temp dir — the dynamic import
  // here is what makes the module-loading timing land after the env var.
  db = await import('../src/db/index.js');
  ({ getConnection } = await import('../src/db/client.js'));
});

afterAll(async () => {
  delete process.env.DUCKDB_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

// Expected columns per table, in DDL order, transcribed from schema.ts's
// TABLE_STATEMENTS independently of that file (not generated from it) so
// this test actually catches a column being dropped, renamed, or added.
const EXPECTED_COLUMNS: Record<string, string[]> = {
  // connector_config/last_scanned_at/last_scan_found_count (ebay-scanning
  // feature, T1) were added via a later ALTER_STATEMENTS phase, so DuckDB
  // reports them after the original CREATE TABLE's columns, not interleaved.
  sources: [
    'id',
    'name',
    'platform_type',
    'url',
    'notes',
    'active',
    'created_at',
    'updated_at',
    'connector_config',
    'last_scanned_at',
    'last_scan_found_count',
  ],
  // external_source/external_item_id (ebay-scanning feature, T1) were
  // likewise added via ALTER_STATEMENTS, appended after the original
  // columns; non_working (ebay-condition-filter feature, T1) was appended
  // later still, so it lands last of all.
  listings: [
    'id',
    'source_id',
    'title',
    'description',
    'listing_url',
    'asking_price',
    'listing_date',
    'status',
    'acquisition_fees',
    'photo_paths',
    'created_at',
    'updated_at',
    'external_source',
    'external_item_id',
    'non_working',
  ],
  // brand/part_number (brand-model feature) and ai_confidence/ai_source
  // (AI-suggestion provenance) were added via ALTER_STATEMENTS after the
  // original CREATE TABLE, so DuckDB reports them last rather than beside
  // component_category where the TypeScript row type places them.
  // working_status (ebay-condition-filter feature, T1) was appended next —
  // this is the column migrateExpectedPartsNullablePrice's hardcoded
  // rebuild (migrate.ts) drops on a genuinely fresh database; this fixture
  // is what makes that regression visible here (see the dedicated T1
  // describe block below for the direct proof). notes (part-notes-and-
  // unpriced-indicator feature, T2) was appended last of all, after
  // working_status.
  expected_parts: [
    'id',
    'listing_id',
    'component_category',
    'description',
    'estimated_resale_value',
    'created_at',
    'updated_at',
    'brand',
    'part_number',
    'identity_candidates',
    'ai_confidence',
    'ai_source',
    'price_source',
    'working_status',
    'notes',
  ],
  purchases: ['id', 'listing_id', 'status', 'price_paid', 'purchase_date', 'created_at', 'updated_at'],
  teardown_results: [
    'id',
    'purchase_id',
    'expected_part_id',
    'result',
    'note',
    'created_at',
    'updated_at',
  ],
  // brand/part_number likewise appended by ALTER_STATEMENTS.
  parts: [
    'id',
    'purchase_id',
    'category',
    'description',
    'status',
    'unsellable_reason',
    'created_at',
    'updated_at',
    'brand',
    'part_number',
    'identity_candidates',
  ],
  sale_listings: [
    'id',
    'part_id',
    'platform',
    'title',
    'description',
    'asking_price',
    'listed_at',
    'created_at',
    'updated_at',
  ],
  sales: [
    'id',
    'part_id',
    'sold_price',
    'sold_date',
    'platform_fee',
    'shipping_cost',
    'buyer_note',
    'created_at',
    'updated_at',
  ],
  part_reference_photos: [
    'id',
    'category',
    'brand',
    'part_number',
    'photo_path',
    'source',
    'listing_id',
    'created_at',
  ],
  // (ai-reference-autosourcing feature T1): one row per (category, brand,
  // part_number) combo ever attempted, so a repeat identify-parts pass
  // skips a combo already attempted (Req 6) rather than re-sourcing it.
  part_reference_sourcing_attempts: [
    'id',
    'category',
    'brand',
    'part_number',
    'attempted_at',
    'succeeded',
    // sourcing-resilience feature (T1): backoff bookkeeping for infra-
    // failure retries, appended by ALTER_STATEMENTS in this array order.
    'blocked',
    'attempt_count',
    'next_retry_at',
  ],
  // (ai-catalog-sourcing feature T1): one row per (category, brand) combo
  // ever catalog-sourced, so a repeat identify-parts pass skips a brand
  // whose catalog was already browsed (Req 5) rather than re-browsing it.
  part_catalog_sourcing_attempts: [
    'id',
    'category',
    'brand',
    'attempted_at',
    'succeeded',
    'products_found',
    // sourcing-resilience feature (T1): same backoff bookkeeping as
    // part_reference_sourcing_attempts above.
    'blocked',
    'attempt_count',
    'next_retry_at',
  ],
  // (async identify-parts-queue feature T1): one row per enqueued
  // identify-parts job, columns in the CREATE TABLE's DDL order above.
  identify_parts_jobs: [
    'id',
    'listing_id',
    'stage',
    'result',
    'error_message',
    'delivered',
    'created_at',
    'started_at',
    'completed_at',
    'updated_at',
    // sourcing-resilience feature (T1): job-level retry bookkeeping,
    // appended by ALTER_STATEMENTS in this array order.
    'retry_count',
    'next_retry_at',
  ],
  // Cache of AI-researched resale-value estimates for a given
  // (component_category, brand, part_number) combo (part-price-estimation
  // feature), so a part identified a second time with the same combo reuses
  // the prior research instead of re-querying the AI price-research module.
  part_price_cache: [
    'id',
    'component_category',
    'brand',
    'part_number',
    'estimated_resale_value',
    'last_researched_at',
    'created_at',
    'updated_at',
  ],
  // Price-research job queue (part-price-estimation feature): same
  // queued-row/poll-for-completion shape as identify_parts_jobs above, but
  // keyed on the (component_category, brand, part_number) triple rather than
  // a listing_id, since one price-research job can serve any Expected Part
  // sharing that combo, not just the one that triggered it.
  price_parts_jobs: [
    'id',
    'component_category',
    'brand',
    'part_number',
    'stage',
    'error_message',
    'created_at',
    'started_at',
    'completed_at',
    'updated_at',
    // sourcing-resilience feature (T1): same job-level retry bookkeeping
    // as identify_parts_jobs above.
    'retry_count',
    'next_retry_at',
  ],
};

describe('migrations create every table with the correct columns', () => {
  it('creates exactly the 9 tables named in the Requirements plus part_reference_photos (ai-visual-identification), part_reference_sourcing_attempts (ai-reference-autosourcing), part_catalog_sourcing_attempts (ai-catalog-sourcing), identify_parts_jobs (async identify-parts-queue), part_price_cache (part-price-estimation), and price_parts_jobs (part-price-estimation)', async () => {
    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name`,
    );
    const names = reader.getRowObjectsJson().map((row) => row.table_name as string);
    expect(names).toEqual(Object.keys(EXPECTED_COLUMNS).sort());
  });

  it.each(Object.entries(EXPECTED_COLUMNS))('`%s` has the expected columns in order', async (table, expectedCols) => {
    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $table ORDER BY ordinal_position`,
      { table },
    );
    const actualCols = reader.getRowObjectsJson().map((row) => row.column_name as string);
    expect(actualCols).toEqual(expectedCols);
  });

  it('rejects a negative monetary value at the database layer (CHECK constraint)', async () => {
    const connection = await getConnection();
    // Bypasses the query-function layer entirely, proving the CHECK
    // constraint itself (not just API-layer validation built in later
    // tasks) is what rejects a negative asking_price.
    await expect(
      connection.run(
        `INSERT INTO sources (id, name, platform_type) VALUES ('11111111-1111-1111-1111-111111111111', 'x', 'other')`,
      ),
    ).resolves.not.toThrow();
    await expect(
      connection.run(
        `INSERT INTO listings (id, source_id, title, asking_price, listing_date)
         VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'x', -5, '2024-01-01')`,
      ),
    ).rejects.toThrow();
  });

  it('adds every ALTER_STATEMENTS column with the correct type, nullable, and with no default (ALTER_STATEMENTS)', async () => {
    const connection = await getConnection();
    // Transcribed independently of schema.ts (VARCHAR/TIMESTAMP/INTEGER, all
    // nullable — none of the ALTER_STATEMENTS columns carry NOT NULL) so
    // this catches a type or nullability regression that the column-name-only
    // test above cannot: that test only reads column_name, never data_type,
    // is_nullable or column_default.
    //
    // column_default is projected as well as is_nullable, and that matters
    // most for the four identity columns (expected_parts/parts brand and
    // part_number). Those carry a standing invariant: brand and part number
    // are never guessed, never defaulted — an unidentified component stays
    // null. `is_nullable` alone cannot defend it. `ADD COLUMN ... DEFAULT
    // 'Unknown'` leaves the column nullable (so is_nullable stays 'YES') and
    // still lets an explicit NULL insert store null (so every round-trip
    // test stays green), while silently backfilling a fabricated brand onto
    // every row that already existed when the migration ran. The default
    // itself is the only observable difference, so it is the thing asserted.
    const reader = await connection.runAndReadAll(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE (table_name = 'sources' AND column_name IN ('connector_config', 'last_scanned_at', 'last_scan_found_count'))
          OR (table_name = 'listings' AND column_name IN ('external_source', 'external_item_id'))
          OR (table_name = 'expected_parts' AND column_name IN ('brand', 'part_number'))
          OR (table_name = 'parts' AND column_name IN ('brand', 'part_number'))
       ORDER BY table_name, column_name`,
    );
    expect(reader.getRowObjectsJson()).toEqual([
      { table_name: 'expected_parts', column_name: 'brand', data_type: 'VARCHAR', is_nullable: 'YES', column_default: null },
      { table_name: 'expected_parts', column_name: 'part_number', data_type: 'VARCHAR', is_nullable: 'YES', column_default: null },
      { table_name: 'listings', column_name: 'external_item_id', data_type: 'VARCHAR', is_nullable: 'YES', column_default: null },
      { table_name: 'listings', column_name: 'external_source', data_type: 'VARCHAR', is_nullable: 'YES', column_default: null },
      { table_name: 'parts', column_name: 'brand', data_type: 'VARCHAR', is_nullable: 'YES', column_default: null },
      { table_name: 'parts', column_name: 'part_number', data_type: 'VARCHAR', is_nullable: 'YES', column_default: null },
      { table_name: 'sources', column_name: 'connector_config', data_type: 'VARCHAR', is_nullable: 'YES', column_default: null },
      { table_name: 'sources', column_name: 'last_scan_found_count', data_type: 'INTEGER', is_nullable: 'YES', column_default: null },
      { table_name: 'sources', column_name: 'last_scanned_at', data_type: 'TIMESTAMP', is_nullable: 'YES', column_default: null },
    ]);
  });
});

// T1 proof: migrate.ts documents that running every DDL statement again on
// every server boot is safe. Nothing before this exercised a second run —
// the suite's single getConnection() call in beforeAll only ever runs
// migrations once per process.
describe('migrations are idempotent', () => {
  it('running every DDL statement a second time on the same connection does not throw and preserves existing data', async () => {
    const connection = await getConnection();
    // Row inserted before the second run: a destructive re-run (e.g. a
    // stray CREATE TABLE without IF NOT EXISTS dropping and recreating the
    // table) would lose this row even if no statement actually threw.
    const source = await db.createSource({
      name: 'idempotency check',
      platformType: 'other',
      url: null,
      notes: null,
    });

    await expect(runMigrations(connection)).resolves.not.toThrow();

    const reader = await connection.runAndReadAll(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'sources' ORDER BY ordinal_position`,
    );
    expect(reader.getRowObjectsJson().map((row) => row.column_name)).toEqual(EXPECTED_COLUMNS.sources);

    const stillThere = await db.getSourceById(source.id);
    expect(stillThere?.id).toBe(source.id);
  });
});

// T1 proof (ebay-condition-filter feature, Req 4-6): the two new
// ALTER_STATEMENTS columns this feature adds — listings.non_working and
// expected_parts.working_status — must behave correctly in the only two
// real-world migration scenarios: a database that has never run any
// migration before (every fresh test run, any new deploy environment), and
// a database that already completed every migration that existed
// immediately before this feature shipped (every real production
// deployment in the field today).
//
// These two scenarios are NOT interchangeable. migrate.ts's
// migrateExpectedPartsNullablePrice rebuilds expected_parts from a
// hardcoded column list the moment estimated_resale_value is not yet
// nullable — true on every brand-new database (TABLE_STATEMENTS' CREATE
// TABLE still declares it NOT NULL) but false on an already-migrated one
// (the rebuild already ran once, long before this feature, and its own
// information_schema guard skips it on every later boot). working_status is
// added via ALTER_STATEMENTS *before* that rebuild runs, so whether it
// survives depends entirely on whether the rebuild's own CREATE TABLE/INSERT
// column lists were updated to carry it across.
describe('non_working / working_status across a fresh database vs. an already-migrated one (T1)', () => {
  it('MUST FIX: a genuinely fresh database loses expected_parts.working_status to the pre-existing nullable-price rebuild, even though ALTER_STATEMENTS added it', async () => {
    // migrateExpectedPartsNullablePrice's CREATE TABLE expected_parts_new /
    // INSERT column lists (migrate.ts) were never updated to include
    // working_status, so it is silently dropped the moment that rebuild
    // runs against a table that still has estimated_resale_value NOT NULL —
    // which is every brand-new database, since TABLE_STATEMENTS' own CREATE
    // TABLE declares that column NOT NULL. Independently confirmed: calling
    // db.createExpectedPart() against a fresh database throws "Binder
    // Error: Table \"expected_parts\" does not have a column with name
    // \"working_status\"" — every Expected Part insert on a fresh install
    // fails outright, which is exactly what this suite's own shared fresh
    // database (this file's beforeAll) would hit too, were it not for the
    // EXPECTED_COLUMNS fixture above already failing first and loudly.
    const freshDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-db-test-fresh-'));
    try {
      const instance = await DuckDBInstance.create(path.join(freshDir, 'pc-parts-flipper.duckdb'));
      const connection = await instance.connect();

      // The real migration path a brand-new database goes through — no
      // pre-existing state at all.
      await runMigrations(connection);

      const listingCol = await connection.runAndReadAll(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'listings' AND column_name = 'non_working'`,
      );
      expect(listingCol.getRowObjectsJson(), 'listings.non_working must exist after migrating a fresh database').toHaveLength(1);

      const partCol = await connection.runAndReadAll(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'expected_parts' AND column_name = 'working_status'`,
      );
      expect(partCol.getRowObjectsJson(), 'expected_parts.working_status must exist after migrating a fresh database').toHaveLength(1);

      connection.closeSync();
      instance.closeSync();
    } finally {
      await rm(freshDir, { recursive: true, force: true });
    }
  });

  it('an already-migrated database (the schema that existed immediately before this feature) backfills both columns on pre-existing rows without losing data', async () => {
    // Replicates the exact pre-T1 schema end-state: every statement
    // runMigrations runs today, minus this feature's own two
    // ALTER_STATEMENTS entries (non_working/working_status — confirmed to
    // be exactly the last two entries by reading schema.ts directly), plus
    // migrate.ts's migrateExpectedPartsNullablePrice rebuild reproduced by
    // hand (it is a private, unexported function, so a real pre-existing
    // production database's end state — the rebuild already applied, long
    // before this feature shipped — has to be built this way instead).
    const upgradeDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-db-test-upgrade-'));
    try {
      const instance = await DuckDBInstance.create(path.join(upgradeDir, 'pc-parts-flipper.duckdb'));
      const connection = await instance.connect();

      for (const statement of [...ENUM_STATEMENTS, ...TABLE_STATEMENTS, ...ALTER_STATEMENTS.slice(0, -2)]) {
        await connection.run(statement);
      }
      await connection.run(`CREATE TABLE expected_parts_new (
        id UUID PRIMARY KEY, listing_id UUID NOT NULL REFERENCES listings(id), component_category component_category NOT NULL,
        description VARCHAR NOT NULL, estimated_resale_value DECIMAL(10, 2) CHECK (estimated_resale_value >= 0),
        created_at TIMESTAMP NOT NULL DEFAULT current_timestamp, updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        brand VARCHAR, part_number VARCHAR, identity_candidates VARCHAR DEFAULT '[]', ai_confidence VARCHAR, ai_source VARCHAR, price_source VARCHAR
      )`);
      await connection.run(`INSERT INTO expected_parts_new (id, listing_id, component_category, description, estimated_resale_value, created_at, updated_at, brand, part_number, identity_candidates, ai_confidence, ai_source, price_source)
        SELECT id, listing_id, component_category, description, estimated_resale_value, created_at, updated_at, brand, part_number, identity_candidates, ai_confidence, ai_source, price_source FROM expected_parts`);
      await connection.run(`CREATE TABLE teardown_results_backup (id UUID, purchase_id UUID, expected_part_id UUID, result VARCHAR, note VARCHAR, created_at TIMESTAMP, updated_at TIMESTAMP)`);
      await connection.run(`INSERT INTO teardown_results_backup SELECT id, purchase_id, expected_part_id, result, note, created_at, updated_at FROM teardown_results`);
      await connection.run(`DROP TABLE teardown_results`);
      await connection.run(`DROP TABLE expected_parts`);
      await connection.run(`ALTER TABLE expected_parts_new RENAME TO expected_parts`);
      await connection.run(`CREATE TABLE teardown_results (
        id UUID PRIMARY KEY, purchase_id UUID NOT NULL REFERENCES purchases(id), expected_part_id UUID REFERENCES expected_parts(id),
        result teardown_result_type NOT NULL, note VARCHAR, created_at TIMESTAMP NOT NULL DEFAULT current_timestamp, updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        UNIQUE (purchase_id, expected_part_id))`);
      await connection.run(`INSERT INTO teardown_results SELECT id, purchase_id, expected_part_id, result, note, created_at, updated_at FROM teardown_results_backup`);
      await connection.run(`DROP TABLE teardown_results_backup`);
      for (const statement of INDEX_STATEMENTS) {
        await connection.run(statement);
      }

      // Seeds a Listing + Expected Part under that pre-existing schema —
      // the "pre-existing row, seeded before the migration" the requirement
      // this test proves names directly.
      await connection.run(`INSERT INTO sources (id, name, platform_type) VALUES ('11111111-1111-1111-1111-111111111111', 'x', 'other')`);
      await connection.run(`INSERT INTO listings (id, source_id, title, asking_price, listing_date, photo_paths) VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'x', 5, '2024-01-01', '[]')`);
      await connection.run(`INSERT INTO expected_parts (id, listing_id, component_category, description, estimated_resale_value) VALUES ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'CPU', 'pre-existing part', NULL)`);

      // Applies the real, current runMigrations — the actual upgrade a live
      // server performs on its next boot after this feature ships.
      await runMigrations(connection);

      const listingRow = await connection.runAndReadAll(`SELECT non_working FROM listings WHERE id = '22222222-2222-2222-2222-222222222222'`);
      expect(listingRow.getRowObjectsJson()).toEqual([{ non_working: false }]);

      const partRow = await connection.runAndReadAll(`SELECT working_status FROM expected_parts WHERE id = '33333333-3333-3333-3333-333333333333'`);
      expect(partRow.getRowObjectsJson()).toEqual([{ working_status: 'working' }]);

      connection.closeSync();
      instance.closeSync();
    } finally {
      await rm(upgradeDir, { recursive: true, force: true });
    }
  });
});

// T2 proof: notes was added to expected_parts via ALTER_STATEMENTS, but
// every fresh database (no estimated_resale_value NOT NULL relaxation yet)
// also runs migrateExpectedPartsNullablePrice's table-rebuild, whose
// hand-written CREATE TABLE/INSERT column lists (migrate.ts) are the only
// thing standing between that ALTER and actually surviving the rebuild —
// exactly the failure mode the working_status comment above this block
// documents happening for real once already. This proves notes was not
// missed the same way: a brand-new database, migrated start to finish
// through the real runMigrations path (not a hand-reproduced schema), has
// a queryable notes column that round-trips an actual value, not just a
// column that exists with nothing provable about its contents.
describe('expected_parts.notes across a fresh database (T2)', () => {
  it('a genuinely fresh database created via the full runMigrations path has a queryable notes column on expected_parts that round-trips a value', async () => {
    const freshDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-db-test-fresh-notes-'));
    try {
      const instance = await DuckDBInstance.create(path.join(freshDir, 'pc-parts-flipper.duckdb'));
      const connection = await instance.connect();

      // The real migration path a brand-new database goes through — no
      // pre-existing state at all.
      await runMigrations(connection);

      await connection.run(
        `INSERT INTO sources (id, name, platform_type) VALUES ('11111111-1111-1111-1111-111111111111', 'x', 'other')`,
      );
      await connection.run(
        `INSERT INTO listings (id, source_id, title, asking_price, listing_date, photo_paths)
         VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'x', 5, '2024-01-01', '[]')`,
      );
      // Bypasses the query-function layer entirely (raw SQL against the
      // freshly-migrated connection), same as this file's other fresh-DB
      // proofs above, so what fails here is schema.ts/migrate.ts's own
      // column lists, not anything query-layer code could paper over.
      await connection.run(
        `INSERT INTO expected_parts (id, listing_id, component_category, description, estimated_resale_value, notes)
         VALUES ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'CPU', 'fresh db notes check', NULL, 'missing a screw')`,
      );

      const row = await connection.runAndReadAll(
        `SELECT notes FROM expected_parts WHERE id = '33333333-3333-3333-3333-333333333333'`,
      );
      expect(row.getRowObjectsJson()).toEqual([{ notes: 'missing a screw' }]);

      connection.closeSync();
      instance.closeSync();
    } finally {
      await rm(freshDir, { recursive: true, force: true });
    }
  });
});

// T1 proof (Req 3): the UNIQUE index on listings(source_id, external_item_id)
// is what makes "re-running the same scan never creates a second Listing
// for the same eBay item" true at the database layer, independent of
// whatever de-dup check the scan service (T6) performs first.
describe('UNIQUE index on listings(source_id, external_item_id) de-dupes eBay-scanned listings', () => {
  it('allows multiple NULL external_item_id rows for the same Source (manually-entered listings)', async () => {
    const source = await db.createSource({
      name: 'Local FB group',
      platformType: 'facebook_marketplace',
      url: null,
      notes: null,
    });
    const first = await db.createListing({
      sourceId: source.id,
      title: 'Manual listing 1',
      description: null,
      listingUrl: null,
      askingPrice: 10,
      listingDate: '2024-05-01',
      acquisitionFees: 0,
      photoPaths: [],
    });
    const second = await db.createListing({
      sourceId: source.id,
      title: 'Manual listing 2',
      description: null,
      listingUrl: null,
      askingPrice: 20,
      listingDate: '2024-05-02',
      acquisitionFees: 0,
      photoPaths: [],
    });
    expect(first.externalItemId).toBeNull();
    expect(second.externalItemId).toBeNull();
    expect(first.id).not.toBe(second.id);
  });

  it('rejects a second Listing with the same (source_id, external_item_id) — re-running a scan never double-creates (Req 3)', async () => {
    const source = await db.createSource({ name: 'eBay search', platformType: 'ebay', url: null, notes: null });
    await db.createListing({
      sourceId: source.id,
      title: 'eBay item v123',
      description: null,
      listingUrl: null,
      askingPrice: 30,
      listingDate: '2024-05-03',
      acquisitionFees: 0,
      photoPaths: [],
      externalSource: 'ebay',
      externalItemId: 'v1|123456789012',
    });

    // Second insert, same Source + same eBay item id — only the UNIQUE
    // index stands between this and a duplicate scan-created Listing.
    await expect(
      db.createListing({
        sourceId: source.id,
        title: 'eBay item v123 (duplicate scan insert)',
        description: null,
        listingUrl: null,
        askingPrice: 30,
        listingDate: '2024-05-03',
        acquisitionFees: 0,
        photoPaths: [],
        externalSource: 'ebay',
        externalItemId: 'v1|123456789012',
      }),
    ).rejects.toThrow();
  });

  it('allows the same external_item_id across two different Sources (the index is composite, not external_item_id alone)', async () => {
    const sourceA = await db.createSource({ name: 'eBay search A', platformType: 'ebay', url: null, notes: null });
    const sourceB = await db.createSource({ name: 'eBay search B', platformType: 'ebay', url: null, notes: null });
    const listingA = await db.createListing({
      sourceId: sourceA.id,
      title: 'item from search A',
      description: null,
      listingUrl: null,
      askingPrice: 30,
      listingDate: '2024-05-04',
      acquisitionFees: 0,
      photoPaths: [],
      externalSource: 'ebay',
      externalItemId: 'v1|shared-item',
    });
    const listingB = await db.createListing({
      sourceId: sourceB.id,
      title: 'item from search B',
      description: null,
      listingUrl: null,
      askingPrice: 30,
      listingDate: '2024-05-04',
      acquisitionFees: 0,
      photoPaths: [],
      externalSource: 'ebay',
      externalItemId: 'v1|shared-item',
    });
    expect(listingA.id).not.toBe(listingB.id);
  });
});
describe('query functions round-trip data through the full lifecycle', () => {
  it('createSource/getSourceById/listSources/updateSource round-trip', async () => {
    const source = await db.createSource({
      name: 'Local FB group',
      platformType: 'facebook_marketplace',
      url: 'https://facebook.com/groups/x',
      notes: 'cash only',
    });
    expect(source.id).toBeTruthy();
    expect(source.active).toBe(true);

    const fetched = await db.getSourceById(source.id);
    expect(fetched).toEqual(source);

    const all = await db.listSources({ activeOnly: true });
    expect(all.some((s) => s.id === source.id)).toBe(true);

    const deactivated = await db.updateSource(source.id, { active: false });
    expect(deactivated?.active).toBe(false);
    const stillInActiveOnly = await db.listSources({ activeOnly: true });
    expect(stillInActiveOnly.some((s) => s.id === source.id)).toBe(false);
  });

  it('runs the full Listing -> ExpectedPart -> Purchase -> TeardownResult -> Part -> SaleListing -> Sale chain', async () => {
    const source = await db.createSource({
      name: 'eBay search',
      platformType: 'ebay',
      url: null,
      notes: null,
    });

    const listing = await db.createListing({
      sourceId: source.id,
      title: 'Dell OptiPlex bundle',
      description: 'Untested bundle of 3',
      listingUrl: 'https://ebay.com/itm/123',
      askingPrice: 150,
      listingDate: '2024-03-01',
      acquisitionFees: 12.5,
      photoPaths: ['/data/photos/a.jpg', '/data/photos/b.jpg'],
    });
    expect(listing.status).toBe('open');
    expect(listing.photoPaths).toEqual(['/data/photos/a.jpg', '/data/photos/b.jpg']);
    const fetchedListing = await db.getListingById(listing.id);
    expect(fetchedListing).toEqual(listing);

    const expectedPart = await db.createExpectedPart({
      listingId: listing.id,
      componentCategory: 'CPU',
      brand: 'Intel',
      partNumber: 'i5-8500',
      description: 'Pulled from a working machine',
      estimatedResaleValue: 60,
      identityCandidates: [],
      aiConfidence: null,
      aiSource: null,
    });
    expect(expectedPart.estimatedResaleValue).toBe(60);
    // An empty identityCandidates input must persist and round-trip as `[]`
    // (not null/undefined) — the degenerate case of the same
    // JSON.stringify/JSON.parse mechanism the non-empty-array tests below
    // exercise with real candidate data.
    expect(expectedPart.identityCandidates).toEqual([]);
    // brand/partNumber must survive the INSERT ... RETURNING round-trip, not
    // just be echoed back from the input object.
    expect(expectedPart.brand).toBe('Intel');
    expect(expectedPart.partNumber).toBe('i5-8500');
    const expectedParts = await db.listExpectedPartsByListing(listing.id);
    expect(expectedParts).toEqual([expectedPart]);

    const purchase = await db.createPurchase({
      listingId: listing.id,
      pricePaid: 150,
      purchaseDate: '2024-03-02',
    });
    expect(purchase.status).toBe('ordered');
    const fetchedPurchase = await db.getPurchaseById(purchase.id);
    expect(fetchedPurchase).toEqual(purchase);

    const teardownResult = await db.createTeardownResult({
      purchaseId: purchase.id,
      expectedPartId: expectedPart.id,
      result: 'present_as_expected',
      note: null,
    });
    expect(teardownResult.result).toBe('present_as_expected');
    const teardownResults = await db.listTeardownResultsByPurchase(purchase.id);
    expect(teardownResults).toEqual([teardownResult]);

    const part = await db.createPart({
      purchaseId: purchase.id,
      category: 'CPU',
      brand: 'Intel',
      partNumber: 'i5-8500',
      description: 'Pulled, tested working',
      identityCandidates: [],
    });
    expect(part.status).toBe('ready_to_list');
    // Same empty-array round-trip guarantee as expectedPart above, now for
    // the parts table's identity_candidates column.
    expect(part.identityCandidates).toEqual([]);
    expect(part.brand).toBe('Intel');
    expect(part.partNumber).toBe('i5-8500');
    const fetchedPart = await db.getPartById(part.id);
    // A separate SELECT, so this proves the columns were persisted rather
    // than only present on the RETURNING row.
    expect(fetchedPart).toEqual(part);
    expect(fetchedPart?.brand).toBe('Intel');
    expect(fetchedPart?.partNumber).toBe('i5-8500');

    const saleListing = await db.createSaleListing({
      partId: part.id,
      platform: 'ebay',
      title: 'Intel i5-8500 CPU',
      description: 'Pulled, tested working',
      askingPrice: 55,
    });
    expect(saleListing.listedAt).toBeNull();
    const fetchedSaleListing = await db.getSaleListingById(saleListing.id);
    expect(fetchedSaleListing).toEqual(saleListing);

    const sale = await db.createSale({
      partId: part.id,
      soldPrice: 52,
      soldDate: '2024-03-10',
      platformFee: 3.25,
      shippingCost: 5,
      buyerNote: 'ship fast please',
    });
    expect(sale.soldPrice).toBe(52);
    const fetchedSale = await db.getSaleByPartId(part.id);
    expect(fetchedSale).toEqual(sale);

    // Proves createSale's real, corrected contract directly: calling it
    // alone does NOT move the Part to 'sold' (it only inserts the sales
    // row) — the stale comment this task fixes used to claim otherwise.
    const partAfterSaleAlone = await db.getPartById(part.id);
    expect(partAfterSaleAlone?.status).toBe('ready_to_list');

    // createSale only inserts the sales row (Req 9's "Moves Part to sold" is
    // a cross-table transition the route layer composes, consistent with
    // every other lifecycle move in this module — e.g. accepting a Listing
    // or submitting a teardown — none of which are done inside a single
    // queries/*.ts function here). Modelling that same caller-driven
    // transition explicitly before checking the profit rollup below.
    const soldPart = await db.updatePart(part.id, { status: 'sold' });
    expect(soldPart?.status).toBe('sold');
    // Req 10: the per-Purchase profit rollup must reflect the single Sale
    // just recorded above — the one assertion in this chain that exercises
    // the read-only aggregation query, not just single-row create/get.
    const profitRows = await db.listProfitByPurchase({});
    const thisPurchaseProfit = profitRows.find((p) => p.purchaseId === purchase.id);
    expect(thisPurchaseProfit?.saleRevenue).toBe(52);
    expect(thisPurchaseProfit?.feesAndShipping).toBe(8.25);
    expect(thisPurchaseProfit?.netProfit).toBe(52 - 8.25 - 150);
    expect(thisPurchaseProfit?.isFinal).toBe(true);
  });
});

// MUST FIX (cycle 0 retry 1) proof: a non-atomic read-then-write route
// guard (e.g. "is this Part still 'listed'?" checked, then createSale
// called) can't itself prevent two concurrent requests from both passing
// the check and both inserting. These UNIQUE constraints are the
// database-level backstop that makes a duplicate impossible regardless of
// what the route layer checked first, protecting the Req 10 profit rollup
// from double-counting.
describe('UNIQUE constraints back the database-level routing guards', () => {
  it('rejects a second Sale for the same Part (sales(part_id) UNIQUE)', async () => {
    const source = await db.createSource({ name: 'eBay search', platformType: 'ebay', url: null, notes: null });
    const listing = await db.createListing({
      sourceId: source.id,
      title: 'Dell OptiPlex bundle',
      description: null,
      listingUrl: null,
      askingPrice: 100,
      listingDate: '2024-04-01',
      acquisitionFees: 0,
      photoPaths: [],
    });
    const purchase = await db.createPurchase({ listingId: listing.id, pricePaid: 100, purchaseDate: '2024-04-02' });
    const part = await db.createPart({ purchaseId: purchase.id, category: 'CPU', brand: null, partNumber: null, description: 'i5-8500', identityCandidates: [] });

    await db.createSale({
      partId: part.id,
      soldPrice: 50,
      soldDate: '2024-04-10',
      platformFee: 1,
      shippingCost: 1,
      buyerNote: null,
    });
    // Second Sale for the identical Part — only the UNIQUE constraint on
    // sales(part_id) stands between this and a duplicate revenue row.
    await expect(
      db.createSale({
        partId: part.id,
        soldPrice: 60,
        soldDate: '2024-04-11',
        platformFee: 1,
        shippingCost: 1,
        buyerNote: null,
      }),
    ).rejects.toThrow();
  });

  it('rejects a second TeardownResult for the same (purchaseId, expectedPartId), but allows multiple null-expectedPartId rows for the same purchase', async () => {
    const source = await db.createSource({ name: 'eBay search', platformType: 'ebay', url: null, notes: null });
    const listing = await db.createListing({
      sourceId: source.id,
      title: 'Dell OptiPlex bundle',
      description: null,
      listingUrl: null,
      askingPrice: 100,
      listingDate: '2024-04-01',
      acquisitionFees: 0,
      photoPaths: [],
    });
    const expectedPart = await db.createExpectedPart({
      listingId: listing.id,
      componentCategory: 'CPU',
      brand: null,
      partNumber: null,
      description: 'i5-8500',
      estimatedResaleValue: 60,
      identityCandidates: [],
      aiConfidence: null,
      aiSource: null,
    });
    const purchase = await db.createPurchase({ listingId: listing.id, pricePaid: 100, purchaseDate: '2024-04-02' });

    await db.createTeardownResult({
      purchaseId: purchase.id,
      expectedPartId: expectedPart.id,
      result: 'present_as_expected',
      note: null,
    });
    // Same Purchase + same Expected Part a second time — only the UNIQUE
    // constraint on teardown_results(purchase_id, expected_part_id) stands
    // between this and a duplicate reconciliation row.
    await expect(
      db.createTeardownResult({
        purchaseId: purchase.id,
        expectedPartId: expectedPart.id,
        result: 'present_as_expected',
        note: null,
      }),
    ).rejects.toThrow();

    // Two 'additional' rows (expectedPartId: null) for the SAME Purchase
    // must both succeed: DuckDB treats each NULL as distinct from every
    // other NULL for uniqueness, so the constraint above never blocks
    // legitimate additional-Part finds.
    const additionalOne = await db.createTeardownResult({
      purchaseId: purchase.id,
      expectedPartId: null,
      result: 'additional',
      note: 'bonus RAM stick',
    });
    const additionalTwo = await db.createTeardownResult({
      purchaseId: purchase.id,
      expectedPartId: null,
      result: 'additional',
      note: 'bonus cable',
    });
    expect(additionalOne.id).not.toBe(additionalTwo.id);
    const results = await db.listTeardownResultsByPurchase(purchase.id);
    expect(results.filter((r) => r.expectedPartId === null)).toHaveLength(2);
  });
});

describe('Expected Part brand/part number', () => {
  // Seeds the minimum chain (source -> listing) an Expected Part needs.
  async function seedListing(): Promise<string> {
    const source = await db.createSource({ name: 'eBay search', platformType: 'ebay', url: null, notes: null });
    const listing = await db.createListing({
      sourceId: source.id,
      title: 'Dell OptiPlex bundle',
      description: null,
      listingUrl: null,
      askingPrice: 100,
      listingDate: '2024-05-01',
      acquisitionFees: 0,
      photoPaths: [],
    });
    return listing.id;
  }

  it('stores null for an unidentified component rather than inventing a placeholder', async () => {
    const listingId = await seedListing();
    const created = await db.createExpectedPart({
      listingId,
      componentCategory: 'RAM',
      brand: null,
      partNumber: null,
      description: 'Two DDR4 DIMMs, capacity not legible',
      estimatedResaleValue: 30,
      identityCandidates: [],
      aiConfidence: null,
      aiSource: null,
    });
    const fetched = await db.getExpectedPartById(created.id);
    expect(fetched?.brand).toBeNull();
    expect(fetched?.partNumber).toBeNull();
  });

  it('applies brand/partNumber through updateExpectedPart, and clears them again on an explicit null', async () => {
    const listingId = await seedListing();
    const created = await db.createExpectedPart({
      listingId,
      componentCategory: 'GPU',
      brand: null,
      partNumber: null,
      description: 'Unidentified card',
      estimatedResaleValue: 150,
      identityCandidates: [],
      aiConfidence: null,
      aiSource: null,
    });

    // Filling the fields in later is the real editing flow: a part the user
    // identifies after the listing was first captured.
    const identified = await db.updateExpectedPart(created.id, { brand: 'NVIDIA', partNumber: 'RTX 3060' });
    expect(identified?.brand).toBe('NVIDIA');
    expect(identified?.partNumber).toBe('RTX 3060');

    // An omitted key must leave the column untouched (buildSetClause's
    // undefined contract), while an explicit null must clear it — the two
    // directions are different code paths and a test of only one proves
    // nothing about the other.
    const descriptionOnly = await db.updateExpectedPart(created.id, { description: 'Now identified' });
    expect(descriptionOnly?.brand).toBe('NVIDIA');
    expect(descriptionOnly?.partNumber).toBe('RTX 3060');

    const cleared = await db.updateExpectedPart(created.id, { brand: null, partNumber: null });
    expect(cleared?.brand).toBeNull();
    expect(cleared?.partNumber).toBeNull();
  });
});

// T1 proof (ebay-condition-filter feature, Req 4-6): Listing.nonWorking and
// ExpectedPart.workingStatus both round-trip through the real query
// functions with their documented defaults — false/'working' when the
// caller omits the field entirely, and the explicit value when the caller
// supplies one. Every assertion reads back through a fresh SELECT
// (getListingById/getExpectedPartById), not just the INSERT ... RETURNING
// row, so a column present only on that row (and not actually persisted)
// would not pass.
describe('Listing nonWorking / Expected Part workingStatus (T1)', () => {
  async function seedSource(): Promise<string> {
    const source = await db.createSource({ name: 'eBay search', platformType: 'ebay', url: null, notes: null });
    return source.id;
  }

  it('createListing with nonWorking omitted comes back false; explicit true round-trips through a fresh SELECT', async () => {
    const sourceId = await seedSource();
    const omitted = await db.createListing({
      sourceId,
      title: 'Omitted nonWorking',
      description: null,
      listingUrl: null,
      askingPrice: 50,
      listingDate: '2024-06-01',
      acquisitionFees: 0,
      photoPaths: [],
    });
    expect(omitted.nonWorking).toBe(false);
    const fetchedOmitted = await db.getListingById(omitted.id);
    expect(fetchedOmitted?.nonWorking).toBe(false);

    const flagged = await db.createListing({
      sourceId,
      title: 'For Parts or Not Working bundle',
      description: null,
      listingUrl: null,
      askingPrice: 40,
      listingDate: '2024-06-02',
      acquisitionFees: 0,
      photoPaths: [],
      nonWorking: true,
    });
    expect(flagged.nonWorking).toBe(true);
    const fetchedFlagged = await db.getListingById(flagged.id);
    expect(fetchedFlagged?.nonWorking).toBe(true);
  });

  it("createExpectedPart with workingStatus omitted comes back the DB default 'working' (never null); explicit 'non_working' round-trips through mapRow", async () => {
    const sourceId = await seedSource();
    const listing = await db.createListing({
      sourceId,
      title: 'Working status rig',
      description: null,
      listingUrl: null,
      askingPrice: 100,
      listingDate: '2024-06-03',
      acquisitionFees: 0,
      photoPaths: [],
    });

    const omitted = await db.createExpectedPart({
      listingId: listing.id,
      componentCategory: 'GPU',
      brand: null,
      partNumber: null,
      description: 'omitted workingStatus',
      estimatedResaleValue: null,
      identityCandidates: [],
      aiConfidence: null,
      aiSource: null,
    });
    expect(omitted.workingStatus).toBe('working');
    const fetchedOmitted = await db.getExpectedPartById(omitted.id);
    expect(fetchedOmitted?.workingStatus).toBe('working');

    const nonWorking = await db.createExpectedPart({
      listingId: listing.id,
      componentCategory: 'CPU',
      brand: null,
      partNumber: null,
      description: 'explicit non_working',
      estimatedResaleValue: null,
      identityCandidates: [],
      aiConfidence: null,
      aiSource: null,
      workingStatus: 'non_working',
    });
    expect(nonWorking.workingStatus).toBe('non_working');
    const fetchedNonWorking = await db.getExpectedPartById(nonWorking.id);
    expect(fetchedNonWorking?.workingStatus).toBe('non_working');
  });
});

// T2 proof: identity_candidates (apps/server/src/db/queries/expectedParts.ts,
// queries/parts.ts) round-trips a non-empty IdentityCandidate[] through
// create/update/read on both tables, and is actually present in
// listPartsWithContext/getPartWithContextById's explicit SELECT column list
// — not just on mapRow's shape, which a dropped SELECT column would not
// catch (JSON.parse(undefined) throws rather than silently returning []).
describe('identity_candidates round-trips through expected_parts and parts (T2)', () => {
  const candidates = [
    { brand: 'NVIDIA', partNumber: 'RTX 3070' },
    { brand: 'NVIDIA', partNumber: 'RTX 3080' },
  ];

  // Seeds the minimum chain (source -> listing) an Expected Part needs.
  async function seedListing(): Promise<string> {
    const source = await db.createSource({ name: 'eBay search', platformType: 'ebay', url: null, notes: null });
    const listing = await db.createListing({
      sourceId: source.id,
      title: 'Dell OptiPlex bundle',
      description: null,
      listingUrl: null,
      askingPrice: 100,
      listingDate: '2024-05-01',
      acquisitionFees: 0,
      photoPaths: [],
    });
    return listing.id;
  }

  it('createExpectedPart stores a non-empty identityCandidates array and mapRow parses it back out on a fresh SELECT', async () => {
    const listingId = await seedListing();
    const created = await db.createExpectedPart({
      listingId,
      componentCategory: 'GPU',
      brand: null,
      partNumber: null,
      description: 'Ambiguous GPU, two plausible SKUs',
      estimatedResaleValue: 200,
      identityCandidates: candidates,
      aiConfidence: null,
      aiSource: null,
    });
    expect(created.identityCandidates).toEqual(candidates);

    // Separate SELECT (not the INSERT ... RETURNING row), so this proves
    // the JSON.stringify'd value was actually persisted as text and
    // JSON.parse'd back into the same structure, not merely echoed.
    const fetched = await db.getExpectedPartById(created.id);
    expect(fetched?.identityCandidates).toEqual(candidates);
  });

  it('updateExpectedPart persists an updated identityCandidates array through its set-clause branch', async () => {
    const listingId = await seedListing();
    const created = await db.createExpectedPart({
      listingId,
      componentCategory: 'GPU',
      brand: null,
      partNumber: null,
      description: 'Ambiguous GPU',
      estimatedResaleValue: 200,
      identityCandidates: [{ brand: 'AMD', partNumber: 'RX 6700' }],
      aiConfidence: null,
      aiSource: null,
    });

    const updated = await db.updateExpectedPart(created.id, { identityCandidates: candidates });
    expect(updated?.identityCandidates).toEqual(candidates);

    // An omitted key must leave the column untouched (buildSetClause's
    // undefined contract) — proves identityCandidates participates in that
    // same undefined-vs-explicit-value branch as brand/partNumber above,
    // rather than always being overwritten.
    const untouched = await db.updateExpectedPart(created.id, { description: 'Still ambiguous' });
    expect(untouched?.identityCandidates).toEqual(candidates);
  });

  it('createPart stores a non-empty identityCandidates array and mapRow parses it back out on a fresh SELECT', async () => {
    const source = await db.createSource({ name: 'eBay search', platformType: 'ebay', url: null, notes: null });
    const listing = await db.createListing({
      sourceId: source.id,
      title: 'Dell OptiPlex bundle',
      description: null,
      listingUrl: null,
      askingPrice: 100,
      listingDate: '2024-05-01',
      acquisitionFees: 0,
      photoPaths: [],
    });
    const purchase = await db.createPurchase({ listingId: listing.id, pricePaid: 100, purchaseDate: '2024-05-02' });
    const created = await db.createPart({
      purchaseId: purchase.id,
      category: 'GPU',
      brand: null,
      partNumber: null,
      description: 'Carried over from an ambiguous Expected Part',
      identityCandidates: candidates,
    });
    expect(created.identityCandidates).toEqual(candidates);

    const fetched = await db.getPartById(created.id);
    expect(fetched?.identityCandidates).toEqual(candidates);

    // listPartsWithContext/getPartWithContextById use their own explicit
    // SELECT column list (not `SELECT *`) — proving identityCandidates
    // comes back through both proves `pt.identity_candidates,` is actually
    // present in that list, not just that mapRow knows the field.
    const withContext = await db.getPartWithContextById(created.id);
    expect(withContext?.identityCandidates).toEqual(candidates);

    const listed = await db.listPartsWithContext({ purchaseId: purchase.id });
    expect(listed.find((p) => p.id === created.id)?.identityCandidates).toEqual(candidates);
  });
});

// T2 proof: notes (apps/server/src/db/queries/expectedParts.ts) round-trips
// through create/update/read, with the same three-state discipline every
// other optional Expected Part column in this file already proves:
// non-null stays exactly as written, omitted comes back database-null (not
// '' and not undefined), and updating it through updateExpectedPart's
// buildSetClause branch touches nothing else on the row.
describe('Expected Part notes (T2)', () => {
  // Seeds the minimum chain (source -> listing) an Expected Part needs.
  async function seedListing(): Promise<string> {
    const source = await db.createSource({ name: 'eBay search', platformType: 'ebay', url: null, notes: null });
    const listing = await db.createListing({
      sourceId: source.id,
      title: 'Dell OptiPlex bundle',
      description: null,
      listingUrl: null,
      askingPrice: 100,
      listingDate: '2024-05-01',
      acquisitionFees: 0,
      photoPaths: [],
    });
    return listing.id;
  }

  it('createExpectedPart stores a non-null notes value and getExpectedPartById reads it back unchanged', async () => {
    const listingId = await seedListing();
    const created = await db.createExpectedPart({
      listingId,
      componentCategory: 'PSU',
      brand: null,
      partNumber: null,
      description: 'Bronze-rated unit, condition unclear',
      estimatedResaleValue: 25,
      identityCandidates: [],
      aiConfidence: null,
      aiSource: null,
      notes: 'missing mounting screws',
    });
    expect(created.notes).toBe('missing mounting screws');

    // Separate SELECT (not the INSERT ... RETURNING row), so this proves
    // the value was actually persisted, not merely echoed back.
    const fetched = await db.getExpectedPartById(created.id);
    expect(fetched?.notes).toBe('missing mounting screws');
  });

  it('createExpectedPart with notes omitted reads back database-null, not an empty string or undefined', async () => {
    const listingId = await seedListing();
    const created = await db.createExpectedPart({
      listingId,
      componentCategory: 'Cooler',
      brand: null,
      partNumber: null,
      description: 'Omitted notes',
      estimatedResaleValue: 10,
      identityCandidates: [],
      aiConfidence: null,
      aiSource: null,
    });
    expect(created.notes).toBeNull();
    expect(created.notes).not.toBe('');

    const fetched = await db.getExpectedPartById(created.id);
    expect(fetched?.notes).toBeNull();
    expect(fetched?.notes).not.toBe('');
  });

  it('updateExpectedPart updates only notes, leaving every other field on the row unchanged', async () => {
    const listingId = await seedListing();
    const created = await db.createExpectedPart({
      listingId,
      componentCategory: 'GPU',
      brand: 'NVIDIA',
      partNumber: 'RTX 3060',
      description: 'Known-good card',
      estimatedResaleValue: 220,
      identityCandidates: [{ brand: 'NVIDIA', partNumber: 'RTX 3060 Ti' }],
      aiConfidence: 'high',
      aiSource: 'image',
      priceSource: 'manual',
      workingStatus: 'non_working',
      notes: 'original note',
    });

    const updated = await db.updateExpectedPart(created.id, { notes: 'fan rattles on startup' });
    expect(updated?.notes).toBe('fan rattles on startup');
    expect(updated?.componentCategory).toBe('GPU');
    expect(updated?.brand).toBe('NVIDIA');
    expect(updated?.partNumber).toBe('RTX 3060');
    expect(updated?.description).toBe('Known-good card');
    expect(updated?.estimatedResaleValue).toBe(220);
    expect(updated?.identityCandidates).toEqual([{ brand: 'NVIDIA', partNumber: 'RTX 3060 Ti' }]);
    expect(updated?.aiConfidence).toBe('high');
    expect(updated?.aiSource).toBe('image');
    expect(updated?.priceSource).toBe('manual');
    expect(updated?.workingStatus).toBe('non_working');

    // An omitted notes key must leave the column untouched (buildSetClause's
    // undefined contract) — proves notes participates in the same
    // undefined-vs-explicit-value branch as brand/partNumber/
    // identityCandidates above, rather than always being overwritten.
    const untouched = await db.updateExpectedPart(created.id, { description: 'Still known-good' });
    expect(untouched?.notes).toBe('fan rattles on startup');
  });
});

// T2 proof (marketplace-sources feature): migratePlatformTypeAddMercari
// (migrate.ts, private/unexported) rebuilds the full ten-table FK subtree
// rooted at `sources` to add 'mercari' to the platform_type enum. Proves,
// against the realistic upgrade scenario (a database that already applied
// every statement in schema.ts except this feature's own enum literal —
// built by hand below, the same way the T1 upgrade scenario above does,
// since the rebuild helper itself is private), that every row across that
// subtree survives the backup/drop/recreate/restore cycle byte-for-byte,
// and that a second run is a true no-op (not just one that happens to
// preserve the same data a second time) via a console.log spy on the
// rebuild's own completion message.
describe('migratePlatformTypeAddMercari preserves and no-ops across the full sources FK subtree (T2)', () => {
  it('rebuilds platform_type with mercari, preserves every row byte-for-byte, and a second run never re-executes the rebuild', async () => {
    const upgradeDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-db-test-mercari-'));
    try {
      const instance = await DuckDBInstance.create(path.join(upgradeDir, 'pc-parts-flipper.duckdb'));
      const connection = await instance.connect();

      // Replicates the exact pre-feature schema end-state: every statement
      // runMigrations runs today, except platform_type is built without
      // 'mercari' — the real-world shape of a production database that
      // already applied every past migration, immediately before this one
      // ships.
      await connection.run(`CREATE TYPE platform_type AS ENUM ('ebay', 'facebook_marketplace', 'other')`);
      for (const statement of [...ENUM_STATEMENTS.slice(1), ...TABLE_STATEMENTS, ...ALTER_STATEMENTS]) {
        await connection.run(statement);
      }
      // Hand-reproduces migrateExpectedPartsNullablePrice's rebuild (private,
      // unexported) so expected_parts already carries its post-rebuild
      // nullable column and every later ALTER_STATEMENTS column, matching a
      // real already-migrated production database rather than a brand-new
      // one.
      await connection.run(`CREATE TABLE expected_parts_new (
        id UUID PRIMARY KEY, listing_id UUID NOT NULL REFERENCES listings(id), component_category component_category NOT NULL,
        description VARCHAR NOT NULL, estimated_resale_value DECIMAL(10, 2) CHECK (estimated_resale_value >= 0),
        created_at TIMESTAMP NOT NULL DEFAULT current_timestamp, updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        brand VARCHAR, part_number VARCHAR, identity_candidates VARCHAR DEFAULT '[]', ai_confidence VARCHAR, ai_source VARCHAR, price_source VARCHAR,
        working_status VARCHAR DEFAULT 'working', notes VARCHAR
      )`);
      await connection.run(`INSERT INTO expected_parts_new (id, listing_id, component_category, description, estimated_resale_value, created_at, updated_at, brand, part_number, identity_candidates, ai_confidence, ai_source, price_source, working_status, notes)
        SELECT id, listing_id, component_category, description, estimated_resale_value, created_at, updated_at, brand, part_number, identity_candidates, ai_confidence, ai_source, price_source, working_status, notes FROM expected_parts`);
      await connection.run(`CREATE TABLE teardown_results_backup (id UUID, purchase_id UUID, expected_part_id UUID, result VARCHAR, note VARCHAR, created_at TIMESTAMP, updated_at TIMESTAMP)`);
      await connection.run(`INSERT INTO teardown_results_backup SELECT id, purchase_id, expected_part_id, result, note, created_at, updated_at FROM teardown_results`);
      await connection.run(`DROP TABLE teardown_results`);
      await connection.run(`DROP TABLE expected_parts`);
      await connection.run(`ALTER TABLE expected_parts_new RENAME TO expected_parts`);
      await connection.run(`CREATE TABLE teardown_results (
        id UUID PRIMARY KEY, purchase_id UUID NOT NULL REFERENCES purchases(id), expected_part_id UUID REFERENCES expected_parts(id),
        result teardown_result_type NOT NULL, note VARCHAR, created_at TIMESTAMP NOT NULL DEFAULT current_timestamp, updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        UNIQUE (purchase_id, expected_part_id))`);
      await connection.run(`INSERT INTO teardown_results SELECT id, purchase_id, expected_part_id, result, note, created_at, updated_at FROM teardown_results_backup`);
      await connection.run(`DROP TABLE teardown_results_backup`);
      for (const statement of INDEX_STATEMENTS) {
        await connection.run(statement);
      }

      // Seeds one row per table across the full FK subtree rooted at
      // `sources` (sources, listings, part_reference_photos, expected_parts,
      // purchases, teardown_results, parts, sale_listings, sales,
      // identify_parts_jobs) — every table migratePlatformTypeAddMercari
      // backs up and restores. Every column, including timestamps, is an
      // explicit fixed literal so the before/after comparison below is
      // deterministic rather than racing DEFAULT current_timestamp.
      await connection.run(`INSERT INTO sources (id, name, platform_type, url, notes, active, created_at, updated_at, connector_config, last_scanned_at, last_scan_found_count)
        VALUES ('11111111-1111-1111-1111-111111111111', 'eBay store', 'ebay', 'https://example.com', 'a note', true, '2024-01-01 00:00:00', '2024-01-02 00:00:00', '{"queries":["gpu"]}', '2024-01-03 00:00:00', 5)`);
      await connection.run(`INSERT INTO listings (id, source_id, title, description, listing_url, asking_price, listing_date, status, acquisition_fees, photo_paths, created_at, updated_at, external_source, external_item_id, non_working)
        VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'RTX 3060', 'a gpu', 'https://example.com/item', 150.00, '2024-01-01', 'open', 5.00, '["a.jpg"]', '2024-01-01 00:00:00', '2024-01-02 00:00:00', 'ebay', 'EB123', false)`);
      await connection.run(`INSERT INTO part_reference_photos (id, category, brand, part_number, photo_path, source, listing_id, created_at)
        VALUES ('33333333-3333-3333-3333-333333333333', 'GPU', 'NVIDIA', 'RTX 3060', '/ref/photo.jpg', 'manual', '22222222-2222-2222-2222-222222222222', '2024-01-01 00:00:00')`);
      await connection.run(`INSERT INTO expected_parts (id, listing_id, component_category, description, estimated_resale_value, created_at, updated_at, brand, part_number, identity_candidates, ai_confidence, ai_source, price_source, working_status, notes)
        VALUES ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'GPU', 'a gpu card', 220.00, '2024-01-01 00:00:00', '2024-01-02 00:00:00', 'NVIDIA', 'RTX 3060', '[{"brand":"NVIDIA","partNumber":"RTX 3060 Ti"}]', 'high', 'image', 'manual', 'working', 'a note')`);
      await connection.run(`INSERT INTO purchases (id, listing_id, status, price_paid, purchase_date, created_at, updated_at)
        VALUES ('55555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', 'received', 150.00, '2024-01-03', '2024-01-01 00:00:00', '2024-01-02 00:00:00')`);
      await connection.run(`INSERT INTO teardown_results (id, purchase_id, expected_part_id, result, note, created_at, updated_at)
        VALUES ('66666666-6666-6666-6666-666666666666', '55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 'present_as_expected', 'matches listing', '2024-01-01 00:00:00', '2024-01-02 00:00:00')`);
      await connection.run(`INSERT INTO parts (id, purchase_id, category, description, status, unsellable_reason, created_at, updated_at, brand, part_number, identity_candidates)
        VALUES ('77777777-7777-7777-7777-777777777777', '55555555-5555-5555-5555-555555555555', 'GPU', 'a gpu part', 'listed', NULL, '2024-01-01 00:00:00', '2024-01-02 00:00:00', 'NVIDIA', 'RTX 3060', '[]')`);
      await connection.run(`INSERT INTO sale_listings (id, part_id, platform, title, description, asking_price, listed_at, created_at, updated_at)
        VALUES ('88888888-8888-8888-8888-888888888888', '77777777-7777-7777-7777-777777777777', 'ebay', 'RTX 3060 for sale', 'a gpu', 250.00, '2024-01-04 00:00:00', '2024-01-01 00:00:00', '2024-01-02 00:00:00')`);
      await connection.run(`INSERT INTO sales (id, part_id, sold_price, sold_date, platform_fee, shipping_cost, buyer_note, created_at, updated_at)
        VALUES ('99999999-9999-9999-9999-999999999999', '77777777-7777-7777-7777-777777777777', 240.00, '2024-01-05', 10.00, 8.00, 'thanks', '2024-01-01 00:00:00', '2024-01-02 00:00:00')`);
      await connection.run(`INSERT INTO identify_parts_jobs (id, listing_id, stage, result, error_message, delivered, created_at, started_at, completed_at, updated_at)
        VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'completed', '{"parts":[]}', NULL, true, '2024-01-01 00:00:00', '2024-01-01 00:01:00', '2024-01-01 00:02:00', '2024-01-02 00:00:00')`);

      const SUBTREE_TABLES = [
        'sources', 'listings', 'part_reference_photos', 'expected_parts', 'purchases',
        'teardown_results', 'parts', 'sale_listings', 'sales', 'identify_parts_jobs',
      ];
      const snapshot = async () => {
        const tables: Record<string, unknown> = {};
        for (const table of SUBTREE_TABLES) {
          const reader = await connection.runAndReadAll(`SELECT * FROM ${table} ORDER BY id`);
          tables[table] = reader.getRowObjectsJson();
        }
        return tables;
      };

      const beforeFirstRun = await snapshot();
      expect(beforeFirstRun.sources, 'the seed row must actually be present before the migration runs').toHaveLength(1);

      // The real upgrade path a live server performs on its next boot after
      // this feature ships — never a direct call to the private
      // migratePlatformTypeAddMercari function.
      await runMigrations(connection);

      const hasMercariAfterFirstRun = await connection.runAndReadAll(
        `SELECT list_contains(enum_range(NULL::platform_type), 'mercari') AS has_mercari`,
      );
      expect(hasMercariAfterFirstRun.getRowObjectsJson()).toEqual([{ has_mercari: true }]);

      const afterFirstRun = await snapshot();
      expect(afterFirstRun, 'every row across the ten-table FK subtree must survive the rebuild byte-for-byte').toEqual(beforeFirstRun);

      // Second run: enum_range already contains 'mercari', so the guard at
      // the top of migratePlatformTypeAddMercari must skip the rebuild
      // entirely — proven by its own completion log never firing a second
      // time (identical data alone wouldn't distinguish a skipped rebuild
      // from one that ran again and happened to preserve the same rows).
      const logSpy = vi.spyOn(console, 'log');
      await runMigrations(connection);
      const rebuildLogCalls = logSpy.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.includes('platform_type mercari migration complete'),
      );
      expect(rebuildLogCalls, 'a second run must not re-execute the rebuild — the guard must make it a true no-op').toHaveLength(0);
      logSpy.mockRestore();

      const afterSecondRun = await snapshot();
      expect(afterSecondRun, 'the no-op second run must leave every row exactly as the first run left it').toEqual(afterFirstRun);

      connection.closeSync();
      instance.closeSync();
    } finally {
      await rm(upgradeDir, { recursive: true, force: true });
    }
  }, 30000);
});

// MUST FIX (cycle 0 retry 1) independent repro: the describe block above
// hand-reproduces migrateExpectedPartsNullablePrice's rebuild SQL BEFORE
// seeding data, so its own INSERT ... SELECT never actually copies real
// pre-existing rows through itself — it only proves the later rebuild
// against data already shaped the post-rebuild way. This block seeds the
// full FK subtree into the genuinely pre-rebuild schema first, runs the
// real nullable-price rebuild's own SQL (verbatim match of migrate.ts's
// migrateExpectedPartsNullablePrice) against those real seeded rows so its
// copy step is actually exercised, closes and reopens the on-disk file (a
// real server reboot) to produce a genuinely "already-migrated" file, then
// runs the real migratePlatformTypeAddMercari (via the real, exported
// runMigrations) three consecutive times against that file and confirms:
// no Catalog Error crash, the full ten-table subtree survives byte-for-byte
// every run, and the guard is still a true no-op by the third run, not just
// the second.
describe('MUST FIX (cycle 0 retry 1): migratePlatformTypeAddMercari against a file that already ran migrateExpectedPartsNullablePrice on real seeded data (T2)', () => {
  it('does not crash with a Catalog Error, preserves the full FK subtree across three consecutive runs, and stays a true no-op by the third run', async () => {
    const upgradeDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-db-test-mercari-mustfix-'));
    const dbFilePath = path.join(upgradeDir, 'pc-parts-flipper.duckdb');
    try {
      let instance = await DuckDBInstance.create(dbFilePath);
      let connection = await instance.connect();

      // Pre-feature schema: platform_type without 'mercari', every other
      // statement exactly as schema.ts defines it today.
      await connection.run(`CREATE TYPE platform_type AS ENUM ('ebay', 'facebook_marketplace', 'other')`);
      for (const statement of [...ENUM_STATEMENTS.slice(1), ...TABLE_STATEMENTS, ...ALTER_STATEMENTS]) {
        await connection.run(statement);
      }

      // Seeds one row per table across the full FK subtree BEFORE any
      // rebuild runs — directly into the genuinely-fresh, pre-rebuild
      // expected_parts/teardown_results shape, so the nullable-price
      // rebuild below must carry these exact rows through its own
      // INSERT ... SELECT, not just preserve rows already shaped the way
      // its own output table expects.
      await connection.run(`INSERT INTO sources (id, name, platform_type, url, notes, active, created_at, updated_at, connector_config, last_scanned_at, last_scan_found_count)
        VALUES ('11111111-1111-1111-1111-111111111111', 'eBay store', 'ebay', 'https://example.com', 'a note', true, '2024-01-01 00:00:00', '2024-01-02 00:00:00', '{"queries":["gpu"]}', '2024-01-03 00:00:00', 5)`);
      await connection.run(`INSERT INTO listings (id, source_id, title, description, listing_url, asking_price, listing_date, status, acquisition_fees, photo_paths, created_at, updated_at, external_source, external_item_id, non_working)
        VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'RTX 3060', 'a gpu', 'https://example.com/item', 150.00, '2024-01-01', 'open', 5.00, '["a.jpg"]', '2024-01-01 00:00:00', '2024-01-02 00:00:00', 'ebay', 'EB123', false)`);
      await connection.run(`INSERT INTO part_reference_photos (id, category, brand, part_number, photo_path, source, listing_id, created_at)
        VALUES ('33333333-3333-3333-3333-333333333333', 'GPU', 'NVIDIA', 'RTX 3060', '/ref/photo.jpg', 'manual', '22222222-2222-2222-2222-222222222222', '2024-01-01 00:00:00')`);
      await connection.run(`INSERT INTO expected_parts (id, listing_id, component_category, description, estimated_resale_value, created_at, updated_at, brand, part_number, identity_candidates, ai_confidence, ai_source, price_source, working_status, notes)
        VALUES ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'GPU', 'a gpu card', 220.00, '2024-01-01 00:00:00', '2024-01-02 00:00:00', 'NVIDIA', 'RTX 3060', '[{"brand":"NVIDIA","partNumber":"RTX 3060 Ti"}]', 'high', 'image', 'manual', 'working', 'a note')`);
      await connection.run(`INSERT INTO purchases (id, listing_id, status, price_paid, purchase_date, created_at, updated_at)
        VALUES ('55555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', 'received', 150.00, '2024-01-03', '2024-01-01 00:00:00', '2024-01-02 00:00:00')`);
      await connection.run(`INSERT INTO teardown_results (id, purchase_id, expected_part_id, result, note, created_at, updated_at)
        VALUES ('66666666-6666-6666-6666-666666666666', '55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 'present_as_expected', 'matches listing', '2024-01-01 00:00:00', '2024-01-02 00:00:00')`);
      await connection.run(`INSERT INTO parts (id, purchase_id, category, description, status, unsellable_reason, created_at, updated_at, brand, part_number, identity_candidates)
        VALUES ('77777777-7777-7777-7777-777777777777', '55555555-5555-5555-5555-555555555555', 'GPU', 'a gpu part', 'listed', NULL, '2024-01-01 00:00:00', '2024-01-02 00:00:00', 'NVIDIA', 'RTX 3060', '[]')`);
      await connection.run(`INSERT INTO sale_listings (id, part_id, platform, title, description, asking_price, listed_at, created_at, updated_at)
        VALUES ('88888888-8888-8888-8888-888888888888', '77777777-7777-7777-7777-777777777777', 'ebay', 'RTX 3060 for sale', 'a gpu', 250.00, '2024-01-04 00:00:00', '2024-01-01 00:00:00', '2024-01-02 00:00:00')`);
      await connection.run(`INSERT INTO sales (id, part_id, sold_price, sold_date, platform_fee, shipping_cost, buyer_note, created_at, updated_at)
        VALUES ('99999999-9999-9999-9999-999999999999', '77777777-7777-7777-7777-777777777777', 240.00, '2024-01-05', 10.00, 8.00, 'thanks', '2024-01-01 00:00:00', '2024-01-02 00:00:00')`);
      await connection.run(`INSERT INTO identify_parts_jobs (id, listing_id, stage, result, error_message, delivered, created_at, started_at, completed_at, updated_at)
        VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'completed', '{"parts":[]}', NULL, true, '2024-01-01 00:00:00', '2024-01-01 00:01:00', '2024-01-01 00:02:00', '2024-01-02 00:00:00')`);

      const SUBTREE_TABLES = [
        'sources', 'listings', 'part_reference_photos', 'expected_parts', 'purchases',
        'teardown_results', 'parts', 'sale_listings', 'sales', 'identify_parts_jobs',
      ];
      const snapshot = async () => {
        const tables: Record<string, unknown> = {};
        for (const table of SUBTREE_TABLES) {
          const reader = await connection.runAndReadAll(`SELECT * FROM ${table} ORDER BY id`);
          tables[table] = reader.getRowObjectsJson();
        }
        return tables;
      };

      const seeded = await snapshot();
      expect(seeded.sources, 'the seed row must actually be present before any migration runs').toHaveLength(1);

      // Runs the real migrateExpectedPartsNullablePrice's own SQL verbatim
      // (migrate.ts lines 88-139) against the seeded rows above — its own
      // INSERT ... SELECT now actually carries this test's real
      // pre-existing data across, not data inserted straight into the
      // post-rebuild shape.
      await connection.run(`CREATE TABLE expected_parts_new (
        id UUID PRIMARY KEY, listing_id UUID NOT NULL REFERENCES listings(id), component_category component_category NOT NULL,
        description VARCHAR NOT NULL, estimated_resale_value DECIMAL(10, 2) CHECK (estimated_resale_value >= 0),
        created_at TIMESTAMP NOT NULL DEFAULT current_timestamp, updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        brand VARCHAR, part_number VARCHAR, identity_candidates VARCHAR DEFAULT '[]', ai_confidence VARCHAR, ai_source VARCHAR, price_source VARCHAR,
        working_status VARCHAR DEFAULT 'working', notes VARCHAR
      )`);
      await connection.run(`INSERT INTO expected_parts_new (id, listing_id, component_category, description, estimated_resale_value, created_at, updated_at, brand, part_number, identity_candidates, ai_confidence, ai_source, price_source, working_status, notes)
        SELECT id, listing_id, component_category, description, estimated_resale_value, created_at, updated_at, brand, part_number, identity_candidates, ai_confidence, ai_source, price_source, working_status, notes FROM expected_parts`);
      await connection.run(`CREATE TABLE teardown_results_backup (id UUID, purchase_id UUID, expected_part_id UUID, result VARCHAR, note VARCHAR, created_at TIMESTAMP, updated_at TIMESTAMP)`);
      await connection.run(`INSERT INTO teardown_results_backup SELECT id, purchase_id, expected_part_id, result, note, created_at, updated_at FROM teardown_results`);
      await connection.run(`DROP TABLE teardown_results`);
      await connection.run(`DROP TABLE expected_parts`);
      await connection.run(`ALTER TABLE expected_parts_new RENAME TO expected_parts`);
      await connection.run(`CREATE TABLE teardown_results (
        id UUID PRIMARY KEY, purchase_id UUID NOT NULL REFERENCES purchases(id), expected_part_id UUID REFERENCES expected_parts(id),
        result teardown_result_type NOT NULL, note VARCHAR, created_at TIMESTAMP NOT NULL DEFAULT current_timestamp, updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        UNIQUE (purchase_id, expected_part_id))`);
      await connection.run(`INSERT INTO teardown_results SELECT id, purchase_id, expected_part_id, result, note, created_at, updated_at FROM teardown_results_backup`);
      await connection.run(`DROP TABLE teardown_results_backup`);
      for (const statement of INDEX_STATEMENTS) {
        await connection.run(statement);
      }

      const afterNullableRebuild = await snapshot();
      expect(afterNullableRebuild, 'the real nullable-price rebuild must carry every seeded row across its own copy step byte-for-byte').toEqual(seeded);

      // A real server reboot: close this connection/instance and reopen a
      // fresh one against the exact same on-disk file — the realistic
      // shape of "an already-migrated database" the must_fix crash was
      // filed against, not a hand-rolled approximation on a still-open
      // connection.
      connection.closeSync();
      instance.closeSync();
      instance = await DuckDBInstance.create(dbFilePath);
      connection = await instance.connect();

      const beforeMercariRuns = await snapshot();
      expect(beforeMercariRuns, 'data must still be present immediately after reopening the file').toEqual(afterNullableRebuild);

      // Run 1: the real migratePlatformTypeAddMercari (via the real,
      // exported runMigrations) against this already-migrated on-disk
      // file. The must_fix crash threw "Catalog Error: Could not drop the
      // table because this table is main key table of the table
      // 'expected_parts_new'" from exactly this scenario — not throwing is
      // the must_fix's own central claim.
      await expect(runMigrations(connection)).resolves.toBeUndefined();

      const hasMercari = await connection.runAndReadAll(
        `SELECT list_contains(enum_range(NULL::platform_type), 'mercari') AS has_mercari`,
      );
      expect(hasMercari.getRowObjectsJson()).toEqual([{ has_mercari: true }]);

      const afterRun1 = await snapshot();
      expect(afterRun1, 'every row across the ten-table FK subtree must survive run 1 byte-for-byte').toEqual(beforeMercariRuns);

      // Run 2.
      const logSpy = vi.spyOn(console, 'log');
      await expect(runMigrations(connection)).resolves.toBeUndefined();
      const rebuildLogCallsRun2 = logSpy.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.includes('platform_type mercari migration complete'),
      );
      expect(rebuildLogCallsRun2, 'run 2 must not re-execute the rebuild').toHaveLength(0);
      const afterRun2 = await snapshot();
      expect(afterRun2, 'run 2 must leave every row exactly as run 1 left it').toEqual(afterRun1);

      // Run 3: proves the no-op guard holds beyond just "one more run" — a
      // guard keyed on transient state (rather than the enum's real
      // contents) could pass run 2 and still misfire on run 3.
      logSpy.mockClear();
      await expect(runMigrations(connection)).resolves.toBeUndefined();
      const rebuildLogCallsRun3 = logSpy.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.includes('platform_type mercari migration complete'),
      );
      expect(rebuildLogCallsRun3, 'run 3 must still not re-execute the rebuild').toHaveLength(0);
      logSpy.mockRestore();
      const afterRun3 = await snapshot();
      expect(afterRun3, 'run 3 must leave every row exactly as run 2 left it').toEqual(afterRun2);

      connection.closeSync();
      instance.closeSync();
    } finally {
      await rm(upgradeDir, { recursive: true, force: true });
    }
  }, 30000);
});

