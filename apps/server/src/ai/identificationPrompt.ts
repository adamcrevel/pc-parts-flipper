// Builds the exact prompt text sent to the vision model for AI part
// identification. Split out of partIdentification.ts so the prompt wording —
// the part of this feature most likely to be tuned — can be read, reviewed and
// unit-tested on its own, without the process-spawning machinery around it.
import type { ComponentCategory } from '@pc-parts-flipper/shared';
import type { ExpectedPart, Listing } from '../db/index.js';
import { VALID_CATEGORIES } from '../routes/listingValidation.js';

// Re-exported from the route validation module rather than re-listed here, so
// the categories the model is told to use can never drift from the ones the
// Expected Parts editor and the DuckDB ENUM column actually accept.
export const ALLOWED_CATEGORIES: readonly ComponentCategory[] = VALID_CATEGORIES;

// Upper bound on how many alternates `identityCandidates` may carry for one
// part. Shared between the prompt instruction (below) and the parser's
// cap-and-Warn enforcement, so the two can never drift apart.
export const MAX_IDENTITY_CANDIDATES = 4;

/**
 * Renders the "PREVIOUS IDENTIFICATION" prompt section from a Listing's
 * live Expected Parts, one line per part (category/brand/partNumber plus its
 * note or "(none)"). Lists every existing part, not filtered to only the
 * noted ones, so the model has the full previous breakdown to reason
 * against, not just the subset a human happened to annotate.
 */
function formatPreviousIdentification(existingParts: readonly ExpectedPart[]): string {
  const lines = existingParts.map((part) => {
    const identity = [part.componentCategory, part.brand ?? '(brand unknown)', part.partNumber ?? '(part number unknown)'].join(' / ');
    const note = part.notes?.trim() ? part.notes.trim() : '(none)';
    return `- ${identity} — note: ${note}`;
  });
  return ['PREVIOUS IDENTIFICATION (from an earlier pass on this same listing):', ...lines].join('\n');
}

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
 * - For non-working listings, the workingStatus rule asks the model to assess
 *   whether each part is itself broken or working, for per-part diagnostics.
 * - When `existingParts` is non-empty (a re-identification), a PREVIOUS
 *   IDENTIFICATION section and two extra rules ask the model to treat a
 *   human's note as a correction and carry it forward onto the matching new
 *   part's own "notes" field — kept explicitly distinct from the existing
 *   whole-response "notes" field (rule 7) so the model never conflates the
 *   two. Passing no `existingParts` (the default) reproduces the original,
 *   first-ever-identification prompt unchanged.
 */
