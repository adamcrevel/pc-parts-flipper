// Tests for visual comparison prompt builder and response parser (ai-visual-identification feature T4).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as PromptModule from '../src/ai/visualComparisonPrompt.js';
import type * as ParserModule from '../src/ai/visualComparisonParser.js';
import type { Listing, ReferencePhoto } from '../src/db/index.js';
import type * as LoggerModule from '../src/logger.js';
import type * as ErrorModule from '../src/error-handler.js';

let photosDir: string;
let prompt: typeof PromptModule;
let parser: typeof ParserModule;
let AppError: typeof ErrorModule.AppError;
let logger: typeof LoggerModule.logger;

// Builds a Listing fixture; only the fields the visual comparison prompt actually reads
// (title, description, id, photoPaths) matter.
function listingFixture(overrides: Partial<Listing> = {}): Listing {
  return {
    id: 'listing-1',
    sourceId: 'source-1',
    title: 'Dell OptiPlex 7070 SFF',
    description: 'i7-9700, 16GB RAM, tested working',
    listingUrl: null,
    askingPrice: 299.99,
    listingDate: '2024-01-15',
    status: 'open',
    acquisitionFees: 10.0,
    photoPaths: [],
    externalSource: null,
    externalItemId: null,
    createdAt: '2024-01-15T00:00:00Z',
    updatedAt: '2024-01-15T00:00:00Z',
    ...overrides,
  };
}

