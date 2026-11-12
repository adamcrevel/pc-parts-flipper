// Facebook Marketplace session handling and expired-session guard (Req 6,
// T8), split out of facebookMarketplaceConnector.ts to keep that file near
// the ~200-line convention — the same way mercariSearchMapping.ts and
// mercariItemDetail.ts are split out of mercariConnector.ts.
//
// Everything about "is this browser still a logged-in Facebook user?"
// lives here: where the persisted session file is, how an authenticated
// browser context is built from it, and — most importantly — the guard
// that decides a navigation was answered by an auth wall rather than by
// search results. Requirement 6's single most safety-critical promise is
// that an expired session can never look like "the scan ran and found
// nothing", so that guard deliberately checks four independent signals
// rather than only the post-navigation URL prefix: Facebook bounces an
// unauthenticated request to /login or /checkpoint *sometimes*, but it
// also serves an inline login wall at the requested search URL itself,
// bounces to the bare site root, and answers with a non-OK status — each
// of which would otherwise parse as "zero listings" and import silently.
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Page, Response } from 'playwright';
import { AppError } from '../error-handler.js';
import { DATA_DIR } from '../photos/photoStorage.js';
import { SCAN_BROWSER_INIT_SCRIPT, SCAN_BROWSER_USER_AGENT } from './browserSession.js';

// Same DATA_DIR resolution as photoStorage.ts's PHOTOS_DIR and
// facebook-marketplace-login.ts's SESSION_FILE_PATH (duplicated as a bare
// path.join rather than imported from the login script, which runs
// top-level side-effecting code on import — launching a real visible
// browser window and blocking on operator interaction — that must never
// fire just from importing this connector).
export const SESSION_FILE_PATH = path.join(DATA_DIR, 'facebook-marketplace-session.json');

export const LOGIN_COMMAND = 'npm run login-facebook-marketplace';

// Every way a rejected session can surface ends in the same instruction,
// so the operator always reads one actionable next step no matter which
// of the four signals tripped. The leading clause differs per signal so
// the four causes stay distinguishable in logs and in tests.
function sessionRejectedError(reason: string): AppError {
  return new AppError(
    `${reason} — the saved session has likely expired or been challenged. Run \`${LOGIN_COMMAND}\` to re-authenticate.`,
    400,
  );
}

/**
 * Mirrors facebook-marketplace-login.ts's `isLoggedInUrl` check (inverted),
 * duplicated here for the same reason SESSION_FILE_PATH is above rather
 * than imported. True once `url` is a facebook.com login or checkpoint
 * (2FA/device-confirmation) URL — i.e. the saved session was rejected and
 * Facebook bounced this navigation back to auth instead of serving results.
 */
export function isLoginOrCheckpointUrl(url: string): boolean {
  const parsed = parseFacebookUrl(url);
  if (!parsed) {
    return false;
  }
  return parsed.pathname.startsWith('/login') || parsed.pathname.startsWith('/checkpoint');
}

/**
 * True when a search navigation ended up at facebook.com's bare root
 * (`/` or no path at all). Facebook answers some rejected sessions by
 * bouncing to the root-path logged-out homepage rather than to an
 * explicit /login URL, which carries no listings and would otherwise be
 * indistinguishable from a search that matched nothing.
 */
export function isFacebookRootUrl(url: string): boolean {
  const parsed = parseFacebookUrl(url);
  if (!parsed) {
    return false;
  }
  return parsed.pathname === '/' || parsed.pathname === '';
}

// Shared parse+host check for the two URL predicates above. Returns null
// for anything unparseable or not on facebook.com, so a malformed URL or
// some unrelated host can never be mistaken for a Facebook auth wall.
function parseFacebookUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.hostname === 'facebook.com' || parsed.hostname.endsWith('.facebook.com') ? parsed : null;
}