export function buildIdentificationPrompt(listing: Listing, existingParts: ExpectedPart[] = []): string {
  const categoryList = ALLOWED_CATEGORIES.join(', ');
  // A Listing's description is nullable; a literal "(none provided)" tells the
  // model the field was empty rather than leaving a blank it might read as a
  // truncated prompt.
  const description = listing.description?.trim() ? listing.description : '(none provided)';

  const rules = [
    `1. The "category" field MUST be exactly one of these values, and nothing else: ${categoryList}. If a component does not fit any of the specific values, use "Other" and explain what it is in the description.`,
    '2. Report the component\'s identity as two separate fields: "brand" is the manufacturer (e.g. "NVIDIA", "Corsair", "Samsung") and "partNumber" is the specific model or part number (e.g. "RTX 3060", "MZ-V8V1T0B", "Vengeance LPX 16GB"). Use JSON null for either one you cannot confidently support from the listing text or the photos. Do NOT guess, do NOT infer a likely brand from the category, and do NOT put a placeholder such as "Unknown" or "N/A" in these fields — null is the correct answer when you do not know.',
    '3. The "description" field is for what "brand" and "partNumber" do not already say: condition, quantity, capacity/speed where it is not part of the model name, and any notable detail. Do NOT restate the brand or model number there as a sentence.',
    '4. Be honest and conservative. If you cannot fully narrow a part down, say exactly what you can tell and what you cannot in its description (e.g. "DDR4 DIMMs, 2 sticks, capacity not legible"), leave "brand"/"partNumber" null for whichever you cannot establish, and lower its confidence. Do NOT guess a specific model, capacity or speed you cannot actually support from the listing text or the photos. An honest partial identification is far more useful than a confident wrong one.',
    '5. For every part, state what your identification is based on in the "source" field: "text" if it came from the listing title/description only, "image" if it came from a photo only, or "both" if the text and a photo agree.',
    '6. Set "confidence" to "high", "medium" or "low" reflecting how sure you are of that specific part.',
    '7. Use the "notes" field for anything that does not belong to one specific part — caveats, data-quality warnings, or observations about the listing itself (for example if the photos look like stock/marketing images rather than the actual item being sold). Use an empty string if you have nothing to add.',
    `8. If you cannot settle on one brand but can narrow it down to a short list of specific, genuinely plausible brands, report them in an "identityCandidates" array of {"brand","partNumber"} pairs, ranked most-to-least likely and capped at ${MAX_IDENTITY_CANDIDATES} entries — fill in "partNumber" per candidate where you know it, else null. The same applies when the brand is known but the exact model/part number is only narrowed to a short list: repeat that brand on every candidate and vary "partNumber". Do NOT pad the list by repeating the same pair, and do NOT include a candidate identical to the "brand"/"partNumber" you already reported at the top level. Leave "identityCandidates" as an empty array when there is no real lead to narrow from — never invent…`,
  ];

  // Add per-part notes carry-forward rules only for a re-identification
  // (existingParts non-empty); numbered after the fixed rules 1-8 so a
  // first-ever identification (existingParts empty, the default) keeps
  // exactly the same rule numbering and prompt text as before.
  let nextRuleNumber = 9;
  if (existingParts.length > 0) {
    rules.push(
      `${nextRuleNumber}. The PREVIOUS IDENTIFICATION section below lists this listing's existing Expected Parts and any human-entered note on each. Treat each note as a human correction or clarification for that specific part, and prefer its guidance over what the listing text or photos alone would suggest whenever the two conflict.`,
    );
    nextRuleNumber += 1;
    rules.push(
      `${nextRuleNumber}. For each part in your new identification that corresponds to one of the parts listed in PREVIOUS IDENTIFICATION, carry that part's note forward into THIS part's own "notes" field — verbatim or lightly adapted. A part with no corresponding previous note, or a newly-identified part with no match in PREVIOUS IDENTIFICATION, gets "notes":"" (empty string). This per-part "notes" field is distinct from the whole-response "notes" field described in rule 7: rule 7's "notes" is for caveats about the listing as a whole, this one is this specific part's carried-forward note. Never put one kind of content in the other.`,
    );
    nextRuleNumber += 1;
  }

  // Add working-status rule only when the listing is marked non-working.
  if (listing.nonWorking) {
    rules.push(
      `${nextRuleNumber}. For each part, set the "workingStatus" field to reflect whether this specific part is broken or working. Use "non_working" if the listing text specifically says or clearly implies that this exact part does not work. Use "working" if the text specifically clears this part (e.g. "GPU tested working"), OR if the text calls out a different part as broken while saying nothing against this one. Use "unclear" if nothing in the text gives you a clear signal either way for this specific part.`,
    );
  }

  const jsonExample = listing.nonWorking
    ? '{"parts":[{"category":"GPU","brand":"NVIDIA","partNumber":"RTX 3060","description":"12GB, tested working, light dust","confidence":"high","source":"both","identityCandidates":[],"workingStatus":"working","notes":"..."},{"category":"RAM","brand":null,"partNumber":null,"description":"2 DDR4 DIMMs, capacity not legible in photos","confidence":"low","source":"image","identityCandidates":[],"workingStatus":"unclear","notes":"..."},{"category":"GPU","brand":"NVIDIA","partNumber":null,"description":"single fan, blower-style cooler, one fan not spinning","confidence":"medium","source":"image","identityCandidates":[{"brand":"NVIDIA","partNumber":"GTX 1650"},{"brand":"NVIDIA","partNumber":"GTX 1650 Super"}],"workingStatus":"non_working","notes":"..."}],"notes":"..."}'
    : '{"parts":[{"category":"GPU","brand":"NVIDIA","partNumber":"RTX 3060","description":"12GB, tested working, light dust","confidence":"high","source":"both","identityCandidates":[],"notes":"..."},{"category":"RAM","brand":null,"partNumber":null,"description":"2 DDR4 DIMMs, capacity not legible in photos","confidence":"low","source":"image","identityCandidates":[],"notes":"..."},{"category":"GPU","brand":"NVIDIA","partNumber":null,"description":"single fan, blower-style cooler","confidence":"medium","source":"image","identityCandidates":[{"brand":"NVIDIA","partNumber":"GTX 1650"},{"brand":"NVIDIA","partNumber":"GTX 1650 Super"}],"notes":"..."}],"notes":"..."}';

  const previousIdentificationSection = existingParts.length > 0 ? formatPreviousIdentification(existingParts) : null;

  return [
    'You are helping identify the individual PC components contained in a used pre-built computer that is for sale.',
    '',
    'LISTING TITLE:',
    listing.title,
    '',
    'LISTING DESCRIPTION:',
    description,
    '',
    ...(previousIdentificationSection ? [previousIdentificationSection, ''] : []),
    'Any images attached to this message are photos from the same listing.',
    '',
    'For each component you can identify, report it as one part.',
    '',
    'RULES:',
    ...rules,
    '',
    'RESPOND WITH ONLY RAW JSON matching exactly this shape. No markdown, no code fences, no commentary before or after:',
    jsonExample,
  ].join('\n');
}
