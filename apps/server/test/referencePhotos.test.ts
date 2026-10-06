// Tests for apps/server/src/db/queries/referencePhotos.ts (ai-visual-identification feature T1).
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { isDecodableImage } from '../src/db/imageSignature.js';

let dataDir: string;
let db: typeof DbModule;
let getConnection: typeof ClientModule.getConnection;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-refphotos-test-'));
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

// Seeds a listing for reference photo tests.
async function seedListing(): Promise<string> {
  const source = await db.createSource({
    name: 'Test source',
    platformType: 'other',
    url: null,
    notes: null,
  });
  const listing = await db.createListing({
    sourceId: source.id,
    title: 'Test listing',
    description: null,
    listingUrl: null,
    askingPrice: 100,
    listingDate: '2024-05-01',
    acquisitionFees: 0,
    photoPaths: ['/photos/item1.jpg'],
  });
  return listing.id;
}

describe('Reference Photos — promoteReferencePhotos', () => {
  it('inserts one row per photo path and returns successfully', async () => {
    const listingId = await seedListing();
    const photos = ['/photos/ref1.jpg', '/photos/ref2.jpg'];

    await db.promoteReferencePhotos(
      listingId,
      photos,
      'GPU',
      'NVIDIA',
      'RTX 3060',
    );

    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT * FROM part_reference_photos WHERE listing_id = $listing_id ORDER BY photo_path`,
      { listing_id: listingId },
    );
    const rows = reader.getRowObjectsJson();
    expect(rows).toHaveLength(2);
    expect(rows[0].photo_path).toBe('/photos/ref1.jpg');
    expect(rows[1].photo_path).toBe('/photos/ref2.jpg');
    expect(rows[0].source).toBe('confirmed_listing');
    expect(rows[0].brand).toBe('NVIDIA');
  });

  it('skips duplicate photos (unique index violation) and logs at Info', async () => {
    const listingId = await seedListing();
    const photos = ['/photos/dup1.jpg'];

    // First insert succeeds.
    await db.promoteReferencePhotos(listingId, photos, 'CPU', 'Intel', 'Core i7');

    // Second insert of the same photo is skipped, not thrown.
    await expect(
      db.promoteReferencePhotos(listingId, photos, 'CPU', 'Intel', 'Core i7'),
    ).resolves.not.toThrow();

    // Only one row exists in the database.
    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT COUNT(*) as cnt FROM part_reference_photos WHERE photo_path = '/photos/dup1.jpg'`,
    );
    const count = Number(reader.getRowObjectsJson()[0].cnt);
    expect(count).toBe(1);
  });

  it('handles null part_number in insert', async () => {
    const listingId = await seedListing();
    const photos = ['/photos/nopart.jpg'];

    await db.promoteReferencePhotos(listingId, photos, 'RAM', 'Corsair', null);

    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT part_number FROM part_reference_photos WHERE photo_path = '/photos/nopart.jpg'`,
    );
    const row = reader.getRowObjectsJson()[0];
    expect(row.part_number).toBeNull();
  });

  it('dedups the same combo twice even when part_number is NULL (Requirement 4)', async () => {
    const listingId = await seedListing();
    const photos = ['/photos/null-dedup.jpg'];

    // Promote the exact same category/brand/NULL-partNumber/photoPath combo twice,
    // simulating re-saving the same Listing twice (Requirement 4). DuckDB's unique
    // index treats every NULL as distinct from every other NULL (same precedent as
    // teardown_results' (purchase_id, expected_part_id) constraint in schema.ts), so
    // this proves whether the brand-only (no partNumber) promotion path still
    // collapses to one row or silently double-inserts.
    await db.promoteReferencePhotos(listingId, photos, 'RAM', 'Corsair', null);
    await db.promoteReferencePhotos(listingId, photos, 'RAM', 'Corsair', null);

    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT COUNT(*) as cnt FROM part_reference_photos WHERE photo_path = '/photos/null-dedup.jpg'`,
    );
    const count = Number(reader.getRowObjectsJson()[0].cnt);
    expect(count).toBe(1);
  });

  it('dedups a concurrent double-promotion of the same NULL-part_number combo (Requirement 4)', async () => {
    const listingId = await seedListing();
    const photos = ['/photos/null-dedup-concurrent.jpg'];

    // Fire two promotions of the exact same category/brand/NULL-partNumber/
    // photoPath combo at the same time (Promise.all, not sequential awaits).
    // The old implementation ran a separate SELECT existence check and then a
    // separate INSERT as two connection calls; both concurrent calls could
    // pass the SELECT before either INSERT landed, producing two rows. The
    // fixed implementation collapses the check and the insert into one
    // INSERT...SELECT...WHERE NOT EXISTS statement, so exactly one of the two
    // concurrent calls must actually insert a row.
    await Promise.all([
      db.promoteReferencePhotos(listingId, photos, 'RAM', 'Kingston', null),
      db.promoteReferencePhotos(listingId, photos, 'RAM', 'Kingston', null),
    ]);

    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT COUNT(*) as cnt FROM part_reference_photos WHERE photo_path = '/photos/null-dedup-concurrent.jpg'`,
    );
    const count = Number(reader.getRowObjectsJson()[0].cnt);
    expect(count).toBe(1);
  });

  it('keeps two different photos distinct when category/brand match and part_number is NULL', async () => {
    const listingId = await seedListing();

    // Two different photos promoted under the same category/brand with a NULL
    // partNumber must both survive as separate rows (NULL-distinctness is only a
    // problem for exact-combo re-promotion, never for genuinely different photos).
    await db.promoteReferencePhotos(listingId, ['/photos/null-a.jpg'], 'PSU', 'Corsair', null);
    await db.promoteReferencePhotos(listingId, ['/photos/null-b.jpg'], 'PSU', 'Corsair', null);

    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT photo_path FROM part_reference_photos
       WHERE category = 'PSU' AND brand = 'Corsair' AND part_number IS NULL
       ORDER BY photo_path`,
    );
    const rows = reader.getRowObjectsJson();
    expect(rows).toHaveLength(2);
    expect(rows[0].photo_path).toBe('/photos/null-a.jpg');
    expect(rows[1].photo_path).toBe('/photos/null-b.jpg');
  });

  it('does not swallow a non-dedup DB error (foreign key violation on a nonexistent listing)', async () => {
    // A random, well-formed UUID that was never inserted into `listings` triggers
    // a foreign-key constraint violation, not a unique-index violation. The catch
    // block in promoteReferencePhotos only recognizes and swallows the unique-
    // index "already promoted, skip" case (UNIQUE_CONSTRAINT_MESSAGE); every other
    // DB error, including this one, must propagate to the caller unchanged.
    const bogusListingId = '00000000-0000-4000-8000-000000000000';

    await expect(
      db.promoteReferencePhotos(bogusListingId, ['/photos/fk-violation.jpg'], 'GPU', 'NVIDIA', null),
    ).rejects.toThrow(/foreign key/i);

    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT COUNT(*) as cnt FROM part_reference_photos WHERE photo_path = '/photos/fk-violation.jpg'`,
    );
    expect(Number(reader.getRowObjectsJson()[0].cnt)).toBe(0);
  });
});

describe('Reference Photos — insertSeedReferencePhoto', () => {
  it('dedups a concurrent double-insert of the same NULL-part_number seed combo (reuses the atomic dedup from promoteReferencePhotos/insertReferencePhotoRow, not a separate reimplementation)', async () => {
    // Same race shape as the "dedups a concurrent double-promotion" test above,
    // but driven through insertSeedReferencePhoto directly (the function
    // seedReferencePhotos.ts actually calls) instead of promoteReferencePhotos,
    // to prove the seed path shares insertReferencePhotoRow's single
    // INSERT...WHERE NOT EXISTS statement rather than its own two-step
    // SELECT-then-INSERT. A separate reimplementation using the old two-step
    // form would let both concurrent calls pass the SELECT before either
    // INSERT lands, producing two rows.
    const results = await Promise.all([
      db.insertSeedReferencePhoto('Storage', 'ASRock', null, '/photos/seed-null-dedup-concurrent.jpg'),
      db.insertSeedReferencePhoto('Storage', 'ASRock', null, '/photos/seed-null-dedup-concurrent.jpg'),
    ]);

    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT COUNT(*) as cnt FROM part_reference_photos WHERE photo_path = '/photos/seed-null-dedup-concurrent.jpg'`,
    );
    const count = Number(reader.getRowObjectsJson()[0].cnt);
    expect(count).toBe(1);
    expect(results.filter(r => r.inserted).length).toBe(1);
  });
});

