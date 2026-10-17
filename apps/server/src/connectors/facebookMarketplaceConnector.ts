// Facebook Marketplace connector (Req 6, T8): no public listings API exists
// for Facebook Marketplace, so this drives a real, already-authenticated
// Playwright browser session instead of a plain HTTP client. The session is
// persisted by src/scripts/facebook-marketplace-login.ts, run once by hand
// via `npm run login-facebook-marketplace` — see that script's own top
// comment for why it must be run against a DEDICATED SECONDARY account.
//
// This file is orchestration only; the three concerns it used to inline are
// now siblings, following the same split convention mercariConnector.ts /
// mercariSearchMapping.ts / mercariItemDetail.ts use:
//   - facebookMarketplaceConfig.ts  — connector_config validation
//   - facebookMarketplaceSession.ts — session file, authenticated context,
//                                     and the expired-session guard
//   - facebookMarketplaceListing.ts — search URL + JSON response parsing
//   - facebookMarketplaceDom.ts     — DOM fallback + description scraping
//
// *** THIS IS THE CONNECTOR MOST LIKELY TO NEED REWORK. *** No real,
// dedicated Facebook account/session file is available in this sandbox, so
// none of the search URL shape, response/DOM parsing, or description
// selector has been confirmed against a real logged-in session — see
// facebookMarketplaceListing.ts's and facebookMarketplaceDom.ts's own top
// comments for exactly what is a best-evidenced guess there. Facebook's
// anti-bot defenses and internal GraphQL/DOM shapes also tend to change
// with less notice than eBay's or Mercari's. Parsing is deliberately
// isolated in those two files so correcting any one of those guesses is a
// small, localized edit there rather than a rewrite of this file's
// session/orchestration logic.
import { chromium, type Browser } from 'playwright';
import { logger } from '../logger.js';
import { validateFacebookMarketplaceConnectorConfig } from './facebookMarketplaceConfig.js';
import { extractListingDescription, parseListingsFromDom } from './facebookMarketplaceDom.js';
import { buildSearchUrl, parseListingsFromResponses } from './facebookMarketplaceListing.js';
import {
  assertSearchPageAuthenticated,
  createAuthenticatedContext,
  ensureSessionFileExists,
} from './facebookMarketplaceSession.js';
import type { CandidateListing, DescriptionFetcher, MarketplaceConnector } from './types.js';

const LISTING_URL_BASE = 'https://www.facebook.com/marketplace/item/';

/**
 * Runs one search pass for a single query term in its own fresh,
 * authenticated browser context. Collects every XHR/fetch response's JSON
 * body during navigation (network-response-first strategy) and prefers
 * parsing those; falls back to scraping the rendered DOM only when no
 * response yielded a recognizable listing node, since a structured JSON
 * payload is far more resilient to markup/class-name churn than any DOM
 * selector. Throws AppError(400) naming the login script — via
 * assertSearchPageAuthenticated — whenever the navigation was answered by
 * an auth wall rather than by real search results, so an expired session
 * can never masquerade as a zero-result scan.
 */
async function searchOneQuery(
  browser: Browser,
  query: string,
  options: { maxPrice?: number; radiusMiles?: number; location?: string },
): Promise<CandidateListing[]> {
  const context = await createAuthenticatedContext(browser);
  const page = await context.newPage();

  const responseBodies: Array<Promise<unknown>> = [];
  page.on('response', (response) => {
    const resourceType = response.request().resourceType();
    if (resourceType === 'xhr' || resourceType === 'fetch') {
      responseBodies.push(response.json().catch(() => undefined));
    }
  });

  try {
    const navigation = await page.goto(buildSearchUrl(query, options), { waitUntil: 'networkidle' });
    await assertSearchPageAuthenticated(page, navigation ?? null);

    const bodies = (await Promise.all(responseBodies)).filter((body) => body !== undefined);
    let candidates = parseListingsFromResponses(bodies);
    if (candidates.length === 0) {
      candidates = await parseListingsFromDom(page);
    }

    const maxPrice = options.maxPrice;
    if (maxPrice !== undefined) {
      candidates = candidates.filter((candidate) => candidate.askingPrice <= maxPrice);
    }
    return candidates;
  } finally {
    await context.close();
  }
}

/**
 * Runs one automated Facebook Marketplace scan pass: validates the
 * Source's connector_config, confirms a persisted login session exists,
 * then issues one search navigation per configured query term, each in its
 * own fresh browser context (so one query's state/cookies never bleed into
 * the next), concatenating every query's results.
 */
async function search(config: unknown): Promise<CandidateListing[]> {
  const { queries, maxPrice, radiusMiles, location } = validateFacebookMarketplaceConnectorConfig(config);
  await ensureSessionFileExists();

  logger.info({ queryCount: queries.length, maxPrice, radiusMiles, location }, 'Starting Facebook Marketplace scan pass');
  const browser = await chromium.launch({ headless: true });
  try {
    const results: CandidateListing[] = [];
    for (const query of queries) {
      const found = await searchOneQuery(browser, query, { maxPrice, radiusMiles, location });
      results.push(...found);
    }
    logger.info({ queryCount: queries.length, foundCount: results.length }, 'Finished Facebook Marketplace scan pass');
    return results;
  } finally {
    await browser.close();
  }
}

/**
 * Builds a DescriptionFetcher that, on each call, launches its own
 * short-lived authenticated browser context, visits the listing's own URL,
 * and extracts its description text. Deliberately not a single browser
 * shared across calls (unlike ebayConnector.ts's lazy OAuth client): the
 * MarketplaceConnector/scan-service contract never signals "this scan pass
 * is finished" for a shared instance to close on, so a long-lived browser
 * launched here would leak a Chromium process past the scan's own return —
 * a context opened fresh per call and always closed in its own `finally`
 * cannot leak either way. Every failure is caught here, logged at Warn, and
 * resolves to null — never thrown past this boundary — matching
 * createDescriptionFetcher's documented best-effort contract in types.ts.
 */
function createDescriptionFetcher(): DescriptionFetcher {
  return async (externalItemId: string): Promise<string | null> => {
    try {
      await ensureSessionFileExists();
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await createAuthenticatedContext(browser);
        const page = await context.newPage();
        await page.goto(`${LISTING_URL_BASE}${encodeURIComponent(externalItemId)}/`, { waitUntil: 'networkidle' });
        return await extractListingDescription(page);
      } finally {
        await browser.close();
      }
    } catch (err) {
      logger.warn({ externalItemId, err }, 'Failed to fetch Facebook Marketplace item description');
      return null;
    }
  };
}

// The Facebook Marketplace MarketplaceConnector instance. Not registered in
// registry.ts yet — a later task (not T8) wires platformType
// 'facebook_marketplace' to this.
export const facebookMarketplaceConnector: MarketplaceConnector = {
  platformType: 'facebook_marketplace',
  search,
  createDescriptionFetcher,
};
