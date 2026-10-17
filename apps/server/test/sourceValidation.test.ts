// T10 proof (Req 1, 13): validateSourceInput's platform-specific
// connectorConfig validation for the two new marketplace connectors —
// 'mercari' (same queries/maxPrice rules as the existing 'ebay' case) and
// 'facebook_marketplace' (queries/maxPrice plus location/radiusMiles).
// Pure unit tests against the exported validateSourceInput function
// directly (apps/server/src/routes/sourceValidation.ts) — no HTTP server
// needed, unlike sources.test.ts's end-to-end route coverage of the
// pre-existing 'ebay' case.
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/error-handler.js';
import { validateSourceInput, VALID_PLATFORM_TYPES, type SourceRequestBody } from '../src/routes/sourceValidation.js';

// Minimal valid base fields shared by every case below; each test only
// overrides platformType/connectorConfig.
function body(overrides: Partial<SourceRequestBody>): SourceRequestBody {
  return {
    name: 'Test Source',
    platformType: 'mercari',
    url: 'https://example.com',
    notes: null,
    ...overrides,
  };
}

describe('VALID_PLATFORM_TYPES (T10)', () => {
  it('includes mercari alongside the pre-existing ebay, facebook_marketplace, and other values', () => {
    expect(VALID_PLATFORM_TYPES).toEqual(['ebay', 'facebook_marketplace', 'mercari', 'other']);
  });
});

describe('validateSourceInput — mercari connectorConfig (T10)', () => {
  it('accepts a valid mercari connectorConfig and round-trips queries/maxPrice through JSON', () => {
    const result = validateSourceInput(
      body({ platformType: 'mercari', connectorConfig: { queries: ['rtx 3080', 'ryzen 5800x'], maxPrice: 400 } }),
    );
    expect(JSON.parse(result.connectorConfig as string)).toEqual({ queries: ['rtx 3080', 'ryzen 5800x'], maxPrice: 400 });
  });

  it('accepts a valid mercari connectorConfig with maxPrice omitted', () => {
    const result = validateSourceInput(body({ platformType: 'mercari', connectorConfig: { queries: ['rtx 3080'] } }));
    expect(JSON.parse(result.connectorConfig as string)).toEqual({ queries: ['rtx 3080'] });
  });

  it('rejects an empty queries array with a 400 naming connectorConfig.queries', () => {
    expect(() => validateSourceInput(body({ platformType: 'mercari', connectorConfig: { queries: [] } }))).toThrow(
      new AppError('connectorConfig.queries is required and must be a non-empty array', 400),
    );
  });

  it('rejects a missing queries field with a 400 naming connectorConfig.queries', () => {
    expect(() => validateSourceInput(body({ platformType: 'mercari', connectorConfig: {} }))).toThrow(
      new AppError('connectorConfig.queries is required and must be a non-empty array', 400),
    );
  });

  it('rejects a blank query string with a 400 naming the offending index', () => {
    expect(() =>
      validateSourceInput(body({ platformType: 'mercari', connectorConfig: { queries: ['valid query', '   '] } })),
    ).toThrow(new AppError('connectorConfig.queries[1] is required', 400));
  });

  it('rejects a negative maxPrice with a 400 naming connectorConfig.maxPrice', () => {
    expect(() =>
      validateSourceInput(body({ platformType: 'mercari', connectorConfig: { queries: ['valid query'], maxPrice: -5 } })),
    ).toThrow(new AppError('connectorConfig.maxPrice must be a non-negative number', 400));
  });

  it('accepts maxPrice of exactly 0 (the non-negative boundary)', () => {
    const result = validateSourceInput(body({ platformType: 'mercari', connectorConfig: { queries: ['valid query'], maxPrice: 0 } }));
    expect(JSON.parse(result.connectorConfig as string)).toEqual({ queries: ['valid query'], maxPrice: 0 });
  });
});

