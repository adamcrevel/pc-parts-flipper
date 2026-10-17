// CLI entry point for capturing a logged-in Facebook Marketplace session:
// `npm run login-facebook-marketplace -w @pc-parts-flipper/server`.
//
// *** MUST be run against a DEDICATED SECONDARY Facebook account — NEVER the
// operator's primary one. *** Facebook's ToS (rewritten effective
// 2025-01-01) prohibits automated collection "whether you scrape logged in
// or logged out," so the realistic exposure of running the scan connector
// (facebookMarketplaceConnector.ts, which replays the session this script
// saves) is Meta checkpointing, restricting, or outright banning the
// *account* the session belongs to — not a lawsuit (every Meta suit found
// while planning this feature targeted industrial-scale commercial
// operations, never an individual's low-volume personal use). Running this
// against a secondary account confines that blast radius to an account that
// exists only for this purpose: losing it costs nothing the operator
// actually depends on. Running it against a primary account risks losing
// access to real friends, groups, photos, and Marketplace history the
// operator cannot recreate.
//
// Deliberately interactive and one-time rather than scripted end-to-end:
// Facebook's login flow can demand a 2FA code or a "checkpoint" identity
// challenge at any point, and only a human watching the actual window can
// solve either. This script's only job is to open that window, wait for the
// operator to finish (by hand, however many steps that takes), and persist
// the resulting cookies + local storage so every later scan reuses it
// without re-authenticating or ever storing a Facebook password anywhere.
//
// Lives under src/ (not a top-level scripts/ directory) because this
// package's tsconfig sets rootDir/include to src: anything outside it would
// be excluded from both `tsc --noEmit` and the build output.
import { chromium, type Browser } from 'playwright';
import path from 'node:path';
import { SCAN_BROWSER_INIT_SCRIPT, SCAN_BROWSER_USER_AGENT } from '../connectors/browserSession.js';
import { logger } from '../logger.js';
import { DATA_DIR } from '../photos/photoStorage.js';

const LOGIN_URL = 'https://www.facebook.com/login';

// Reuses photoStorage.ts's DATA_DIR (shared with DuckDB's DUCKDB_DATA_DIR
// override) so a test run that redirects data to an isolated directory
// redirects the session file with it too, the same reasoning photoStorage.ts
// itself documents for photos.
export const SESSION_FILE_PATH = path.join(DATA_DIR, 'facebook-marketplace-session.json');

// How often to re-check the page's URL while waiting for the operator to
// finish logging in. Short enough that the script notices within a couple
// of seconds of the final redirect off the login/checkpoint flow, long
// enough not to spam Facebook's page with no-op reads while a human is busy
// typing a password or a 2FA code.
const POLL_INTERVAL_MS = 1500;

/**
 * True once `url` is a facebook.com URL that is no longer part of the
 * login/checkpoint flow — i.e. the operator has finished authenticating
 * (including any 2FA/checkpoint challenge Facebook inserted along the way).
 * A bare path-prefix check rather than an exact-match list because
 * Facebook's checkpoint flow uses several sub-paths under `/checkpoint/`
 * (device confirmation, 2FA code entry, etc.) and new ones can appear
 * without this script needing an update for each one.
 */
export function isLoggedInUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!parsed.hostname.endsWith('facebook.com')) {
    return false;
  }
  return !parsed.pathname.startsWith('/login') && !parsed.pathname.startsWith('/checkpoint');
}

// `browser` is declared outside the try so a `finally` below can close it
// on every path that got far enough to launch it — a goto failure, a
// context/page creation failure, or a storageState() write failure must
// all still close the window rather than leave Chromium running orphaned.
let browser: Browser | undefined;
let exitCode = 0;
try {
  // headless: false — the entire point of this script is a window the
  // operator can see and interact with to clear 2FA/checkpoint prompts;
  // every other Playwright launch in this codebase (browserSession.ts's
  // launchScanBrowser) is headless because nothing else needs a human.
  browser = await chromium.launch({ headless: false });
  // Applies the same fingerprint patch (UA + navigator.webdriver override)
  // browserSession.ts's headless scan contexts use, so Facebook sees the
  // same "ordinary desktop Chrome tab" shape at login time that the
  // replayed session will present later during an actual scan.
  const context = await browser.newContext({ userAgent: SCAN_BROWSER_USER_AGENT });
  await context.addInitScript(SCAN_BROWSER_INIT_SCRIPT);
  const page = await context.newPage();
  await page.goto(LOGIN_URL);

  logger.info(
    'Log into the DEDICATED SECONDARY Facebook account in the opened browser window ' +
      '(complete any 2FA/checkpoint prompt). This script will detect completion automatically ' +
      'and save the session — do not close the window yourself.',
  );

  // Poll page.url() rather than page.waitForURL(), which needs a known
  // target pattern up front — the whole reason this is a human-in-the-loop
  // script is that the exact sequence of intermediate URLs (plain login,
  // 2FA code entry, device-confirmation checkpoint, or straight through) is
  // not knowable in advance. No timeout: the operator may need an
  // arbitrarily long time to find their phone for a 2FA code.
  while (!isLoggedInUrl(page.url())) {
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  await context.storageState({ path: SESSION_FILE_PATH });
  logger.info({ path: SESSION_FILE_PATH }, 'Facebook Marketplace session saved');
} catch (err) {
  logger.error({ err }, 'Facebook Marketplace login aborted');
  exitCode = 1;
} finally {
  if (browser) {
    await browser.close();
  }
}
process.exit(exitCode);
