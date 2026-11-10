// Shared Playwright helper for the Mercari and Facebook Marketplace
// connectors (Req 1/3): both platforms have no public listings API, so both
// drive a real browser instead of a plain HTTP client — Mercari to pass its
// Cloudflare bot check (confirmed live: a bare HTTP request gets a 403
// "Just a moment..." challenge page every time, while a real browser passes
// automatically), Facebook Marketplace to carry a real logged-in session.
// Both still need to look like an ordinary desktop Chrome tab rather than
// an automated one, since Playwright's default Chromium build otherwise
// exposes itself through `navigator.webdriver` and a non-standard default
// user agent. The UA string and init script are exported separately from
// `launchScanBrowser` below so a later persistent, logged-in context (which
// cannot reuse a bare headless `chromium.launch` — it needs its own
// `launchPersistentContext`/`newContext` call carrying a `storageState`)
// can still apply the exact same fingerprint patch rather than duplicating
// it.
import { chromium, type Browser } from 'playwright';

// A real desktop Chrome user-agent string, version-matched to the Chromium
// build Playwright actually bundles (confirmed by reading
// `node_modules/playwright-core/browsers.json` after installing the pinned
// `playwright` dependency in package.json: Chrome for Testing 156.0.8078.4
// for `chromium`). Playwright's own default UA already looks like Chrome,
// but pins the OS to whatever the host machine reports (e.g. a Linux CI
// runner) — overriding it with a stock Windows desktop string is a
// strictly more common, less fingerprintable shape for a bot-detection
// system to see than "Chrome on Linux", which is rare among real consumer
// shoppers.
export const SCAN_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

// Playwright's automated Chromium sets `navigator.webdriver` to `true`,
// which is the single most common signal both Cloudflare's bot management
// (Mercari) and Facebook's own anti-automation checks look for first.
// `addInitScript` runs this before any page script on every new document,
// including client-side navigations within the same context, so it can't be
// bypassed by the site's own JS running before a manual patch would.
// Redefining the property (rather than assigning it) is required because
// `navigator.webdriver` is defined with only a getter on the automated
// build — a plain assignment silently no-ops.
export const SCAN_BROWSER_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
  });
`;

/**
 * Launches a headless Chromium instance for a one-shot scan pass (Mercari's
 * connector, and anything else that doesn't need a persisted login). Callers
 * apply `SCAN_BROWSER_USER_AGENT`/`SCAN_BROWSER_INIT_SCRIPT` themselves when
 * they create a page/context from the returned Browser, since a bare
 * `Browser` has no context yet to carry a user agent or init script.
 */
export async function launchScanBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}
