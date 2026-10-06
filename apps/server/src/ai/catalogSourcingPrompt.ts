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
    '7. If you cannot find any valid products, return an empty products array.',
    '',
    'RESPOND WITH ONLY RAW JSON. No markdown, no code fences, no commentary before or after:',
    '{"products":[{"partNumber":"Model Name","url":"https://example.com/product-image.jpg"},{"partNumber":"Another Model","url":"https://example.com/another-image.jpg"}]}',
    'OR, if nothing was found:',
    '{"products":[]}',
  ].join('\n');
}
