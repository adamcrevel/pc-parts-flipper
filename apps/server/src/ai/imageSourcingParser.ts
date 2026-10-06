// Parses the model's raw stdout into a validated image sourcing response.
// Split out so this is the only part dealing with untrusted, non-deterministic
// input. Follows the same defensive asymmetry as identificationParser.ts:
// structural failure (not JSON, no `found` field) is fatal; field-level
// surprise (a malformed `url` when found=true) is survivable — coerced to
// found:false and logged, never silently trusted.
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { stripCodeFence } from './identificationParser.js';

/**
 * The validated result of an image sourcing attempt.
 * When found is false, url is always null.
 * When found is true, url is a non-empty string (the photo URL).
 */
export interface ImageSourcingResult {
  found: boolean;
  url: string | null;
}


// JSON.parse throws a SyntaxError whose message leaks nothing useful to a
// user; this restates it as a clear 502 (the failure is upstream — the model
// did not answer in the shape it was asked for). Mirrors identificationParser's
// own parseJson; kept local for consistency since it is standard wrapping.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Parses the runner's raw stdout into a validated image sourcing result.
 * Throws AppError(502) when the output is not JSON or carries no boolean
 * `found` field — never returns an empty/silent result to paper over a
 * failed call. When found=true but the url field is malformed (missing,
 * not a string, or empty), coerces the whole result to {found: false,
 * url: null} and logs a Warn — the model was asked for something specific
 * and did not deliver it. When found=false, the url field is ignored and
 * normalized to null regardless of what the model sent (no logging needed,
 * a legitimate "not found" carries no url).
 */
export function parseImageSourcingResponse(rawStdout: string): ImageSourcingResult {
  const text = stripCodeFence(rawStdout);
  const parsed = parseJson(text);

  if (typeof parsed !== 'object' || parsed === null) {
    logger.error({ outputPreview: text.slice(0, 200) }, 'AI image sourcing output was not valid JSON');
    throw new AppError('The AI model did not return valid JSON for image sourcing', 502);
  }

  // `in` narrowing rather than an inline cast: the parsed value is untrusted
  // model output, so the property is read as `unknown` and confirmed below.
  const found: unknown = 'found' in parsed ? parsed.found : undefined;
  if (typeof found !== 'boolean') {
    logger.error(
      { outputPreview: text.slice(0, 200), foundValue: found },
      'AI image sourcing output had no boolean found field',
    );
    throw new AppError('The AI model response was missing a boolean "found" field', 502);
  }

  // When found is false, return immediately with url always null
  if (!found) {
    return { found: false, url: null };
  }

  // When found is true, the url field must be a non-empty string
  const url: unknown = 'url' in parsed ? parsed.url : undefined;
  if (typeof url === 'string' && url.trim().length > 0) {
    return { found: true, url: url.trim() };
  }

  // If we get here, found=true but url is malformed (missing, not a string,
  // empty, etc.). This is a failure to deliver what was asked for — coerce
  // to false and log it, never trust an unverified url through.
  logger.warn(
    { url, reason: found === true && !url ? 'missing url when found=true' : 'non-string or empty url when found=true' },
    'AI image sourcing returned found=true but with a malformed url field; coercing to not found',
  );
  return { found: false, url: null };
}
