// Proof for apps/server/src/ai/referenceSourcingOrchestrator.ts and its one
// call site in identifyListingParts (ai-reference-autosourcing feature T5).
//
// The real `omp` binary is NEVER invoked: setOmpSourcingRunnerOverride stands
// in for the tools-enabled sourcing call and setOmpRunnerOverride for the
// identification passes. The one piece of real I/O is a local http server on
// an ephemeral port serving real decodable image bytes, so
// insertSourcedReferencePhoto's genuine download + verify + insert path runs
// end to end (same fixture pattern as referencePhotos.test.ts) without
// reaching the network.
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import type * as RunnerModule from '../src/ai/ompRunner.js';
import type * as SourcingRunnerModule from '../src/ai/ompSourcingRunner.js';
import type * as OrchestratorModule from '../src/ai/referenceSourcingOrchestrator.js';
import type * as IdentificationModule from '../src/ai/partIdentification.js';
import type { Listing } from '../src/db/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

let dataDir: string;
let db: typeof DbModule;
let getConnection: typeof ClientModule.getConnection;
let runner: typeof RunnerModule;
let sourcingRunner: typeof SourcingRunnerModule;
let orchestrator: typeof OrchestratorModule;
let identification: typeof IdentificationModule;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-sourcing-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import), same as referencePhotos.test.ts: both
  // client.ts's and referencePhotos.ts's DATA_DIR are computed from
  // DUCKDB_DATA_DIR once at module-evaluation time, so a static import would
  // bind the shared development data directory before this line runs.
  db = await import('../src/db/index.js') as typeof DbModule;
  ({ getConnection } = await import('../src/db/client.js') as typeof ClientModule);
  runner = await import('../src/ai/ompRunner.js') as typeof RunnerModule;
  sourcingRunner = await import('../src/ai/ompSourcingRunner.js') as typeof SourcingRunnerModule;
  orchestrator = await import('../src/ai/referenceSourcingOrchestrator.js') as typeof OrchestratorModule;
  identification = await import('../src/ai/partIdentification.js') as typeof IdentificationModule;
  await runMigrations(await getConnection());
});

afterAll(async () => {
  delete process.env.DUCKDB_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  runner.setOmpRunnerOverride(null);
  sourcingRunner.setOmpSourcingRunnerOverride(null);
});

// Real decodable-image bytes (a minimal JFIF header): insertSourcedReferencePhoto's
// verification inspects magic bytes only, so this exercises the genuine-image branch.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

// Starts a local HTTP server on an ephemeral port returning a fixed status/body.
async function startFixtureServer(status: number, body: Buffer): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.statusCode = status;
    res.end(body);
  });
  const { promise: listening, resolve: listeningResolve } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listeningResolve);
  await listening;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fixture server did not bind to a port');
  }
  return { server, url: `http://127.0.0.1:${address.port}/photo.jpg` };
}

async function stopFixtureServer(server: Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  await promise;
}

// Installs a sourcing runner that records every prompt it is handed and
// answers with `reply` (a function so a test can vary per-call answers).
function recordSourcingCalls(reply: (callIndex: number) => Promise<string>): string[] {
  const prompts: string[] = [];
  sourcingRunner.setOmpSourcingRunnerOverride(async (promptText) => {
    prompts.push(promptText);
    return reply(prompts.length - 1);
  });
  return prompts;
}

// part_reference_photos rows for one exact combo, by source.
async function countPhotoRows(category: string, brand: string, partNumber: string): Promise<number> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT COUNT(*) AS cnt FROM part_reference_photos
     WHERE category = $category AND brand = $brand AND part_number = $part_number AND source = 'auto_sourced'`,
    { category, brand, part_number: partNumber },
  );
  return Number(reader.getRowObjectsJson()[0].cnt);
}

// The recorded `succeeded` flag for one combo, or null when no attempt row exists.
async function attemptSucceeded(category: string, brand: string, partNumber: string): Promise<boolean | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT succeeded FROM part_reference_sourcing_attempts
     WHERE category = $category AND brand = $brand AND part_number = $part_number`,
    { category, brand, part_number: partNumber },
  );
  const rows = reader.getRowObjectsJson();
  return rows.length === 0 ? null : Boolean(rows[0].succeeded);
}

