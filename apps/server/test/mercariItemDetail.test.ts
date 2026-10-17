// T6 proof: apps/server/src/connectors/mercariItemDetail.ts (Req 6 --
// Mercari item-detail description fetch via its page's own __NEXT_DATA__
// script tag) and mercariConnector.ts's one-line wiring of
// createDescriptionFetcher onto the exported mercariConnector.
//
// fetchMercariItemDescription is exported specifically so every failure
// branch (missing tag, malformed JSON, missing description field,
// navigation failure) can be exercised against a bare mocked Page --
// goto/$eval stubs only, no real browser/network involved (see its own doc
// comment). createDescriptionFetcher's own resource cleanup (`finally`
// around context.close()/browser.close()) is tested separately, through
// mercariConnector.createDescriptionFetcher itself against a mocked
// browserSession.js -- which is also how the wiring addition in
// mercariConnector.ts is exercised.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright';
import { logger } from '../src/logger.js';
import { fetchMercariItemDescription } from '../src/connectors/mercariItemDetail.js';
import { mercariConnector } from '../src/connectors/mercariConnector.js';
import { launchScanBrowser } from '../src/connectors/browserSession.js';
import type * as BrowserSessionModule from '../src/connectors/browserSession.js';

vi.mock('../src/connectors/browserSession.js', async () => {
  const actual = await vi.importActual<typeof BrowserSessionModule>('../src/connectors/browserSession.js');
  return { ...actual, launchScanBrowser: vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ITEM_ID = 'm12345678901';

// Minimal mocked Playwright Page exposing only the two methods
// fetchMercariItemDescription calls. `$eval`'s real second argument (a
// page-side selector function) is never invoked against a real DOM here --
// the mock resolves `tagText` directly, standing in for whatever that
// selector would have read off a real page's #__NEXT_DATA__ tag.
function mockPage(opts: { gotoRejectsWith?: Error; tagText?: string | null }) {
  const goto = opts.gotoRejectsWith ? vi.fn().mockRejectedValue(opts.gotoRejectsWith) : vi.fn().mockResolvedValue(undefined);
  const $eval = vi.fn().mockResolvedValue(opts.tagText ?? null);
  const page = { goto, $eval } as unknown as Page;
  return { page, goto, $eval };
}

describe('fetchMercariItemDescription (T6, Req 6)', () => {
  it('resolves null without throwing when the __NEXT_DATA__ tag is missing, and logs a Warn naming that cause', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { page } = mockPage({ tagText: null });

    await expect(fetchMercariItemDescription(page, ITEM_ID)).resolves.toBeNull();

    expect(warnSpy).toHaveBeenCalledWith(
      { externalItemId: ITEM_ID },
      'Mercari item page has no __NEXT_DATA__ script tag; skipping description',
    );
  });

  it('resolves null without throwing when the __NEXT_DATA__ tag holds malformed JSON, and logs a Warn naming the parse failure -- distinct from the missing-tag message above', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { page } = mockPage({ tagText: '{not valid json' });

    await expect(fetchMercariItemDescription(page, ITEM_ID)).resolves.toBeNull();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ externalItemId: ITEM_ID }),
      'Mercari item __NEXT_DATA__ JSON failed to parse; skipping description',
    );
  });

  it('resolves null rather than throwing when page.goto rejects (e.g. a navigation timeout), logging a Warn whose message names this cause distinctly from the missing-tag/malformed-JSON causes above', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const gotoError = new Error('page.goto: Timeout 30000ms exceeded.');
    const { page, $eval } = mockPage({ gotoRejectsWith: gotoError });

    await expect(fetchMercariItemDescription(page, ITEM_ID)).resolves.toBeNull();

    // $eval is never reached once goto rejects -- the single Warn comes
    // from the outer catch, with a message distinct from both
    // '... has no __NEXT_DATA__ ...' (missing-tag, above) and
    // '... JSON failed to parse ...' (malformed-JSON, above), and carries
    // the real navigation error text so an operator can tell the three
    // apart in logs.
    expect(warnSpy).toHaveBeenCalledWith({ externalItemId: ITEM_ID, error: gotoError.message }, 'Mercari item description fetch failed');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect($eval).not.toHaveBeenCalled();
  });
});

describe('mercariConnector.createDescriptionFetcher (T6, Req 6) -- resource cleanup', () => {
  it('closes the browser context and browser via finally even when the description-field lookup hits an internal failure partway through', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const contextClose = vi.fn().mockResolvedValue(undefined);
    const browserClose = vi.fn().mockResolvedValue(undefined);
    // $eval throws synchronously the instant it is invoked -- an internal
    // failure partway through the description-field lookup that is NOT a
    // missing tag or malformed JSON (those are covered above). This is
    // caught by fetchMercariItemDescription's own outer try/catch (it
    // never throws past its own boundary, by contract/doc comment and the
    // tests above) -- this test proves context.close()/browser.close()
    // are not skipped even then, because they sit in `finally` around that
    // call rather than only running after a successful return.
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      $eval: vi.fn(() => {
        throw new Error('simulated hard failure mid-lookup');
      }),
    };
    const context = {
      addInitScript: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue(page),
      close: contextClose,
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: browserClose,
    };
    vi.mocked(launchScanBrowser).mockResolvedValue(browser as unknown as Browser);

    const fetcher = mercariConnector.createDescriptionFetcher!();
    await expect(fetcher('m999')).resolves.toBeNull();

    expect(contextClose).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledTimes(1);
  });
});
