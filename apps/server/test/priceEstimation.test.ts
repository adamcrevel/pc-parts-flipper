// Tests for price estimation prompt builder and response parser
// (part-price-estimation feature T2).
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type * as PromptModule from '../src/ai/priceEstimationPrompt.js';
import type * as ParserModule from '../src/ai/priceEstimationParser.js';
import type * as LoggerModule from '../src/logger.js';

let prompt: typeof PromptModule;
let parser: typeof ParserModule;
let logger: typeof LoggerModule.logger;

beforeAll(async () => {
  // Dynamic imports so test setup can mock logger before importing modules
  const modules = await Promise.all([
    import('../src/ai/priceEstimationPrompt.js'),
    import('../src/ai/priceEstimationParser.js'),
    import('../src/logger.js'),
  ]);

  prompt = modules[0] as typeof PromptModule;
  parser = modules[1] as typeof ParserModule;
  logger = (modules[2] as typeof LoggerModule).logger;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildPriceEstimationPrompt', () => {
  it('includes the category, brand, and partNumber verbatim', () => {
    const text = prompt.buildPriceEstimationPrompt('GPU', 'NVIDIA', 'RTX 3060');

    expect(text).toContain('GPU');
    expect(text).toContain('NVIDIA');
    expect(text).toContain('RTX 3060');
  });

  it('asks for a used, working/good-condition estimate rather than new price', () => {
    const text = prompt.buildPriceEstimationPrompt('CPU', 'Intel', 'i7-13700K');

    expect(text.toLowerCase()).toContain('used');
    expect(text.toLowerCase()).toContain('working');
  });

  it('instructs the model to say so rather than guess when not confident (rule 4)', () => {
    const text = prompt.buildPriceEstimationPrompt('RAM', 'Corsair', 'CMK16GX4M2B3200C16');

    // Match rule 4's own sentence specifically via phrases unique to it —
    // not just 'confident' (also appears in the JSON output examples) or
    // 'guess' (also appears in rule 5's 'round-trip-guess') — so deleting
    // rule 4 actually fails this test.
    expect(text).toContain('say so plainly');
    expect(text).toContain('rather than guessing');
  });

  it('instructs raw-JSON-only output with both confident and priceUsd keys', () => {
    const text = prompt.buildPriceEstimationPrompt('Storage', 'Samsung', '970 EVO Plus 1TB');

    expect(text).toContain('RAW JSON');
    expect(text).toContain('No markdown, no code fences');
    expect(text).toContain('"confident"');
    expect(text).toContain('"priceUsd"');
  });

  it('asks for a single price, explicitly not a range', () => {
    const text = prompt.buildPriceEstimationPrompt('PSU', 'EVGA', 'SuperNOVA 750 G5');

    expect(text.toLowerCase()).toContain('single');
    expect(text.toLowerCase()).toContain('not a range');
  });

  it('instructs researching the exact part rather than substituting a similar or newer one (Req 2: that specific category+brand+partNumber)', () => {
    const text = prompt.buildPriceEstimationPrompt('Motherboard', 'ASUS', 'ROG STRIX B550-F');

    expect(text.toLowerCase()).toContain('this exact part');
    expect(text.toLowerCase()).toContain('do not substitute a similar or newer part');
  });

  it('works with all component categories', () => {
    const categories = ['CPU', 'GPU', 'Motherboard', 'RAM', 'Storage', 'PSU', 'Case', 'Cooler', 'Other'] as const;

    for (const category of categories) {
      const text = prompt.buildPriceEstimationPrompt(category, 'TestBrand', 'TestPart');
      expect(text).toContain(category);
      expect(text).toContain('TestBrand');
      expect(text).toContain('TestPart');
    }
  });
});

