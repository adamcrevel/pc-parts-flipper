// Builds the exact prompt text sent to the model for estimating one
// specific part's used resale value (part-price-estimation feature T2).
// Split out, same reasoning as imageSourcingPrompt.ts/catalogSourcingPrompt.ts:
// the wording is the part most likely to be tuned, kept reviewable and
// unit-testable without the process-spawning machinery around it.
import type { ComponentCategory } from '@pc-parts-flipper/shared';

/**
 * Hard ceiling on one price-estimation call. Tools stay enabled (the model
 * is expected to browse for recent used-market comparables, not just recall
 * a number from training data), so this needs real round-trip room — but
 * unlike catalog sourcing's DEFAULT_OMP_CATALOG_SOURCING_TIMEOUT_MS (10
 * minutes, an unbounded whole-category crawl) this call targets one exact
 * part, closer in shape to single-product image sourcing's
 * DEFAULT_OMP_SOURCING_TIMEOUT_MS (5 minutes). Set to 3 minutes: enough for
 * a few real searches on one specific part without letting a wedged call pin
 * a request open indefinitely.
 */
export const DEFAULT_PRICE_ESTIMATION_TIMEOUT_MS = 180_000;

/**
 * Builds the prompt for estimating one part's used resale value. Instructs
 * the model to research the exact category/brand/part number given — never
 * a close substitute — and report a single USD figure for a used,
 * working/good-condition unit, based on real current market activity it can
 * find rather than a recalled list price. Mirrors
 * identificationPrompt.ts's own honesty/conservatism instruction (rule 4
 * there): told plainly to say so rather than guess when it cannot support a
 * number, the model reports "not confident" instead of inventing a
 * plausible-looking figure that would silently become a real asking price
 * downstream. Do not weaken that instruction.
 */
export function buildPriceEstimationPrompt(category: ComponentCategory, brand: string, partNumber: string): string {
  return [
    `Estimate the current used resale price of the exact component specified below.`,
    '',
    `COMPONENT DETAILS:`,
    `Category: ${category}`,
    `Brand: ${brand}`,
    `Part Number: ${partNumber}`,
    '',
    `INSTRUCTIONS:`,
    '1. Research the actual current resale market for this exact part — recent sold listings, marketplace asking prices, or other real current activity. Do NOT substitute a similar or newer part, and do NOT just recall a manufacturer list price from training data.',
    '2. Estimate what this exact part, in used, working/good condition (not new, not broken-for-parts), would sell for in US dollars right now.',
    '3. Report one single price estimate, not a range.',
    '4. Be honest and conservative. If you cannot find enough real market activity for this exact part to support a confident number, say so plainly — set "confident" to false — rather than guessing. An honest "not confident" is far more useful than a confident wrong price.',
    '5. Do NOT invent, round-trip-guess, or pad a number you cannot actually support from what you found.',
    '6. List up to 5 of the real comps (sold listings or current asking prices) you found and based your estimate on, each with its title, URL, price in USD, condition, and whether it was a completed sale ("sold") or a current asking price ("listed").',
    '',
    'RESPOND WITH ONLY RAW JSON. No markdown, no code fences, no commentary before or after:',
    '{"confident":true,"priceUsd":45.00,"comps":[{"title":"Example Part - Used","url":"https://example.com/listing","priceUsd":45.00,"condition":"used","saleType":"sold"}]}',
    'OR, if you cannot confidently estimate a price:',
    '{"confident":false,"priceUsd":null,"comps":[]}',
  ].join('\n');
}
