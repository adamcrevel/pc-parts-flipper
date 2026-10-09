// Turns the model's raw stdout into a validated IdentifyPartsResponse.
// Split out of partIdentification.ts because this is the only part of the
// feature dealing with untrusted, non-deterministic input, and it carries a
// deliberate asymmetry worth reading on its own:
//
//   - Structural failure (not JSON at all, no `parts` array) is fatal — a
//     silent empty result must never stand in for a failed call.
//   - Field-level surprise (an unknown category, a confidence the model
//     invented) is survivable — one odd field is coerced to a safe value and
//     logged at Warn, rather than throwing away an otherwise useful set of
//     suggestions the user can edit by hand anyway.
import type { AiIdentifiedPart, AiPartConfidence, AiPartSource, AiPartWorkingStatus, ComponentCategory, IdentifyPartsResponse, IdentityCandidate } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { ALLOWED_CATEGORIES, MAX_IDENTITY_CANDIDATES } from './identificationPrompt.js';

const VALID_CONFIDENCES: readonly AiPartConfidence[] = ['high', 'medium', 'low'];
const VALID_SOURCES: readonly AiPartSource[] = ['text', 'image', 'both'];
const VALID_WORKING_STATUSES: readonly AiPartWorkingStatus[] = ['working', 'non_working', 'unclear'];

// Fallbacks for a field the model returned in a shape not on the allow-list.
// Both are deliberately the *least* assertive option available: an unreadable
// confidence must not present as 'high', and an unreadable basis must not
// claim a photo was involved. For workingStatus, fallback to 'unclear' when
// the model's input is unrecognized or missing.
const FALLBACK_CONFIDENCE: AiPartConfidence = 'low';
const FALLBACK_SOURCE: AiPartSource = 'text';
const FALLBACK_WORKING_STATUS: AiPartWorkingStatus = 'unclear';

// Matches an opening markdown fence (``` or ```json) at the very start of the
// output, and a closing fence at the very end. Defensive only: the prompt asks
// for raw JSON, but a fenced response is the single most likely way for a
// model to disregard that, and recovering costs one regex.
const OPENING_FENCE = /^```[^\n]*\n?/;
const CLOSING_FENCE = /\n?```$/;

/** Removes a wrapping markdown code fence, if the model added one despite being told not to. */
export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed.replace(OPENING_FENCE, '').replace(CLOSING_FENCE, '').trim();
}

/**
 * Finds the outermost bracketed JSON payload embedded in `text`: the
 * substring running from the first opening bracket matching `kind` (`{` for
 * `'object'`, `[` for `'array'`) to the LAST occurrence of its matching
 * closing bracket, inclusive. Returns `undefined` if either bracket is
 * absent, or if the closing bracket occurs before the opening one.
 *
 * Pure string search — it does no JSON validation of its own; the caller
 * still runs the returned substring through `parseJson`/`JSON.parse` to
 * confirm it is actually valid. Used as the fallback for a model response
 * that wraps a genuinely valid JSON payload in incidental prose (a caveat
 * sentence before or after it, despite the prompt's "no commentary"
 * instruction) — a direct parse of the full response fails, but the
 * substring this function extracts parses cleanly. Deliberately not a more
 * elaborate recovery: a truncated/incomplete payload (cut off mid-generation)
 * still fails, since the closing bracket it should have isn't there to find.
 */
export function extractBracketedJson(text: string, kind: 'object' | 'array'): string | undefined {
  const openChar = kind === 'object' ? '{' : '[';
  const closeChar = kind === 'object' ? '}' : ']';

  const openIndex = text.indexOf(openChar);
  const closeIndex = text.lastIndexOf(closeChar);

  if (openIndex === -1 || closeIndex === -1 || closeIndex < openIndex) {
    return undefined;
  }

  return text.slice(openIndex, closeIndex + 1);
}

// Loosely-typed view of one parsed part before any field has been confirmed.
interface RawPart {
  category?: unknown;
  brand?: unknown;
  partNumber?: unknown;
  description?: unknown;
  confidence?: unknown;
  source?: unknown;
  identityCandidates?: unknown;
  workingStatus?: unknown;
}