describe('Reference Photos — findReferencePhotosForLeads', () => {
  async function seedPhotos(): Promise<{ listingId: string }> {
    const listingId = await seedListing();

    // Seed a variety of reference photos.
    await db.promoteReferencePhotos(
      listingId,
      ['/photos/nvidia1.jpg'],
      'GPU',
      'NVIDIA',
      'RTX 3060',
    );
    await db.promoteReferencePhotos(
      listingId,
      ['/photos/nvidia2.jpg'],
      'GPU',
      'NVIDIA',
      null,
    );
    await db.promoteReferencePhotos(
      listingId,
      ['/photos/amd1.jpg'],
      'GPU',
      'AMD',
      'RX 6700',
    );
    await db.promoteReferencePhotos(
      listingId,
      ['/photos/intel1.jpg'],
      'CPU',
      'Intel',
      'Core i9',
    );

    return { listingId };
  }

  it('returns one row per distinct brand+partNumber pair (deduplication)', async () => {
    await seedPhotos();

    const results = await db.findReferencePhotosForLeads('GPU', [], 100);

    // Should return 3 distinct brand+partNumber combos: (NVIDIA, RTX 3060), (NVIDIA, null), (AMD, RX 6700)
    expect(results).toHaveLength(3);
  });

  it('filters to only leads with matching brands when leads contain non-null brands', async () => {
    await seedPhotos();

    const results = await db.findReferencePhotosForLeads(
      'GPU',
      [{ brand: 'NVIDIA', partNumber: null }, { brand: 'Intel', partNumber: null }],
      100,
    );

    // Should only return NVIDIA rows (2: one with RTX 3060, one with null part number).
    // Intel is CPU, not GPU, so filtered out at category level.
    expect(results).toHaveLength(2);
    expect(results.every(r => r.brand === 'NVIDIA')).toBe(true);
  });

  it('returns all rows in category when no lead has a non-null brand', async () => {
    await seedPhotos();

    const results = await db.findReferencePhotosForLeads(
      'GPU',
      [{ brand: null, partNumber: null }, { brand: null, partNumber: 'Something' }],
      100,
    );

    // Should return all GPU rows: 3 distinct brand+partNumber combos.
    expect(results).toHaveLength(3);
  });

  it('caps results at limit', async () => {
    await seedPhotos();

    const results = await db.findReferencePhotosForLeads('GPU', [], 2);

    expect(results).toHaveLength(2);
  });

  it('returns most-recent-first within each brand+partNumber group', async () => {
    const listingId = await seedListing();

    // Insert same brand+partNumber twice with different photos to test ordering.
    await db.promoteReferencePhotos(
      listingId,
      ['/photos/old_nvidia.jpg'],
      'GPU',
      'NVIDIA',
      'RTX 3060',
    );

    // Create a small delay or use the database to ensure created_at ordering matters.
    await db.promoteReferencePhotos(
      listingId,
      ['/photos/new_nvidia.jpg'],
      'GPU',
      'NVIDIA',
      'RTX 3060',
    );

    const results = await db.findReferencePhotosForLeads('GPU', [], 100);

    // Should have one NVIDIA RTX 3060 row (most recent).
    const nvidiaRow = results.find(r => r.brand === 'NVIDIA' && r.partNumber === 'RTX 3060');
    expect(nvidiaRow?.photoPath).toBe('/photos/new_nvidia.jpg');
  });

  it('returns empty array for category with no photos', async () => {
    const results = await db.findReferencePhotosForLeads(
      'Motherboard',
      [],
      100,
    );

    expect(results).toEqual([]);
  });

  it('handles leads with specific partNumbers (optional match)', async () => {
    await seedPhotos();

    const results = await db.findReferencePhotosForLeads(
      'GPU',
      [{ brand: 'NVIDIA', partNumber: 'RTX 3060' }],
      100,
    );

    // Should still return both NVIDIA rows because partNumber match is optional
    // in lead preference; we filter by brand but return all rows with that brand.
    expect(results).toHaveLength(2);
    expect(results.every(r => r.brand === 'NVIDIA')).toBe(true);
  });

  it('prefers a part\'s own brand/partNumber lead over a later identityCandidate lead when the limit truncates results (Requirement 6)', async () => {
    const listingId = await seedListing();

    // Seed two GPU brands: 'Zotac' (will be passed as the own-brand lead, first
    // in preference order per Requirement 6) and 'AMD' (will be passed as a
    // lower-priority identityCandidate lead, second in the array). 'AMD' sorts
    // alphabetically before 'Zotac', so this also distinguishes "preference
    // order respected" from "merely sorted by brand name".
    await db.promoteReferencePhotos(listingId, ['/photos/zotac1.jpg'], 'GPU', 'Zotac', 'RTX 4070');
    await db.promoteReferencePhotos(listingId, ['/photos/amd-candidate.jpg'], 'GPU', 'AMD', 'RX 6700');

    // Caller shape matches partIdentification.ts's identifyListingParts: own
    // brand/partNumber lead first, then identityCandidates, exactly as T5 builds
    // the `leads` array. limit=1 forces a choice between the two leads.
    const results = await db.findReferencePhotosForLeads(
      'GPU',
      [
        { brand: 'Zotac', partNumber: 'RTX 4070' },
        { brand: 'AMD', partNumber: 'RX 6700' },
      ],
      1,
    );

    expect(results).toHaveLength(1);
    expect(results[0].brand).toBe('Zotac');
  });

  it('prefers leads[0] (ZBrand) over an alphabetically-earlier leads[1] (ABrand) when both partNumbers are null and the limit truncates results (Requirement 6)', async () => {
    const listingId = await seedListing();

    // Both leads carry a NULL partNumber — the common case for a part whose
    // brand is known but exact model isn't yet. 'ABrand' sorts alphabetically
    // before 'ZBrand', so a plain `ORDER BY brand` (ignoring leads-array
    // priority) would return ABrand here; only leads-array-priority ordering
    // returns ZBrand, since it is leads[0] (the part's own brand) and ABrand
    // is leads[1] (a lower-priority identityCandidate).
    await db.promoteReferencePhotos(listingId, ['/photos/zbrand.jpg'], 'GPU', 'ZBrand', null);
    await db.promoteReferencePhotos(listingId, ['/photos/abrand.jpg'], 'GPU', 'ABrand', null);

    const results = await db.findReferencePhotosForLeads(
      'GPU',
      [
        { brand: 'ZBrand', partNumber: null },
        { brand: 'ABrand', partNumber: null },
      ],
      1,
    );

    expect(results).toHaveLength(1);
    expect(results[0].brand).toBe('ZBrand');
  });
});

