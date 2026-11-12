// T4 proof: apps/server/src/connectors/mercariStatusChecker.ts (Req 3/7 --
// Mercari per-item live-status recheck via its item-detail page's own
// __NEXT_DATA__ script tag) and mercariConnector.ts's one-line wiring of
// createStatusChecker onto the exported mercariConnector.
//
// fetchMercariItemStatus is exported specifically so every branch (each
// confirmed status value, HTTP 404, a non-404 non-2xx response, a missing
// __NEXT_DATA__ tag, an unparseable __NEXT_DATA__ payload, a missing
// ItemDetail node, and an unrecognized status value) can be exercised
// against a bare mocked Page/Response -- no real browser/network involved,
// mirroring fetchMercariItemDescription's own test split in
// mercariItemDetail.test.ts. createStatusChecker's own resource cleanup
// (`finally` around context.close()/browser.close()) is tested separately
// through mercariConnector.createStatusChecker itself against a mocked
// browserSession.js -- the same structure mercariItemDetail.test.ts already
// uses for createDescriptionFetcher.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser, Page, Response } from 'playwright';
import { AppError } from '../src/error-handler.js';
import { fetchMercariItemStatus } from '../src/connectors/mercariStatusChecker.js';
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

// Minimal mocked Playwright Page/Response pair exposing only what
// fetchMercariItemStatus calls. `$eval`'s real second argument (a page-side
// selector function) is never invoked against a real DOM here -- the mock
// resolves `tagText` directly, standing in for whatever that selector would
// have read off a real page's #__NEXT_DATA__ tag.
function mockPage(opts: { httpStatus?: number; ok?: boolean; tagText?: string | null }) {
  const httpStatus = opts.httpStatus ?? 200;
  const ok = opts.ok ?? (httpStatus >= 200 && httpStatus < 300);
  const response = { status: () => httpStatus, ok: () => ok } as unknown as Response;
  const goto = vi.fn().mockResolvedValue(response);
  const $eval = vi.fn().mockResolvedValue(opts.tagText ?? null);
  const page = { goto, $eval } as unknown as Page;
  return { page, goto, $eval };
}

function nextDataWith(status: string | undefined): string {
  const itemDetail: Record<string, unknown> = status === undefined ? {} : { status };
  return JSON.stringify({
    props: { pageProps: { serverState: { [`ItemDetail:${ITEM_ID}`]: itemDetail } } },
  });
}

