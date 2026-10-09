// Builds the exact prompt text sent to the vision model for finding and
// verifying a manufacturer's direct product photo. Split out so the prompt
// wording — the part most likely to be tuned — can be read, reviewed and
// unit-tested on its own, without the process-spawning machinery around it.
import type { ComponentCategory } from '@pc-parts-flipper/shared';

/**
 * Builds the prompt for sourcing a reference photo of a specific product.
 * Instructs the model to find exactly one real image from the manufacturer's
 * official website only, never a reseller or marketplace, and return raw JSON.
 *
 * The JSON shape carries a third field beyond found/url: `blocked`, the
 * model's own report that it was denied the chance to search at all (a rate
 * limit, a CAPTCHA/"verify you're human" interstitial, any other
 * access-denied wall). That distinction is the only thing separating an
 * infrastructure failure the caller should retry later from a genuine,
 * completed "this product's photo does not exist on the official site"
 * answer the caller should record permanently — an omp call that hits a 429
 * still exits 0 with a structurally valid response, so without this field the
 * two outcomes are indistinguishable (sourcing-resilience Req 8).
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
    '6. If you completed a real search and simply could not find a valid manufacturer image, return found: false with blocked: false.',
    '7. If a rate limit, a CAPTCHA or "verify you\'re human" challenge, a bot-detection block, or any other access-denied condition prevented you from completing a real search, return found: false with blocked: true. Use blocked: true ONLY for that case — never for a search you were able to run that simply turned up nothing.',
    '',
    'RESPOND WITH ONLY RAW JSON. No markdown, no code fences, no commentary before or after:',
    '{"found":true,"url":"https://example.com/product-image.jpg","blocked":false}',
    'OR, if you searched and found nothing:',
    '{"found":false,"url":null,"blocked":false}',
    'OR, if you were rate-limited, CAPTCHA-challenged, or otherwise denied access:',
    '{"found":false,"url":null,"blocked":true}',
  ].join('\n');
}
