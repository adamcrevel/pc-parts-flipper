// Mercari scan connector (Req 6): Mercari exposes no public listings API, so
// this drives a real headless Chromium tab (browserSession.ts's
// launchScanBrowser) to one search URL per configured query term. Mercari's
// own search page issues a `searchFacetQuery` GET request client-side once
// loaded, authenticated with a bearer/CSRF token minted by the page's own JS
// and held only in memory (confirmed live: neither token exists in any
// cookie, localStorage, or sessionStorage key on a real search page).
// searchOneQuery races `page.waitForResponse` against the `page.goto` that
// triggers it, so it reads the page's own already-authenticated response
// rather than issuing a second, parallel, credential-less request of its
// own — an earlier version did exactly that via `page.evaluate(() =>
// fetch(...))`, and Mercari correctly rejected it with a 200 response body
// `{"errors":[{"status":401,"message":"Unauthorized"}]}` that got silently
// misread as zero results (`body.data?.search?.itemsList ?? []` swallows
// any API-level error shape, not just this one — see the `errors` check
// below). The real browser tab loading the search page itself is also what
// clears Mercari's Cloudflare bot check (confirmed live: a bare HTTP
// request to mercari.com gets a 403 "Just a moment..." challenge page every
// time; a real browser tab loads the search page itself without issue).
//
// mercariSearchMapping.ts's own header comment has more on why this file no
// longer builds the `searchFacetQuery` request's own variables/persisted-
// query-hash payload.
import type { Browser } from 'playwright';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { launchScanBrowser, SCAN_BROWSER_INIT_SCRIPT, SCAN_BROWSER_USER_AGENT } from './browserSession.js';
import { createDescriptionFetcher } from './mercariItemDetail.js';
import { mapSearchItem, validateMercariConnectorConfig, type MercariSearchFacetResponse } from './mercariSearchMapping.js';
import { createStatusChecker } from './mercariStatusChecker.js';
import type { CandidateListing, MarketplaceConnector } from './types.js';

/**
 * Runs one query's search pass: a fresh browser context/page (so query
 * state never bleeds across calls) navigates to Mercari's search page for
 * `query`, racing `page.waitForResponse` against that `page.goto` so it
 * captures the real `searchFacetQuery` GET request the page's own JS issues
 * once loaded — not a second, parallel request of this function's own (see
 * this file's header comment for why that matters). Throws AppError(502) on
 * a failed request or a top-level `errors` array in an otherwise-200
 * response body, matching ebayConnector.ts's error convention.
 */
async function searchOneQuery(browser: Browser, query: string): Promise<CandidateListing[]> {
  const context = await browser.newContext({ userAgent: SCAN_BROWSER_USER_AGENT });
  await context.addInitScript(SCAN_BROWSER_INIT_SCRIPT);
  const page = await context.newPage();

  try {
    const [response] = await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes('searchFacetQuery') && resp.request().method() === 'GET',
        { timeout: 30000 },
      ),
      page.goto(`https://www.mercari.com/search/?keyword=${encodeURIComponent(query)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      }),
    ]);

    if (!response.ok()) {
      throw new Error(`Mercari search request failed with status ${response.status()}`);
    }

    const body = (await response.json()) as MercariSearchFacetResponse;
    if (body.errors && body.errors.length > 0) {
      throw new Error(body.errors.map((e) => e.message).join('; '));
    }

    const items = body.data?.search?.itemsList ?? [];
    return items.filter((item) => item.status === 'on_sale').map(mapSearchItem);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Mercari item search failed';
    logger.warn({ query, error: message }, 'Mercari item search request failed');
    throw new AppError(message, 502);
  } finally {
    await context.close();
  }
}

/**
 * Runs one automated Mercari scan pass: validates connector_config,
 * launches one shared headless browser for the whole pass (one real
 * Chromium process per pass, not per query), searches each configured
 * query term, and concatenates every result. `maxPrice` is re-applied here
 * client-side even though Mercari's own search may already narrow by price
 * server-side, since the captured criteria has no price-range field this
 * connector sets.
 */
async function search(config: unknown): Promise<CandidateListing[]> {
  const { queries, maxPrice } = validateMercariConnectorConfig(config);

  logger.info({ queryCount: queries.length, maxPrice }, 'Starting Mercari scan pass');
  const browser = await launchScanBrowser();
  try {
    const results: CandidateListing[] = [];
    for (const query of queries) {
      const found = await searchOneQuery(browser, query);
      results.push(...found);
    }

    const filtered = maxPrice === undefined ? results : results.filter((candidate) => candidate.askingPrice <= maxPrice);
    logger.info({ queryCount: queries.length, foundCount: filtered.length }, 'Finished Mercari scan pass');
    return filtered;
  } finally {
    await browser.close();
  }
}

// The Mercari MarketplaceConnector instance. Not yet registered under
// 'mercari' in registry.ts (a later task does that).
export const mercariConnector: MarketplaceConnector = {
  platformType: 'mercari',
  search,
  createDescriptionFetcher,
  createStatusChecker,
};
