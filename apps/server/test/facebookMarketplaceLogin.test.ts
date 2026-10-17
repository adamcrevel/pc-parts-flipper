// T7 proof: apps/server/src/scripts/facebook-marketplace-login.ts.
//
// This file is a top-level script, not an importable library module: its
// whole login flow (chromium.launch -> newContext -> goto -> poll loop ->
// storageState -> close -> process.exit) runs unconditionally at
// module-evaluation time, with no `if (require.main === module)`-style
// guard. So every `import()` below -- even the ones that exist only to pull
// out the pure `isLoggedInUrl` predicate -- drives that whole flow through
// mocked `playwright`/`process.exit`. `vi.resetModules()` plus a fresh
// dynamic `import()` per scenario is what lets different tests give that
// flow different mocked outcomes (a `page.url()` that is "already logged
// in" immediately, vs. a `storageState()`/`goto()` call that rejects).
//
// The real interactive login flow itself -- an actual visible browser
// window, a human clearing a 2FA code or a Facebook checkpoint challenge --
// is NOT exercised here and cannot be: there is no dedicated secondary
// Facebook account in this sandbox, and the flow is deliberately
// human-in-the-loop (see the file's own top-of-file comment). What's
// verified below is everything that is actually testable without a human
// and a real Facebook session: the pure `isLoggedInUrl` predicate the poll
// loop uses to decide when to stop, and the file's resource-cleanup
// behavior on the mocked Playwright calls that flow composes.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock, MockInstance } from 'vitest';
import { chromium } from 'playwright';

vi.mock('playwright', () => ({ chromium: { launch: vi.fn() } }));

const launchMock = vi.mocked(chromium.launch);

interface FakePage {
  goto: Mock;
  url: Mock;
  waitForTimeout: Mock;
}

function fakePage(url: string, overrides: Partial<Pick<FakePage, 'goto'>> = {}): FakePage {
  return {
    goto: overrides.goto ?? vi.fn(async () => undefined),
    url: vi.fn(() => url),
    waitForTimeout: vi.fn(async () => undefined),
  };
}

interface FakeContext {
  addInitScript: Mock;
  newPage: Mock;
  storageState: Mock;
}

function fakeContext(
  page: FakePage,
  overrides: Partial<Pick<FakeContext, 'storageState' | 'newPage'>> = {},
): FakeContext {
  return {
    addInitScript: vi.fn(async () => undefined),
    newPage: overrides.newPage ?? vi.fn(async () => page),
    storageState: overrides.storageState ?? vi.fn(async () => undefined),
  };
}

