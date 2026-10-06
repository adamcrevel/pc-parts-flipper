// Tests for catalog sourcing prompt builder and response parser
// (ai-catalog-sourcing feature T2). No product-count cap (user steering,
// Cycle 0 log): buildCatalogSourcingPrompt and parseCatalogSourcingResponse
// both dropped their maxProducts parameter.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type * as PromptModule from '../src/ai/catalogSourcingPrompt.js';
import type * as ParserModule from '../src/ai/catalogSourcingParser.js';
import type * as LoggerModule from '../src/logger.js';

let prompt: typeof PromptModule;
let parser: typeof ParserModule;
let logger: typeof LoggerModule.logger;

beforeAll(async () => {
  // Dynamic imports so test setup can mock logger before importing modules
  // under test — same pattern imageSourcing.test.ts (ai-reference-
  // autosourcing feature T3) already established for this exact scenario.
  const modules = await Promise.all([
    import('../src/ai/catalogSourcingPrompt.js'),
    import('../src/ai/catalogSourcingParser.js'),
    import('../src/error-handler.js'),
    import('../src/logger.js'),
  ]);

  prompt = modules[0] as typeof PromptModule;
  parser = modules[1] as typeof ParserModule;
  logger = (modules[3] as typeof LoggerModule).logger;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildCatalogSourcingPrompt', () => {
  it('includes the category and brand verbatim', () => {
    const text = prompt.buildCatalogSourcingPrompt('Case', 'Montech');

    expect(text).toContain('Case');
    expect(text).toContain('Montech');
  });

  it('explicitly restricts source to manufacturer only, excluding resellers/marketplaces', () => {
    const text = prompt.buildCatalogSourcingPrompt('PSU', 'Seasonic');

    expect(text).toContain('manufacturer');
    expect(text).toContain('official');
    expect(text.toLowerCase()).toContain('reseller');
    expect(text.toLowerCase()).toContain('amazon');
    expect(text.toLowerCase()).toContain('ebay');
    expect(text.toLowerCase()).toContain('marketplace');
  });

  it('instructs raw-JSON-only output with a products array of partNumber/url pairs', () => {
    const text = prompt.buildCatalogSourcingPrompt('GPU', 'EVGA');

    expect(text).toContain('RAW JSON');
    expect(text).toContain('No markdown, no code fences');
    expect(text).toContain('"products"');
    expect(text).toContain('"partNumber"');
    expect(text).toContain('"url"');
  });

  it('instructs finding every product with no count limit, never inventing results', () => {
    const text = prompt.buildCatalogSourcingPrompt('Motherboard', 'ASUS');

    expect(text.toLowerCase()).toContain('every');
    expect(text).toContain('"products":[]');
    expect(text.toLowerCase()).toContain('do not invent');
    // Must not instruct a numeric cap on how many products to find.
    expect(text.toLowerCase()).not.toContain('up to');
  });

  it('works with all component categories', () => {
    const categories = ['CPU', 'GPU', 'Motherboard', 'RAM', 'Storage', 'PSU', 'Case', 'Cooler', 'Other'] as const;

    for (const category of categories) {
      const text = prompt.buildCatalogSourcingPrompt(category, 'TestBrand');
      expect(text).toContain(category);
      expect(text).toContain('TestBrand');
    }
  });
});

