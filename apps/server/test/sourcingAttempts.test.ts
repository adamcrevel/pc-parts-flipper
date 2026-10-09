// Tests for apps/server/src/db/queries/sourcingAttempts.ts
// (ai-reference-autosourcing feature T1, extended by sourcing-resilience T2:
// three-way outcome recording and the backoff-gated skip-check).
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

// The stored attempt row, read directly rather than through the module under
// test. `succeeded`/`blocked` come back as JSON booleans, `attempt_count` as
// a number.
async function readAttemptRow(
  category: string,
  brand: string,
  partNumber: string,
): Promise<{ succeeded: boolean; blocked: boolean; attemptCount: number }> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT succeeded, blocked, attempt_count FROM part_reference_sourcing_attempts
     WHERE category = $category AND brand = $brand AND part_number = $part_number`,
    { category, brand, part_number: partNumber },
  );
  const rows = reader.getRowObjectsJson();
  expect(rows).toHaveLength(1);
  return {
    succeeded: rows[0].succeeded as boolean,
    blocked: rows[0].blocked as boolean,
    attemptCount: Number(rows[0].attempt_count),
  };
}

// How far in the future the combo's backoff window sits, in seconds, as
// measured by DuckDB itself against the same `current_timestamp` the
// skip-check compares to; null when `next_retry_at` is NULL (a permanently
// settled combo). Measuring the real stored interval — rather than merely
// asserting non-null — is what makes the exponential growth of the schedule
// observable from a test.
async function secondsUntilRetry(
  category: string,
  brand: string,
  partNumber: string,
): Promise<number | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT date_diff('second', CAST(current_timestamp AS TIMESTAMP), next_retry_at) AS secs
       FROM part_reference_sourcing_attempts
      WHERE category = $category AND brand = $brand AND part_number = $part_number`,
    { category, brand, part_number: partNumber },
  );
  const rows = reader.getRowObjectsJson();
  expect(rows).toHaveLength(1);
  return rows[0].secs === null ? null : Number(rows[0].secs);
}

// Simulates the passage of real time: moves an already-recorded combo's
// backoff window into the past without touching any other column, so the
// reopening behaviour can be tested without waiting five real minutes.
async function expireBackoffWindow(
  category: string,
  brand: string,
  partNumber: string,
): Promise<void> {
  const connection = await getConnection();
  await connection.runAndReadAll(
    `UPDATE part_reference_sourcing_attempts
        SET next_retry_at = CAST(current_timestamp AS TIMESTAMP) - INTERVAL 1 MINUTE
      WHERE category = $category AND brand = $brand AND part_number = $part_number`,
    { category, brand, part_number: partNumber },
  );
}

describe('Sourcing Attempts — hasSourcingBeenAttempted', () => {
  it('returns false before any recordSourcingAttempt and true after', async () => {
    const before = await db.hasSourcingBeenAttempted('GPU', 'NVIDIA', 'RTX 4060');
    expect(before).toBe(false);

    await db.recordSourcingAttempt('GPU', 'NVIDIA', 'RTX 4060', 'succeeded');

    const after = await db.hasSourcingBeenAttempted('GPU', 'NVIDIA', 'RTX 4060');
    expect(after).toBe(true);
  });

  // Requirement 2: a clean, completed search that genuinely found nothing is
  // permanent. The proof is that it stores NO backoff window at all, so there
  // is no instant — now or ever — at which the skip-check could reopen it.
  it('keeps reporting true forever for a genuine not_found combo (no backoff window is ever stored)', async () => {
    await db.recordSourcingAttempt('CPU', 'AMD', 'Ryzen 5 5600X', 'not_found');

    expect(await secondsUntilRetry('CPU', 'AMD', 'Ryzen 5 5600X')).toBeNull();
    expect(await db.hasSourcingBeenAttempted('CPU', 'AMD', 'Ryzen 5 5600X')).toBe(true);
  });

  // Requirement 1: an infra-blocked combo is skipped only while its window is
  // still closed, and becomes attemptable again the moment it reopens.
  it('reports true inside an infrastructure_blocked combo\'s backoff window and false once it reopens', async () => {
    await db.recordSourcingAttempt('GPU', 'Zotac', 'RTX 4070 Twin Edge', 'infrastructure_blocked');

    expect(await db.hasSourcingBeenAttempted('GPU', 'Zotac', 'RTX 4070 Twin Edge')).toBe(true);

    await expireBackoffWindow('GPU', 'Zotac', 'RTX 4070 Twin Edge');

    expect(await db.hasSourcingBeenAttempted('GPU', 'Zotac', 'RTX 4070 Twin Edge')).toBe(false);
  });
});

