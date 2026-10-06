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
  // brand/part_number (brand-model feature) were added via ALTER_STATEMENTS
  // after the original CREATE TABLE, so DuckDB reports them last rather than
  // beside component_category where the TypeScript row type places them.
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
  ],
};

describe('migrations create every table with the correct columns', () => {
  it('creates exactly the 9 tables named in the Requirements plus part_reference_photos (ai-visual-identification) and part_reference_sourcing_attempts (ai-reference-autosourcing)', async () => {
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
