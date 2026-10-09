// Parses the model's raw stdout into a validated catalog-sourcing result
// (ai-catalog-sourcing feature T2). Follows the same defensive asymmetry as
// imageSourcingParser.ts: structural failure (not JSON, no `products` array)
// is fatal; a malformed individual entry is survivable — dropped from the
// array and logged at Warn, never silently trusted, never failing the whole
// response over one bad entry among several good ones.
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { extractBracketedJson, stripCodeFence } from './identificationParser.js';

/** One verified-shape catalog candidate: a model name/number paired with its claimed image URL. */
export interface CatalogSourcingCandidate {
  partNumber: string;
  url: string;
}

/**
 * One whole catalog-sourcing response: the candidates the model reported,
 * plus its own report of whether it was denied the chance to search.
 *
 * `blocked` is true when a rate limit, a CAPTCHA/"verify you're human"
 * challenge, or any other access-denied condition stopped the model from
 * completing a real browse of the brand's site (sourcing-resilience Req 8).
 * It is reported exactly as the model sent it rather than being inferred
 * from `candidates`, and the two are independent: a model that found three
 * products and was then rate-limited mid-catalog reports both a non-empty
 * `candidates` list and `blocked: true`, which is real information its
 * caller needs — the partial results are usable now, and the combo is still
 * worth retrying later for the rest. An empty `candidates` with
 * `blocked: false` is the only genuine "this brand has nothing in this
 * category" answer, the one outcome worth recording permanently. A response
 * that omits `blocked`, or sends a non-boolean, coerces to false (the
 * pre-existing behaviour: not blocked), with no warning — an older/terser
 * model response is not a malformed one.
 */
export interface CatalogSourcingResult {
  candidates: CatalogSourcingCandidate[];
  blocked: boolean;
}

/** True only for a plain object carrying non-empty string `partNumber` and `url` fields. */
function isValidCandidate(value: unknown): value is CatalogSourcingCandidate {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const partNumber: unknown = 'partNumber' in value ? value.partNumber : undefined;
  const url: unknown = 'url' in value ? value.url : undefined;
  return (
    typeof partNumber === 'string' &&
    partNumber.trim().length > 0 &&
    typeof url === 'string' &&
    url.trim().length > 0
  );
}

// Turns the model's response text into a parsed JSON value, or undefined
// when it carries no usable JSON at all (JSON.parse's SyntaxError message
// leaks nothing useful to a user, so the caller restates undefined as a
// clear 502 instead — the failure is upstream).
//
// Two attempts, in order. The fence-stripped `text` is parsed directly,
// which covers a bare or fully-fenced payload. Only if that fails is the
// outermost `{...}` payload embedded in the ORIGINAL `rawStdout` extracted
// and parsed — bracket search is immune to whether a fence wraps the
// payload, so the original text is the right thing to search. That second
// attempt is the harden-ai-json-parsing fallback, identical in mechanism to
// identificationParser.ts's own: it recovers a response that buried a
// complete, valid payload inside incidental prose the model added despite
// being told not to. A truncated payload (no closing brace to find) or a
// response with no JSON at all still comes back undefined.
function parseResponseJson(rawStdout: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to the embedded-payload attempt below.
  }

  const extracted = extractBracketedJson(rawStdout, 'object');
  if (extracted === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(extracted);
  } catch {
    return undefined;
  }
}

/**
 * Parses the runner's raw stdout into a validated, de-duplicated list of
 * catalog-sourcing candidates plus the model's own `blocked` report.
 * Throws AppError(502) when the output is not JSON or carries no `products`
 * array — never returns an empty result to paper over a failed call. An
 * individual malformed entry (missing/non-string `partNumber` or `url`, or
 * a non-object entry) is dropped and logged at Warn rather than failing the
 * whole response — the same single-bad-entry-is-survivable rule
 * `coerceIdentityCandidates` in identificationParser.ts already applies.
 * The candidate list is de-duplicated by `partNumber` (first occurrence
 * wins). No size cap — the manufacturer's real catalog size is the only
 * limit (user steering, Cycle 0 log). `blocked` is coerced to false when
 * absent or non-boolean, with no warning.
 *
 * A response that embeds a complete, valid JSON object inside incidental
 * prose (a caveat sentence the model added despite the prompt's "no
 * commentary" instruction — live-observed as `"Confirmed — https resolves
 * fine...\n\n{\"products\":[...]}"`) is recovered rather than discarded:
 * the direct parse is tried first, and only on its failure is the outermost
 * `{...}` payload extracted from the ORIGINAL raw text and re-parsed. A
 * genuinely malformed or JSON-free response still throws exactly as before.
 */
export function parseCatalogSourcingResponse(rawStdout: string): CatalogSourcingResult {
  const text = stripCodeFence(rawStdout);
  const parsed = parseResponseJson(rawStdout, text);

  if (typeof parsed !== 'object' || parsed === null) {
    logger.error({ outputPreview: text.slice(0, 200) }, 'AI catalog sourcing output was not valid JSON');
    throw new AppError('The AI model did not return valid JSON for catalog sourcing', 502);
  }

  const products: unknown = 'products' in parsed ? parsed.products : undefined;
  if (!Array.isArray(products)) {
    logger.error(
      { outputPreview: text.slice(0, 200), productsValue: products },
      'AI catalog sourcing output had no products array',
    );
    throw new AppError('The AI model response was missing a "products" array', 502);
  }

  // The model's own "I was denied access" report. Absent or non-boolean
  // coerces to false with no warning: a response that simply omits the field
  // is not malformed, it is a search that was never blocked.
  const blockedValue: unknown = 'blocked' in parsed ? parsed.blocked : undefined;
  const blocked = blockedValue === true;

  const deduped: CatalogSourcingCandidate[] = [];
  const seenPartNumbers = new Set<string>();

  for (const entry of products) {
    if (!isValidCandidate(entry)) {
      logger.warn({ entry }, 'AI catalog sourcing returned a malformed product entry; dropping it');
      continue;
    }
    const candidate: CatalogSourcingCandidate = { partNumber: entry.partNumber.trim(), url: entry.url.trim() };
    if (seenPartNumbers.has(candidate.partNumber)) {
      continue;
    }
    seenPartNumbers.add(candidate.partNumber);
    deduped.push(candidate);
  }

  return { candidates: deduped, blocked };
}
