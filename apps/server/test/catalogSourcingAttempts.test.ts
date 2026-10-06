// Tests for apps/server/src/db/queries/catalogSourcingAttempts.ts
// (ai-catalog-sourcing feature T1).
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

let dataDir: string;
let db: typeof DbModule;
let getConnection: typeof ClientModule.getConnection;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-catalog-sourcing-attempts-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import): client.ts's DATA_DIR is computed once,
  // from DUCKDB_DATA_DIR, at module-evaluation time into a file-scoped const.
  // A static top-of-file import would evaluate before this beforeAll sets the
  // env var and would therefore open the shared dev database instead of this
  // test's isolated temp dir — the dynamic import here is what makes the
  // module-loading timing land after the env var.
  db = (await import('../src/db/index.js')) as typeof DbModule;
  ({ getConnection } = (await import('../src/db/client.js')) as typeof ClientModule);
  await runMigrations(await getConnection());
});

afterAll(async () => {
  delete process.env.DUCKDB_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

// Direct row count for one (category, brand) combo, bypassing the query
// module under test so the assertion doesn't depend on the same code it's
// verifying.
async function countAttemptRows(category: string, brand: string): Promise<number> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT COUNT(*) as cnt FROM part_catalog_sourcing_attempts
     WHERE category = $category AND brand = $brand`,
    { category, brand },
  );
  return Number(reader.getRowObjectsJson()[0].cnt);
}

describe('Catalog Sourcing Attempts — hasCatalogSourcingBeenAttempted', () => {
  it('returns false before any recordCatalogSourcingAttempt and true after', async () => {
    const before = await db.hasCatalogSourcingBeenAttempted('Case', 'Montech');
    expect(before).toBe(false);

    await db.recordCatalogSourcingAttempt('Case', 'Montech', true, 5);

    const after = await db.hasCatalogSourcingBeenAttempted('Case', 'Montech');
    expect(after).toBe(true);
  });
});

describe('Catalog Sourcing Attempts — recordCatalogSourcingAttempt', () => {
  it('inserts a row with succeeded=true and the real products_found count', async () => {
    await db.recordCatalogSourcingAttempt('PSU', 'Seasonic', true, 6);

    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT succeeded, products_found FROM part_catalog_sourcing_attempts
       WHERE category = 'PSU' AND brand = 'Seasonic'`,
    );
    const rows = reader.getRowObjectsJson();
    expect(rows).toHaveLength(1);
    expect(rows[0].succeeded).toBe(true);
    expect(Number(rows[0].products_found)).toBe(6);
  });

  it('inserts a row with succeeded=false and products_found=0 for an empty/failed catalog attempt', async () => {
    await db.recordCatalogSourcingAttempt('Cooler', 'Nonexistent Brand', false, 0);

    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT succeeded, products_found FROM part_catalog_sourcing_attempts
       WHERE category = 'Cooler' AND brand = 'Nonexistent Brand'`,
    );
    const rows = reader.getRowObjectsJson();
    expect(rows).toHaveLength(1);
    expect(rows[0].succeeded).toBe(false);
    expect(Number(rows[0].products_found)).toBe(0);
  });

  // Requirement 5 dedup proof: a second attempt for the identical
  // (category, brand) combo must be silently skipped (no throw), and the
  // unique index on (category, brand) must be the thing actually preventing
  // the second row — not just the query module choosing not to insert. If
  // the unique index were dropped from schema.ts's INDEX_STATEMENTS, this
  // test would fail: both inserts would succeed and the row count would be
  // 2, not 1.
  it('silently skips a second recordCatalogSourcingAttempt for the identical combo (Requirement 5, unique index dedup)', async () => {
    await db.recordCatalogSourcingAttempt('GPU', 'EVGA', true, 3);

    await expect(db.recordCatalogSourcingAttempt('GPU', 'EVGA', false, 0)).resolves.not.toThrow();

    const count = await countAttemptRows('GPU', 'EVGA');
    expect(count).toBe(1);

    // The first attempt's values must survive untouched — the skipped
    // second call never updates the existing row.
    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT succeeded, products_found FROM part_catalog_sourcing_attempts
       WHERE category = 'GPU' AND brand = 'EVGA'`,
    );
    const rows = reader.getRowObjectsJson();
    expect(rows[0].succeeded).toBe(true);
    expect(Number(rows[0].products_found)).toBe(3);

    // hasCatalogSourcingBeenAttempted still reports true after the skipped retry.
    expect(await db.hasCatalogSourcingBeenAttempted('GPU', 'EVGA')).toBe(true);
  });

  // Requirement 5 / Standing Checks concurrency proof: two GENUINELY
  // concurrent recordCatalogSourcingAttempt calls for the identical combo
  // (fired together via Promise.all, not sequential awaits) must never
  // produce two rows or an unhandled rejection — the same proof style
  // sourcingAttempts.test.ts's own concurrency test uses for
  // part_reference_sourcing_attempts.
  it('dedups two genuinely concurrent recordCatalogSourcingAttempt calls for the identical combo (Requirement 5, real race)', async () => {
    // Both calls fired together via Promise.all against the SAME combo, not
    // one awaited before the other starts.
    await Promise.all([
      db.recordCatalogSourcingAttempt('Case', 'Fractal Design', true, 4),
      db.recordCatalogSourcingAttempt('Case', 'Fractal Design', false, 0),
    ]);

    // Exactly one row must exist — the unique index must have made the
    // loser of the race hit the caught-constraint-violation skip path
    // instead of inserting a second row.
    const count = await countAttemptRows('Case', 'Fractal Design');
    expect(count).toBe(1);

    // The winner of the race is whichever call's INSERT landed first; its
    // values are whatever that was. What matters for this test is that it
    // is one of the two value-pairs actually passed in, proving a row from
    // one of the two concurrent calls survived rather than neither.
    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT succeeded, products_found FROM part_catalog_sourcing_attempts
       WHERE category = 'Case' AND brand = 'Fractal Design'`,
    );
    const row = reader.getRowObjectsJson()[0];
    expect([true, false]).toContain(row.succeeded);
    expect([4, 0]).toContain(Number(row.products_found));
  });
});
