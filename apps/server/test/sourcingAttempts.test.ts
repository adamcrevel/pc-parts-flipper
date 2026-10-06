// Tests for apps/server/src/db/queries/sourcingAttempts.ts
// (ai-reference-autosourcing feature T1).
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
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-sourcing-attempts-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import): client.ts's DATA_DIR is computed once,
  // from DUCKDB_DATA_DIR, at module-evaluation time into a file-scoped const.
  // A static top-of-file import would evaluate before this beforeAll sets the
  // env var and would therefore open the shared dev database instead of this
  // test's isolated temp dir — the dynamic import here is what makes the
  // module-loading timing land after the env var.
  db = await import('../src/db/index.js') as typeof DbModule;
  ({ getConnection } = await import('../src/db/client.js') as typeof ClientModule);
  await runMigrations(await getConnection());
});

afterAll(async () => {
  delete process.env.DUCKDB_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

// Direct row count for one (category, brand, part_number) combo, bypassing
// the query module under test so the assertion doesn't depend on the same
// code it's verifying.
async function countAttemptRows(
  category: string,
  brand: string,
  partNumber: string,
): Promise<number> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT COUNT(*) as cnt FROM part_reference_sourcing_attempts
     WHERE category = $category AND brand = $brand AND part_number = $part_number`,
    { category, brand, part_number: partNumber },
  );
  return Number(reader.getRowObjectsJson()[0].cnt);
}

describe('Sourcing Attempts — hasSourcingBeenAttempted', () => {
  it('returns false before any recordSourcingAttempt and true after', async () => {
    const before = await db.hasSourcingBeenAttempted('GPU', 'NVIDIA', 'RTX 4060');
    expect(before).toBe(false);

    await db.recordSourcingAttempt('GPU', 'NVIDIA', 'RTX 4060', true);

    const after = await db.hasSourcingBeenAttempted('GPU', 'NVIDIA', 'RTX 4060');
    expect(after).toBe(true);
  });
});

describe('Sourcing Attempts — recordSourcingAttempt', () => {
  it('inserts a row with succeeded=true', async () => {
    await db.recordSourcingAttempt('CPU', 'Intel', 'Core i9-13900K', true);

    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT succeeded FROM part_reference_sourcing_attempts
       WHERE category = 'CPU' AND brand = 'Intel' AND part_number = 'Core i9-13900K'`,
    );
    const rows = reader.getRowObjectsJson();
    expect(rows).toHaveLength(1);
    expect(rows[0].succeeded).toBe(true);
  });

  it('inserts a row with succeeded=false', async () => {
    await db.recordSourcingAttempt('Motherboard', 'ASUS', 'ROG STRIX Z790-E', false);

    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT succeeded FROM part_reference_sourcing_attempts
       WHERE category = 'Motherboard' AND brand = 'ASUS' AND part_number = 'ROG STRIX Z790-E'`,
    );
    const rows = reader.getRowObjectsJson();
    expect(rows).toHaveLength(1);
    expect(rows[0].succeeded).toBe(false);
  });

  // Requirement 6 dedup proof: a second attempt for the identical
  // (category, brand, part_number) combo must be silently skipped (no
  // throw), and the unique index on (category, brand, part_number) must be
  // the thing actually preventing the second row — not just the query
  // module choosing not to insert. If the unique index were dropped from
  // schema.ts's INDEX_STATEMENTS, this test would fail: both inserts would
  // succeed and the row count would be 2, not 1.
  it('silently skips a second recordSourcingAttempt for the identical combo (Requirement 6, unique index dedup)', async () => {
    await db.recordSourcingAttempt('RAM', 'Corsair', 'Vengeance LPX 32GB', true);

    await expect(
      db.recordSourcingAttempt('RAM', 'Corsair', 'Vengeance LPX 32GB', false),
    ).resolves.not.toThrow();

    const count = await countAttemptRows('RAM', 'Corsair', 'Vengeance LPX 32GB');
    expect(count).toBe(1);

    // The first attempt's succeeded value must survive untouched — the
    // skipped second call never updates the existing row.
    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT succeeded FROM part_reference_sourcing_attempts
       WHERE category = 'RAM' AND brand = 'Corsair' AND part_number = 'Vengeance LPX 32GB'`,
    );
    expect(reader.getRowObjectsJson()[0].succeeded).toBe(true);

    // hasSourcingBeenAttempted still reports true after the skipped retry.
    expect(await db.hasSourcingBeenAttempted('RAM', 'Corsair', 'Vengeance LPX 32GB')).toBe(true);
  });

  // Requirement 6 / Standing Checks concurrency proof: two GENUINELY
  // concurrent recordSourcingAttempt calls for the identical combo (fired
  // together via Promise.all, not sequential awaits) must never produce two
  // rows or an unhandled rejection — the same proof style referencePhotos.
  // test.ts's "dedups a concurrent double-promotion" test uses for
  // part_reference_photos. Unlike the sequential-await test above, this is
  // the only test in this file that can actually catch a real race between
  // two overlapping INSERTs landing before either one's unique-index check
  // resolves.
  it('dedups two genuinely concurrent recordSourcingAttempt calls for the identical combo (Requirement 6, real race)', async () => {
    // Both calls fired together via Promise.all against the SAME combo, not
    // one awaited before the other starts.
    await Promise.all([
      db.recordSourcingAttempt('GPU', 'AMD', 'RX 7900 XTX', true),
      db.recordSourcingAttempt('GPU', 'AMD', 'RX 7900 XTX', false),
    ]);

    // Exactly one row must exist — the unique index must have made the
    // loser of the race hit the caught-constraint-violation skip path
    // instead of inserting a second row.
    const count = await countAttemptRows('GPU', 'AMD', 'RX 7900 XTX');
    expect(count).toBe(1);

    // The winner of the race is whichever call's INSERT landed first; its
    // succeeded value is whatever that was. What matters for this test is
    // that it is one of the two values actually passed in, proving a row
    // from one of the two concurrent calls survived rather than neither.
    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT succeeded FROM part_reference_sourcing_attempts
       WHERE category = 'GPU' AND brand = 'AMD' AND part_number = 'RX 7900 XTX'`,
    );
    expect([true, false]).toContain(reader.getRowObjectsJson()[0].succeeded);
  });
});