// Builds a ReferencePhoto fixture.
function referencePhotoFixture(overrides: Partial<ReferencePhoto> = {}): ReferencePhoto {
  return {
    id: 'ref-photo-1',
    category: 'GPU',
    brand: 'NVIDIA',
    partNumber: 'RTX 3060',
    photoPath: '/photos/ref-photo.jpg',
    source: 'seed',
    listingId: null,
    createdAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

beforeAll(async () => {
  photosDir = await mkdtemp(join(tmpdir(), 'pc-parts-flipper-test-'));

  // Dynamic imports so test setup can mock logger before importing modules
  const modules = await Promise.all([
    import('../src/ai/visualComparisonPrompt.js'),
    import('../src/ai/visualComparisonParser.js'),
    import('../src/error-handler.js'),
    import('../src/logger.js'),
  ]);

  prompt = modules[0] as typeof PromptModule;
  parser = modules[1] as typeof ParserModule;
  AppError = (modules[2] as typeof ErrorModule).AppError;
  logger = (modules[3] as typeof LoggerModule).logger;
});

afterAll(async () => {
  await rm(photosDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildVisualComparisonPrompt', () => {
  it('includes listing title and description verbatim', () => {
    const listing = listingFixture({
      title: 'Dell OptiPlex 7070 SFF',
      description: 'i7-9700, no GPU',
    });
    const eligibleParts: PromptModule.EligiblePart[] = [];

    const text = prompt.buildVisualComparisonPrompt(listing, eligibleParts);

    expect(text).toContain('Dell OptiPlex 7070 SFF');
    expect(text).toContain('i7-9700, no GPU');
  });

  it('marks an empty description explicitly rather than leaving a blank', () => {
    const listing = listingFixture({ description: null });
    const eligibleParts: PromptModule.EligiblePart[] = [];

    const text = prompt.buildVisualComparisonPrompt(listing, eligibleParts);

    expect(text).toContain('(none provided)');
  });

  it('includes part descriptions, reference photo labels, and identifying marks instructions', () => {
    const listing = listingFixture();
    const refPhoto = referencePhotoFixture({
      brand: 'NVIDIA',
      partNumber: 'RTX 3060',
      source: 'seed',
    });
    const eligibleParts: PromptModule.EligiblePart[] = [
      {
        partIndex: 0,
        category: 'GPU',
        description: '12GB, single fan cooler',
        references: [refPhoto],
      },
    ];

    const text = prompt.buildVisualComparisonPrompt(listing, eligibleParts);

    // Part info
    expect(text).toContain('Part 1: GPU');
    expect(text).toContain('Description from first pass: "12GB, single fan cooler"');
    // Reference photo labels include brand, partNumber, and source
    expect(text).toContain('Reference 1');
    expect(text).toContain('NVIDIA');
    expect(text).toContain('RTX 3060');
    expect(text).toContain('seed reference');
  });

  it('numbers reference photos and labels their source (seed vs. confirmed listing)', () => {
    const listing = listingFixture();
    const seedRef = referencePhotoFixture({
      brand: 'NVIDIA',
      partNumber: 'RTX 3070',
      source: 'seed',
    });
    const confirmedRef = referencePhotoFixture({
      id: 'ref-photo-2',
      brand: 'NVIDIA',
      partNumber: 'RTX 3060',
      source: 'confirmed_listing',
      listingId: 'some-listing-id',
    });

    const eligibleParts: PromptModule.EligiblePart[] = [
      {
        partIndex: 0,
        category: 'GPU',
        description: 'High-end card',
        references: [seedRef, confirmedRef],
      },
    ];

    const text = prompt.buildVisualComparisonPrompt(listing, eligibleParts);

    expect(text).toContain('Reference 1');
    expect(text).toContain('Reference 2');
    expect(text).toContain('seed reference');
    expect(text).toContain('confirmed listing');
  });

  it('ties each reference photo label line to its own identity and source (not merely present anywhere in the prompt)', () => {
    const listing = listingFixture();
    const seedRef = referencePhotoFixture({
      brand: 'NVIDIA',
      partNumber: 'RTX 3070',
      source: 'seed',
    });
    const confirmedRef = referencePhotoFixture({
      id: 'ref-photo-2',
      brand: 'AMD',
      partNumber: 'RX 6700 XT',
      source: 'confirmed_listing',
      listingId: 'some-listing-id',
    });

    const eligibleParts: PromptModule.EligiblePart[] = [
      {
        partIndex: 0,
        category: 'GPU',
        description: 'High-end card',
        references: [seedRef, confirmedRef],
      },
    ];

    const text = prompt.buildVisualComparisonPrompt(listing, eligibleParts);

    // Reference 1 is the seedRef (NVIDIA RTX 3070): its own line must carry its own
    // identity AND its own source together, not just have both substrings appear
    // somewhere unrelated in the prompt.
    expect(text).toContain('Reference 1 (NVIDIA RTX 3070) — seed reference');
    // Reference 2 is the confirmedRef (AMD RX 6700 XT), labeled "confirmed listing".
    expect(text).toContain('Reference 2 (AMD RX 6700 XT) — confirmed listing');
  });

  it('instructs to compare using identifying marks', () => {
    const listing = listingFixture();
    const eligibleParts: PromptModule.EligiblePart[] = [];

    const text = prompt.buildVisualComparisonPrompt(listing, eligibleParts);

    expect(text).toContain('identifying marks');
    expect(text).toContain('shape');
    expect(text).toContain('color');
    expect(text).toContain('pattern');
    expect(text).toContain('connector layout');
    expect(text).toContain('badge');
    expect(text).toContain('sticker');
  });

  it('requests raw JSON only output without markdown or code fences', () => {
    const listing = listingFixture();
    const eligibleParts: PromptModule.EligiblePart[] = [];

    const text = prompt.buildVisualComparisonPrompt(listing, eligibleParts);

    expect(text).toContain('RESPOND WITH ONLY RAW JSON');
    expect(text).toContain('No markdown, no code fences');
    expect(text).toContain('no commentary before or after');
  });

  it('includes example JSON output showing both updated and noChange responses', () => {
    const listing = listingFixture();
    const eligibleParts: PromptModule.EligiblePart[] = [];

    const text = prompt.buildVisualComparisonPrompt(listing, eligibleParts);

    expect(text).toContain('"partIndex"');
    expect(text).toContain('"noChange":true');
  });

  it('handles multiple eligible parts with distinct indices and reference sets', () => {
    const listing = listingFixture();
    const ref1 = referencePhotoFixture({
      category: 'GPU',
      brand: 'NVIDIA',
      partNumber: 'RTX 3060',
    });
    const ref2 = referencePhotoFixture({
      id: 'ref-photo-2',
      category: 'RAM',
      brand: 'Corsair',
      partNumber: 'Vengeance LPX 16GB',
    });

    const eligibleParts: PromptModule.EligiblePart[] = [
      {
        partIndex: 0,
        category: 'GPU',
        description: 'Video card',
        references: [ref1],
      },
      {
        partIndex: 2,
        category: 'RAM',
        description: 'Memory modules',
        references: [ref2],
      },
    ];

    const text = prompt.buildVisualComparisonPrompt(listing, eligibleParts);
    expect(text).toContain('Part 1: GPU');
    expect(text).toContain('Part 3: RAM');
    expect(text).toContain('Video card');
    expect(text).toContain('Memory modules');
  });
});

describe('parseVisualComparisonResponse', () => {
  it('parses a well-formed JSON array with updated identities', () => {
    const raw = JSON.stringify([
      {
        partIndex: 0,
        brand: 'NVIDIA',
        partNumber: 'RTX 3080',
        identityCandidates: [],
      },
      {
        partIndex: 2,
        brand: 'Corsair',
        partNumber: 'Vengeance LPX 32GB',
        identityCandidates: [],
      },
    ]);

    const result = parser.parseVisualComparisonResponse(raw);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      partIndex: 0,
      brand: 'NVIDIA',
      partNumber: 'RTX 3080',
      identityCandidates: [],
    });
    expect(result[1]).toEqual({
      partIndex: 2,
      brand: 'Corsair',
      partNumber: 'Vengeance LPX 32GB',
      identityCandidates: [],
    });
  });

  it('filters out noChange entries from the result', () => {
    const raw = JSON.stringify([
      {
        partIndex: 0,
        brand: 'NVIDIA',
        partNumber: 'RTX 3060',
        identityCandidates: [],
      },
      {
        partIndex: 1,
        noChange: true,
      },
      {
        partIndex: 2,
        brand: null,
        partNumber: null,
        identityCandidates: [],
      },
    ]);

    const result = parser.parseVisualComparisonResponse(raw);

    // noChange entries are filtered out; only actual updates are returned
    expect(result).toHaveLength(2);
    expect(result[0].partIndex).toBe(0);
    expect(result[1].partIndex).toBe(2);
  });

  it('coerces malformed brand/partNumber to null and logs a warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify([
      {
        partIndex: 0,
        brand: 42,
        partNumber: { model: 'RTX 3060' },
        identityCandidates: [],
      },
    ]);

    const result = parser.parseVisualComparisonResponse(raw);

    expect(result).toHaveLength(1);
    expect(result[0].brand).toBeNull();
    expect(result[0].partNumber).toBeNull();
    // Warns on the coerced fields
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'brand', value: 42 }),
      expect.stringContaining('non-string part identity field'),
    );
  });

  it('coerces a malformed field on one entry among several valid entries without dropping any of them', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify([
      { partIndex: 0, brand: 'NVIDIA', partNumber: 'RTX 3060', identityCandidates: [] },
      { partIndex: 1, brand: 42, partNumber: 'Ryzen 5 3600', identityCandidates: [] },
      { partIndex: 2, brand: 'Corsair', partNumber: 'Vengeance LPX 16GB', identityCandidates: [] },
    ]);

    const result = parser.parseVisualComparisonResponse(raw);

    // All three entries survive — the malformed field on entry 1 is coerced in
    // place, not dropped, and the two valid siblings are untouched.
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ partIndex: 0, brand: 'NVIDIA', partNumber: 'RTX 3060', identityCandidates: [] });
    expect(result[1]).toEqual({ partIndex: 1, brand: null, partNumber: 'Ryzen 5 3600', identityCandidates: [] });
    expect(result[2]).toEqual({ partIndex: 2, brand: 'Corsair', partNumber: 'Vengeance LPX 16GB', identityCandidates: [] });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'brand', value: 42 }),
      expect.stringContaining('non-string part identity field'),
    );
  });

  it('treats blank brand/partNumber strings as null', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify([
      {
        partIndex: 0,
        brand: '  ',
        partNumber: '',
        identityCandidates: [],
      },
    ]);

    const result = parser.parseVisualComparisonResponse(raw);

    expect(result[0].brand).toBeNull();
    expect(result[0].partNumber).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips non-object entries with a warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify([
      { partIndex: 0, brand: 'NVIDIA', partNumber: 'RTX 3060', identityCandidates: [] },
      'invalid entry',
      null,
      { partIndex: 1, brand: 'AMD', partNumber: 'Ryzen', identityCandidates: [] },
    ]);

    const result = parser.parseVisualComparisonResponse(raw);

    expect(result).toHaveLength(2);
    expect(result[0].partIndex).toBe(0);
    expect(result[1].partIndex).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ entry: 'invalid entry' }),
      expect.stringContaining('non-object entry'),
    );
  });

  it('skips entries with missing/invalid partIndex and logs a warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify([
      { partIndex: 0, brand: 'NVIDIA', partNumber: 'RTX 3060', identityCandidates: [] },
      { brand: 'AMD', partNumber: 'Ryzen', identityCandidates: [] },
      { partIndex: 'invalid', brand: 'Intel', partNumber: null, identityCandidates: [] },
      { partIndex: 1, brand: 'Corsair', partNumber: null, identityCandidates: [] },
    ]);

    const result = parser.parseVisualComparisonResponse(raw);

    // Only entries with valid numeric partIndex are kept
    expect(result).toHaveLength(2);
    expect(result[0].partIndex).toBe(0);
    expect(result[1].partIndex).toBe(1);
    // Invalid partIndex entries logged as warnings
    expect(warnSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('normalization'),
    );
  });

  it('coerces malformed identityCandidates array', () => {
    const raw = JSON.stringify([
      {
        partIndex: 0,
        brand: 'NVIDIA',
        partNumber: 'RTX 3060',
        identityCandidates: 'not an array',
      },
    ]);

    const result = parser.parseVisualComparisonResponse(raw);

    expect(result[0].identityCandidates).toEqual([]);
  });

  it('normalizes identityCandidates per the existing coercion rules', () => {
    const raw = JSON.stringify([
      {
        partIndex: 0,
        brand: 'NVIDIA',
        partNumber: 'RTX 3060',
        identityCandidates: [
          { brand: 'NVIDIA', partNumber: 'RTX 3070' },
          { brand: 'NVIDIA', partNumber: 'RTX 3080' },
        ],
      },
    ]);

    const result = parser.parseVisualComparisonResponse(raw);

    expect(result[0].identityCandidates).toHaveLength(2);
    expect(result[0].identityCandidates[0]).toEqual({
      brand: 'NVIDIA',
      partNumber: 'RTX 3070',
    });
    expect(result[0].identityCandidates[1]).toEqual({
      brand: 'NVIDIA',
      partNumber: 'RTX 3080',
    });
  });

  it('throws AppError(502) when output is not JSON', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(() => {
      parser.parseVisualComparisonResponse('not json at all');
    }).toThrow(AppError);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('not a JSON array'),
    );
  });

  it('throws AppError(502) when output is not a JSON array', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(() => {
      parser.parseVisualComparisonResponse(JSON.stringify({ result: [] }));
    }).toThrow(AppError);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('not a JSON array'),
    );
  });

  it('handles markdown-fenced JSON output', () => {
    const raw = `\`\`\`json
[
  { "partIndex": 0, "brand": "NVIDIA", "partNumber": "RTX 3060", "identityCandidates": [] }
]
\`\`\``;

    const result = parser.parseVisualComparisonResponse(raw);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      partIndex: 0,
      brand: 'NVIDIA',
      partNumber: 'RTX 3060',
      identityCandidates: [],
    });
  });

  it('passes explicitly-null brand/partNumber through as null with no warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify([
      {
        partIndex: 0,
        brand: null,
        partNumber: null,
        identityCandidates: [],
      },
    ]);

    const result = parser.parseVisualComparisonResponse(raw);

    expect(result[0].brand).toBeNull();
    expect(result[0].partNumber).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('preserves partIndex from input unchanged', () => {
    const raw = JSON.stringify([
      { partIndex: 5, brand: 'NVIDIA', partNumber: 'RTX 3060', identityCandidates: [] },
      { partIndex: 0, brand: 'AMD', partNumber: 'Ryzen 5', identityCandidates: [] },
      { partIndex: 10, brand: 'Intel', partNumber: null, identityCandidates: [] },
    ]);

    const result = parser.parseVisualComparisonResponse(raw);

    expect(result[0].partIndex).toBe(5);
    expect(result[1].partIndex).toBe(0);
    expect(result[2].partIndex).toBe(10);
  });

  it('returns empty array when all entries are noChange or invalid', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify([
      { partIndex: 0, noChange: true },
      { partIndex: 1, noChange: true },
      'invalid',
    ]);

    const result = parser.parseVisualComparisonResponse(raw);

    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });
});
