// Proof for the one-time eBay photo backfill (Req 2):
// apps/server/src/photos/photoBackfill.ts's per-Listing processing and batch
// loop, plus the query that selects which Listings need backfilling
// (listListingsMissingPhotos).
//
// The batch tests inject fake fetch/download/save seams via BackfillDeps
// rather than running the CLI wrapper (src/scripts/backfill-photos.ts), which
// holds no logic of its own — so no eBay call and no file write happens here.
// The query test uses a real DuckDB in an isolated temp dir, the same
// pattern as db.test.ts/scanService.test.ts.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as DbModule from '../src/db/index.js';
import type { Listing } from '../src/db/index.js';
import type * as PhotoBackfillModule from '../src/photos/photoBackfill.js';

let dataDir: string;
let db: typeof DbModule;
let photoBackfill: typeof PhotoBackfillModule;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-photo-backfill-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import): see db.test.ts's beforeAll — client.ts
  // (and photoStorage.ts) read DUCKDB_DATA_DIR once at module-evaluation
  // time, so a static top-of-file import would reach the shared dev database
  // and the real data/photos directory instead of this test's temp dir.
  db = await import('../src/db/index.js');
  photoBackfill = await import('../src/photos/photoBackfill.js');
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// Builds a Listing object in memory. The batch tests never persist these —
// backfillListingPhotos takes the rows it is given and talks to the database
// only through the injected savePhotoPaths seam.
function listingFixture(id: string, externalItemId: string | null = `v1|${id}|0`): Listing {
  return {
    id,
    sourceId: 'source-1',
    title: `Listing ${id}`,
    description: null,
    listingUrl: `https://www.ebay.com/itm/${id}`,
    askingPrice: 300,
    listingDate: '2026-01-01',
    status: 'open',
    acquisitionFees: 0,
    photoPaths: [],
    externalSource: 'ebay',
    externalItemId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

// Records every save so a test can assert exactly which Listings were
// updated and with what, not merely how many succeeded.
function recordingDeps(
  fetchItemImageUrls: (externalItemId: string) => Promise<string[]>,
  downloadImages: (imageUrls: string[], listingId: string) => Promise<string[]>,
): { deps: PhotoBackfillModule.BackfillDeps; saved: Array<{ listingId: string; photoPaths: string[] }> } {
  const saved: Array<{ listingId: string; photoPaths: string[] }> = [];
  return {
    saved,
    deps: {
      fetchItemImageUrls,
      downloadImages,
      savePhotoPaths: async (listingId, photoPaths) => {
        saved.push({ listingId, photoPaths });
      },
    },
  };
}

describe('backfillListingPhotos', () => {
  it('backfills every Listing and reports them as succeeded', async () => {
    const { deps, saved } = recordingDeps(
      async (externalItemId) => [`https://i.ebayimg.com/images/g/${externalItemId}/s-l1600.jpg`],
      async (imageUrls, listingId) => imageUrls.map((_url, i) => `photos/${listingId}-${i}.jpg`),
    );

    const summary = await photoBackfill.backfillListingPhotos([listingFixture('a'), listingFixture('b')], deps);

    expect(summary).toEqual({ succeeded: 2, skipped: 0, failed: 0 });
    expect(saved).toEqual([
      { listingId: 'a', photoPaths: ['photos/a-0.jpg'] },
      { listingId: 'b', photoPaths: ['photos/b-0.jpg'] },
    ]);
  });

  it('continues the batch when one Listing\'s eBay lookup throws, and still saves the rest', async () => {
    const { deps, saved } = recordingDeps(
      async (externalItemId) => {
        // Stands in for eBay 404ing an item that has since been removed from
        // the marketplace — the most likely real backfill failure.
        if (externalItemId === 'v1|b|0') {
          throw new Error('The specified item ID was not found.');
        }
        return [`https://i.ebayimg.com/images/g/${externalItemId}/s-l1600.jpg`];
      },
      async (imageUrls, listingId) => imageUrls.map((_url, i) => `photos/${listingId}-${i}.jpg`),
    );

    const summary = await photoBackfill.backfillListingPhotos(
      [listingFixture('a'), listingFixture('b'), listingFixture('c')],
      deps,
    );

    // The failing Listing is counted and skipped; crucially 'c' — which comes
    // after it — was still processed, proving the batch did not abort.
    expect(summary).toEqual({ succeeded: 2, skipped: 0, failed: 1 });
    expect(saved.map((s) => s.listingId)).toEqual(['a', 'c']);
  });

  it('continues the batch when one Listing\'s image downloads all fail', async () => {
    const { deps, saved } = recordingDeps(
      async (externalItemId) => [`https://i.ebayimg.com/images/g/${externalItemId}/s-l1600.jpg`],
      // Every image for 'a' fails to download; 'b' downloads fine.
      async (imageUrls, listingId) => (listingId === 'a' ? [] : imageUrls.map((_url, i) => `photos/${listingId}-${i}.jpg`)),
    );

    const summary = await photoBackfill.backfillListingPhotos([listingFixture('a'), listingFixture('b')], deps);

    expect(summary).toEqual({ succeeded: 1, skipped: 0, failed: 1 });
    // A Listing with nothing stored must not be updated at all — writing an
    // empty photoPaths array would be a no-op write that also hides the row
    // from a later retry only if the query changed; either way it is wrong.
    expect(saved.map((s) => s.listingId)).toEqual(['b']);
  });

  it('counts a Listing eBay holds no images for as skipped, not failed', async () => {
    const { deps, saved } = recordingDeps(
      async () => [],
      async (imageUrls, listingId) => imageUrls.map((_url, i) => `photos/${listingId}-${i}.jpg`),
    );

    const summary = await photoBackfill.backfillListingPhotos([listingFixture('a')], deps);

    expect(summary).toEqual({ succeeded: 0, skipped: 1, failed: 0 });
    expect(saved).toEqual([]);
  });

  it('skips a Listing with no external item id without calling eBay', async () => {
    let fetchCalls = 0;
    const { deps } = recordingDeps(
      async () => {
        fetchCalls += 1;
        return [];
      },
      async (imageUrls, listingId) => imageUrls.map((_url, i) => `photos/${listingId}-${i}.jpg`),
    );

    const summary = await photoBackfill.backfillListingPhotos([listingFixture('a', null)], deps);

    expect(summary).toEqual({ succeeded: 0, skipped: 1, failed: 0 });
    expect(fetchCalls).toBe(0);
  });
});

describe('listListingsMissingPhotos', () => {
  it('returns only eBay-imported Listings that have no photos yet', async () => {
    const source = await db.createSource({
      name: 'Backfill Source',
      platformType: 'ebay',
      url: null,
      notes: null,
      connectorConfig: JSON.stringify({ queries: ['rtx 3080'] }),
    });

    const baseInput = {
      sourceId: source.id,
      description: null,
      listingUrl: 'https://www.ebay.com/itm/1',
      askingPrice: 250,
      listingDate: '2026-03-01',
      acquisitionFees: 0,
    };

    const needsBackfill = await db.createListing({
      ...baseInput,
      title: 'Needs backfill',
      photoPaths: [],
      externalSource: 'ebay',
      externalItemId: 'v1|needs|0',
    });
    const alreadyHasPhotos = await db.createListing({
      ...baseInput,
      title: 'Already has photos',
      photoPaths: ['photos/existing.jpg'],
      externalSource: 'ebay',
      externalItemId: 'v1|has|0',
    });
    const manuallyEntered = await db.createListing({
      ...baseInput,
      title: 'Manually entered',
      photoPaths: [],
      externalSource: null,
      externalItemId: null,
    });

    const found = await db.listListingsMissingPhotos('ebay');
    const foundIds = found.map((l) => l.id);

    expect(foundIds).toContain(needsBackfill.id);
    // A Listing that already has photos must not be re-fetched: the backfill
    // is meant to fill gaps, not to re-download or duplicate existing photos.
    expect(foundIds).not.toContain(alreadyHasPhotos.id);
    // A hand-entered Listing has no eBay item id to look up at all.
    expect(foundIds).not.toContain(manuallyEntered.id);
  });
});
