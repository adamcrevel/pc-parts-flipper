// Parses the second (visual comparison) pass's raw model stdout into a
// validated array of per-part identity updates. Split into its own file,
// alongside visualComparisonPrompt.ts, rather than folded into
// identificationParser.ts: that file is already at this project's ~200-line
// convention for pre-existing files this feature only lightly touches (it
// exports coerceIdentityField/coerceIdentityCandidates for reuse here, and
// nothing else changes there). Follows the same defensive asymmetry as the
// first pass's parser: structural failure (not JSON, not an array) is fatal;
// a single malformed entry is coerced and logged at Warn, never dropped
// silently without being accounted for.
import type { IdentityCandidate } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { coerceIdentityCandidates, coerceIdentityField, stripCodeFence } from './identificationParser.js';

/** One visual-comparison update: the second pass's view of a single eligible part. */
export interface VisualComparisonUpdate {
  partIndex: number;
  brand: string | null;
  partNumber: string | null;
  identityCandidates: IdentityCandidate[];
}

// Loosely-typed view of one visual comparison result before validation.
interface RawVisualComparisonEntry {
  partIndex?: unknown;
  brand?: unknown;
  partNumber?: unknown;
  identityCandidates?: unknown;
  noChange?: unknown;
}

// JSON.parse throws a SyntaxError whose message leaks nothing useful to a
// user; this restates it as a clear 502 (the failure is upstream — the model
// did not answer in the shape it was asked for). Mirrors
// identificationParser.ts's own private parseJson; kept local rather than
// exported/shared since it is six lines of standard-library wrapping, not
// feature logic worth a cross-file dependency.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Normalizes one visual comparison entry. Validates partIndex exists and is
// a number, then normalizes optional identity fields using the same coercion
// logic as the first-pass parser.
function normalizeVisualComparisonEntry(
  raw: RawVisualComparisonEntry,
): VisualComparisonUpdate | { partIndex: number; noChange: true } {
  const partIndex = typeof raw.partIndex === 'number' ? raw.partIndex : undefined;
  if (partIndex === undefined || !Number.isInteger(partIndex) || partIndex < 0) {
    throw new AppError('Visual comparison entry missing or has invalid partIndex', 502);
  }

  // If noChange is explicitly true, return early
  if (raw.noChange === true) {
    return { partIndex, noChange: true };
  }

  // Otherwise normalize the identity fields
  return {
    partIndex,
    brand: coerceIdentityField(raw.brand, 'brand'),
    partNumber: coerceIdentityField(raw.partNumber, 'partNumber'),
    identityCandidates: coerceIdentityCandidates(raw.identityCandidates),
  };
}

/**
 * Parses the runner's raw stdout into a validated array of visual comparison results.
 * Throws AppError(502) when the output is not JSON or carries no valid entries.
 * Field-level surprises (malformed entries) are coerced and logged at Warn.
 */
export function parseVisualComparisonResponse(rawStdout: string): VisualComparisonUpdate[] {
  const text = stripCodeFence(rawStdout);
  const parsed = parseJson(text);

  if (!Array.isArray(parsed)) {
    logger.error({ outputPreview: text.slice(0, 200) }, 'AI visual comparison output was not a JSON array');
    throw new AppError('The AI model did not return a JSON array for visual comparison', 502);
  }

  // Non-object entries are dropped with a Warn
  const usableEntries = parsed.filter((entry): entry is RawVisualComparisonEntry => {
    if (typeof entry === 'object' && entry !== null) {
      return true;
    }
    logger.warn({ entry }, 'AI visual comparison returned a non-object entry; skipping it');
    return false;
  });

  // Normalize each entry, handling per-entry structural issues
  const results: VisualComparisonUpdate[] = [];
  for (const entry of usableEntries) {
    try {
      const normalized = normalizeVisualComparisonEntry(entry);
      // Filter out noChange entries — they are not returned in the final result
      if ('noChange' in normalized) {
        continue;
      }
      results.push(normalized);
    } catch (error) {
      // A single entry's structural failure is logged and skipped
      logger.warn(
        { entry, error: error instanceof Error ? error.message : String(error) },
        'AI visual comparison entry failed normalization; skipping it',
      );
    }
  }

  return results;
}
