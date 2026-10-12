// Proof for the one-time eBay description backfill (Req 4, 5):
// apps/server/src/scan/descriptionBackfill.ts's per-Listing processing, plus
// the query that selects which Listings need backfilling
// (listListingsMissingDescription).
//
// The backfillOneListing tests inject fake fetch/save seams via BackfillDeps
// rather than running the CLI wrapper (src/scripts/backfill-descriptions.ts),
// which holds no logic of its own — so no eBay call and no database write
// happens here except through the recorded fake. The query test uses a real
// DuckDB in an isolated temp dir, the same pattern as db.test.ts/
// photoBackfill.test.ts.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as DbModule from '../src/db/index.js';
import type { Listing } from '../src/db/index.js';
import type * as DescriptionBackfillModule from '../src/scan/descriptionBackfill.js';

let dataDir: string;
let db: typeof DbModule;
let descriptionBackfill: typeof DescriptionBackfillModule;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-description-backfill-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import): see db.test.ts's beforeAll — client.ts
  // reads DUCKDB_DATA_DIR once at module-evaluation time, so a static
  // top-of-file import would reach the shared dev database instead of this
  // test's temp dir.
  db = await import('../src/db/index.js');
  descriptionBackfill = await import('../src/scan/descriptionBackfill.js');
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// Builds a Listing object in memory. The backfillOneListing tests never
// persist these — backfillOneListing takes the row it is given and talks to
// the database only through the injected saveDescription seam.
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
  fetchItemDescription: (externalItemId: string) => Promise<string | null>,
): { deps: DescriptionBackfillModule.BackfillDeps; saved: Array<{ listingId: string; description: string }> } {
  const saved: Array<{ listingId: string; description: string }> = [];
  return {
    saved,
    deps: {
      fetchItemDescription,
      saveDescription: async (listingId, description) => {
        saved.push({ listingId, description });
      },
    },
  };
}

describe('backfillOneListing', () => {
  it('succeeds and saves the real formatted description eBay returns', async () => {
    const { deps, saved } = recordingDeps(async () => 'Great condition, barely used.\n\n--- Item Specifics ---\nRAM: 16GB\nStorage: 512GB SSD');

    const outcome = await descriptionBackfill.backfillOneListing(listingFixture('a'), deps);

    expect(outcome).toBe('succeeded');
    expect(saved).toEqual([
      { listingId: 'a', description: 'Great condition, barely used.\n\n--- Item Specifics ---\nRAM: 16GB\nStorage: 512GB SSD' },
    ]);
  });

  it('skips a Listing with no external item id without calling eBay', async () => {
    let fetchCalls = 0;
    const { deps, saved } = recordingDeps(async () => {
      fetchCalls += 1;
      return 'should never be reached';
    });

    const outcome = await descriptionBackfill.backfillOneListing(listingFixture('a', null), deps);

    expect(outcome).toBe('skipped');
    expect(fetchCalls).toBe(0);
    expect(saved).toEqual([]);
  });

  it('counts a Listing eBay holds no description or specifics for as skipped, not failed, and saves nothing', async () => {
    const { deps, saved } = recordingDeps(async () => null);

    const outcome = await descriptionBackfill.backfillOneListing(listingFixture('a'), deps);

    expect(outcome).toBe('skipped');
    expect(saved).toEqual([]);
  });

  it('reports failed, not thrown, when the eBay lookup throws, and saves nothing', async () => {
    // Stands in for eBay 404ing an item that has since been removed from the
    // marketplace — the most likely real backfill failure.
    const { deps, saved } = recordingDeps(async () => {
      throw new Error('The specified item ID was not found.');
    });

    const outcome = await descriptionBackfill.backfillOneListing(listingFixture('a'), deps);

    expect(outcome).toBe('failed');
    expect(saved).toEqual([]);
  });
});

describe('listListingsMissingDescription', () => {
  it('returns only eBay-imported Listings that have no description yet, oldest first', async () => {
    const source = await db.createSource({
      name: 'Description Backfill Source',
      platformType: 'ebay',
      url: null,
      notes: null,
      connectorConfig: JSON.stringify({ queries: ['rtx 3080'] }),
    });

    const baseInput = {
      sourceId: source.id,
      listingUrl: 'https://www.ebay.com/itm/1',
      askingPrice: 250,
      listingDate: '2026-03-01',
      acquisitionFees: 0,
      photoPaths: [],
      externalSource: 'ebay' as const,
    };

    // Inserted first, so it is the oldest row eligible for backfill.
    const olderNeedsBackfill = await db.createListing({
      ...baseInput,
      title: 'Older, needs backfill',
      description: null,
      externalItemId: 'v1|older|0',
    });
    // Inserted second: each createListing round-trip to DuckDB (parse,
    // execute, RETURNING fetch) takes real time on its own, so the second
    // insert's current_timestamp default is observably later than the
    // first's without needing an artificial wait — the same reasoning
    // db.test.ts relies on for every other created_at-ordered query in this
    // suite, none of which inserts a sleep either.
    const newerNeedsBackfill = await db.createListing({
      ...baseInput,
      title: 'Newer, needs backfill',
      description: null,
      externalItemId: 'v1|newer|0',
    });
    const alreadyHasDescription = await db.createListing({
      ...baseInput,
      title: 'Already has a description',
      description: 'Already captured.',
      externalItemId: 'v1|has-description|0',
    });
    const manuallyEntered = await db.createListing({
      ...baseInput,
      title: 'Manually entered',
      description: null,
      externalSource: null,
      externalItemId: null,
    });
    // Distinct from manuallyEntered: this row matches external_source =
    // 'ebay' (so it would pass that filter alone) but still has no eBay
    // item id, isolating the external_item_id IS NOT NULL clause itself
    // rather than piggybacking on the external_source filter.
    const ebaySourcedNoItemId = await db.createListing({
      ...baseInput,
      title: 'eBay-sourced but no item id',
      description: null,
      externalItemId: null,
    });

    const found = await db.listListingsMissingDescription('ebay');
    const foundIds = found.map((l) => l.id);

    expect(foundIds).toContain(olderNeedsBackfill.id);
    expect(foundIds).toContain(newerNeedsBackfill.id);
    // A Listing that already has a description must not be re-fetched: the
    // backfill is meant to fill gaps, not to re-fetch or overwrite existing
    // description text.
    expect(foundIds).not.toContain(alreadyHasDescription.id);
    // A hand-entered Listing has no eBay item id to look up at all.
    expect(foundIds).not.toContain(manuallyEntered.id);
    // Same exclusion, but matching external_source = 'ebay' on its own —
    // proves the external_item_id IS NOT NULL clause itself excludes this
    // row, not merely the external_source filter happening to catch it.
    expect(foundIds).not.toContain(ebaySourcedNoItemId.id);
    // Oldest-created-first: the row inserted earlier must come before the
    // row inserted later in the returned list, not merely both be present.
    expect(foundIds.indexOf(olderNeedsBackfill.id)).toBeLessThan(foundIds.indexOf(newerNeedsBackfill.id));
  });
});