describe('Reference Photos — isDecodableImage format coverage', () => {
  // Direct unit tests for isDecodableImage's PNG, GIF, and WebP branches (Requirement 3).
  // The existing test suite exercises JPEG validation via real-HTTP-response paths,
  // but PNG, GIF, and WebP branches are untested; this block adds minimal unit tests that
  // write magic-byte fixtures to temp files and verify acceptance/rejection, mirroring the
  // pattern of byte-buffer verification used elsewhere in this suite.



  const isDecodableImageDir = (): string => path.join(dataDir, 'isDecodableImage-fixtures');

  // PNG: fixed 8-byte magic-byte signature from imageSignature.ts.
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // PNG with first byte corrupted (changed from 0x89 to 0x00).
  const PNG_BYTES_CORRUPTED = Buffer.from([0x00, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // GIF: ASCII "GIF89a" header.
  const GIF_BYTES = Buffer.from('GIF89a', 'ascii');
  // GIF with last byte corrupted (changed from 'a' to 'b').
  const GIF_BYTES_CORRUPTED = Buffer.from('GIF89b', 'ascii');

  // WebP: "RIFF" + 4 size bytes (arbitrary) + "WEBP".
  const WEBP_BYTES = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
  ]);
  // WebP with first byte of "RIFF" corrupted (changed to 'X').
  const WEBP_BYTES_CORRUPTED = Buffer.concat([
    Buffer.from('XIFF', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
  ]);

  beforeAll(async () => {
    // Ensure test fixture directory exists.
    await mkdir(isDecodableImageDir(), { recursive: true });
  });

  it('accepts a valid PNG header', async () => {
    const filePath = path.join(isDecodableImageDir(), 'valid.png');
    await writeFile(filePath, PNG_BYTES);
    expect(await isDecodableImage(filePath)).toBe(true);
  });

  it('rejects a one-byte-corrupted PNG header', async () => {
    const filePath = path.join(isDecodableImageDir(), 'corrupted.png');
    await writeFile(filePath, PNG_BYTES_CORRUPTED);
    expect(await isDecodableImage(filePath)).toBe(false);
  });

  it('accepts a valid GIF header', async () => {
    const filePath = path.join(isDecodableImageDir(), 'valid.gif');
    await writeFile(filePath, GIF_BYTES);
    expect(await isDecodableImage(filePath)).toBe(true);
  });

  it('rejects a one-byte-corrupted GIF header', async () => {
    const filePath = path.join(isDecodableImageDir(), 'corrupted.gif');
    await writeFile(filePath, GIF_BYTES_CORRUPTED);
    expect(await isDecodableImage(filePath)).toBe(false);
  });

  it('accepts a valid WebP header', async () => {
    const filePath = path.join(isDecodableImageDir(), 'valid.webp');
    await writeFile(filePath, WEBP_BYTES);
    expect(await isDecodableImage(filePath)).toBe(true);
  });

  it('rejects a one-byte-corrupted WebP header', async () => {
    const filePath = path.join(isDecodableImageDir(), 'corrupted.webp');
    await writeFile(filePath, WEBP_BYTES_CORRUPTED);
    expect(await isDecodableImage(filePath)).toBe(false);
  });
});
