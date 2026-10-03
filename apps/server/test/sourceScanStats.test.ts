// T3 proof: apps/server/src/db/queries/sources.ts's updateSourceScanStats
// (the ebay-scanning feature's scan-recency contract for T6/T9's scan
// service) correctly persists lastScannedAt/lastScanFoundCount on a Source.
//
// Kept as its own file rather than added to db.test.ts (which T4's listings
// work may also be editing concurrently) to avoid two in-flight tasks
// colliding on the same shared test file; follows db.test.ts's own isolated
// per-run temp DuckDB pattern (DUCKDB_DATA_DIR) so this suite never touches
// the shared dev database under data/.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as DbModule from '../src/db/index.js';

let dataDir: string;
let db: typeof DbModule;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-source-scan-stats-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Dynamic import (same exception as db.test.ts): client.ts's DATA_DIR is
  // computed once, at module-evaluation time, from DUCKDB_DATA_DIR — a
  // static top-of-file import would evaluate before this beforeAll sets the
  // env var and would open the shared dev database instead of this temp dir.
  db = await import('../src/db/index.js');
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('updateSourceScanStats', () => {
  it('persists lastScannedAt/lastScanFoundCount on the Source and leaves other fields unchanged', async () => {
    const created = await db.createSource({
      name: 'Scan Stats Source',
      platformType: 'ebay',
      url: 'https://example.com/scan-stats-source',
      notes: null,
      connectorConfig: JSON.stringify({ queries: ['rtx 3080'] }),
    });
    expect(created.lastScannedAt).toBeNull();
    expect(created.lastScanFoundCount).toBeNull();

    // DuckDB's TIMESTAMP column has no timezone concept — it stores the
    // literal wall-clock value given and returns it as a space-separated
    // "YYYY-MM-DD HH:MM:SS" string (confirmed by probing createSource's own
    // created_at output), not an ISO-8601 string. Asserting against that
    // exact literal form (rather than round-tripping through `new Date()`,
    // which would parse the un-timezoned string as local time and silently
    // shift it) is what actually proves the value stored.
    const scannedAt = '2026-01-15T10:30:00.000Z';
    const expectedStored = '2026-01-15 10:30:00';
    const updated = await db.updateSourceScanStats(created.id, { lastScannedAt: scannedAt, lastScanFoundCount: 7 });

    expect(updated).not.toBeNull();
    expect(updated!.lastScannedAt).toBe(expectedStored);
    expect(updated!.lastScanFoundCount).toBe(7);
    // Fields outside the scan-stats patch must be untouched by this narrow update.
    expect(updated!.name).toBe('Scan Stats Source');
    expect(updated!.connectorConfig).toBe(JSON.stringify({ queries: ['rtx 3080'] }));

    // Re-fetch independently to confirm the stats actually persisted to the
    // database rather than only being reflected in the function's return value.
    const refetched = await db.getSourceById(created.id);
    expect(refetched!.lastScanFoundCount).toBe(7);
    expect(refetched!.lastScannedAt).toBe(expectedStored);
  });

  it('returns null when updating scan stats for a Source id that does not exist', async () => {
    const result = await db.updateSourceScanStats('00000000-0000-0000-0000-000000000000', {
      lastScannedAt: '2026-01-15T10:30:00.000Z',
      lastScanFoundCount: 3,
    });
    expect(result).toBeNull();
  });
});
