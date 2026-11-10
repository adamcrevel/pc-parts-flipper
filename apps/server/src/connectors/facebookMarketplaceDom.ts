// Facebook Marketplace DOM scraping (Req 6, T8), split out of
// facebookMarketplaceListing.ts to keep that file near the ~200-line
// convention — the same split convention mercariSearchMapping.ts and
// mercariItemDetail.ts follow against mercariConnector.ts. This file holds
// the *fallback* strategy only: the connector prefers parsing the JSON
// network responses handled in facebookMarketplaceListing.ts, and reaches
// for the rendered markup below only when no response yielded a
// recognizable listing node. It also holds the listing detail page's
// description extraction, which is DOM-selector work of exactly the same
// kind.
//
// *** UNVERIFIED AGAINST A REAL LOGGED-IN SESSION. *** No real, dedicated
// Facebook account is available in this sandbox, so the card selector and
// the description selector below are best-evidenced guesses, not confirmed
// live shapes — see facebookMarketplaceConnector.ts's own top comment.
import type { Page } from 'playwright';
import type { CandidateListing } from './types.js';

const LISTING_ID_PATTERN = /\/marketplace\/item\/(\d+)/;
const PRICE_PATTERN = /\$[\d,]+(?:\.\d{2})?/;

export interface RawDomListing {
  href: string;
  text: string;
  imgSrc: string | null;
}

// Minimal structural shape of the two DOM element kinds collectDomListings
// touches — just enough for this file to type-check without the project's
// "DOM" lib, not a general-purpose DOM typing.
interface BrowserImgElement {
  getAttribute(name: string): string | null;
}

interface BrowserAnchorElement {
  href: string;
  innerText: string;
  querySelector(selector: string): BrowserImgElement | null;
}

/**
 * Runs inside the page (via page.evaluate) to collect every marketplace
 * listing card's anchor href, visible text, and thumbnail src. The
 * `/marketplace/item/<id>/` href pattern is Facebook's stable, publicly
 * documented listing URL shape and has stayed constant far longer than any
 * card wrapper class name Facebook's anti-bot/layout churn tends to break —
 * selecting on it rather than a class/data-testid name is this fallback's
 * whole resilience story. Cast through `globalThis` rather than referencing
 * `document`/`HTMLAnchorElement` as bare identifiers: this project's
 * tsconfig has no "DOM" lib (a Node/Fastify backend has no business with
 * one everywhere else), but this one function's body runs inside the page
 * via page.evaluate below, where a real `document` exists at runtime
 * regardless of what this file compiles against.
 */
function collectDomListings(): RawDomListing[] {
  const browserGlobal = globalThis as unknown as { document: { querySelectorAll(selector: string): Iterable<BrowserAnchorElement> } };
  const anchors = Array.from(browserGlobal.document.querySelectorAll('a[href*="/marketplace/item/"]'));
  const seen = new Set<string>();
  const out: RawDomListing[] = [];
  for (const anchor of anchors) {
    const href = anchor.href;
    if (seen.has(href)) {
      continue;
    }
    seen.add(href);
    const img = anchor.querySelector('img');
    out.push({ href, text: anchor.innerText ?? '', imgSrc: img ? img.getAttribute('src') : null });
  }
  return out;
}

/**
 * Maps one scraped listing card to a CandidateListing. Returns null when
 * the card's href doesn't carry a numeric item id, or its text has no
 * recognizable `$`-prefixed price — either means this anchor wasn't
 * actually a listing card (a search results page can mix in a few
 * non-listing links that also match the href substring check).
 */
export function mapRawDomListing(raw: RawDomListing): CandidateListing | null {
  const idMatch = raw.href.match(LISTING_ID_PATTERN);
  if (!idMatch) {
    return null;
  }
  const priceMatch = raw.text.match(PRICE_PATTERN);
  if (!priceMatch) {
    return null;
  }
  const askingPrice = Number(priceMatch[0].replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(askingPrice)) {
    return null;
  }

  const lines = raw.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const title = lines.find((line) => !PRICE_PATTERN.test(line)) ?? lines[0] ?? 'Facebook Marketplace listing';

  return {
    externalItemId: idMatch[1],
    title,
    listingUrl: raw.href,
    askingPrice,
    listingDate: new Date().toISOString().slice(0, 10),
    imageUrls: raw.imgSrc ? [raw.imgSrc] : [],
    nonWorking: false,
  };
}

export async function parseListingsFromDom(page: Page): Promise<CandidateListing[]> {
  const raw = await page.evaluate(collectDomListings);
  const seenIds = new Set<string>();
  const out: CandidateListing[] = [];
  for (const entry of raw) {
    const mapped = mapRawDomListing(entry);
    if (mapped && !seenIds.has(mapped.externalItemId)) {
      seenIds.add(mapped.externalItemId);
      out.push(mapped);
    }
  }
  return out;
}

// Best-evidenced guess at the listing detail page's description container,
// based on Facebook's general `data-testid` naming convention for
// Marketplace PDP (product detail page) elements seen in public write-ups —
// unverified against a live session. Likely needs correcting once a real
// account is available.
const DESCRIPTION_SELECTOR = '[data-testid="marketplace_pdp_description"]';

/**
 * Extracts a listing detail page's description text. Returns null (never
 * throws) both when the selector finds nothing and when the page errors —
 * callers (facebookMarketplaceConnector.ts's description fetcher) treat
 * both the same: "no description available for this item", logged at Warn
 * by the caller, not here.
 */
export async function extractListingDescription(page: Page): Promise<string | null> {
  try {
    const text = await page.$eval(DESCRIPTION_SELECTOR, (el) => el.textContent);
    const trimmed = text?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
