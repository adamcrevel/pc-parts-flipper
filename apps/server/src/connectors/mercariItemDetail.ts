// Mercari item-detail description fetcher (Req 6), wired onto
// mercariConnector.ts's exported connector as its `createDescriptionFetcher`.
// Unlike mercariConnector.ts's own search(), which must run the
// `searchFacetQuery` GraphQL call from inside an already-loaded page to
// clear Mercari's Cloudflare bot check, an item-detail page's own item data
// is server-side rendered straight into the page's `<script
// id="__NEXT_DATA__">` tag — no further client-side API call is needed to
// read it, so a plain `page.$eval` against that tag after navigation is
// enough.
//
// The JSON path below was confirmed live, not guessed: this sandbox's own
// client-side search call is Cloudflare-blocked the same way
// mercariConnector.ts's header comment documents, which also blocks
// discovering real item ids by searching — so a real GPU-category item id
// was instead found via Mercari's own public sitemap
// (https://www.mercari.com/us-sitemap-categories-0001.xml ->
// /us/category/computer-gpus-2255/, whose page itself IS server-rendered
// with real item links). Loading
// https://www.mercari.com/us/item/<that id>/ in a headless Chromium tab and
// reading its own `#__NEXT_DATA__` script tag showed an Apollo-style
// normalized cache at `props.pageProps.serverState`, keyed by
// `"<__typename>:<id>"`; the item's own node lives at
// `serverState["ItemDetail:<externalItemId>"]` and that node's `description`
// field held the item's real plain-text description. Confirmed against two
// separate real item ids before this sandbox's network began failing
// further requests.
import type { Browser, Page } from 'playwright';
import { logger } from '../logger.js';
import { launchScanBrowser, SCAN_BROWSER_INIT_SCRIPT, SCAN_BROWSER_USER_AGENT } from './browserSession.js';
import type { DescriptionFetcher } from './types.js';

const NEXT_DATA_SELECTOR = '#__NEXT_DATA__';

/**
 * Reads one item's description out of an already-parsed `__NEXT_DATA__`
 * payload (see this file's header comment for the confirmed path/shape).
 * Returns `undefined` — never throws — when any step of that path is
 * missing or not the expected type, so the caller can tell "field not
 * found" apart from "found, but empty string".
 */
function readDescription(nextData: unknown, externalItemId: string): string | undefined {
  if (typeof nextData !== 'object' || nextData === null) {
    return undefined;
  }
  const props = (nextData as Record<string, unknown>).props;
  if (typeof props !== 'object' || props === null) {
    return undefined;
  }
  const pageProps = (props as Record<string, unknown>).pageProps;
  if (typeof pageProps !== 'object' || pageProps === null) {
    return undefined;
  }
  const serverState = (pageProps as Record<string, unknown>).serverState;
  if (typeof serverState !== 'object' || serverState === null) {
    return undefined;
  }
  const itemDetail = (serverState as Record<string, unknown>)[`ItemDetail:${externalItemId}`];
  if (typeof itemDetail !== 'object' || itemDetail === null) {
    return undefined;
  }
  const description = (itemDetail as Record<string, unknown>).description;
  return typeof description === 'string' ? description : undefined;
}

/**
 * Fetches one Mercari item's description text out of its item-detail page's
 * own `__NEXT_DATA__` script tag, given an already-created (not yet
 * navigated) Page. Split out from `createDescriptionFetcher` below purely
 * so tests can exercise every failure branch against a bare mocked Page,
 * with no real browser/network involved. Never throws past its own
 * boundary — every failure (navigation, missing tag, malformed JSON, or a
 * missing description field) resolves to `null` and is logged at Warn,
 * matching `attachCandidateDescription`'s best-effort contract
 * (scanService.ts).
 */
export async function fetchMercariItemDescription(page: Page, externalItemId: string): Promise<string | null> {
  try {
    await page.goto(`https://www.mercari.com/us/item/${encodeURIComponent(externalItemId)}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const tagText = await page.$eval(NEXT_DATA_SELECTOR, (el) => el.textContent).catch(() => null);
    if (!tagText) {
      logger.warn({ externalItemId }, 'Mercari item page has no __NEXT_DATA__ script tag; skipping description');
      return null;
    }

    let nextData: unknown;
    try {
      nextData = JSON.parse(tagText);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid JSON';
      logger.warn({ externalItemId, error: message }, 'Mercari item __NEXT_DATA__ JSON failed to parse; skipping description');
      return null;
    }

    const description = readDescription(nextData, externalItemId);
    if (description === undefined) {
      logger.warn({ externalItemId }, 'Mercari item __NEXT_DATA__ is missing the expected description field; skipping description');
      return null;
    }
    return description;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Mercari item description fetch failed';
    logger.warn({ externalItemId, error: message }, 'Mercari item description fetch failed');
    return null;
  }
}

/**
 * Builds the Mercari DescriptionFetcher the scan service calls at most once
 * per scan pass. Launches its own short-lived browser per call (via
 * `launchScanBrowser`, closed in a `finally`) rather than a single browser
 * memoized across calls the way ebayConnector.ts's lazy OAuth client is:
 * the MarketplaceConnector/scan-service contract (types.ts) never signals
 * "this scan pass is finished" for a shared instance to close on, so a
 * long-lived browser launched once per factory call would leak a Chromium
 * process past the scan's own return — matches
 * facebookMarketplaceConnector.ts's own createDescriptionFetcher, the other
 * browser-driven connector in this codebase, for the same reason.
 */
function createDescriptionFetcher(): DescriptionFetcher {
  return async (externalItemId: string): Promise<string | null> => {
    try {
      const browser: Browser = await launchScanBrowser();
      try {
        const context = await browser.newContext({ userAgent: SCAN_BROWSER_USER_AGENT });
        await context.addInitScript(SCAN_BROWSER_INIT_SCRIPT);
        const page = await context.newPage();
        try {
          return await fetchMercariItemDescription(page, externalItemId);
        } finally {
          await context.close();
        }
      } finally {
        await browser.close();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to launch browser';
      logger.warn({ externalItemId, error: message }, 'Mercari item description fetch failed to launch browser');
      return null;
    }
  };
}

export { createDescriptionFetcher };
