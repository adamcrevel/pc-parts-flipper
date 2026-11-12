// T9 live proof: drives the real in-page reader
// (facebookMarketplaceStatusDom.ts's collectListingPageSignals) and the real
// classifier (facebookMarketplaceStatus.ts's classifyListingPageSignals)
// inside a real headless Chromium, against Marketplace-shaped HTML served
// by `page.route` at the listing's own URL — no network call ever leaves
// the process. facebookMarketplaceStatus.test.ts `vi.mock`s `playwright`
// and models the DOM with a hand-built fixture; this file is the one place
// the same code path runs against a real document, real `innerText` line
// breaks and real `location.pathname`, following the precedent
// browserSession.test.ts sets for launching a real browser in this suite.
//
// It pins the SOLD_LINE_PATTERNS separator boundary end to end: a title
// whose first word is merely joined to the next by a separator character
// ("Sold–out edition") stays 'active', while a genuine "Sold <sep> ..."
// status line still answers 'sold' — for every one of the four separators,
// not only the hyphen. It also pins the three PDP-scoped reads the DOM
// reader performs: a neighbour tile nested *inside* the PDP is excluded
// from both the pill and the text read (but a tile carrying this item's
// own id is not), the item's own SOLD_SELECTOR pill is read, and the
// gone-interstitial is read when no PDP is rendered. Every earlier
// "reproduced live in Chromium" claim on this file had no committed
// artifact; this is that artifact.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';

import { launchScanBrowser } from '../src/connectors/browserSession.js';
import { classifyListingPageSignals } from '../src/connectors/facebookMarketplaceStatus.js';
import { collectListingPageSignals } from '../src/connectors/facebookMarketplaceStatusDom.js';
import type { ListingLiveStatus } from '../src/connectors/types.js';

const OWN_ITEM_ID = '1234567890';
const NEIGHBOUR_ITEM_ID = '9876543210';
const LISTING_URL = `https://www.facebook.com/marketplace/item/${OWN_ITEM_ID}/`;

interface PdpShape {
  /** Item id of the "More like this" tile nested inside the PDP container; another listing's by default. */
  neighbourItemId?: string;
  /** Render the item's own SOLD_SELECTOR pill inside the PDP, outside any tile. */
  ownSoldPill?: boolean;
}

// Each line of the listing's own PDP rendered as its own block element,
// the way Chromium's innerText produces one line per block — the exact
// shape hasSoldLine's line-splitting relies on.
//
// The neighbour tile sits *inside* the PDP container, the nested-rail shape
// readScopedPageSignals's foreign-tile exclusion exists for: it carries its
// own SOLD_SELECTOR pill and its own bare "Sold" text line, so both the
// pill read and the innerText read would leak if the exclusion did not run.
// Both pills are rendered without visible text so the pill selector is the
// only thing they can ever signal through — a pill reading "Sold" would
// also satisfy SOLD_LINE_PATTERNS as a text line and mask the selector read.
function marketplacePage(pdpLines: string[], { neighbourItemId = NEIGHBOUR_ITEM_ID, ownSoldPill = false }: PdpShape = {}): string {
  const lines = pdpLines.map((line) => `<div>${line}</div>`).join('');
  const ownPill = ownSoldPill ? '<span aria-label="Sold"></span>' : '';
  const neighbourTile = `<div><div>More like this</div><a href="/marketplace/item/${neighbourItemId}/"><span aria-label="Sold"></span>Sold<br>RTX 3070</a></div>`;
  // Declared UTF-8, as Facebook's own pages are: without it Chromium
  // decodes the routed body as windows-1252 and the en-dash/bullet cases
  // below never reach the classifier as the characters they test.
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <div data-testid="marketplace_pdp_container">${ownPill}${lines}${neighbourTile}</div>
  </body></html>`;
}

// The page Facebook renders in place of a PDP for an item that no longer
// exists: no PDP container at all, only the unavailable interstitial, with
// Facebook's curly apostrophe as served.
function goneInterstitialPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <div data-testid="marketplace_pdp_unavailable"><div>This content isn\u2019t available right now</div><div>The listing may have been removed.</div></div>
  </body></html>`;
}

let browser: Browser;
let page: Page;
// The HTML the next navigation to LISTING_URL is answered with.
let fixtureHtml = '';

beforeAll(async () => {
  browser = await launchScanBrowser();
  page = await browser.newPage();
  // Every request is answered in-process; nothing reaches facebook.com.
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixtureHtml }));
}, 30000);

