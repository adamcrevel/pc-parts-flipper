// Builds the exact prompt text sent to the vision model for AI part
// identification. Split out of partIdentification.ts so the prompt wording —
// the part of this feature most likely to be tuned — can be read, reviewed and
// unit-tested on its own, without the process-spawning machinery around it.
import type { ComponentCategory } from '@pc-parts-flipper/shared';
import type { Listing } from '../db/index.js';
import { VALID_CATEGORIES } from '../routes/listingValidation.js';

// Re-exported from the route validation module rather than re-listed here, so
// the categories the model is told to use can never drift from the ones the
// Expected Parts editor and the DuckDB ENUM column actually accept.
export const ALLOWED_CATEGORIES: readonly ComponentCategory[] = VALID_CATEGORIES;

/**
 * Builds the prompt for one Listing. The instructions it carries are load
 * bearing, each for an observed reason:
 *
 * - The allowed category list is enumerated inline because the model otherwise
 *   invents plausible-but-unusable categories ("Graphics Card", "SSD") that no
 *   longer map onto the Expected Parts editor's fixed select.
 * - The honesty/conservatism instruction is what produces genuinely useful
 *   output: told to say so when a part cannot be narrowed down, the model
 *   reports "some DDR4 DIMMs, capacity not legible" instead of confidently
 *   guessing a specific kit. Do not weaken it.
 * - The brand/partNumber instruction asks for the component's identity as two
 *   structured fields rather than as prose, because those two values are what
 *   a resale listing's title is built from downstream. The explicit "use null,
 *   do not guess" wording is load bearing for the same reason: a hallucinated
 *   model number would silently become the headline of a real sale listing.
 * - Narrowing description to "what brand/partNumber do not already say" keeps
 *   the model from restating the identity as a sentence, which would leave two
 *   sources of truth for the same fact.
 * - The per-part basis (text/image/both) lets the user weigh a part read off
 *   the seller's own spec list differently from one recognized in a photo.
 * - The raw-JSON-only instruction exists because anything else (a code fence,
 *   a sentence of preamble) has to be stripped back off by the parser.
 */
export function buildIdentificationPrompt(listing: Listing): string {
  const categoryList = ALLOWED_CATEGORIES.join(', ');
  // A Listing's description is nullable; a literal "(none provided)" tells the
  // model the field was empty rather than leaving a blank it might read as a
  // truncated prompt.
  const description = listing.description?.trim() ? listing.description : '(none provided)';

  return [
    'You are helping identify the individual PC components contained in a used pre-built computer that is for sale.',
    '',
    'LISTING TITLE:',
    listing.title,
    '',
    'LISTING DESCRIPTION:',
    description,
    '',
    'Any images attached to this message are photos from the same listing.',
    '',
    'For each component you can identify, report it as one part.',
    '',
    'RULES:',
    `1. The "category" field MUST be exactly one of these values, and nothing else: ${categoryList}. If a component does not fit any of the specific values, use "Other" and explain what it is in the description.`,
    '2. Report the component\'s identity as two separate fields: "brand" is the manufacturer (e.g. "NVIDIA", "Corsair", "Samsung") and "partNumber" is the specific model or part number (e.g. "RTX 3060", "MZ-V8V1T0B", "Vengeance LPX 16GB"). Use JSON null for either one you cannot confidently support from the listing text or the photos. Do NOT guess, do NOT infer a likely brand from the category, and do NOT put a placeholder such as "Unknown" or "N/A" in these fields — null is the correct answer when you do not know.',
    '3. The "description" field is for what "brand" and "partNumber" do not already say: condition, quantity, capacity/speed where it is not part of the model name, and any notable detail. Do NOT restate the brand or model number there as a sentence.',
    '4. Be honest and conservative. If you cannot fully narrow a part down, say exactly what you can tell and what you cannot in its description (e.g. "DDR4 DIMMs, 2 sticks, capacity not legible"), leave "brand"/"partNumber" null for whichever you cannot establish, and lower its confidence. Do NOT guess a specific model, capacity or speed you cannot actually support from the listing text or the photos. An honest partial identification is far more useful than a confident wrong one.',
    '5. For every part, state what your identification is based on in the "source" field: "text" if it came from the listing title/description only, "image" if it came from a photo only, or "both" if the text and a photo agree.',
    '6. Set "confidence" to "high", "medium" or "low" reflecting how sure you are of that specific part.',
    '7. Use the "notes" field for anything that does not belong to one specific part — caveats, data-quality warnings, or observations about the listing itself (for example if the photos look like stock/marketing images rather than the actual item being sold). Use an empty string if you have nothing to add.',
    '',
    'RESPOND WITH ONLY RAW JSON matching exactly this shape. No markdown, no code fences, no commentary before or after:',
    '{"parts":[{"category":"GPU","brand":"NVIDIA","partNumber":"RTX 3060","description":"12GB, tested working, light dust","confidence":"high","source":"both"},{"category":"RAM","brand":null,"partNumber":null,"description":"2 DDR4 DIMMs, capacity not legible in photos","confidence":"low","source":"image"}],"notes":"..."}',
  ].join('\n');
}
