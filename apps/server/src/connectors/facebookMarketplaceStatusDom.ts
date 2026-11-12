// Facebook Marketplace per-item live-status page reading (Req 8), split
// out of facebookMarketplaceStatus.ts to keep that file near the ~200-line
// convention — the same Session/Listing/Dom split facebookMarketplaceDom.ts
// already follows for the search side. This file owns every selector and
// the in-page reader that turns a listing's *own* detail page into plain
// ListingPageSignals; facebookMarketplaceStatus.ts owns the text patterns,
// the auth guard and the pure classification of those signals, so a
// selector correction here never touches the classifier and vice versa.
//
// *** UNVERIFIED AGAINST A REAL LOGGED-IN SESSION. *** No real, dedicated
// Facebook account is available in this sandbox, so every selector below
// is a best-evidenced guess, not a confirmed live shape — see
// facebookMarketplaceStatus.ts's and facebookMarketplaceConnector.ts's own
// top comments.
import type { Page, Response } from 'playwright';
import type { ListingPageSignals } from './facebookMarketplaceStatus.js';

// Best-evidenced guess at the "Sold" pill Facebook renders over a sold
// listing's detail page. Selector-based rather than text-based because the
// bare word "sold" is far too common in seller-written descriptions
// ("sold as is", "already sold my other one") to classify on.
//
// Every aria-label member is an exact (`=`) match, never a prefix (`^=`):
// a listing's photos carry the listing's *title* as their aria-label
// ("Soldering iron Hakko FX-888D, photo 1 of 4"), so `[aria-label^="Sold"]`
// sold every live listing whose title started with those four letters, and
// `[aria-label^="Sold "]` would still sell a live "Sold as is - RTX 3080"
// title the same way. A pill whose label carries a suffix ("Sold · 2 weeks
// ago") is therefore missed rather than guessed at — the fail-safe
// direction (A9): a missed sale leaves a Listing open, a guessed one
// retires a live listing.
const SOLD_SELECTOR = ['[aria-label="Sold"]', '[aria-label="Sold out"]', '[data-testid="marketplace_pdp_sold_pill"]'].join(', ');

// The item's *own* PDP (product detail page) container. Every sold/removed
// signal below is read inside this element rather than off the whole
// document, because a Marketplace listing page also renders other sellers'
// items ("Related listings", "More like this"), each of which carries its
// own "Sold" tile and aria-label — reading those at document scope marked
// the rechecked item sold whenever any neighbour on the page was. When no
// container matches, every scoped read below yields nothing and the
// classifier falls back to 'active': an unreadable page must leave a
// Listing where it is, never retire it.
//
// Best-evidenced guesses, in Facebook's `data-testid`/`data-pagelet`
// naming convention for Marketplace PDP elements — the same unverified
// footing as facebookMarketplaceDom.ts's DESCRIPTION_SELECTOR.
const PDP_CONTAINER_SELECTOR = [
  '[data-testid="marketplace_pdp_container"]',
  '[data-testid="marketplace_pdp"]',
  '[data-pagelet="MarketplacePDP"]',
].join(', ');

// Whether the related-items rail sits *beside* the PDP container or
// *inside* it is unknowable without a live session, so scoping to the
// container alone is not enough: a rail nested inside it would put every
// neighbour's "Sold" pill and "Sold" text line back in scope. Rather than
// guess a second, inner header/price testid (which would likely never
// match, silencing the sold signal entirely), readScopedPageSignals
// excludes every tile that links to a *different* listing — the same
// `/marketplace/item/<id>/` anchor shape facebookMarketplaceDom.ts's
// collectDomListings already relies on as Facebook's one stable
// listing-card signature. Residual, undocumentable-without-a-session
// assumption: a tile's "Sold" pill and text sit inside its anchor (as a
// search-results card's title and price do); a tile whose anchor wraps
// only the photo, with the badge beside it, would still leak.
const ITEM_LINK_SELECTOR = 'a[href*="/marketplace/item/"]';

// The region Facebook renders *in place of* a PDP for an item that no
// longer exists. Read only when no PDP container was found, so that a
// seller's own prose ("this card is no longer available at retail") inside
// a perfectly live listing's description can never be mistaken for the
// interstitial — the document-scoped text match this replaces did exactly
// that. Also best-evidenced guesses, not confirmed live shapes.
//
// Originally included [role="alert"] (a generic, document-wide ARIA live
// region) and [data-testid="error_page"] (a generic error-page testid
// unverified as Marketplace-specific), both too broad: every real PDP
// container testid is unverified, so the real PDP selector likely never
// matches on real pages, routing every real page down this "interstitial"
// branch. If the page also renders an unrelated ARIA alert banner
// (cookie/privacy notice, rate-limit warning) with text matching
// UNAVAILABLE_PATTERNS, a live listing gets misclassified 'removed'.
// Narrowed to only the PDP-specific marketplace_pdp_unavailable testid.
const UNAVAILABLE_CONTAINER_SELECTOR = [
  '[data-testid="marketplace_pdp_unavailable"]',
].join(', ');