afterAll(async () => {
  await browser?.close();
});

async function liveStatusOf(html: string): Promise<ListingLiveStatus> {
  fixtureHtml = html;
  const response = await page.goto(LISTING_URL);
  return classifyListingPageSignals(await collectListingPageSignals(page, response));
}

describe('SOLD_LINE_PATTERNS in real headless Chromium', () => {
  it('reads the fixture through the real document, not a stub', async () => {
    // Guards every case below: the routed HTML really is what the real
    // page renders, at the real listing URL the reader derives the item id
    // from, with real innerText line breaks between block elements.
    fixtureHtml = marketplacePage(['RTX 3080 GPU', '$250']);
    await page.goto(LISTING_URL);
    const rendered = await page.evaluate(() => {
      // This project's tsconfig carries no "DOM" lib, but this body runs
      // inside the page where `location` and `document` exist.
      const browserGlobal = globalThis as unknown as {
        location: { pathname: string };
        document: { body: { innerText: string } };
      };
      return { pathname: browserGlobal.location.pathname, text: browserGlobal.document.body.innerText };
    });
    expect(rendered.pathname).toBe(`/marketplace/item/${OWN_ITEM_ID}/`);
    expect(rendered.text).toContain('RTX 3080 GPU\n$250');
  }, 30000);

  it.each([
    ['a hyphen', 'Sold-out edition Funko Pop'],
    ['an en-dash', 'Sold\u2013out edition Funko Pop'],
    ['a pipe', 'Sold|Trade bundle, RTX 3080'],
    ['a bullet', 'Sold\u2022out vinyl reissue box set'],
  ])("answers 'active' for a live listing whose title merely joins Sold to the next word with %s", async (_label, title) => {
    await expect(liveStatusOf(marketplacePage([title, '$40', 'Listed 3 days ago in Seattle, WA']))).resolves.toBe('active');
  }, 30000);

  it.each([
    ['a hyphen', 'Sold - Listed 2 weeks ago'],
    ['an en-dash', 'Sold \u2013 Listed 2 weeks ago'],
    ['a pipe', 'Sold | Listed 2 weeks ago'],
    ['a bullet', 'Sold \u2022 Listed 2 weeks ago'],
  ])("answers 'sold' for a Sold status line rendered as text with %s separator", async (_label, statusLine) => {
    await expect(liveStatusOf(marketplacePage(['RTX 3080 GPU', statusLine, '$250']))).resolves.toBe('sold');
  }, 30000);

  it.each([
    ['a hyphen', 'Sold -'],
    ['an en-dash', 'Sold \u2013'],
    ['a pipe', 'Sold |'],
    ['a bullet', 'Sold \u2022'],
  ])("answers 'sold' for a Sold line that ends on %s with nothing after it", async (_label, statusLine) => {
    // The end-of-line half of the boundary: a pill whose trailing text
    // wrapped onto the next block still reads as the status line.
    await expect(liveStatusOf(marketplacePage(['RTX 3080 GPU', statusLine, 'Listed 2 weeks ago']))).resolves.toBe('sold');
  }, 30000);
});

describe('PDP-scoped reads in real headless Chromium', () => {
  it("answers 'active' for a live listing whose nested neighbour tile is the only thing marked Sold", async () => {
    // The neighbour's own pill and its bare "Sold" line both sit inside the
    // PDP container; only the foreign-tile exclusion keeps them out.
    await expect(liveStatusOf(marketplacePage(['RTX 3080 GPU', '$250', 'Listed 3 days ago in Seattle, WA']))).resolves.toBe('active');
  }, 30000);

  it("answers 'sold' when the in-container tile carries this item's own id", async () => {
    // The exclusion must be by id, not by anchor shape: a tile linking to
    // the page's own item is this listing's, and its pill counts.
    await expect(liveStatusOf(marketplacePage(['RTX 3080 GPU', '$250'], { neighbourItemId: OWN_ITEM_ID }))).resolves.toBe('sold');
  }, 30000);

  it("answers 'sold' for the item's own SOLD_SELECTOR pill with no Sold text line anywhere", async () => {
    await expect(liveStatusOf(marketplacePage(['RTX 3080 GPU', '$250', 'Listed 3 days ago in Seattle, WA'], { ownSoldPill: true }))).resolves.toBe('sold');
  }, 30000);

  it("answers 'removed' for a page with no PDP container and a real unavailable interstitial", async () => {
    await expect(liveStatusOf(goneInterstitialPage())).resolves.toBe('removed');
  }, 30000);
});