function fakeBrowser(context: FakeContext, overrides: Partial<{ newContext: Mock }> = {}) {
  return {
    newContext: overrides.newContext ?? vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
}

let exitMock: MockInstance;

beforeEach(() => {
  launchMock.mockReset();
  exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isLoggedInUrl', () => {
  // isLoggedInUrl is a pure function, so it only needs to be extracted
  // once: a single successful mocked import (page.url() already reports a
  // logged-in URL, so the poll loop exits immediately) is enough to pull
  // the real export off the real module.
  let isLoggedInUrl: (url: string) => boolean;

  beforeAll(async () => {
    const page = fakePage('https://www.facebook.com/marketplace/');
    const context = fakeContext(page);
    const browser = fakeBrowser(context);
    launchMock.mockResolvedValue(browser as never);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.resetModules();
    // Dynamic import (not a literal module-selection choice but a test
    // boundary one): this file's whole login flow runs at module-eval
    // time, so re-importing it fresh per scenario via `vi.resetModules()`
    // is the only way to give each scenario its own mocked outcome -- a
    // static top-level import would only ever evaluate the module once.
    const mod = await import('../src/scripts/facebook-marketplace-login.js');
    isLoggedInUrl = mod.isLoggedInUrl;
  });

  // Each case below isolates one of the predicate's three branches (URL
  // parse failure, host check, path-prefix check) or a specific boundary
  // within one of them, rather than reusing the same shape with the
  // implementation's own constants -- every expected value here is a
  // literal `true`/`false` worked out by hand against the documented rule
  // ("true once on facebook.com and no longer under /login or /checkpoint"),
  // not derived from the function under test.

  it('is true for an ordinary post-login facebook.com URL', () => {
    expect(isLoggedInUrl('https://www.facebook.com/marketplace/')).toBe(true);
  });

  it('is true for the bare facebook.com root after login', () => {
    expect(isLoggedInUrl('https://www.facebook.com/')).toBe(true);
  });

  it('is true on a facebook.com subdomain (hostname suffix match, not exact)', () => {
    expect(isLoggedInUrl('https://m.facebook.com/marketplace/search/?query=gpu')).toBe(true);
  });

  it('is true for a path that merely contains "login" without starting with it (startsWith, not includes)', () => {
    expect(isLoggedInUrl('https://www.facebook.com/home/login-help/')).toBe(true);
  });

  it('is false while still on the login page', () => {
    expect(isLoggedInUrl('https://www.facebook.com/login/?next=%2Fmarketplace')).toBe(false);
  });

  it('is false on the bare /login path with no trailing slash or query', () => {
    expect(isLoggedInUrl('https://www.facebook.com/login')).toBe(false);
  });

  it('is false on the exact /checkpoint path', () => {
    expect(isLoggedInUrl('https://www.facebook.com/checkpoint/1501092823525282/')).toBe(false);
  });

  it('is false on a /checkpoint sub-path (2FA/device-confirmation step), proving the bare prefix match the file documents', () => {
    expect(isLoggedInUrl('https://www.facebook.com/checkpoint/two_step_verification/two_factor/')).toBe(false);
  });

  it('is false for a non-facebook.com host even when the path looks like an ordinary logged-in page', () => {
    expect(isLoggedInUrl('https://evil.example.com/marketplace/')).toBe(false);
  });

  it('is false for a malformed URL string (caught, not thrown)', () => {
    expect(isLoggedInUrl('not a url')).toBe(false);
  });
});

describe('browser cleanup on every post-launch failure path (A33 must_fix confirmation)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('baseline: browser.close() IS called when the whole flow succeeds', async () => {
    const page = fakePage('https://www.facebook.com/marketplace/');
    const context = fakeContext(page);
    const browser = fakeBrowser(context);
    launchMock.mockResolvedValue(browser as never);

    // See the file-header/beforeAll comments above: dynamic import is
    // required here to force a fresh, independently-mocked module
    // evaluation per scenario (vi.resetModules() in this describe's own
    // beforeEach discards the previous evaluation's cache first).
    await import('../src/scripts/facebook-marketplace-login.js');

    expect(browser.close).toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it('browser.close() IS called when page.goto() rejects after a successful launch', async () => {
    const page = fakePage('https://www.facebook.com/marketplace/', {
      goto: vi.fn(async () => {
        throw new Error('net::ERR_CONNECTION_RESET');
      }),
    });
    const context = fakeContext(page);
    const browser = fakeBrowser(context);
    launchMock.mockResolvedValue(browser as never);

    await import('../src/scripts/facebook-marketplace-login.js');

    // A33's fix: `browser` is now `let`-declared outside the try block and
    // closed from a `finally`, so a goto() failure -- which happens
    // strictly after a successful launch -- must still close Chromium
    // rather than leak it (the pre-fix behavior this test used to assert
    // the opposite of, before the must_fix landed).
    expect(browser.close).toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('browser.close() IS called when browser.newContext() rejects after a successful launch (context-creation failure)', async () => {
    const page = fakePage('https://www.facebook.com/marketplace/');
    const context = fakeContext(page);
    const browser = fakeBrowser(context, {
      newContext: vi.fn(async () => {
        throw new Error('Target closed');
      }),
    });
    launchMock.mockResolvedValue(browser as never);

    // Dynamic import deliberately: see the file-header/beforeAll comments
    // above -- this script's whole login flow runs at module-eval time, so
    // vi.resetModules() plus a fresh import() per scenario is the only way
    // to re-drive it with this test's own mocked newContext() rejection.
    await import('../src/scripts/facebook-marketplace-login.js');

    expect(browser.close).toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('browser.close() IS called when context.newPage() rejects after a successful launch (page-creation failure)', async () => {
    const page = fakePage('https://www.facebook.com/marketplace/');
    const context = fakeContext(page, {
      newPage: vi.fn(async () => {
        throw new Error('Target page, context or browser has been closed');
      }),
    });
    const browser = fakeBrowser(context);
    launchMock.mockResolvedValue(browser as never);

    // Dynamic import deliberately: same module-eval-time boundary as above,
    // re-driven here with this test's own mocked newPage() rejection.
    await import('../src/scripts/facebook-marketplace-login.js');

    expect(browser.close).toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it('browser.close() IS called when context.storageState() rejects after a successful launch', async () => {
    const page = fakePage('https://www.facebook.com/marketplace/');
    const context = fakeContext(page, {
      storageState: vi.fn(async () => {
        throw new Error('ENOSPC: disk full, write');
      }),
    });
    const browser = fakeBrowser(context);
    launchMock.mockResolvedValue(browser as never);

    // Dynamic import deliberately: same module-eval-time boundary as above,
    // re-driven here with this test's own mocked storageState() rejection.
    await import('../src/scripts/facebook-marketplace-login.js');

    // A33's fix: this is the same scenario the pre-fix version of this
    // suite asserted close() was NOT called for -- now the inverse,
    // confirming the leak is actually closed rather than trusting A33's
    // claim.
    expect(browser.close).toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(1);
  });
});
