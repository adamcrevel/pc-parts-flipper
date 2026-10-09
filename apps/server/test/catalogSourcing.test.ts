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

  it('tells the model to report blocked:true for a rate limit or CAPTCHA, distinctly from a completed nothing-found search (sourcing-resilience Req 8)', () => {
    const text = prompt.buildCatalogSourcingPrompt('GPU', 'Zotac');

    // The access-denied conditions the live failures actually looked like.
    expect(text.toLowerCase()).toContain('rate limit');
    expect(text.toLowerCase()).toContain('captcha');
    // Both JSON shapes must be spelled out, or the model has no way to tell
    // the two empty-catalog outcomes apart.
    expect(text).toContain('{"products":[],"blocked":true}');
    expect(text).toContain('{"products":[],"blocked":false}');
    // And the blocked:true case must be explicitly fenced off from the
    // ordinary "searched, found nothing" case.
    expect(text).toContain('never for a search you were able to run that simply turned up nothing');
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

    expect(result).toEqual({
      candidates: [
        { partNumber: 'AIR 903 MAX', url: 'https://montechpc.com/air-903-max.webp' },
        { partNumber: 'AIR 903 BASE', url: 'https://montechpc.com/air-903-base.webp' },
      ],
      blocked: false,
    });
  });

  it('parses a large catalog response with no truncation (no count cap)', () => {
    const raw = JSON.stringify({
      products: Array.from({ length: 50 }, (_, i) => ({
        partNumber: `Model ${i}`,
        url: `https://example.com/${i}.jpg`,
      })),
    });

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result.candidates).toHaveLength(50);
  });

  it('parses an empty products array as an empty result, not an error', () => {
    const raw = JSON.stringify({ products: [] });

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual({ candidates: [], blocked: false });
  });

  it('trims whitespace from partNumber and url strings', () => {
    const raw = JSON.stringify({
      products: [{ partNumber: '  AIR 903 MAX  ', url: '  https://montechpc.com/air-903-max.webp  ' }],
    });

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual({
      candidates: [{ partNumber: 'AIR 903 MAX', url: 'https://montechpc.com/air-903-max.webp' }],
      blocked: false,
    });
  });

  it('strips a markdown code fence the model added despite being told not to', () => {
    const raw = '```json\n{"products":[{"partNumber":"AIR 903 MAX","url":"https://montechpc.com/x.webp"}]}\n```';

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual({
      candidates: [{ partNumber: 'AIR 903 MAX', url: 'https://montechpc.com/x.webp' }],
      blocked: false,
    });
  });

  it('drops a malformed entry (missing url) and logs at Warn, keeping the rest', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({
      products: [{ partNumber: 'Good One', url: 'https://example.com/good.jpg' }, { partNumber: 'Bad One' }],
    });

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual({
      candidates: [{ partNumber: 'Good One', url: 'https://example.com/good.jpg' }],
      blocked: false,
    });
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

    expect(result).toEqual({
      candidates: [{ partNumber: 'Good One', url: 'https://example.com/good.jpg' }],
      blocked: false,
    });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('drops a non-object entry (e.g. a bare string) and logs at Warn, keeping the rest', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({
      products: ['not an object', { partNumber: 'Good One', url: 'https://example.com/good.jpg' }],
    });

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual({
      candidates: [{ partNumber: 'Good One', url: 'https://example.com/good.jpg' }],
      blocked: false,
    });
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

    expect(result).toEqual({
      candidates: [{ partNumber: 'AIR 903 MAX', url: 'https://example.com/first.jpg' }],
      blocked: false,
    });
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

    expect(result).toEqual({
      candidates: [{ partNumber: 'X', url: 'https://test.com/img.png' }],
      blocked: false,
    });
  });

  it('handles triple-backtick fence without language specifier', () => {
    const raw = '```\n{"products":[]}\n```';

    const result = parser.parseCatalogSourcingResponse(raw);

    expect(result).toEqual({ candidates: [], blocked: false });
  });
});

describe('parseCatalogSourcingResponse — blocked field (sourcing-resilience Req 8)', () => {
  it('reports blocked:true for the live-observed rate-limit/CAPTCHA shape', () => {
    const raw = JSON.stringify({ products: [], blocked: true });

    expect(parser.parseCatalogSourcingResponse(raw)).toEqual({ candidates: [], blocked: true });
  });

  it('reports a partial catalog alongside blocked:true rather than discarding either signal', () => {
    const raw = JSON.stringify({
      products: [{ partNumber: 'AIR 903 MAX', url: 'https://montechpc.com/a.webp' }],
      blocked: true,
    });

    expect(parser.parseCatalogSourcingResponse(raw)).toEqual({
      candidates: [{ partNumber: 'AIR 903 MAX', url: 'https://montechpc.com/a.webp' }],
      blocked: true,
    });
  });

  it('coerces an absent blocked field to false without warning (older/terser response)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({ products: [] });

    expect(parser.parseCatalogSourcingResponse(raw).blocked).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('coerces a non-boolean blocked field to false without warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    for (const blockedValue of ['true', 1, {}, [], null]) {
      const raw = JSON.stringify({ products: [], blocked: blockedValue });
      expect(parser.parseCatalogSourcingResponse(raw).blocked).toBe(false);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('parseCatalogSourcingResponse — prose-wrapped JSON recovery (sourcing-resilience Req 9)', () => {
  it('recovers the live-observed "Confirmed — https resolves fine..." response', () => {
    // The exact failure shape captured from a real run: a sentence of
    // commentary, then a bare (unfenced) valid payload. stripCodeFence leaves
    // the prose in place and the direct JSON.parse fails, so this can only
    // pass via extractBracketedJson.
    const raw =
      'Confirmed — https resolves fine on their CDN.\n\n{"products":[{"partNumber":"AIR 903 MAX","url":"https://montechpc.com/a.webp"}]}';

    expect(parser.parseCatalogSourcingResponse(raw)).toEqual({
      candidates: [{ partNumber: 'AIR 903 MAX', url: 'https://montechpc.com/a.webp' }],
      blocked: false,
    });
  });

  it('recovers a blocked:true payload wrapped in prose on both sides', () => {
    const raw = 'Their site showed me a CAPTCHA.\n{"products":[],"blocked":true}\nHope that helps.';

    expect(parser.parseCatalogSourcingResponse(raw)).toEqual({ candidates: [], blocked: true });
  });

  it('still throws AppError(502) for prose carrying no JSON object at all', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(() => parser.parseCatalogSourcingResponse('I was rate limited and gave up [no payload].')).toThrow(
      expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining('did not return valid JSON'),
      }),
    );
  });

  it('still throws AppError(502) for a payload truncated before its closing brace', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(() => parser.parseCatalogSourcingResponse('Here you go:\n{"products":[{"partNumber":"X"')).toThrow(
      expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining('did not return valid JSON'),
      }),
    );
  });
});