describe('fetchMercariItemStatus (T4, Req 3/7)', () => {
  it('resolves active for a real for-sale item\'s confirmed on_sale status', async () => {
    const { page } = mockPage({ tagText: nextDataWith('on_sale') });
    await expect(fetchMercariItemStatus(page, ITEM_ID)).resolves.toBe('active');
  });

  it('resolves sold for the confirmed trading status (a buyer has already committed)', async () => {
    const { page } = mockPage({ tagText: nextDataWith('trading') });
    await expect(fetchMercariItemStatus(page, ITEM_ID)).resolves.toBe('sold');
  });

  it('resolves sold for Mercari\'s own sold_out status', async () => {
    const { page } = mockPage({ tagText: nextDataWith('sold_out') });
    await expect(fetchMercariItemStatus(page, ITEM_ID)).resolves.toBe('sold');
  });

  it.each(['stop', 'cancel', 'admin_cancel'])(
    'resolves removed for Mercari\'s own REMOVED_ITEM_STATUSES value %s (seller/admin delisted, not sold)',
    async (status) => {
      const { page } = mockPage({ tagText: nextDataWith(status) });
      await expect(fetchMercariItemStatus(page, ITEM_ID)).resolves.toBe('removed');
    },
  );

  it('resolves removed on an HTTP 404 without reading __NEXT_DATA__ at all', async () => {
    const { page, $eval } = mockPage({ httpStatus: 404, ok: false });
    await expect(fetchMercariItemStatus(page, ITEM_ID)).resolves.toBe('removed');
    expect($eval).not.toHaveBeenCalled();
  });

  it('resolves removed when the page loads but has no __NEXT_DATA__ script tag', async () => {
    const { page } = mockPage({ tagText: null });
    await expect(fetchMercariItemStatus(page, ITEM_ID)).resolves.toBe('removed');
  });

  it('resolves removed when __NEXT_DATA__ parses but the ItemDetail node itself is missing', async () => {
    const { page } = mockPage({ tagText: JSON.stringify({ props: { pageProps: { serverState: {} } } }) });
    await expect(fetchMercariItemStatus(page, ITEM_ID)).resolves.toBe('removed');
  });

  it('throws AppError naming the real HTTP status for a non-404 non-2xx response, rather than resolving to any status', async () => {
    const { page, $eval } = mockPage({ httpStatus: 500, ok: false });
    // Asserted on the message, not just the AppError type: this file has
    // three separate throw sites (bad HTTP status, malformed JSON,
    // unrecognized status value) that all raise AppError -- the message is
    // what proves this specific branch fired, not merely that some AppError
    // surfaced.
    await expect(fetchMercariItemStatus(page, ITEM_ID)).rejects.toThrow(
      `Mercari item status check for ${ITEM_ID} failed with status 500`,
    );
    await expect(fetchMercariItemStatus(page, ITEM_ID)).rejects.toBeInstanceOf(AppError);
    expect($eval).not.toHaveBeenCalled();
  });

  it('throws AppError naming the parse failure when __NEXT_DATA__ holds malformed JSON, rather than resolving to removed', async () => {
    const { page } = mockPage({ tagText: '{not valid json' });
    await expect(fetchMercariItemStatus(page, ITEM_ID)).rejects.toThrow(/__NEXT_DATA__ JSON failed to parse/);
    await expect(fetchMercariItemStatus(page, ITEM_ID)).rejects.toBeInstanceOf(AppError);
  });

  it('throws AppError naming the unrecognized value for a status outside the confirmed set, rather than guessing active/sold/removed', async () => {
    const { page } = mockPage({ tagText: nextDataWith('some_future_status') });
    await expect(fetchMercariItemStatus(page, ITEM_ID)).rejects.toThrow(
      `Mercari item ${ITEM_ID} has unrecognized status 'some_future_status'`,
    );
    await expect(fetchMercariItemStatus(page, ITEM_ID)).rejects.toBeInstanceOf(AppError);
  });
});

describe('mercariConnector.createStatusChecker (T4, Req 3/7) -- resource cleanup', () => {
  it('closes the browser context and browser via finally even when the status lookup hits an internal failure partway through', async () => {
    const contextClose = vi.fn().mockResolvedValue(undefined);
    const browserClose = vi.fn().mockResolvedValue(undefined);
    // $eval throws synchronously the instant it is invoked -- an internal
    // failure partway through the status lookup that is NOT a missing tag
    // or malformed JSON (those are covered above). This proves
    // context.close()/browser.close() are not skipped even when the lookup
    // itself rejects, because they sit in `finally` around that call rather
    // than only running after a successful return.
    const page = {
      goto: vi.fn().mockResolvedValue({ status: () => 200, ok: () => true }),
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

    const checkStatus = mercariConnector.createStatusChecker!();
    await expect(checkStatus('m999')).rejects.toThrow('simulated hard failure mid-lookup');

    expect(contextClose).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledTimes(1);
  });

  it('resolves a real confirmed status end to end through the connector\'s own wiring', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue({ status: () => 200, ok: () => true }),
      $eval: vi.fn().mockResolvedValue(nextDataWith('on_sale')),
    };
    const context = {
      addInitScript: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(launchScanBrowser).mockResolvedValue(browser as unknown as Browser);

    const checkStatus = mercariConnector.createStatusChecker!();
    await expect(checkStatus(ITEM_ID)).resolves.toBe('active');
  });
});
