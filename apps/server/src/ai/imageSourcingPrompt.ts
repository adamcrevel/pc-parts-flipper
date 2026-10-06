// Builds the exact prompt text sent to the vision model for finding and
// verifying a manufacturer's direct product photo. Split out so the prompt
// wording — the part most likely to be tuned — can be read, reviewed and
// unit-tested on its own, without the process-spawning machinery around it.
import type { ComponentCategory } from '@pc-parts-flipper/shared';

/**
 * Builds the prompt for sourcing a reference photo of a specific product.
 * Instructs the model to find exactly one real image from the manufacturer's
 * official website only, never a reseller or marketplace, and return raw JSON.
 */
export function buildImageSourcingPrompt(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
): string {
  return [
    `Find a direct product image of the exact component specified below.`,
    '',
    `COMPONENT DETAILS:`,
    `Category: ${category}`,
    `Brand: ${brand}`,
    `Part Number: ${partNumber}`,
    '',
    `INSTRUCTIONS:`,
    '1. Search for and locate exactly one real, direct photograph of this specific product.',
    '2. The image MUST come directly from the manufacturer\'s own official website ONLY.',
    '3. Do NOT use images from resellers, retailers, marketplaces (Amazon, eBay, etc.), aggregators, or review sites.',
    '4. The image should show the actual physical product, not a diagram or stock art.',
    '5. If you can find a valid manufacturer image, return its direct URL.',
    '6. If you cannot find a valid manufacturer image, return found: false.',
    '',
    'RESPOND WITH ONLY RAW JSON. No markdown, no code fences, no commentary before or after:',
    '{"found":true,"url":"https://example.com/product-image.jpg"}',
    'OR',
    '{"found":false,"url":null}',
  ].join('\n');
}
