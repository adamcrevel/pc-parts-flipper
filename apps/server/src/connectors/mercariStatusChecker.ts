// Mercari item-detail live-status checker (Req 3/7), wired onto
// mercariConnector.ts's exported connector as its `createStatusChecker`.
// Split into its own file rather than folded into mercariItemDetail.ts,
// mirroring this connector's existing search/detail split
// (mercariSearchMapping.ts/mercariItemDetail.ts) with one file per
// MarketplaceConnector hook. Re-visits the exact same item-detail page
// mercariItemDetail.ts's description fetcher already visits, reading the
// same `__NEXT_DATA__` `ItemDetail:<id>` node's `status` field instead of
// its `description` field.
//
// The status-value reading/mapping (`readItemStatus`/`mapItemStatus`) lives
// in the sibling mercariStatusMapping.ts, split out purely to keep this file
// under this codebase's ~200-line-per-file convention — mirroring
// mercariSearchMapping.ts's own split off mercariConnector.ts. See that
// file's header comment for the confirmed Mercari status value set, its
// sourcing, and the mapping each value draws to this project's
// ListingLiveStatus.
import type { Browser, Page } from 'playwright';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { launchScanBrowser, SCAN_BROWSER_INIT_SCRIPT, SCAN_BROWSER_USER_AGENT } from './browserSession.js';
import { mapItemStatus, readItemStatus } from './mercariStatusMapping.js';
import type { ListingLiveStatus, StatusChecker } from './types.js';

const NEXT_DATA_SELECTOR = '#__NEXT_DATA__';

/**
 * Checks one Mercari item's live status via its own item-detail page's
 * `__NEXT_DATA__` script tag, given an already-created (not yet navigated)
 * Page. Split out from `createStatusChecker` below purely so tests can
 * exercise every branch against a bare mocked Page, mirroring
 * `fetchMercariItemDescription`'s own split in mercariItemDetail.ts. Unlike
 * that best-effort description fetch, this one does throw past its own
 * boundary on a genuine failure (a non-404 non-2xx response, a malformed
 * `__NEXT_DATA__` payload, or an unrecognized status) — a status recheck
 * can't silently fall back to "skip it" the way a missing description can;
 * throwing here means the scan service leaves the Listing's current status
 * untouched rather than guessing one.
 */
export async function fetchMercariItemStatus(page: Page, externalItemId: string): Promise<ListingLiveStatus> {
  const response = await page.goto(`https://www.mercari.com/us/item/${encodeURIComponent(externalItemId)}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  if (response && response.status() === 404) {
    logger.debug({ externalItemId }, 'Mercari item status check: item not found (removed)');
    return 'removed';
  }
  if (response && !response.ok()) {
    logger.warn({ externalItemId, status: response.status() }, 'Mercari item status check request failed');
    throw new AppError(`Mercari item status check for ${externalItemId} failed with status ${response.status()}`, 502);
  }

  const tagText = await page.$eval(NEXT_DATA_SELECTOR, (el) => el.textContent).catch(() => null);
  if (!tagText) {
    logger.debug({ externalItemId }, 'Mercari item page has no __NEXT_DATA__ script tag; treating as removed');
    return 'removed';
  }

  let nextData: unknown;
  try {
    nextData = JSON.parse(tagText);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid JSON';
    logger.warn({ externalItemId, error: message }, 'Mercari item __NEXT_DATA__ JSON failed to parse during status check');
    throw new AppError(`Mercari item ${externalItemId} __NEXT_DATA__ JSON failed to parse: ${message}`, 502);
  }

  const status = readItemStatus(nextData, externalItemId);
  if (status === undefined) {
    logger.debug({ externalItemId }, 'Mercari item __NEXT_DATA__ is missing the expected status field; treating as removed');
    return 'removed';
  }

  return mapItemStatus(status, externalItemId);
}

/**
 * Builds the Mercari StatusChecker the scan service calls at most once per
 * scan pass, reused for every missing-candidate lookup in that pass.
 * Launches its own short-lived browser per call, closed in a `finally` —
 * matches `createDescriptionFetcher`'s own lifecycle rationale
 * (mercariItemDetail.ts) exactly, for the same reason: the
 * MarketplaceConnector/scan-service contract never signals "this scan pass
 * is finished" for a shared instance to close on, so a long-lived browser
 * launched once per factory call would leak a Chromium process past the
 * scan's own return.
 */
export function createStatusChecker(): StatusChecker {
  return async (externalItemId: string): Promise<ListingLiveStatus> => {
    const browser: Browser = await launchScanBrowser();
    try {
      const context = await browser.newContext({ userAgent: SCAN_BROWSER_USER_AGENT });
      await context.addInitScript(SCAN_BROWSER_INIT_SCRIPT);
      const page = await context.newPage();
      try {
        return await fetchMercariItemStatus(page, externalItemId);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  };
}