describe('parseCatalogSourcingResponse', () => {
  it('parses a valid response with several real-looking candidates', () => {
    const raw = JSON.stringify({
      products: [
        { partNumber: 'AIR 903 MAX', url: 'https://montechpc.com/air-903-max.webp' },
        { partNumber: 'AIR 903 BASE', url: 'https://montechpc.com/air-903-base.webp' },
      ],
    });

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual([
      { partNumber: 'AIR 903 MAX', url: 'https://montechpc.com/air-903-max.webp' },
      { partNumber: 'AIR 903 BASE', url: 'https://montechpc.com/air-903-base.webp' },
    ]);
  });

  it('parses a large catalog response with no truncation (no count cap)', () => {
    const raw = JSON.stringify({
      products: Array.from({ length: 50 }, (_, i) => ({
        partNumber: `Model ${i}`,
        url: `https://example.com/${i}.jpg`,
      })),
    });

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toHaveLength(50);
  });

  it('parses an empty products array as an empty result, not an error', () => {
    const raw = JSON.stringify({ products: [] });

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual([]);
  });

  it('trims whitespace from partNumber and url strings', () => {
    const raw = JSON.stringify({
      products: [{ partNumber: '  AIR 903 MAX  ', url: '  https://montechpc.com/air-903-max.webp  ' }],
    });

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual([{ partNumber: 'AIR 903 MAX', url: 'https://montechpc.com/air-903-max.webp' }]);
  });

  it('strips a markdown code fence the model added despite being told not to', () => {
    const raw = '```json\n{"products":[{"partNumber":"AIR 903 MAX","url":"https://montechpc.com/x.webp"}]}\n```';

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual([{ partNumber: 'AIR 903 MAX', url: 'https://montechpc.com/x.webp' }]);
  });

  it('drops a malformed entry (missing url) and logs at Warn, keeping the rest', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({
      products: [{ partNumber: 'Good One', url: 'https://example.com/good.jpg' }, { partNumber: 'Bad One' }],
    });

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual([{ partNumber: 'Good One', url: 'https://example.com/good.jpg' }]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('drops a malformed entry (non-string partNumber) and logs at Warn, keeping the rest', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({
      products: [
        { partNumber: 123, url: 'https://example.com/bad.jpg' },
        { partNumber: 'Good One', url: 'https://example.com/good.jpg' },
      ],
    });

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual([{ partNumber: 'Good One', url: 'https://example.com/good.jpg' }]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('drops a non-object entry (e.g. a bare string) and logs at Warn, keeping the rest', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({
      products: ['not an object', { partNumber: 'Good One', url: 'https://example.com/good.jpg' }],
    });

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual([{ partNumber: 'Good One', url: 'https://example.com/good.jpg' }]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('de-duplicates by partNumber, keeping the first occurrence', () => {
    const raw = JSON.stringify({
      products: [
        { partNumber: 'AIR 903 MAX', url: 'https://example.com/first.jpg' },
        { partNumber: 'AIR 903 MAX', url: 'https://example.com/second.jpg' },
      ],
    });

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual([{ partNumber: 'AIR 903 MAX', url: 'https://example.com/first.jpg' }]);
  });

  it('throws AppError(502) for non-JSON output', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(() => parser.parseCatalogSourcingResponse("I couldn't find that brand's site.")).toThrow(
      expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining('did not return valid JSON'),
      }),
    );
  });

  it('throws AppError(502) for JSON missing the products field entirely', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const raw = JSON.stringify({ found: true });

    expect(() => parser.parseCatalogSourcingResponse(raw)).toThrow(
      expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining('products'),
      }),
    );
  });

  it('throws AppError(502) for JSON with a non-array products field', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const raw = JSON.stringify({ products: 'not an array' });

    expect(() => parser.parseCatalogSourcingResponse(raw)).toThrow(
      expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining('products'),
      }),
    );
  });

  it('throws AppError(502) for null as the parsed JSON', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(() => parser.parseCatalogSourcingResponse('null')).toThrow(
      expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining('did not return valid JSON'),
      }),
    );
  });
});

describe('parseCatalogSourcingResponse — markdown fence handling', () => {
  it('handles triple-backtick fence with language specifier and newlines', () => {
    const raw = '```json\n{"products":[{"partNumber":"X","url":"https://test.com/img.png"}]}\n```';

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual([{ partNumber: 'X', url: 'https://test.com/img.png' }]);
  });

  it('handles triple-backtick fence without language specifier', () => {
    const raw = '```\n{"products":[]}\n```';

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual([]);
  });
});
