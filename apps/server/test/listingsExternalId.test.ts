// T4 proof: createListing carries optional externalSource/externalItemId
// (Req 3's eBay-scan dedup support) without breaking existing manual-entry
// callers, and findListingByExternalId resolves/misses correctly. Uses the
// same isolated-DuckDB-tmpdir + dynamic-import pattern as db.test.ts (see
// that file's beforeAll comment for why the import must be dynamic), rather
// than booting the HTTP server like listings.test.ts does: nothing in this
// task's scope (apps/server/src/db/queries/listings.ts) is reachable over
// HTTP yet — findListingByExternalId is a query-layer-only contract that a
// later task (T6) wires into a route.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as DbModule from '../src/db/index.js';

let dataDir: string;
let db: typeof DbModule;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-listings-external-id-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import): see db.test.ts's beforeAll — client.ts
  // reads DUCKDB_DATA_DIR once at module-evaluation time, so a static
  // top-of-file import would open the shared dev database instead of this
  // test's isolated temp dir.
  db = await import('../src/db/index.js');
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// Creates a Source to satisfy listings' source_id FOREIGN KEY; every test
// below needs one, so it's factored out rather than repeated.
async function createTestSource() {
  return db.createSource({
    name: 'eBay search',
    platformType: 'ebay',
    url: null,
    notes: null,
  });
}

describe('createListing externalSource/externalItemId (T4)', () => {
  it('stores and round-trips externalSource/externalItemId when supplied', async () => {
    const source = await createTestSource();
    const listing = await db.createListing({
      sourceId: source.id,
      title: 'eBay-sourced bundle',
      description: null,
      listingUrl: 'https://ebay.com/itm/999',
      askingPrice: 200,
      listingDate: '2024-04-01',
      acquisitionFees: 0,
      photoPaths: [],
      externalSource: 'ebay',
      externalItemId: 'itm-999',
    });
    expect(listing.externalSource).toBe('ebay');
    expect(listing.externalItemId).toBe('itm-999');

    const fetched = await db.getListingById(listing.id);
    expect(fetched?.externalSource).toBe('ebay');
    expect(fetched?.externalItemId).toBe('itm-999');
  });

  it('defaults externalSource/externalItemId to null for the old manual-creation call shape (no such args)', async () => {
    const source = await createTestSource();
    // Deliberately omits externalSource/externalItemId entirely, exactly as
    // every existing manual-creation caller does — proves the extension is
    // additive and doesn't force callers to opt in.
    const listing = await db.createListing({
      sourceId: source.id,
      title: 'Manually entered bundle',
      description: null,
      listingUrl: null,
      askingPrice: 100,
      listingDate: '2024-04-02',
      acquisitionFees: 0,
      photoPaths: [],
    });
    expect(listing.externalSource).toBeNull();
    expect(listing.externalItemId).toBeNull();
  });
});

describe('findListingByExternalId (T4)', () => {
  it('returns the matching Listing for a given (sourceId, externalItemId) pair', async () => {
    const source = await createTestSource();
    const created = await db.createListing({
      sourceId: source.id,
      title: 'Findable eBay bundle',
      description: null,
      listingUrl: 'https://ebay.com/itm/1234',
      askingPrice: 75,
      listingDate: '2024-04-03',
      acquisitionFees: 0,
      photoPaths: [],
      externalSource: 'ebay',
      externalItemId: 'itm-1234',
    });

    const found = await db.findListingByExternalId(source.id, 'itm-1234');
    expect(found).toEqual(created);
  });

  it('returns null when no Listing matches the (sourceId, externalItemId) pair', async () => {
    const source = await createTestSource();
    // Insert a Listing for a different externalItemId on the same Source,
    // proving the miss isn't just "table is empty" but an actual filter.
    await db.createListing({
      sourceId: source.id,
      title: 'Different eBay bundle',
      description: null,
      listingUrl: 'https://ebay.com/itm/5555',
      askingPrice: 50,
      listingDate: '2024-04-04',
      acquisitionFees: 0,
      photoPaths: [],
      externalSource: 'ebay',
      externalItemId: 'itm-5555',
    });

    const missing = await db.findListingByExternalId(source.id, 'itm-not-present');
    expect(missing).toBeNull();
  });
});