// Selectors for the inline login wall Facebook renders *at the requested
// URL* for a rejected session — the page's own URL stays the search URL,
// so no URL check can catch this one. `royal_login_form`/`royal_*` are
// Facebook's own long-standing test ids for the logged-out login form,
// and a `name="pass"` password input or a form posting to /login is the
// structural signature of that wall regardless of what the ids are
// renamed to.
// Exported so the sibling per-item status check
// (facebookMarketplaceStatus.ts) probes for the exact same wall rather
// than keeping a second, drifting copy of these signatures.
export const LOGIN_WALL_SELECTOR = [
  'form[action*="/login"]',
  'input[name="pass"]',
  '[data-testid="royal_login_form"]',
  '[data-testid="royal_login_button"]',
].join(', ');

// Playwright follows redirects itself, so an authenticated search
// navigation settles on a 2xx; 3xx is accepted too for the case where a
// final hop is surfaced directly. 4xx/5xx means Facebook refused the
// request (rate limit, bot block, revoked session) and nothing on the
// resulting page can be trusted as search results.
const MIN_OK_STATUS = 200;
const MAX_OK_STATUS_EXCLUSIVE = 400;

/**
 * Throws AppError(400) naming the login script unless this navigation
 * really did land on authenticated search results. Checks four
 * independent signals, because Facebook rejects a stale session in more
 * than one way and every unchecked way degrades into a silent zero-result
 * scan: (1) the URL is a /login or /checkpoint page, (2) the URL is
 * facebook.com's bare root, (3) the navigation's HTTP status is not
 * 2xx/3xx, (4) the page body carries a login wall even though its URL is
 * still the search URL.
 *
 * `response` is `page.goto()`'s own return value; it is null only for a
 * navigation Playwright did not produce a response for (a same-document
 * navigation), in which case the status signal is simply unavailable and
 * the other three still apply. A failure of the DOM query in (4) is
 * deliberately *not* swallowed — the whole point of this guard is that a
 * scan which cannot confirm it is authenticated must fail loudly rather
 * than return an empty result set.
 */
export async function assertSearchPageAuthenticated(page: Page, response: Response | null): Promise<void> {
  const url = page.url();
  if (isLoginOrCheckpointUrl(url)) {
    throw sessionRejectedError('Facebook Marketplace redirected to a login/checkpoint page instead of search results');
  }
  if (isFacebookRootUrl(url)) {
    throw sessionRejectedError('Facebook Marketplace redirected to the facebook.com root instead of search results');
  }
  const status = response?.status();
  if (status !== undefined && (status < MIN_OK_STATUS || status >= MAX_OK_STATUS_EXCLUSIVE)) {
    throw sessionRejectedError(`Facebook Marketplace answered the search navigation with HTTP ${status} instead of search results`);
  }
  if ((await page.$(LOGIN_WALL_SELECTOR)) !== null) {
    throw sessionRejectedError('Facebook Marketplace rendered a login wall in place of search results');
  }
}

/**
 * Confirms a persisted session file exists before launching a browser.
 * Throws AppError(400) naming the login script when it's missing, rather
 * than letting Playwright fail obscurely on a bad `storageState` path.
 */
export async function ensureSessionFileExists(): Promise<void> {
  try {
    await access(SESSION_FILE_PATH);
  } catch {
    throw new AppError(
      `No Facebook Marketplace session found at ${SESSION_FILE_PATH}. Run \`${LOGIN_COMMAND}\` to log in before scanning Facebook Marketplace.`,
      400,
    );
  }
}

/**
 * Opens a fresh browser context carrying the persisted login session plus
 * the shared anti-automation fingerprint patch from browserSession.ts.
 * Both callers (the per-query search context and the description
 * fetcher's short-lived context) go through here so neither can drift
 * into using a bare, unauthenticated or unpatched context.
 */
export async function createAuthenticatedContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ storageState: SESSION_FILE_PATH, userAgent: SCAN_BROWSER_USER_AGENT });
  await context.addInitScript(SCAN_BROWSER_INIT_SCRIPT);
  return context;
}
