// Facebook Marketplace per-item live-status signals (Req 8), split out of
// facebookMarketplaceConnector.ts to keep that file near the ~200-line
// convention — the same split convention facebookMarketplaceSession.ts,
// facebookMarketplaceListing.ts and facebookMarketplaceDom.ts already
// follow. This file answers one question about a listing's *own* detail
// page: is this item still for sale, sold, or gone? The connector's
// createStatusChecker owns the browser/session orchestration;
// facebookMarketplaceStatusDom.ts owns the selectors and the in-page
// reader that turn the page into plain ListingPageSignals; everything
// about *classifying* those signals lives here, so correcting a text
// pattern below is a small, localized edit rather than a rewrite of
// either of those.
//
// *** UNVERIFIED AGAINST A REAL LOGGED-IN SESSION. *** No real, dedicated
// Facebook account is available in this sandbox, so the sold pill selector
// (facebookMarketplaceStatusDom.ts) and both text patterns below are
// best-evidenced guesses (Facebook's public "Sold" marketplace badge
// wording, and the "This content isn't available right now" / "no longer
// available" interstitials Facebook serves for a deleted item), not
// confirmed live shapes. This recheck is therefore best-effort and is
// deliberately NOT as reliable as the eBay or Mercari ones — see
// facebookMarketplaceConnector.ts's own top comment.
import type { Page, Response } from 'playwright';
import { AppError } from '../error-handler.js';
import { isFacebookRootUrl, isLoginOrCheckpointUrl, LOGIN_COMMAND, LOGIN_WALL_SELECTOR } from './facebookMarketplaceSession.js';
import type { ListingLiveStatus } from './types.js';

// The narrow text forms that mean "this specific listing is sold" — each
// anchored to a whole trimmed line, so description prose containing the
// word "sold" can never match. The pill (SOLD_SELECTOR in
// facebookMarketplaceStatusDom.ts) is the primary signal; these cover the
// case where it is rendered as plain text instead.
//
// The separator form ("Sold • Listed 2 weeks ago") accepts a bullet, pipe,
// en-dash or hyphen, but only when whitespace (or the end of the line)
// follows the separator: a PDP's first line is the listing's own title,
// and "Sold-out edition Funko Pop", "Sold–out edition Funko Pop",
// "Sold|Trade bundle" and "Sold•out vinyl reissue" are live listings whose
// title merely starts with a joined word — the text-pattern twin of
// SOLD_SELECTOR's prefix-match leak. The boundary is required after every
// member of the character class, not just the hyphen; guarding one
// separator at a time left the other three leaking one character over.
const SOLD_LINE_PATTERNS = [/^sold$/i, /^sold\s*[•|–-](?:\s|$)/i, /^(?:this\s+)?listing\s+(?:was\s+)?sold$/i, /^sold\s+out$/i];

// Facebook's interstitials for an item that no longer exists. Matched
// against the whole interstitial region's text (not per line) because
// these sentences are routinely wrapped across elements.
const UNAVAILABLE_PATTERNS = [
  /this content isn't available/i,
  /no longer available/i,
  /this listing isn't available/i,
  /page isn't available/i,
  /content not found/i,
];

// HTTP statuses that by themselves mean the listing page is gone. These are
// the one status-signal exception to the authenticated-page guard below,
// which otherwise treats any non-2xx/3xx as "Facebook refused us".
const GONE_STATUSES = new Set([404, 410]);

const MIN_OK_STATUS = 200;
const MAX_OK_STATUS_EXCLUSIVE = 400;

/**
 * The raw, already-read signals one listing detail page offers about its
 * own live status. Kept as plain data so the classification below is a
 * pure function testable without a browser.
 */
export interface ListingPageSignals {
  /** page.goto()'s response status, or null when it produced no response. */
  httpStatus: number | null;
  /** True when the sold pill matched *inside the item's own PDP container*, outside any other listing's tile. */
  soldIndicator: boolean;
  /** The PDP container's own visible text, other listings' tiles excluded; '' when no PDP container was found. */
  pdpText: string;
  /** The gone-interstitial region's own text; '' when the PDP itself was rendered. */
  interstitialText: string;
}

/**
 * Throws AppError(400) naming the login script unless this listing-page
 * navigation really was answered by Facebook as a logged-in user. Mirrors
 * assertSearchPageAuthenticated's four signals for the same reason it
 * checks four: a rejected session served as a login wall, a root bounce or
 * a 403 must never be mistaken for "the item is gone" and transition a
 * perfectly live Listing to `removed`. The one difference from the search
 * guard is 404/410 — on a listing page those are the genuine gone signal,
 * not a refusal, so they pass through to classifyListingPageSignals.
 */
export async function assertListingPageAuthenticated(page: Page, response: Response | null): Promise<void> {
  const url = page.url();
  if (isLoginOrCheckpointUrl(url)) {
    throw listingPageRejectedError('Facebook Marketplace redirected to a login/checkpoint page instead of the listing page');
  }
  if (isFacebookRootUrl(url)) {
    throw listingPageRejectedError('Facebook Marketplace redirected to the facebook.com root instead of the listing page');
  }
  const status = response?.status();
  if (status !== undefined && !GONE_STATUSES.has(status) && (status < MIN_OK_STATUS || status >= MAX_OK_STATUS_EXCLUSIVE)) {
    throw listingPageRejectedError(`Facebook Marketplace answered the listing navigation with HTTP ${status} instead of the listing page`);
  }
  if ((await page.$(LOGIN_WALL_SELECTOR)) !== null) {
    throw listingPageRejectedError('Facebook Marketplace rendered a login wall in place of the listing page');
  }
}

function listingPageRejectedError(reason: string): AppError {
  return new AppError(
    `${reason} — the saved session has likely expired or been challenged. Run \`${LOGIN_COMMAND}\` to re-authenticate.`,
    400,
  );
}

// Facebook renders curly apostrophes ("isn’t"), so the page text is
// normalized to plain ASCII apostrophes before matching the text patterns
// below, all of which are written with one.
const CURLY_APOSTROPHE_PATTERN = /[\u2018\u2019\u02bc]/g;

// Line-anchored so description prose containing the word "sold" ("sold as
// is", "already sold my other one") can never be mistaken for the pill.
// Fed the PDP container's text only, so a neighbouring listing's own
// "Sold" line cannot retire this item.
function hasSoldLine(pdpText: string): boolean {
  return pdpText
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line.length > 0 && SOLD_LINE_PATTERNS.some((pattern) => pattern.test(line)));
}

/**
 * Decides one listing's live status from the signals its own page gave up.
 * `sold` wins over `removed` because it is the strictly more specific
 * answer — a sold listing's page often also carries a generic "no longer
 * available" line — and `active` is only ever the answer when no gone
 * signal appeared at all, so an unrecognized page shape leaves a Listing
 * where it is rather than silently retiring it.
 */
export function classifyListingPageSignals(signals: ListingPageSignals): ListingLiveStatus {
  if (signals.soldIndicator || hasSoldLine(signals.pdpText.replace(CURLY_APOSTROPHE_PATTERN, "'"))) {
    return 'sold';
  }
  if (signals.httpStatus !== null && GONE_STATUSES.has(signals.httpStatus)) {
    return 'removed';
  }
  const interstitialText = signals.interstitialText.replace(CURLY_APOSTROPHE_PATTERN, "'");
  return UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(interstitialText)) ? 'removed' : 'active';
}