function listingFixture(overrides: Partial<Listing> = {}): Listing {
  return {
    id: 'sourcing-listing-1',
    sourceId: 'source-1',
    title: 'Gaming PC bundle',
    description: 'Parts pulled from a working build.',
    listingUrl: null,
    askingPrice: 400,
    listingDate: '2026-09-01',
    status: 'open',
    acquisitionFees: 0,
    photoPaths: [],
    externalSource: null,
    externalItemId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

// One first-pass part that is eligible for the second pass (non-empty
// identityCandidates) AND has both brand and partNumber known, which is
// exactly the shape that makes sourcing trigger.
function eligibleKnownPart(brand: string, partNumber: string): Record<string, unknown> {
  return {
    category: 'GPU',
    brand,
    partNumber,
    description: 'Graphics card',
    confidence: 'medium',
    source: 'both',
    identityCandidates: [{ brand: `${brand}-alt`, partNumber: `${partNumber}-alt` }],
  };
}

// One first-pass part that is eligible for the second pass because its own
// partNumber is null (Requirement 1's brand-only trigger shape) — brand is
// known, model is not.
function eligibleBrandOnlyPart(brand: string, category = 'Case'): Record<string, unknown> {
  return {
    category,
    brand,
    partNumber: null,
    description: 'Component, model unknown',
    confidence: 'low',
    source: 'image',
    identityCandidates: [],
  };
}

// Installs an identification runner whose first pass returns `parts` and whose
// second pass applies no updates, recording the image list of every call.
function recordIdentificationCalls(parts: Record<string, unknown>[]): Array<readonly string[]> {
  const images: Array<readonly string[]> = [];
  runner.setOmpRunnerOverride(async (_promptText, imagePaths) => {
    images.push(imagePaths);
    if (images.length === 1) {
      return JSON.stringify({ parts, notes: '' });
    }
    return JSON.stringify([]);
  });
  return images;
}

describe('createReferenceSourcer — trigger conditions', () => {
  it('never attempts sourcing when the part has no brand (Requirement 1)', async () => {
    const prompts = recordSourcingCalls(async () => '{"found":false,"url":null}');

    await orchestrator.createReferenceSourcer()({ category: 'GPU', brand: null, partNumber: 'NoBrand-1' });

    expect(prompts).toEqual([]);
  });

  it('attempts catalog sourcing (not single-product sourcing) when the part has a brand but no part number (Requirement 1)', async () => {
    const prompts = recordSourcingCalls(async () => '{"products":[]}');

    await orchestrator.createReferenceSourcer()({ category: 'GPU', brand: 'NoPartNumberBrand', partNumber: null });

    // Exactly one catalog-shaped call, not a single-product-shaped one.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('NoPartNumberBrand');
    expect(prompts[0]).toContain('"products"');
  });

  it('never attempts sourcing when a reference photo already exists for that exact combo', async () => {
    await db.insertSeedReferencePhoto('GPU', 'ExistingBrand', 'EB-100', 'reference-photos/seed/existing.jpg');
    const prompts = recordSourcingCalls(async () => '{"found":false,"url":null}');

    await orchestrator.createReferenceSourcer()({ category: 'GPU', brand: 'ExistingBrand', partNumber: 'EB-100' });

    expect(prompts).toEqual([]);
  });

  it('still attempts sourcing when the existing row is the same brand but a different part number', async () => {
    await db.insertSeedReferencePhoto('GPU', 'PartialBrand', 'PB-100', 'reference-photos/seed/partial.jpg');
    const prompts = recordSourcingCalls(async () => '{"found":false,"url":null}');

    await orchestrator.createReferenceSourcer()({ category: 'GPU', brand: 'PartialBrand', partNumber: 'PB-999' });

    // The exact-match check must not be satisfied by a brand-only match.
    expect(prompts).toHaveLength(1);
  });

  it('never re-attempts a combo that already has a recorded attempt (Requirement 6)', async () => {
    const prompts = recordSourcingCalls(async () => '{"found":false,"url":null}');
    const sourcer = orchestrator.createReferenceSourcer();

    // First call attempts and records a (failed) attempt for the combo...
    await sourcer({ category: 'GPU', brand: 'OnceOnlyBrand', partNumber: 'OO-1' });
    expect(prompts).toHaveLength(1);
    expect(await attemptSucceeded('GPU', 'OnceOnlyBrand', 'OO-1')).toBe(false);

    // ...and a fresh sourcer (i.e. a later identify-parts call) must not retry it.
    await orchestrator.createReferenceSourcer()({ category: 'GPU', brand: 'OnceOnlyBrand', partNumber: 'OO-1' });
    expect(prompts).toHaveLength(1);
  });
});

describe('createReferenceSourcer — attempt outcomes', () => {
  it('inserts the verified photo and records succeeded=true for a found url', async () => {
    const { server, url } = await startFixtureServer(200, JPEG_BYTES);
    try {
      const prompts = recordSourcingCalls(async () => JSON.stringify({ found: true, url }));

      await orchestrator.createReferenceSourcer()({ category: 'GPU', brand: 'SuccessBrand', partNumber: 'SB-1' });

      expect(prompts).toHaveLength(1);
      // The prompt handed to the runner is the real built prompt for this part.
      expect(prompts[0]).toContain('SB-1');
      expect(await countPhotoRows('GPU', 'SuccessBrand', 'SB-1')).toBe(1);
      expect(await attemptSucceeded('GPU', 'SuccessBrand', 'SB-1')).toBe(true);
    } finally {
      await stopFixtureServer(server);
    }
  });

  it('records succeeded=false and inserts no row when the model reports found:false', async () => {
    recordSourcingCalls(async () => '{"found":false,"url":null}');

    await orchestrator.createReferenceSourcer()({ category: 'GPU', brand: 'NotFoundBrand', partNumber: 'NF-1' });

    expect(await countPhotoRows('GPU', 'NotFoundBrand', 'NF-1')).toBe(0);
    expect(await attemptSucceeded('GPU', 'NotFoundBrand', 'NF-1')).toBe(false);
  });

  it('records succeeded=false and inserts no row when the runner throws', async () => {
    recordSourcingCalls(async () => {
      throw new Error('omp exited with code 1');
    });

    await expect(
      orchestrator.createReferenceSourcer()({ category: 'GPU', brand: 'ThrowBrand', partNumber: 'TB-1' }),
    ).resolves.toBeUndefined();
    expect(await countPhotoRows('GPU', 'ThrowBrand', 'TB-1')).toBe(0);
    expect(await attemptSucceeded('GPU', 'ThrowBrand', 'TB-1')).toBe(false);
  });

  it('records succeeded=false and inserts no row when the response is not parseable JSON', async () => {
    recordSourcingCalls(async () => 'I could not find anything, sorry.');

    await orchestrator.createReferenceSourcer()({ category: 'GPU', brand: 'GarbageBrand', partNumber: 'GB-1' });

    expect(await countPhotoRows('GPU', 'GarbageBrand', 'GB-1')).toBe(0);
    expect(await attemptSucceeded('GPU', 'GarbageBrand', 'GB-1')).toBe(false);
  });

  it('records succeeded=false and inserts no row when the found url fails download verification', async () => {
    const { server, url } = await startFixtureServer(404, Buffer.from('not found'));
    try {
      recordSourcingCalls(async () => JSON.stringify({ found: true, url }));

      await orchestrator.createReferenceSourcer()({ category: 'GPU', brand: 'BadUrlBrand', partNumber: 'BU-1' });

      expect(await countPhotoRows('GPU', 'BadUrlBrand', 'BU-1')).toBe(0);
      expect(await attemptSucceeded('GPU', 'BadUrlBrand', 'BU-1')).toBe(false);
    } finally {
      await stopFixtureServer(server);
    }
  });
});

describe('identifyListingParts reference sourcing', () => {
  it('uses a photo sourced during this call in this same call\'s second pass (Requirement 5)', async () => {
    const { server, url } = await startFixtureServer(200, JPEG_BYTES);
    try {
      recordSourcingCalls(async () => JSON.stringify({ found: true, url }));
      const images = recordIdentificationCalls([eligibleKnownPart('SamePassBrand', 'SP-1')]);

      await identification.identifyListingParts(listingFixture());

      // Two identification calls means the second pass actually ran, and it
      // ran on the photo sourced moments earlier in this same invocation.
      expect(images).toHaveLength(2);
      const sourcedPhotos = images[1].filter(imagePath => imagePath.includes(path.join('reference-photos', 'auto-sourced')));
      expect(sourcedPhotos).toHaveLength(1);
      expect(sourcedPhotos[0].startsWith(dataDir)).toBe(true);
      expect(await countPhotoRows('GPU', 'SamePassBrand', 'SP-1')).toBe(1);
    } finally {
      await stopFixtureServer(server);
    }
  });

  it('completes normally when sourcing fails, exactly as if it had never been attempted (Requirement 3)', async () => {
    recordSourcingCalls(async () => {
      throw new Error('AI reference image sourcing timed out after 300000ms');
    });
    const images = recordIdentificationCalls([eligibleKnownPart('FailSourceBrand', 'FS-1')]);

    const result = await identification.identifyListingParts(listingFixture());

    // No reference photo exists for this part, so the second pass is skipped —
    // the same outcome as a run with no sourcing at all — and nothing threw.
    expect(images).toHaveLength(1);
    expect(result.parts[0].brand).toBe('FailSourceBrand');
    expect(result.parts[0].partNumber).toBe('FS-1');
    expect(await countPhotoRows('GPU', 'FailSourceBrand', 'FS-1')).toBe(0);
    expect(await attemptSucceeded('GPU', 'FailSourceBrand', 'FS-1')).toBe(false);
  });

  it('caps sourcing attempts per call, and gives a separate call its own full budget (Requirement 7)', async () => {
    const prompts = recordSourcingCalls(async () => '{"found":false,"url":null}');

    // Five eligible, both-known, never-attempted parts — more than the cap, so
    // the cap itself is what limits the attempts, not the supply of parts.
    const firstCallParts = ['A', 'B', 'C', 'D', 'E'].map(suffix => eligibleKnownPart(`CapOneBrand${suffix}`, `C1-${suffix}`));
    recordIdentificationCalls(firstCallParts);
    await identification.identifyListingParts(listingFixture());

    // Pinned to the literal 3, not to the constant: an assertion written
    // against MAX_SOURCING_ATTEMPTS_PER_CALL would pass for any value, and
    // this must fail if the cap is ever raised OR lowered.
    expect(prompts).toHaveLength(3);
    expect(orchestrator.MAX_SOURCING_ATTEMPTS_PER_CALL).toBe(3);

    // A second, separate identifyListingParts call gets its own budget back:
    // its five fresh combos must yield another full 3 attempts, not 0.
    const secondCallParts = ['A', 'B', 'C', 'D', 'E'].map(suffix => eligibleKnownPart(`CapTwoBrand${suffix}`, `C2-${suffix}`));
    recordIdentificationCalls(secondCallParts);
    await identification.identifyListingParts(listingFixture());

    expect(prompts).toHaveLength(6);
  });

  it('never sources for a part whose brand or part number is unknown, even when it is eligible', async () => {
    const prompts = recordSourcingCalls(async () => '{"found":false,"url":null}');
    recordIdentificationCalls([
      {
        category: 'GPU',
        brand: null,
        partNumber: null,
        description: 'Unidentified graphics card',
        confidence: 'low',
        source: 'image',
        identityCandidates: [],
      },
    ]);

    await identification.identifyListingParts(listingFixture());

    expect(prompts).toEqual([]);
  });

  it('never sources for a fully settled part, which is not eligible for the second pass at all', async () => {
    const prompts = recordSourcingCalls(async () => '{"found":false,"url":null}');
    recordIdentificationCalls([
      {
        category: 'Storage',
        brand: 'SettledBrand',
        partNumber: 'SET-1',
        description: '1TB',
        confidence: 'high',
        source: 'text',
        identityCandidates: [],
      },
    ]);

    await identification.identifyListingParts(listingFixture());

    expect(prompts).toEqual([]);
  });
});

describe('createReferenceSourcer — catalog-mode trigger conditions (ai-catalog-sourcing feature)', () => {
  it('inserts every verified candidate from a multi-product catalog response, each under its own part number', async () => {
    const { server: server1, url: url1 } = await startFixtureServer(200, JPEG_BYTES);
    const { server: server2, url: url2 } = await startFixtureServer(200, JPEG_BYTES);
    try {
      recordSourcingCalls(async () =>
        JSON.stringify({
          products: [
            { partNumber: 'CAT-100', url: url1 },
            { partNumber: 'CAT-200', url: url2 },
          ],
        }),
      );

      await orchestrator.createReferenceSourcer()({ category: 'Case', brand: 'CatalogBrand', partNumber: null });

      expect(await countPhotoRows('Case', 'CatalogBrand', 'CAT-100')).toBe(1);
      expect(await countPhotoRows('Case', 'CatalogBrand', 'CAT-200')).toBe(1);
      expect(await db.hasCatalogSourcingBeenAttempted('Case', 'CatalogBrand')).toBe(true);
    } finally {
      await stopFixtureServer(server1);
      await stopFixtureServer(server2);
    }
  });

  it('does not duplicate a candidate that already has a part_reference_photos row from a different source (Requirement 6)', async () => {
    const { server, url } = await startFixtureServer(200, JPEG_BYTES);
    try {
      // Pre-seed the exact (category, brand, partNumber) a catalog
      // candidate below will also report, as single-product sourcing (or a
      // confirmed real listing) would have — downloading the SAME bytes so
      // the content-hashed photo_path collides, which is what the existing
      // unique index actually keys on.
      const preseed = await db.insertSourcedReferencePhoto('Cooler', 'DedupBrand', 'DUP-1', url);
      expect(preseed.inserted).toBe(true);
      expect(await countPhotoRows('Cooler', 'DedupBrand', 'DUP-1')).toBe(1);

      recordSourcingCalls(async () =>
        JSON.stringify({
          products: [
            { partNumber: 'DUP-1', url }, // already exists
            { partNumber: 'NEW-1', url }, // genuinely new partNumber, same bytes
          ],
        }),
      );

      await orchestrator.createReferenceSourcer()({ category: 'Cooler', brand: 'DedupBrand', partNumber: null });

      // The pre-existing combo is still exactly one row, not two.
      expect(await countPhotoRows('Cooler', 'DedupBrand', 'DUP-1')).toBe(1);
      // The genuinely new partNumber DID get its own new row.
      expect(await countPhotoRows('Cooler', 'DedupBrand', 'NEW-1')).toBe(1);

      // The attempt record reflects only the one genuinely new insert, not
      // both candidates the model reported.
      const connection = await getConnection();
      const reader = await connection.runAndReadAll(
        `SELECT succeeded, products_found FROM part_catalog_sourcing_attempts WHERE category = 'Cooler' AND brand = 'DedupBrand'`,
      );
      const row = reader.getRowObjectsJson()[0];
      expect(row.succeeded).toBe(true);
      expect(Number(row.products_found)).toBe(1);
    } finally {
      await stopFixtureServer(server);
    }
  });

  it('records succeeded=false and products_found=0 for an empty catalog response, and inserts nothing', async () => {
    recordSourcingCalls(async () => '{"products":[]}');

    await orchestrator.createReferenceSourcer()({ category: 'Case', brand: 'EmptyCatalogBrand', partNumber: null });

    expect(await db.hasCatalogSourcingBeenAttempted('Case', 'EmptyCatalogBrand')).toBe(true);
    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT succeeded, products_found FROM part_catalog_sourcing_attempts WHERE category = 'Case' AND brand = 'EmptyCatalogBrand'`,
    );
    const row = reader.getRowObjectsJson()[0];
    expect(row.succeeded).toBe(false);
    expect(Number(row.products_found)).toBe(0);
  });

  it('drops a candidate that fails download verification but still inserts and counts the rest', async () => {
    const { server: goodServer, url: goodUrl } = await startFixtureServer(200, JPEG_BYTES);
    const { server: badServer, url: badUrl } = await startFixtureServer(404, Buffer.from('nope'));
    try {
      recordSourcingCalls(async () =>
        JSON.stringify({
          products: [
            { partNumber: 'GOOD-1', url: goodUrl },
            { partNumber: 'BAD-1', url: badUrl },
          ],
        }),
      );

      await orchestrator.createReferenceSourcer()({ category: 'PSU', brand: 'MixedBrand', partNumber: null });

      expect(await countPhotoRows('PSU', 'MixedBrand', 'GOOD-1')).toBe(1);
      expect(await countPhotoRows('PSU', 'MixedBrand', 'BAD-1')).toBe(0);

      const connection = await getConnection();
      const reader = await connection.runAndReadAll(
        `SELECT succeeded, products_found FROM part_catalog_sourcing_attempts WHERE category = 'PSU' AND brand = 'MixedBrand'`,
      );
      const row = reader.getRowObjectsJson()[0];
      expect(row.succeeded).toBe(true);
      expect(Number(row.products_found)).toBe(1);
    } finally {
      await stopFixtureServer(goodServer);
      await stopFixtureServer(badServer);
    }
  });

  it('never re-attempts a brand whose catalog was already sourced (Requirement 5)', async () => {
    const prompts = recordSourcingCalls(async () => '{"products":[]}');

    await orchestrator.createReferenceSourcer()({ category: 'Cooler', brand: 'OnceOnlyCatalogBrand', partNumber: null });
    expect(prompts).toHaveLength(1);

    // A fresh sourcer (i.e. a later identify-parts call) must not retry it.
    await orchestrator.createReferenceSourcer()({ category: 'Cooler', brand: 'OnceOnlyCatalogBrand', partNumber: null });
    expect(prompts).toHaveLength(1);
  });

  it('single-product sourcing for a later-resolved model of the same brand is unaffected by a prior catalog attempt (separate tables)', async () => {
    const prompts = recordSourcingCalls(async (callIndex) =>
      // First call: catalog-mode (brand only). Second call: single-product mode.
      callIndex === 0 ? '{"products":[]}' : '{"found":false,"url":null}',
    );
    const sourcer = orchestrator.createReferenceSourcer();

    await sourcer({ category: 'RAM', brand: 'DualModeBrand', partNumber: null });
    await sourcer({ category: 'RAM', brand: 'DualModeBrand', partNumber: 'DM-1' });

    // Both attempted — the catalog-mode attempt record for the brand does not
    // make hasSourcingBeenAttempted (the separate per-product table) report
    // true for a specific model of that same brand.
    expect(prompts).toHaveLength(2);
  });

  it('catalog-mode sourcing counts against the same per-call budget as single-product sourcing (Requirement 7)', async () => {
    const prompts = recordSourcingCalls(async () => '{"found":false,"url":null,"products":[]}');
    const sourcer = orchestrator.createReferenceSourcer();

    // Two single-product attempts, then one catalog attempt: 3 total, exactly at the cap.
    await sourcer({ category: 'GPU', brand: 'BudgetBrandA', partNumber: 'BA-1' });
    await sourcer({ category: 'GPU', brand: 'BudgetBrandB', partNumber: 'BB-1' });
    await sourcer({ category: 'GPU', brand: 'BudgetBrandC', partNumber: null });
    expect(prompts).toHaveLength(3);

    // A fourth call, of either kind, must be rejected by the now-exhausted budget.
    await sourcer({ category: 'GPU', brand: 'BudgetBrandD', partNumber: null });
    expect(prompts).toHaveLength(3);
    expect(await db.hasCatalogSourcingBeenAttempted('GPU', 'BudgetBrandD')).toBe(false);
  });
});

describe('identifyListingParts catalog-mode reference sourcing (ai-catalog-sourcing feature, integration)', () => {
  it('uses a catalog-sourced photo in this same call\'s second pass for a brand-only part (Requirement 1, integration)', async () => {
    const { server, url } = await startFixtureServer(200, JPEG_BYTES);
    try {
      recordSourcingCalls(async () => JSON.stringify({ products: [{ partNumber: 'CATSEC-1', url }] }));
      const images = recordIdentificationCalls([eligibleBrandOnlyPart('CatalogIntegrationBrand')]);

      await identification.identifyListingParts(listingFixture());

      // Two identification calls means the second pass actually ran, and it
      // ran on the photo catalog-sourced moments earlier in this same call.
      expect(images).toHaveLength(2);
      const sourcedPhotos = images[1].filter(imagePath =>
        imagePath.includes(path.join('reference-photos', 'auto-sourced')),
      );
      expect(sourcedPhotos).toHaveLength(1);
      expect(sourcedPhotos[0].startsWith(dataDir)).toBe(true);
      expect(await countPhotoRows('Case', 'CatalogIntegrationBrand', 'CATSEC-1')).toBe(1);
    } finally {
      await stopFixtureServer(server);
    }
  });

  it('completes normally when catalog sourcing fails, exactly as if it had never been attempted (Requirement 3)', async () => {
    recordSourcingCalls(async () => {
      throw new Error('AI catalog sourcing timed out after 600000ms');
    });
    const images = recordIdentificationCalls([eligibleBrandOnlyPart('FailCatalogBrand')]);

    const result = await identification.identifyListingParts(listingFixture());

    // No reference photo exists for this brand, so the second pass is
    // skipped — the same outcome as a run with no sourcing at all.
    expect(images).toHaveLength(1);
    expect(result.parts[0].brand).toBe('FailCatalogBrand');
    expect(result.parts[0].partNumber).toBeNull();
    expect(await db.hasCatalogSourcingBeenAttempted('Case', 'FailCatalogBrand')).toBe(true);
  });
});
