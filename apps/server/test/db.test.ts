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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

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
  // likewise added via ALTER_STATEMENTS, appended after the original columns.
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
  ],
  expected_parts: [
    'id',
    'listing_id',
    'component_category',
    'description',
    'estimated_resale_value',
    'created_at',
    'updated_at',
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
  parts: [
    'id',
    'purchase_id',
    'category',
    'description',
    'status',
    'unsellable_reason',
    'created_at',
    'updated_at',
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
};

describe('migrations create every table with the correct columns', () => {
  it('creates exactly the 8 tables named in the Requirements', async () => {
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

  it('adds the 5 ebay-scanning columns with the correct type and nullability (ALTER_STATEMENTS)', async () => {
    const connection = await getConnection();
    // Transcribed independently of schema.ts (VARCHAR/TIMESTAMP/INTEGER, all
    // nullable — none of the ALTER_STATEMENTS columns carry NOT NULL) so
    // this catches a type or nullability regression that the column-name-only
    // test above cannot: that test only reads column_name, never data_type
    // or is_nullable.
    const reader = await connection.runAndReadAll(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE (table_name = 'sources' AND column_name IN ('connector_config', 'last_scanned_at', 'last_scan_found_count'))
          OR (table_name = 'listings' AND column_name IN ('external_source', 'external_item_id'))
       ORDER BY table_name, column_name`,
    );
    expect(reader.getRowObjectsJson()).toEqual([
      { table_name: 'listings', column_name: 'external_item_id', data_type: 'VARCHAR', is_nullable: 'YES' },
      { table_name: 'listings', column_name: 'external_source', data_type: 'VARCHAR', is_nullable: 'YES' },
      { table_name: 'sources', column_name: 'connector_config', data_type: 'VARCHAR', is_nullable: 'YES' },
      { table_name: 'sources', column_name: 'last_scan_found_count', data_type: 'INTEGER', is_nullable: 'YES' },
      { table_name: 'sources', column_name: 'last_scanned_at', data_type: 'TIMESTAMP', is_nullable: 'YES' },
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
      description: 'i5-8500',
      estimatedResaleValue: 60,
    });
    expect(expectedPart.estimatedResaleValue).toBe(60);
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
      description: 'i5-8500',
    });
    expect(part.status).toBe('ready_to_list');
    const fetchedPart = await db.getPartById(part.id);
    expect(fetchedPart).toEqual(part);

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
    const part = await db.createPart({ purchaseId: purchase.id, category: 'CPU', description: 'i5-8500' });

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
      description: 'i5-8500',
      estimatedResaleValue: 60,
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