// Coerces an unrecognized category to 'Other' rather than rejecting the whole
// response: the suggestion's description still carries the useful information,
// and the user can re-categorize a draft row in one click.
function coerceCategory(value: unknown): ComponentCategory {
  if (typeof value === 'string' && (ALLOWED_CATEGORIES as readonly string[]).includes(value)) {
    return value as ComponentCategory;
  }
  logger.warn({ category: value }, 'AI identification returned an unrecognized component category; coercing to Other');
  return 'Other';
}

// Normalizes one optional identity field (brand / partNumber). A null or
// absent value is the model correctly saying "not identified" and passes
// through silently; anything else non-string (a number, an object) is a shape
// the model was not asked for, so it is coerced to null *and* logged — never
// dropped without being accounted for. A blank/whitespace string is treated as
// null too: "not identified" must not reach the database as empty text that
// later renders as a blank brand in a sale listing title.
export function coerceIdentityField(value: unknown, field: 'brand' | 'partNumber'): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (value !== null && value !== undefined) {
    logger.warn({ field, value }, 'AI identification returned a non-string part identity field; coercing to null');
  }
  return null;
}

// Normalizes the model's "identityCandidates" array, the alternate
// brand/partNumber pairings it reports when it can narrow a part's identity
// to a short list but not a single answer. A non-array/absent value becomes
// an empty list (the common case: most parts settle on one identity). Each
// entry's brand/partNumber is run through the same coerceIdentityField logic
// as the primary identity fields, so a malformed sub-field is coerced and
// logged the same way rather than failing the whole candidate. An entry that
// coerces to {brand: null, partNumber: null} carries no information and is
// dropped — it is not a real candidate. Exact-duplicate pairs are deduped,
// keeping the first (highest-ranked) occurrence, and anything past
// MAX_IDENTITY_CANDIDATES is dropped with a Warn, mirroring coerceCategory's
// log style: a struct of context plus a one-line description of the coercion.
export function coerceIdentityCandidates(value: unknown): IdentityCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const candidates: IdentityCandidate[] = [];
  for (const entry of value) {
    const raw = typeof entry === 'object' && entry !== null ? (entry as { brand?: unknown; partNumber?: unknown }) : {};
    const brand = coerceIdentityField(raw.brand, 'brand');
    const partNumber = coerceIdentityField(raw.partNumber, 'partNumber');
    if (brand === null && partNumber === null) {
      continue;
    }
    // String key keeps the dedup check O(1) per entry without a nested
    // equality loop; null is distinguishable from any real string value.
    const key = `${brand ?? '\0'}\u0001${partNumber ?? '\0'}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({ brand, partNumber });
  }

  if (candidates.length > MAX_IDENTITY_CANDIDATES) {
    logger.warn(
      { count: candidates.length, max: MAX_IDENTITY_CANDIDATES },
      'AI identification returned more identityCandidates than allowed; truncating to the limit',
    );
    return candidates.slice(0, MAX_IDENTITY_CANDIDATES);
  }
  return candidates;
}

// Normalizes one part. Every field is defended independently so a single odd
// value never costs more than that one field.
function normalizePart(raw: RawPart): AiIdentifiedPart {
  const confidence = typeof raw.confidence === 'string' && (VALID_CONFIDENCES as readonly string[]).includes(raw.confidence)
    ? (raw.confidence as AiPartConfidence)
    : FALLBACK_CONFIDENCE;
  const source = typeof raw.source === 'string' && (VALID_SOURCES as readonly string[]).includes(raw.source)
    ? (raw.source as AiPartSource)
    : FALLBACK_SOURCE;
  const workingStatus = typeof raw.workingStatus === 'string' && (VALID_WORKING_STATUSES as readonly string[]).includes(raw.workingStatus)
    ? (raw.workingStatus as AiPartWorkingStatus)
    : FALLBACK_WORKING_STATUS;

  const result: AiIdentifiedPart = {
    category: coerceCategory(raw.category),
    brand: coerceIdentityField(raw.brand, 'brand'),
    partNumber: coerceIdentityField(raw.partNumber, 'partNumber'),
    description: typeof raw.description === 'string' ? raw.description : '',
    confidence,
    source,
    identityCandidates: coerceIdentityCandidates(raw.identityCandidates),
  };

  // Only include workingStatus if it was present in the raw input (even if it
  // coerced to the fallback value), maintaining backward compatibility for
  // listings where the field was not in the prompt.
  if (raw.workingStatus !== undefined) {
    result.workingStatus = workingStatus;
  }

  return result;
}

// JSON.parse throws a SyntaxError whose message leaks nothing useful to a
// user; this restates it as a clear 502 (the failure is upstream — the model
// did not answer in the shape it was asked for).
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Parses the runner's raw stdout into a validated IdentifyPartsResponse.
 * Throws AppError(502) when the output is not JSON or carries no `parts`
 * array — never returns an empty result to paper over a failed call.
 */
export function parseIdentificationResponse(rawStdout: string): IdentifyPartsResponse {
  const text = stripCodeFence(rawStdout);
  let parsed = parseJson(text);

  // The cheap direct-parse attempt above already covers a bare or
  // fully-fenced JSON payload. This fallback only runs when that attempt
  // failed, and searches the ORIGINAL raw text (not the fence-stripped
  // version — bracket search is immune to whether a fence wraps the
  // payload or not) for an outermost `{...}` payload, recovering a response
  // that embeds valid JSON inside incidental prose the model added despite
  // being told not to.
  if (parsed === undefined) {
    const extracted = extractBracketedJson(rawStdout, 'object');
    if (extracted !== undefined) {
      parsed = parseJson(extracted);
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    logger.error({ outputPreview: text.slice(0, 200) }, 'AI identification output was not valid JSON');
    throw new AppError('The AI model did not return valid JSON for part identification', 502);
  }

  // `in` narrowing rather than an inline cast: the parsed value is untrusted
  // model output, so the property is read as `unknown` and confirmed below.
  const parts: unknown = 'parts' in parsed ? parsed.parts : undefined;
  if (!Array.isArray(parts)) {
    logger.error({ outputPreview: text.slice(0, 200) }, 'AI identification output had no parts array');
    throw new AppError('The AI model response was missing a "parts" array', 502);
  }

  // Non-object entries (a bare string, a null) carry nothing normalizePart
  // could read, so they are dropped with a Warn instead of becoming blank rows.
  const usableParts = parts.filter((entry): entry is RawPart => {
    if (typeof entry === 'object' && entry !== null) {
      return true;
    }
    logger.warn({ entry }, 'AI identification returned a non-object part entry; skipping it');
    return false;
  });

  const notes: unknown = 'notes' in parsed ? parsed.notes : undefined;
  return {
    parts: usableParts.map(normalizePart),
    notes: typeof notes === 'string' ? notes : '',
  };
}

/**
 * Resolves the working status for each part based on the AI model's assessments.
 * Intended to be called only when the listing is marked non-working; the logic
 * implements the working-status inference rules for per-part diagnostics.
 *
 * Logic:
 * - If every part's workingStatus is unclear (or absent), all parts resolve to 'non_working'.
 * - Otherwise, a part resolves to 'non_working' only if its own signal was specifically
 *   "non_working"; parts with unclear signals resolve to 'working' in this case.
 *
 * @param parts - The array of identified parts with optional workingStatus fields.
 * @returns A Map from part index to resolved working status ('working' | 'non_working').
 */
export function resolveWorkingStatuses(
  parts: AiIdentifiedPart[],
): Map<number, 'working' | 'non_working'> {
  // Check if every part has an unclear or missing workingStatus signal.
  const allUnclear = parts.every((part) => part.workingStatus === 'unclear' || part.workingStatus === undefined);

  const result = new Map<number, 'working' | 'non_working'>();

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (allUnclear) {
      // All parts have unclear signals, so all resolve to non_working.
      result.set(i, 'non_working');
    } else {
      // At least one part has a clear signal. This part is non_working only
      // if its own signal is specifically "non_working"; otherwise working.
      result.set(i, part.workingStatus === 'non_working' ? 'non_working' : 'working');
    }
  }

  return result;
}
