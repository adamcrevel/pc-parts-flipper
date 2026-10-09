// Tests for image sourcing prompt builder and response parser
// (ai-reference-autosourcing feature T3).
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type * as PromptModule from '../src/ai/imageSourcingPrompt.js';
import type * as ParserModule from '../src/ai/imageSourcingParser.js';
import type * as LoggerModule from '../src/logger.js';

let prompt: typeof PromptModule;
let parser: typeof ParserModule;
let logger: typeof LoggerModule.logger;

beforeAll(async () => {
  // Dynamic imports so test setup can mock logger before importing modules
  const modules = await Promise.all([
    import('../src/ai/imageSourcingPrompt.js'),
    import('../src/ai/imageSourcingParser.js'),
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

describe('buildImageSourcingPrompt', () => {
  it('includes the category, brand, and partNumber verbatim', () => {
    const text = prompt.buildImageSourcingPrompt('GPU', 'NVIDIA', 'RTX 3060');

    expect(text).toContain('GPU');
    expect(text).toContain('NVIDIA');
    expect(text).toContain('RTX 3060');
  });

  it('explicitly restricts source to manufacturer only, excluding resellers/marketplaces', () => {
    const text = prompt.buildImageSourcingPrompt('CPU', 'Intel', 'i7-13700K');

    // Must mention manufacturer/official
    expect(text).toContain('manufacturer');
    expect(text).toContain('official');
    // Must explicitly exclude resellers and marketplaces
    expect(text.toLowerCase()).toContain('reseller');
    expect(text.toLowerCase()).toContain('amazon');
    expect(text.toLowerCase()).toContain('ebay');
    expect(text.toLowerCase()).toContain('marketplace');
  });

  it('instructs raw-JSON-only output with both found and url keys', () => {
    const text = prompt.buildImageSourcingPrompt('RAM', 'Corsair', 'CMK16GX4M2B3200C16');

    expect(text).toContain('RAW JSON');
    expect(text).toContain('No markdown, no code fences');
    expect(text).toContain('"found"');
    expect(text).toContain('"url"');
  });

  it('tells the model to report blocked:true for a rate limit or CAPTCHA, distinctly from a completed nothing-found search (sourcing-resilience Req 8)', () => {
    const text = prompt.buildImageSourcingPrompt('GPU', 'Zotac', 'RTX 4070');

    // The access-denied conditions the live failures actually looked like.
    expect(text.toLowerCase()).toContain('rate limit');
    expect(text.toLowerCase()).toContain('captcha');
    // Both JSON shapes must be spelled out, or the model has no way to tell
    // the two not-found outcomes apart.
    expect(text).toContain('{"found":false,"url":null,"blocked":true}');
    expect(text).toContain('{"found":false,"url":null,"blocked":false}');
    // And the blocked:true case must be explicitly fenced off from the
    // ordinary "searched, found nothing" case.
    expect(text).toContain('never for a search you were able to run that simply turned up nothing');
  });

  it('works with all component categories', () => {
    const categories = ['CPU', 'GPU', 'Motherboard', 'RAM', 'Storage', 'PSU', 'Case', 'Cooler', 'Other'] as const;

    for (const category of categories) {
      const text = prompt.buildImageSourcingPrompt(category, 'TestBrand', 'TestPart');
      expect(text).toContain(category);
      expect(text).toContain('TestBrand');
      expect(text).toContain('TestPart');
    }
  });
});

describe('parseImageSourcingResponse', () => {
  it('parses a valid found:true response with a real-looking URL', () => {
    const raw = JSON.stringify({
      found: true,
      url: 'https://nvidia.com/en-us/geforce/graphics-cards/30-series/rtx-3060/',
    });

    const result = parser.parseImageSourcingResponse(raw);

    expect(result).toEqual({
      found: true,
      url: 'https://nvidia.com/en-us/geforce/graphics-cards/30-series/rtx-3060/',
      blocked: false,
    });
  });

  it('parses a valid found:false response and ignores the url field', () => {
    const raw = JSON.stringify({
      found: false,
      url: null,
    });

    const result = parser.parseImageSourcingResponse(raw);

    expect(result).toEqual({
      found: false,
      url: null,
      blocked: false,
    });
  });

  it('coerces found:false with a garbage url field to {found:false, url:null} with no warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({
      found: false,
      url: 'https://some-random-url.com',
    });

    const result = parser.parseImageSourcingResponse(raw);

    expect(result).toEqual({
      found: false,
      url: null,
      blocked: false,
    });
    // No warning when found=false, regardless of url value
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('coerces found:true with missing url to {found:false, url:null} and logs at Warn', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({
      found: true,
    });

    const result = parser.parseImageSourcingResponse(raw);

    expect(result).toEqual({
      found: false,
      url: null,
      blocked: false,
    });
    // Accounted for in the log
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ url: undefined }),
      expect.stringContaining('malformed url'),
    );
  });

  it('coerces found:true with non-string url to {found:false, url:null} and logs at Warn', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({
      found: true,
      url: 123,
    });

    const result = parser.parseImageSourcingResponse(raw);

    expect(result).toEqual({
      found: false,
      url: null,
      blocked: false,
    });
    // Accounted for with the malformed value
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ url: 123 }),
      expect.stringContaining('malformed url'),
    );
  });

  it('coerces found:true with empty string url to {found:false, url:null} and logs at Warn', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({
      found: true,
      url: '',
    });

    const result = parser.parseImageSourcingResponse(raw);

    expect(result).toEqual({
      found: false,
      url: null,
      blocked: false,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ url: '' }),
      expect.stringContaining('malformed url'),
    );
  });

  it('coerces found:true with whitespace-only url to {found:false, url:null} and logs at Warn', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({
      found: true,
      url: '   ',
    });

    const result = parser.parseImageSourcingResponse(raw);

    expect(result).toEqual({
      found: false,
      url: null,
      blocked: false,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ url: '   ' }),
      expect.stringContaining('malformed url'),
    );
  });

  it('trims whitespace from a valid url string', () => {
    const raw = JSON.stringify({
      found: true,
      url: '  https://example.com/image.jpg  ',
    });

    const result = parser.parseImageSourcingResponse(raw);

    expect(result).toEqual({
      found: true,
      url: 'https://example.com/image.jpg',
      blocked: false,
    });
  });

  it('strips a markdown code fence the model added despite being told not to', () => {
    const raw = '```json\n{"found":true,"url":"https://example.com/image.jpg"}\n```';

    const result = parser.parseImageSourcingResponse(raw);

    expect(result).toEqual({
      found: true,
      url: 'https://example.com/image.jpg',
      blocked: false,
    });
  });

  it('throws AppError(502) for non-JSON output', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(() => parser.parseImageSourcingResponse("I couldn't find that image.")).toThrow(
      expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining('did not return valid JSON'),
      }),
    );
  });

  it('throws AppError(502) for JSON missing the found field entirely', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const raw = JSON.stringify({
      url: 'https://example.com/image.jpg',
    });

    expect(() => parser.parseImageSourcingResponse(raw)).toThrow(
      expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining('boolean'),
      }),
    );
  });

  it('throws AppError(502) for JSON with non-boolean found field', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const raw = JSON.stringify({
      found: 'yes',
      url: 'https://example.com/image.jpg',
    });

    expect(() => parser.parseImageSourcingResponse(raw)).toThrow(
      expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining('boolean'),
      }),
    );
  });

  it('throws AppError(502) for null as the parsed JSON', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(() => parser.parseImageSourcingResponse('null')).toThrow(
      expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining('did not return valid JSON'),
      }),
    );
  });

  it('never trusts an unverified url through (Requirement 3 preparation)', () => {
    // This test verifies the core contract: found:true without a valid url
    // always coerces to false. This is what allows T4 (the download step) to
    // trust that any found:true result really has a url ready to download.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    // Malformed in every conceivable way
    const testCases = [
      { found: true, url: null },
      { found: true, url: undefined },
      { found: true, url: {} },
      { found: true, url: [] },
      { found: true },
    ];

    for (const testCase of testCases) {
      const raw = JSON.stringify(testCase);
      const result = parser.parseImageSourcingResponse(raw);
      // Every single one must coerce to false
      expect(result.found).toBe(false);
      expect(result.url).toBeNull();
    }

    // Each should have logged a warning
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('parseImageSourcingResponse — markdown fence handling', () => {
  it('handles triple-backtick fence with language specifier and newlines', () => {
    const raw = '```json\n{"found":true,"url":"https://test.com/img.png"}\n```';

    const result = parser.parseImageSourcingResponse(raw);

    expect(result.found).toBe(true);
    expect(result.url).toBe('https://test.com/img.png');
  });

  it('handles triple-backtick fence without language specifier', () => {
    const raw = '```\n{"found":false,"url":null}\n```';

    const result = parser.parseImageSourcingResponse(raw);

    expect(result.found).toBe(false);
    expect(result.url).toBeNull();
  });
});

describe('parseImageSourcingResponse — blocked field (sourcing-resilience Req 8)', () => {
  it('reports blocked:true for the live-observed rate-limit/CAPTCHA shape', () => {
    const raw = JSON.stringify({ found: false, url: null, blocked: true });

    expect(parser.parseImageSourcingResponse(raw)).toEqual({ found: false, url: null, blocked: true });
  });

  it('coerces an absent blocked field to false without warning (older/terser response)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({ found: false, url: null });

    expect(parser.parseImageSourcingResponse(raw).blocked).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('coerces a non-boolean blocked field to false without warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    for (const blockedValue of ['true', 1, {}, [], null]) {
      const raw = JSON.stringify({ found: false, url: null, blocked: blockedValue });
      expect(parser.parseImageSourcingResponse(raw).blocked).toBe(false);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reports blocked as the model sent it alongside a found:true result, rather than inferring it from found', () => {
    // Contradictory, but the parser's job is to report faithfully and let the
    // orchestrator classify — not to silently drop the model's own signal.
    const raw = JSON.stringify({ found: true, url: 'https://example.com/i.jpg', blocked: true });

    expect(parser.parseImageSourcingResponse(raw)).toEqual({
      found: true,
      url: 'https://example.com/i.jpg',
      blocked: true,
    });
  });

  it('carries blocked through the found:true-with-malformed-url coercion', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({ found: true, url: '', blocked: true });

    expect(parser.parseImageSourcingResponse(raw)).toEqual({ found: false, url: null, blocked: true });
  });
});

describe('parseImageSourcingResponse — prose-wrapped JSON recovery (sourcing-resilience Req 9)', () => {
  it('recovers a valid payload the model buried after a sentence of commentary', () => {
    // Not a fenced response: stripCodeFence leaves the prose in place and the
    // direct JSON.parse fails, so this can only pass via extractBracketedJson.
    const raw = 'Confirmed — https resolves fine on their CDN.\n\n{"found":true,"url":"https://zotac.com/img.jpg","blocked":false}';

    expect(parser.parseImageSourcingResponse(raw)).toEqual({
      found: true,
      url: 'https://zotac.com/img.jpg',
      blocked: false,
    });
  });

  it('recovers a blocked:true payload wrapped in prose on both sides', () => {
    const raw = 'I was shown a "verify you are human" page.\n{"found":false,"url":null,"blocked":true}\nHope that helps.';

    expect(parser.parseImageSourcingResponse(raw)).toEqual({ found: false, url: null, blocked: true });
  });

  it('still throws AppError(502) for prose carrying no JSON object at all', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(() => parser.parseImageSourcingResponse('I was rate limited and gave up [no payload].')).toThrow(
      expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining('did not return valid JSON'),
      }),
    );
  });

  it('still throws AppError(502) for a payload truncated before its closing brace', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(() => parser.parseImageSourcingResponse('Here you go:\n{"found":true,"url":"https://x.com/i.jpg"')).toThrow(
      expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining('did not return valid JSON'),
      }),
    );
  });
});
