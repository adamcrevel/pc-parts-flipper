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
import type { AiIdentifiedPart, AiPartConfidence, AiPartSource, ComponentCategory, IdentifyPartsResponse } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { ALLOWED_CATEGORIES } from './identificationPrompt.js';

const VALID_CONFIDENCES: readonly AiPartConfidence[] = ['high', 'medium', 'low'];
const VALID_SOURCES: readonly AiPartSource[] = ['text', 'image', 'both'];

// Fallbacks for a field the model returned in a shape not on the allow-list.
// Both are deliberately the *least* assertive option available: an unreadable
// confidence must not present as 'high', and an unreadable basis must not
// claim a photo was involved.
const FALLBACK_CONFIDENCE: AiPartConfidence = 'low';
const FALLBACK_SOURCE: AiPartSource = 'text';

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

// Loosely-typed view of one parsed part before any field has been confirmed.
interface RawPart {
  category?: unknown;
  description?: unknown;
  confidence?: unknown;
  source?: unknown;
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

// Normalizes one part. Every field is defended independently so a single odd
// value never costs more than that one field.
function normalizePart(raw: RawPart): AiIdentifiedPart {
  const confidence = typeof raw.confidence === 'string' && (VALID_CONFIDENCES as readonly string[]).includes(raw.confidence)
    ? (raw.confidence as AiPartConfidence)
    : FALLBACK_CONFIDENCE;
  const source = typeof raw.source === 'string' && (VALID_SOURCES as readonly string[]).includes(raw.source)
    ? (raw.source as AiPartSource)
    : FALLBACK_SOURCE;

  return {
    category: coerceCategory(raw.category),
    description: typeof raw.description === 'string' ? raw.description : '',
    confidence,
    source,
  };
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
  const parsed = parseJson(text);

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
