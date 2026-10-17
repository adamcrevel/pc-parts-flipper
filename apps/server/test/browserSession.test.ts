// T4 smoke test: proves launchScanBrowser actually launches a real
// Chromium process (not a mock, not a stub) and that the process is
// cleanly closed afterward — every other test touching browserSession.ts
// (mercariConnector.test.ts, mercariItemDetail.test.ts,
// facebookMarketplaceConnector.test.ts) mocks this module entirely via
// `vi.mock`, so none of them ever actually exercises the real
// `chromium.launch` call this file wraps. This is the one place that does.
import { describe, expect, it } from 'vitest';

import { launchScanBrowser } from '../src/connectors/browserSession.js';

describe('launchScanBrowser', () => {
  it('launches a real headless Chromium instance, navigates a page, and closes cleanly', async () => {
    const browser = await launchScanBrowser();
    try {
      expect(browser.isConnected()).toBe(true);
      const page = await browser.newPage();
      await page.goto('about:blank');
      expect(await page.evaluate(() => 1 + 1)).toBe(2);
      await page.close();
    } finally {
      await browser.close();
    }
    expect(browser.isConnected()).toBe(false);
  }, 30000);
});
