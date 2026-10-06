// Parses the model's raw stdout into a validated catalog-sourcing result
// (ai-catalog-sourcing feature T2). Follows the same defensive asymmetry as
// imageSourcingParser.ts: structural failure (not JSON, no `products` array)
// is fatal; a malformed individual entry is survivable — dropped from the
// array and logged at Warn, never silently trusted, never failing the whole
// response over one bad entry among several good ones.
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { stripCodeFence } from './identificationParser.js';

/** One verified-shape catalog candidate: a model name/number paired with its claimed image URL. */
export interface CatalogSourcingCandidate {
  partNumber: string;
  url: string;
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

/**
 * Parses the runner's raw stdout into a validated, de-duplicated list of
 * catalog-sourcing candidates. Throws AppError(502) when the output is not
 * JSON or carries no `products` array — never returns an empty result to
 * paper over a failed call. An individual malformed entry (missing/
 * non-string `partNumber` or `url`, or a non-object entry) is dropped and
 * logged at Warn rather than failing the whole response — the same
 * single-bad-entry-is-survivable rule `coerceIdentityCandidates` in
 * identificationParser.ts already applies. The result is de-duplicated by
 * `partNumber` (first occurrence wins). No size cap — the manufacturer's
 * real catalog size is the only limit (user steering, Cycle 0 log).
 */
export function parseCatalogSourcingResponse(rawStdout: string): CatalogSourcingCandidate[] {
  const text = stripCodeFence(rawStdout);
  // JSON.parse throws a SyntaxError whose message leaks nothing useful to a
  // user; a caught parse failure is restated below as a clear 502 instead
  // (the failure is upstream — the model did not answer in the shape it was
  // asked for).
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

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

  return deduped;
}
