// Builds the exact prompt text sent to the model for finding several of a
// brand's current products in one category, from its own official site
// (ai-catalog-sourcing feature T2). Split out, same reasoning as
// imageSourcingPrompt.ts: the wording is the part most likely to be tuned,
// kept reviewable and unit-testable without the process-spawning machinery
// around it.
import type { ComponentCategory } from '@pc-parts-flipper/shared';

/**
 * Builds the prompt for catalog-mode sourcing: finding every distinct
 * current product of one brand within one category. Instructs the model to
 * browse the manufacturer's official website only — never a reseller,
 * retailer, marketplace, or aggregator (Requirement 2) — and return every
 * real product it finds, each with its own model name/number and a real,
 * direct image URL, as raw JSON. No count cap: the manufacturer's real
 * catalog size is the only limit (user steering, Cycle 0 log).
 *
 * The JSON shape carries a top-level `blocked` sibling to `products`: the
 * model's own report that it was denied the chance to browse at all (a rate
 * limit, a CAPTCHA/"verify you're human" interstitial, any other
 * access-denied wall). That distinction is the only thing separating an
 * infrastructure failure the caller should retry later from a genuine,
 * completed "this brand has no products in this category" answer the caller
 * should record permanently — an omp call that hits a 429 still exits 0 with
 * a structurally valid empty-products response, so without this field the two
 * outcomes are indistinguishable (sourcing-resilience Req 8).
 */
export function buildCatalogSourcingPrompt(category: ComponentCategory, brand: string): string {
  return [
    `Find every one of this brand's current products in the category specified below.`,
    '',
    `SEARCH DETAILS:`,
    `Category: ${category}`,
    `Brand: ${brand}`,
    '',
    `INSTRUCTIONS:`,
    `1. Browse the manufacturer's own official website for ${brand} and find every distinct, real, current product in the ${category} category — do not stop at just one or a few; report the whole category.`,
    '2. For each product found, record its exact model name/number and a direct photograph URL of that specific product.',
    '3. Every image URL MUST come directly from the manufacturer\'s own official website ONLY.',
    '4. Do NOT use images or listings from resellers, retailers, marketplaces (Amazon, eBay, etc.), aggregators, or review sites.',
    '5. Each image should show the actual physical product, not a diagram or stock art.',
    '6. Do NOT invent or guess at products or URLs — only report ones you actually found by browsing the real site.',
    '7. If you completed a real search of the official site and simply found no valid products, return an empty products array with blocked: false.',
    '8. If a rate limit, a CAPTCHA or "verify you\'re human" challenge, a bot-detection block, or any other access-denied condition prevented you from completing a real search, return blocked: true (with whatever products you did manage to find, or an empty array). Use blocked: true ONLY for that case — never for a search you were able to run that simply turned up nothing.',
    '',
    'RESPOND WITH ONLY RAW JSON. No markdown, no code fences, no commentary before or after:',
    '{"products":[{"partNumber":"Model Name","url":"https://example.com/product-image.jpg"},{"partNumber":"Another Model","url":"https://example.com/another-image.jpg"}],"blocked":false}',
    'OR, if you searched and nothing was found:',
    '{"products":[],"blocked":false}',
    'OR, if you were rate-limited, CAPTCHA-challenged, or otherwise denied access:',
    '{"products":[],"blocked":true}',
  ].join('\n');
}