describe('parsePriceEstimationResponse', () => {
  it('parses a valid confident:true response to its priceUsd number', () => {
    const raw = JSON.stringify({ confident: true, priceUsd: 189.5 });

    expect(parser.parsePriceEstimationResponse(raw)).toBe(189.5);
  });

  it('returns null for an explicit confident:false response, without warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({ confident: false, priceUsd: null });

    expect(parser.parsePriceEstimationResponse(raw)).toBeNull();
    // An honest "I don't know" is the expected path, not a coercion failure.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns null and logs a Warn for confident:true with a missing priceUsd', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({ confident: true });

    expect(parser.parsePriceEstimationResponse(raw)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns null and logs a Warn for confident:true with a non-numeric priceUsd', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({ confident: true, priceUsd: '189.50' });

    expect(parser.parsePriceEstimationResponse(raw)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns null and logs a Warn for confident:true with a zero priceUsd', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({ confident: true, priceUsd: 0 });

    expect(parser.parsePriceEstimationResponse(raw)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns null and logs a Warn for confident:true with a negative priceUsd', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({ confident: true, priceUsd: -45 });

    expect(parser.parsePriceEstimationResponse(raw)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns null and logs a Warn for confident:true with a non-finite priceUsd (JSON numeric overflow to Infinity)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // 1e400 is valid JSON syntax but overflows a double to Infinity on parse —
    // unlike the bare token `Infinity`, which is not valid JSON at all and
    // would be caught by the not-valid-JSON branch instead, never reaching
    // the Number.isFinite guard this test means to exercise.
    const raw = '{"confident":true,"priceUsd":1e400}';

    expect(parser.parsePriceEstimationResponse(raw)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns null without throwing for a plain-English refusal (non-JSON prose)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(() => parser.parsePriceEstimationResponse("I don't have enough data to estimate that.")).not.toThrow();
    expect(parser.parsePriceEstimationResponse("I don't have enough data to estimate that.")).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns null for a price range instead of a single number', () => {
    const raw = JSON.stringify({ confident: true, priceUsd: '150-200' });

    expect(parser.parsePriceEstimationResponse(raw)).toBeNull();
  });

  it('returns null for "no price found" style text', () => {
    expect(parser.parsePriceEstimationResponse('No price found for this part.')).toBeNull();
  });

  it('returns null for null as the parsed JSON, without throwing', () => {
    expect(() => parser.parsePriceEstimationResponse('null')).not.toThrow();
    expect(parser.parsePriceEstimationResponse('null')).toBeNull();
  });

  it('strips a markdown code fence the model added despite being told not to', () => {
    const raw = '```json\n{"confident":true,"priceUsd":42}\n```';

    expect(parser.parsePriceEstimationResponse(raw)).toBe(42);
  });

  it('never invents a number: every non-clean-confident-numeric shape coerces to null', () => {
    // Malformed in every conceivable way
    const testCases = [
      { confident: true, priceUsd: null },
      { confident: true, priceUsd: undefined },
      { confident: true, priceUsd: {} },
      { confident: true, priceUsd: [] },
      { confident: true, priceUsd: 'free' },
      { confident: 'yes', priceUsd: 25 },
      { priceUsd: 25 },
      {},
    ];

    for (const testCase of testCases) {
      const raw = JSON.stringify(testCase);
      expect(parser.parsePriceEstimationResponse(raw)).toBeNull();
    }
  });
});

describe('parsePriceEstimationResponse — prose-wrapped JSON recovery (sourcing-resilience Req 9)', () => {
  it('recovers the live-observed "...$90 consistently." response instead of discarding a real price', () => {
    // The exact failure shape captured from a real run: a sentence of
    // commentary, then a bare (unfenced) valid payload. stripCodeFence leaves
    // the prose in place and the direct JSON.parse fails, so this can only
    // pass via extractBracketedJson.
    const raw = 'Original full-tower case; these sell around $90 consistently.\n\n{"confident":true,"priceUsd":90.00}';

    expect(parser.parsePriceEstimationResponse(raw)).toBe(90);
  });

  it('recovers a payload wrapped in prose on both sides', () => {
    const raw = 'Based on recent sold listings:\n{"confident":true,"priceUsd":42.5}\nPrices vary by condition.';

    expect(parser.parsePriceEstimationResponse(raw)).toBe(42.5);
  });

  it('recovers an honest confident:false buried in prose, still as null and without warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = 'I could not find reliable sold data for this.\n{"confident":false,"priceUsd":null}';

    expect(parser.parsePriceEstimationResponse(raw)).toBeNull();
    // Recovered and understood as a real "I don't know" — not logged as an
    // unparseable response, which is what the pre-fallback path would do.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still returns null for prose carrying no JSON object at all', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(parser.parsePriceEstimationResponse('I was rate limited and gave up [no payload].')).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('still returns null for a payload truncated before its closing brace', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    expect(parser.parsePriceEstimationResponse('Here you go:\n{"confident":true,"priceUsd":90')).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});