describe('validateSourceInput — facebook_marketplace connectorConfig (T10)', () => {
  function fbBody(connectorConfig: unknown): SourceRequestBody {
    return body({ platformType: 'facebook_marketplace', connectorConfig });
  }

  it('accepts a valid connectorConfig with queries, location, radiusMiles, and maxPrice, round-tripping all four', () => {
    const result = validateSourceInput(
      fbBody({ queries: ['gaming pc'], location: 'Seattle, WA', radiusMiles: 25, maxPrice: 600 }),
    );
    expect(JSON.parse(result.connectorConfig as string)).toEqual({
      queries: ['gaming pc'],
      location: 'Seattle, WA',
      radiusMiles: 25,
      maxPrice: 600,
    });
  });

  it('accepts a connectorConfig with only queries, omitting location/radiusMiles/maxPrice entirely', () => {
    const result = validateSourceInput(fbBody({ queries: ['gaming pc'] }));
    expect(JSON.parse(result.connectorConfig as string)).toEqual({ queries: ['gaming pc'] });
  });

  it('rejects an empty queries array with a 400 naming connectorConfig.queries', () => {
    expect(() => validateSourceInput(fbBody({ queries: [] }))).toThrow(
      new AppError('connectorConfig.queries is required and must be a non-empty array', 400),
    );
  });

  it('rejects a missing queries field with a 400 naming connectorConfig.queries', () => {
    expect(() => validateSourceInput(fbBody({}))).toThrow(
      new AppError('connectorConfig.queries is required and must be a non-empty array', 400),
    );
  });

  it('rejects a blank query string with a 400 naming the offending index', () => {
    expect(() => validateSourceInput(fbBody({ queries: ['valid query', '   '] }))).toThrow(
      new AppError('connectorConfig.queries[1] is required', 400),
    );
  });

  it('normalizes a present-but-blank location to omitted, the same treatment the request body notes field gets', () => {
    const result = validateSourceInput(fbBody({ queries: ['gaming pc'], location: '   ' }));
    const parsed = JSON.parse(result.connectorConfig as string) as Record<string, unknown>;
    expect('location' in parsed).toBe(false);
  });

  it('trims a location with surrounding whitespace rather than storing it verbatim', () => {
    const result = validateSourceInput(fbBody({ queries: ['gaming pc'], location: '  Seattle, WA  ' }));
    expect(JSON.parse(result.connectorConfig as string)).toEqual({ queries: ['gaming pc'], location: 'Seattle, WA' });
  });

  it('rejects a negative radiusMiles with a 400 naming connectorConfig.radiusMiles', () => {
    expect(() => validateSourceInput(fbBody({ queries: ['gaming pc'], radiusMiles: -1 }))).toThrow(
      new AppError('connectorConfig.radiusMiles must be a non-negative number', 400),
    );
  });

  it('accepts radiusMiles of exactly 0 (the non-negative boundary)', () => {
    const result = validateSourceInput(fbBody({ queries: ['gaming pc'], radiusMiles: 0 }));
    expect(JSON.parse(result.connectorConfig as string)).toEqual({ queries: ['gaming pc'], radiusMiles: 0 });
  });

  it('rejects a negative maxPrice with a 400 naming connectorConfig.maxPrice', () => {
    expect(() => validateSourceInput(fbBody({ queries: ['gaming pc'], maxPrice: -5 }))).toThrow(
      new AppError('connectorConfig.maxPrice must be a non-negative number', 400),
    );
  });

  it('accepts maxPrice of exactly 0 (the non-negative boundary)', () => {
    const result = validateSourceInput(fbBody({ queries: ['gaming pc'], maxPrice: 0 }));
    expect(JSON.parse(result.connectorConfig as string)).toEqual({ queries: ['gaming pc'], maxPrice: 0 });
  });
});

describe('validateSourceInput — platformType acceptance (T10)', () => {
  it('accepts mercari as a valid platformType', () => {
    const result = validateSourceInput(body({ platformType: 'mercari', connectorConfig: undefined }));
    expect(result.platformType).toBe('mercari');
  });

  it('still rejects an unrecognized platformType with a 400 listing all four valid values', () => {
    expect(() => validateSourceInput(body({ platformType: 'craigslist' }))).toThrow(
      new AppError('platformType is required and must be one of: ebay, facebook_marketplace, mercari, other', 400),
    );
  });
});