// Minimal structural shape of the elements readScopedPageSignals touches —
// just enough for this file to type-check without the project's "DOM" lib,
// the same narrow-interface convention facebookMarketplaceDom.ts follows.
interface BrowserScopeElement {
  querySelector(selector: string): BrowserScopeElement | null;
  querySelectorAll(selector: string): Iterable<BrowserScopeElement>;
  closest(selector: string): BrowserScopeElement | null;
  getAttribute(name: string): string | null;
  style: { display: string };
  innerText?: string;
  textContent?: string | null;
}

/** The selectors readScopedPageSignals is handed, since it runs in the page. */
interface ScopeSelectors {
  pdp: string;
  sold: string;
  interstitial: string;
  itemLink: string;
}

/**
 * Runs inside the page (via page.evaluate) to read every signal from the
 * item's *own* PDP container rather than from the whole document. Cast
 * through `globalThis` for the same reason facebookMarketplaceDom.ts's
 * collectDomListings does: this project's tsconfig carries no "DOM" lib,
 * but this body executes inside a real page where `document` exists.
 *
 * Two mutually exclusive shapes, because Facebook serves one or the other:
 * the item's PDP (read its sold pill and its own text), or the
 * gone-interstitial that replaces it (read only that region's text). A
 * page carrying neither yields no signal at all, which classifies 'active'.
 *
 * Inside the PDP, every tile for *another* listing (ITEM_LINK_SELECTOR,
 * whose item id differs from this page's own `location.pathname` id) is
 * excluded from both reads: its own "Sold" pill is skipped, and it is
 * hidden (`display: none`, restored afterwards) while the PDP's innerText
 * is read, since innerText omits hidden subtrees. A tile whose id cannot
 * be read, or a page whose own id cannot, counts as foreign — a missed
 * sale, never a guessed one.
 *
 * No named inner function (`const f = () =>` / `function f()`) may appear
 * in this body: it is serialized into the page, and under `tsx` (the dev
 * script) esbuild's keepNames wraps every named function in a module-level
 * `__name(...)` helper that does not exist inside the page — reproduced as
 * `ReferenceError: __name is not defined` from page.evaluate.
 */
function readScopedPageSignals(selectors: ScopeSelectors): Omit<ListingPageSignals, 'httpStatus'> {
  const browserGlobal = globalThis as unknown as {
    document: { querySelector(selector: string): BrowserScopeElement | null };
    location: { pathname: string };
  };
  const doc = browserGlobal.document;
  const pdp = doc.querySelector(selectors.pdp);
  if (pdp === null) {
    const interstitial = doc.querySelector(selectors.interstitial);
    const interstitialText = interstitial ? (interstitial.innerText ?? interstitial.textContent ?? '') : '';
    return { soldIndicator: false, pdpText: '', interstitialText };
  }

  const itemIdPattern = /\/marketplace\/item\/(\d+)/;
  const ownItemId = browserGlobal.location.pathname.match(itemIdPattern)?.[1] ?? null;
  const foreignTiles = Array.from(pdp.querySelectorAll(selectors.itemLink)).filter((tile) => {
    const tileItemId = tile.getAttribute('href')?.match(itemIdPattern)?.[1] ?? null;
    return tileItemId === null || tileItemId !== ownItemId;
  });
  const soldIndicator = Array.from(pdp.querySelectorAll(selectors.sold)).some((pill) => {
    const tile = pill.closest(selectors.itemLink);
    return tile === null || !foreignTiles.includes(tile);
  });
  const previousDisplays = foreignTiles.map((tile) => tile.style.display);
  foreignTiles.forEach((tile) => {
    tile.style.display = 'none';
  });
  let pdpText: string;
  try {
    pdpText = pdp.innerText ?? pdp.textContent ?? '';
  } finally {
    foreignTiles.forEach((tile, index) => {
      tile.style.display = previousDisplays[index] ?? '';
    });
  }
  return { soldIndicator, pdpText, interstitialText: '' };
}

/** Reads every signal classifyListingPageSignals needs off a live page. */
export async function collectListingPageSignals(page: Page, response: Response | null): Promise<ListingPageSignals> {
  const scoped = await page.evaluate(readScopedPageSignals, {
    pdp: PDP_CONTAINER_SELECTOR,
    sold: SOLD_SELECTOR,
    interstitial: UNAVAILABLE_CONTAINER_SELECTOR,
    itemLink: ITEM_LINK_SELECTOR,
  });
  return { httpStatus: response?.status() ?? null, ...scoped };
}
