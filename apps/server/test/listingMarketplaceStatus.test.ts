// T1 standing-check proof: transitionListingMarketplaceStatus's CAS guard,
// in both directions (open -> removed and removed -> open), under genuine
// concurrency. Tests the data-access function directly against an isolated
// DuckDB file (the same query-layer pattern referencePhotos.test.ts uses),
// rather than through HTTP — this is a T1 (DB layer) task, not a scan
// pipeline or route task, and no route calls this function yet.
//
// Follows concurrency.test.ts's own convention for proving a CAS guard:
// fire genuinely parallel calls via Promise.all (not sequential calls
// dressed up as parallel) at the same row and assert exactly one wins
// (returns true) while the loser(s) see false, matching the exact proof
// style listingsAcceptReject.test.ts uses for transitionOpenListing's own
// accept/reject guard.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

let dataDir: string;
let db: typeof DbModule;
let getConnection: typeof ClientModule.getConnection;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-marketplace-status-test-'));
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

// Seeds a Source and one open Listing for a transition test.
async function seedOpenListing(): Promise<string> {
  const source = await db.createSource({
    name: 'Test Source',
    platformType: 'ebay',
    url: null,
    notes: null,
  });
  const listing = await db.createListing({
    sourceId: source.id,
    title: 'Test Listing',
    description: null,
    listingUrl: null,
    askingPrice: 100,
    listingDate: '2026-01-01',
    acquisitionFees: 0,
    photoPaths: [],
  });
  return listing.id;
}

describe('transitionListingMarketplaceStatus — sequential correctness', () => {
  it('open -> removed sets status, marketplaceStatus, and marketplaceStatusDetectedAt in one write', async () => {
    const id = await seedOpenListing();
    const detectedAt = '2026-02-01T00:00:00.000Z';

    const won = await db.transitionListingMarketplaceStatus(id, 'open', 'removed', 'sold', detectedAt);
    expect(won).toBe(true);

    const listing = await db.getListingById(id);
    expect(listing?.status).toBe('removed');
    expect(listing?.marketplaceStatus).toBe('sold');
    // DuckDB round-trips a TIMESTAMP as its own 'YYYY-MM-DD HH:MM:SS' string
    // representation, not the original ISO string passed in — asserting
    // non-null here (the same convention partPriceCache.test.ts's
    // lastResearchedAt assertions use for the same column type) proves the
    // write landed without depending on an exact-format round trip the
    // column type doesn't actually provide.
    expect(listing?.marketplaceStatusDetectedAt).not.toBeNull();
  });

  it('removed -> open clears marketplaceStatus/marketplaceStatusDetectedAt back to null', async () => {
    const id = await seedOpenListing();
    await db.transitionListingMarketplaceStatus(id, 'open', 'removed', 'removed', '2026-02-01T00:00:00.000Z');

    const won = await db.transitionListingMarketplaceStatus(id, 'removed', 'open', null, null);
    expect(won).toBe(true);

    const listing = await db.getListingById(id);
    expect(listing?.status).toBe('open');
    expect(listing?.marketplaceStatus).toBeNull();
    expect(listing?.marketplaceStatusDetectedAt).toBeNull();
  });

  it('refuses to transition when the guarded fromStatus no longer matches', async () => {
    const id = await seedOpenListing();
    // Listing is 'open', not 'removed' — the removed -> open guard must lose.
    const won = await db.transitionListingMarketplaceStatus(id, 'removed', 'open', null, null);
    expect(won).toBe(false);

    const listing = await db.getListingById(id);
    expect(listing?.status).toBe('open');
  });
});

describe('transitionListingMarketplaceStatus — concurrent CAS guard (open -> removed)', () => {
  it('fires two genuinely parallel open -> removed transitions at the same Listing via Promise.all and allows exactly one to win', async () => {
    const id = await seedOpenListing();

    const [resultA, resultB] = await Promise.all([
      db.transitionListingMarketplaceStatus(id, 'open', 'removed', 'sold', '2026-02-01T00:00:00.000Z'),
      db.transitionListingMarketplaceStatus(id, 'open', 'removed', 'removed', '2026-02-01T00:00:01.000Z'),
    ]);

    const wins = [resultA, resultB].filter((won) => won).length;
    expect(wins, `expected exactly one winner, got ${JSON.stringify([resultA, resultB])}`).toBe(1);

    const listing = await db.getListingById(id);
    expect(listing?.status).toBe('removed');
    // Whichever call actually won is the sole writer of marketplaceStatus —
    // it is unambiguously one of the two values passed in, never left at
    // null (which would mean neither write actually landed) and never some
    // third value (which would mean both writes partially landed).
    expect(['sold', 'removed']).toContain(listing?.marketplaceStatus);
  });

  it('a concurrent user accept and a scan-driven removal on the same open Listing can never both win', async () => {
    const id = await seedOpenListing();

    const [removed, accepted] = await Promise.all([
      db.transitionListingMarketplaceStatus(id, 'open', 'removed', 'removed', '2026-02-01T00:00:00.000Z'),
      db.transitionOpenListing(id, 'accepted'),
    ]);

    const wins = [removed, accepted].filter((won) => won).length;
    expect(wins, `expected exactly one winner, got removed=${removed} accepted=${accepted}`).toBe(1);

    const listing = await db.getListingById(id);
    expect(['removed', 'accepted']).toContain(listing?.status);
  });
});

describe('transitionListingMarketplaceStatus — concurrent CAS guard (removed -> open)', () => {
  it('fires two genuinely parallel removed -> open transitions at the same Listing via Promise.all and allows exactly one to win', async () => {
    const id = await seedOpenListing();
    await db.transitionListingMarketplaceStatus(id, 'open', 'removed', 'removed', '2026-02-01T00:00:00.000Z');

    const [resultA, resultB] = await Promise.all([
      db.transitionListingMarketplaceStatus(id, 'removed', 'open', null, null),
      db.transitionListingMarketplaceStatus(id, 'removed', 'open', null, null),
    ]);

    const wins = [resultA, resultB].filter((won) => won).length;
    expect(wins, `expected exactly one winner, got ${JSON.stringify([resultA, resultB])}`).toBe(1);

    const listing = await db.getListingById(id);
    expect(listing?.status).toBe('open');
    expect(listing?.marketplaceStatus).toBeNull();
    expect(listing?.marketplaceStatusDetectedAt).toBeNull();
  });

  it('a transition that reaches back to a status a prior guard already left behind cannot be forced open by a stale caller', async () => {
    const id = await seedOpenListing();
    await db.transitionListingMarketplaceStatus(id, 'open', 'removed', 'sold', '2026-02-01T00:00:00.000Z');

    // The Listing is 'removed', not 'open' — transitionOpenListing's own
    // 'rejected' transition is guarded on status = 'open' (see its own doc
    // comment), so calling it here (a stale caller that still believes the
    // Listing is open) must lose deterministically, proving the two
    // guards' WHERE clauses are independently evaluated against the row's
    // real current status, not merely against whichever status value the
    // caller happens to pass in.
    const rejected = await db.transitionOpenListing(id, 'rejected');
    expect(rejected).toBe(false);

    const reopened = await db.transitionListingMarketplaceStatus(id, 'removed', 'open', null, null);
    expect(reopened).toBe(true);

    const listing = await db.getListingById(id);
    expect(listing?.status).toBe('open');
  });
});