describe('Sourcing Attempts — recordSourcingAttempt', () => {
  it('records a succeeded outcome as succeeded=true, blocked=false and no backoff window', async () => {
    await db.recordSourcingAttempt('CPU', 'Intel', 'Core i9-13900K', 'succeeded');

    const row = await readAttemptRow('CPU', 'Intel', 'Core i9-13900K');
    expect(row.succeeded).toBe(true);
    expect(row.blocked).toBe(false);
    expect(row.attemptCount).toBe(1);
    expect(await secondsUntilRetry('CPU', 'Intel', 'Core i9-13900K')).toBeNull();
  });

  it('records a not_found outcome as succeeded=false, blocked=false and no backoff window', async () => {
    await db.recordSourcingAttempt('Motherboard', 'ASUS', 'ROG STRIX Z790-E', 'not_found');

    const row = await readAttemptRow('Motherboard', 'ASUS', 'ROG STRIX Z790-E');
    expect(row.succeeded).toBe(false);
    expect(row.blocked).toBe(false);
    expect(row.attemptCount).toBe(1);
    expect(await secondsUntilRetry('Motherboard', 'ASUS', 'ROG STRIX Z790-E')).toBeNull();
  });

  // Requirement 1/3: the first infra failure stores blocked=true and a window
  // one BASE_RETRY_DELAY_MS (5 minutes) out — asserted as a real measured
  // interval, so a window of the wrong size fails just as loudly as a missing
  // one.
  it('records an infrastructure_blocked outcome as blocked=true with a ~5 minute backoff window', async () => {
    await db.recordSourcingAttempt('Storage', 'Crucial', 'P3 Plus 1TB', 'infrastructure_blocked');

    const row = await readAttemptRow('Storage', 'Crucial', 'P3 Plus 1TB');
    expect(row.succeeded).toBe(false);
    expect(row.blocked).toBe(true);
    expect(row.attemptCount).toBe(1);

    const secs = await secondsUntilRetry('Storage', 'Crucial', 'P3 Plus 1TB');
    expect(secs).not.toBeNull();
    expect(secs as number).toBeGreaterThan(280);
    expect(secs as number).toBeLessThanOrEqual(300);
  });

  // Requirement 3 / Assumption A2: a retry updates the one existing row in
  // place (never a second row), raises attempt_count, and doubles the wait —
  // the ~10 minute bound here is what proves the schedule is exponential in
  // the accumulated count rather than a flat 5 minutes every time.
  it('updates the existing row in place on a retry, growing attempt_count and doubling the backoff', async () => {
    await db.recordSourcingAttempt('Storage', 'Samsung', '990 PRO 2TB', 'infrastructure_blocked');
    await expireBackoffWindow('Storage', 'Samsung', '990 PRO 2TB');

    await db.recordSourcingAttempt('Storage', 'Samsung', '990 PRO 2TB', 'infrastructure_blocked');

    expect(await countAttemptRows('Storage', 'Samsung', '990 PRO 2TB')).toBe(1);
    expect((await readAttemptRow('Storage', 'Samsung', '990 PRO 2TB')).attemptCount).toBe(2);

    const secs = await secondsUntilRetry('Storage', 'Samsung', '990 PRO 2TB');
    expect(secs).not.toBeNull();
    expect(secs as number).toBeGreaterThan(580);
    expect(secs as number).toBeLessThanOrEqual(600);

    // Still skipped again, now for twice as long.
    expect(await db.hasSourcingBeenAttempted('Storage', 'Samsung', '990 PRO 2TB')).toBe(true);
  });

  // Requirement 2 after Requirement 1: once a retried combo finally completes
  // a real search and finds nothing, it must become permanent — the backoff
  // window is cleared, not merely pushed further out.
  it('clears the backoff window permanently when a retried combo finally settles as not_found', async () => {
    await db.recordSourcingAttempt('PSU', 'Corsair', 'RM850x', 'infrastructure_blocked');
    await expireBackoffWindow('PSU', 'Corsair', 'RM850x');
    expect(await db.hasSourcingBeenAttempted('PSU', 'Corsair', 'RM850x')).toBe(false);

    await db.recordSourcingAttempt('PSU', 'Corsair', 'RM850x', 'not_found');

    const row = await readAttemptRow('PSU', 'Corsair', 'RM850x');
    expect(row.blocked).toBe(false);
    expect(row.attemptCount).toBe(2);
    expect(await secondsUntilRetry('PSU', 'Corsair', 'RM850x')).toBeNull();
    expect(await db.hasSourcingBeenAttempted('PSU', 'Corsair', 'RM850x')).toBe(true);
  });

  // Requirement 6 (ai-reference-autosourcing) / Assumption A5 concurrency
  // proof: two GENUINELY concurrent recordSourcingAttempt calls for the
  // identical combo (fired together via Promise.all, not sequential awaits)
  // both see no existing row and both attempt an INSERT; the unique index on
  // (category, brand, part_number) must turn the loser into the caught,
  // skipped no-op rather than a second row or an unhandled rejection. This is
  // the only test in this file that can catch that race, and the only one
  // that would fail if the unique index were dropped from schema.ts.
  it('dedups two genuinely concurrent recordSourcingAttempt calls for the identical combo (real race)', async () => {
    // Both calls fired together via Promise.all against the SAME combo, not
    // one awaited before the other starts.
    await Promise.all([
      db.recordSourcingAttempt('GPU', 'AMD', 'RX 7900 XTX', 'succeeded'),
      db.recordSourcingAttempt('GPU', 'AMD', 'RX 7900 XTX', 'not_found'),
    ]);

    // Exactly one row must exist — the unique index must have made the
    // loser of the race hit the caught-constraint-violation skip path
    // instead of inserting a second row.
    expect(await countAttemptRows('GPU', 'AMD', 'RX 7900 XTX')).toBe(1);

    // The winner of the race is whichever call's INSERT landed first; its
    // succeeded value is whatever that was. What matters for this test is
    // that it is one of the two values actually passed in, proving a row
    // from one of the two concurrent calls survived rather than neither.
    const row = await readAttemptRow('GPU', 'AMD', 'RX 7900 XTX');
    expect([true, false]).toContain(row.succeeded);
  });
});
