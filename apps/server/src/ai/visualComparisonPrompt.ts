// Builds the exact prompt text sent to the vision model for AI visual comparison
// of listing photos against reference photos. Uses the first-pass identification
// results and reference photo matches to perform a more focused second pass that
// applies identifying marks (shape, color, pattern, connector layout, badges) to
// validate or refine the initial suggestions.
import type { ComponentCategory } from '@pc-parts-flipper/shared';
import type { Listing, ReferencePhoto } from '../db/index.js';

/** Eligible part for visual comparison: combines first-pass results with reference photo matches. */
export interface EligiblePart {
  partIndex: number;
  category: ComponentCategory;
  description: string;
  references: ReferencePhoto[];
}

/**
 * Builds the prompt for visual comparison of a Listing's photos against reference
 * photos. For each eligible part, it restates the category and description from
 * the first pass, numbers and labels each reference photo with the confirmed
 * identity it represents and its source (seeded vs. previously confirmed real
 * listing), and instructs the model to compare the listing's own photos against
 * the labeled references using identifying marks (shape, color, pattern,
 * connector layout, badge/sticker design).
 *
 * The model is asked to return, per partIndex, either an updated brand/partNumber/
 * identityCandidates, or an explicit "no change" when nothing attached genuinely
 * matches.
 *
 * Raw JSON only, matching the first-pass prompt's convention.
 */
export function buildVisualComparisonPrompt(
  listing: Listing,
  eligibleParts: EligiblePart[],
): string {
  const description = listing.description?.trim() ? listing.description : '(none provided)';

  // Build the reference photos section for each part
  const partsSections = eligibleParts.map((part) => {
    const refSection = part.references
      .map((ref, idx) => {
        const sourceLabel = ref.source === 'seed' ? 'seed reference' : 'confirmed listing';
        const partId = ref.partNumber ? ` (${ref.brand} ${ref.partNumber})` : ` (${ref.brand})`;
        return `  Reference ${idx + 1}${partId} — ${sourceLabel}`;
      })
      .join('\n');

    return `Part ${part.partIndex + 1}: ${part.category}
Description from first pass: "${part.description}"
Reference photos to compare against (labels show confirmed identity and source):
${refSection}`;
  });

  return [
    'You are performing a second pass on AI-identified PC components from a used pre-built computer listing.',
    '',
    'In a first pass, components were identified from the listing text and photos. For some of them,',
    'reference photos are now available — photos of the exact same part from known sources (either',
    'seed training data or previously confirmed real listings). Your task is to compare the listing\'s',
    'own photos against these labeled references to validate or refine the first-pass identification.',
    '',
    'LISTING TITLE:',
    listing.title,
    '',
    'LISTING DESCRIPTION:',
    description,
    '',
    'Any images attached to this message are photos from the same listing.',
    '',
    'COMPONENTS TO RE-EXAMINE:',
    '',
    partsSections.join('\n\n'),
    '',
    'COMPARISON INSTRUCTIONS:',
    '1. For each part above, compare the listing\'s photos against the labeled reference photos.',
    '2. Look for identifying marks: shape, color, pattern, connector layout, badge/sticker design, silkscreen text, heat spreader style, shroud design, form factor indicators.',
    '3. If the listing\'s photos show the exact same component as one of the references (or a component that matches none of them), return an updated identification for that part.',
    '4. If you cannot confidently distinguish between the references or confirm which reference (if any) matches the listing\'s photos, return {"partIndex": N, "noChange": true} for that part index.',
    '5. Brand, partNumber, and identityCandidates follow the same rules as the first pass: use JSON null when not confident, do NOT guess or infer.',
    '6. Do NOT include a candidate identical to the brand/partNumber you already reported at the top level.',
    '',
    'RESPOND WITH ONLY RAW JSON matching exactly this shape. No markdown, no code fences, no commentary before or after:',
    '[{"partIndex":0,"brand":"NVIDIA","partNumber":"RTX 3060","identityCandidates":[]},{"partIndex":1,"noChange":true}]',
  ].join('\n');
}
