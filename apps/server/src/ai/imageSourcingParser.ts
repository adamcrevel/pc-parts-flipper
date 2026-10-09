// Parses the model's raw stdout into a validated image sourcing response.
// Split out so this is the only part dealing with untrusted, non-deterministic
// input. Follows the same defensive asymmetry as identificationParser.ts:
// structural failure (not JSON, no `found` field) is fatal; field-level
// surprise (a malformed `url` when found=true) is survivable — coerced to
// found:false and logged, never silently trusted.
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { extractBracketedJson, stripCodeFence } from './identificationParser.js';

/**
 * The validated result of an image sourcing attempt.
 * When found is false, url is always null.
 * When found is true, url is a non-empty string (the photo URL).
 *
 * `blocked` is the model's own report that a rate limit, a CAPTCHA/"verify
 * you're human" challenge, or any other access-denied condition stopped it
 * from completing a real search (sourcing-resilience Req 8). It is reported
 * exactly as the model sent it rather than being inferred from `found`: the
 * caller — not this parser — decides what to do with the combination, and
 * the whole point of the field is to tell an infrastructure failure worth
 * retrying apart from a genuine, completed not-found worth recording
 * permanently. A response that omits it, or sends a non-boolean, coerces to
 * false (the pre-existing behaviour: not blocked), with no warning — an
 * older/terser model response is not a malformed one.
 */
export interface ImageSourcingResult {
  found: boolean;
  url: string | null;
  blocked: boolean;
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

// Reads the `url` field of a found=true response, returning the trimmed URL
// or null when the model did not deliver a usable one (missing, not a
// string, empty, whitespace-only). A null return is always logged at Warn:
// found=true without a real url is a failure to deliver what was asked for,
// and must never be trusted through unaccounted-for.
function normalizeFoundUrl(parsed: object): string | null {
  // `in` narrowing rather than an inline cast: the parsed value is untrusted
  // model output, so the property is read as `unknown` and confirmed below.
  const url: unknown = 'url' in parsed ? parsed.url : undefined;
  if (typeof url === 'string' && url.trim().length > 0) {
    return url.trim();
  }

  logger.warn(
    { url, reason: !url ? 'missing url when found=true' : 'non-string or empty url when found=true' },
    'AI image sourcing returned found=true but with a malformed url field; coercing to not found',
  );
  return null;
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
 * a legitimate "not found" carries no url). The `blocked` flag rides
 * alongside every one of those outcomes, coerced to false when absent or
 * non-boolean.
 *
 * A response that embeds a complete, valid JSON object inside incidental
 * prose (a caveat sentence the model added despite the prompt's "no
 * commentary" instruction) is recovered rather than discarded: the direct
 * parse is tried first, and only on its failure is the outermost `{...}`
 * payload extracted from the ORIGINAL raw text and re-parsed. A genuinely
 * malformed or JSON-free response still throws exactly as before.
 */
export function parseImageSourcingResponse(rawStdout: string): ImageSourcingResult {
  const text = stripCodeFence(rawStdout);
  const parsed = parseResponseJson(rawStdout, text);

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

  // The model's own "I was denied access" report. Absent or non-boolean
  // coerces to false with no warning: a response that simply omits the field
  // is not malformed, it is a search that was never blocked.
  const blockedValue: unknown = 'blocked' in parsed ? parsed.blocked : undefined;
  const blocked = blockedValue === true;

  // When found is false, url is always null regardless of what the model sent
  if (!found) {
    return { found: false, url: null, blocked };
  }

  // When found is true, the url field must survive normalization; a model
  // that could not deliver one coerces the whole result to not-found.
  const url = normalizeFoundUrl(parsed);
  return url === null ? { found: false, url: null, blocked } : { found: true, url, blocked };
}
