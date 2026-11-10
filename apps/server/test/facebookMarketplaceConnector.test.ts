// T8 proof: apps/server/src/connectors/facebookMarketplaceConnector.ts and
// its siblings facebookMarketplaceConfig.ts, facebookMarketplaceSession.ts,
// facebookMarketplaceListing.ts and facebookMarketplaceDom.ts (Req 6 —
// automated Facebook Marketplace scan via an already-authenticated
// Playwright session).
//
// Mocks the `playwright` module's `chromium.launch` and `node:fs/promises`'s
// `access` directly, the same way ebayConnector.test.ts stubs global fetch —
// no real browser is ever launched and no real network call is ever made.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';
import { AppError } from '../src/error-handler.js';
import { logger } from '../src/logger.js';
import { facebookMarketplaceConnector } from '../src/connectors/facebookMarketplaceConnector.js';
import type { Page, Response } from 'playwright';
import {
  assertSearchPageAuthenticated,
  isFacebookRootUrl,
  isLoginOrCheckpointUrl,
  SESSION_FILE_PATH,
} from '../src/connectors/facebookMarketplaceSession.js';
import { SCAN_BROWSER_INIT_SCRIPT, SCAN_BROWSER_USER_AGENT } from '../src/connectors/browserSession.js';
import { buildSearchUrl, parseListingsFromResponses } from '../src/connectors/facebookMarketplaceListing.js';
import { mapRawDomListing } from '../src/connectors/facebookMarketplaceDom.js';

vi.mock('playwright', () => ({ chromium: { launch: vi.fn() } }));
vi.mock('node:fs/promises', () => ({ access: vi.fn() }));

const launchMock = vi.mocked(chromium.launch);
const accessMock = vi.mocked(access);

// A single fake Response-ish object page.on('response', ...) hands the
// connector during a navigation: just enough of Playwright's real Response
// shape (request().resourceType(), json()) for searchOneQuery to collect it.
function fakePlaywrightResponse(body: unknown, resourceType = 'xhr') {
  return {
    request: () => ({ resourceType: () => resourceType }),
    json: async () => body,
  };
}

interface FakePage {
  on: Mock;
  goto: Mock;
  url: Mock;
  evaluate: Mock;
  $: Mock;
  $eval: Mock;
}

// `navigationStatus` isn't part of the Page surface — it's how a test says
// "let page.goto() resolve a Response carrying this HTTP status", which is
// the fourth signal the Requirement 6 guard checks. Left undefined,
// goto() resolves null (Playwright's own behaviour for a navigation it
// produced no response for) and the status signal simply doesn't apply.
type FakePageOverrides = Partial<FakePage> & { navigationStatus?: number };

// Builds a fake Page whose goto() immediately fires whatever response
// handler the connector registered via page.on('response', ...), carrying
// `responseBody` — this stands in for Playwright surfacing a real network
// response during a real navigation to buildSearchUrl's URL.
function fakePage(responseBody: unknown = { data: {} }, overrides: FakePageOverrides = {}): FakePage {
  const { navigationStatus, ...pageOverrides } = overrides;
  let responseHandler: ((response: unknown) => void) | undefined;
  const page: FakePage = {
    on: vi.fn((event: string, handler: (response: unknown) => void) => {
      if (event === 'response') {
        responseHandler = handler;
      }
    }),
    goto: vi.fn(async () => {
      responseHandler?.(fakePlaywrightResponse(responseBody));
      return navigationStatus === undefined ? null : { status: () => navigationStatus };
    }),
    url: vi.fn(() => 'https://www.facebook.com/marketplace/search/?query=test'),
    evaluate: vi.fn(async () => []),
    // No login wall present by default: the guard's DOM probe finds nothing.
    $: vi.fn(async () => null),
    $eval: vi.fn(async () => {
      throw new Error('no matching element');
    }),
    ...pageOverrides,
  };
  return page;
}

interface FakeContext {
  addInitScript: Mock;
  newPage: Mock;
  close: Mock;
}

function fakeContext(page: FakePage): FakeContext {
  return {
    addInitScript: vi.fn(async () => undefined),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
}

function fakeBrowser(context: FakeContext) {
  return {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
}

// Wires launchMock to resolve a fresh fake browser/context/page triple built
// around `responseBody`, and returns the three mocks so a test can assert
// against them (e.g. that close() was called).
function stubBrowserChain(responseBody: unknown = { data: {} }, pageOverrides: FakePageOverrides = {}) {
  const page = fakePage(responseBody, pageOverrides);
  const context = fakeContext(page);
  const browser = fakeBrowser(context);
  launchMock.mockResolvedValue(browser as never);
  return { browser, context, page };
}

// Wires launchMock to resolve one browser whose successive newContext()
// calls hand back the next fake page in `pages` — search() opens one fresh
// context per configured query, so this lets a test make an earlier query
// succeed and a later one land on a login/checkpoint URL.
function stubBrowserChainPerQuery(pages: FakePage[]) {
  const contexts = pages.map((page) => fakeContext(page));
  let next = 0;
  const browser = {
    newContext: vi.fn(async () => contexts[next++] ?? contexts[contexts.length - 1]),
    close: vi.fn(async () => undefined),
  };
  launchMock.mockResolvedValue(browser as never);
  return { browser, contexts };
}

// Runs `promise` to completion and hands back whatever it rejected with, so
// a test can assert on the thrown error's own fields (message text,
// statusCode) rather than only on its class — the two Requirement 6 guards
// below both throw AppError and both name the login command, so neither of
// those two facts alone identifies which guard actually fired.
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the scan to reject, but it resolved');
    },
    (err: unknown) => err,
  );
}

// Shape of one GraphQL/JSON listing node facebookMarketplaceListing.ts's
// parseListingsFromResponses recognizes.
function listingNodeFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: '1234567890',
    marketplace_listing_title: 'RTX 3080 GPU',
    listing_price: { amount: '250' },
    primary_listing_photo: { image: { uri: 'https://scontent.example.com/photo.jpg' } },
    ...overrides,
  };
}

// Wraps listing nodes in a GraphQL connection envelope (edges/node), the
// general shape Facebook's real Marketplace search responses are documented
// to nest listing data in, however many wrapper levels deep.
function graphqlEnvelopeFixture(nodes: unknown[]) {
  return {
    data: {
      marketplace_search: {
        feed_units: {
          edges: nodes.map((node) => ({ node, cursor: 'abc' })),
        },
      },
    },
  };
}

beforeEach(() => {
  accessMock.mockReset();
  launchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isLoginOrCheckpointUrl', () => {
  it('is true for a facebook.com login URL', () => {
    expect(isLoginOrCheckpointUrl('https://www.facebook.com/login/?next=%2Fmarketplace')).toBe(true);
  });

  it('is true for a facebook.com checkpoint URL', () => {
    expect(isLoginOrCheckpointUrl('https://www.facebook.com/checkpoint/1501092823525282/')).toBe(true);
  });

  it('is false for an ordinary facebook.com marketplace URL', () => {
    expect(isLoginOrCheckpointUrl('https://www.facebook.com/marketplace/search/?query=gpu')).toBe(false);
  });

  it('is false for a non-facebook.com host and for a malformed URL', () => {
    expect(isLoginOrCheckpointUrl('https://evil.example.com/login')).toBe(false);
    expect(isLoginOrCheckpointUrl('not a url')).toBe(false);
  });
});

describe('isFacebookRootUrl', () => {
  it('is true for the bare facebook.com root, with or without a trailing path', () => {
    expect(isFacebookRootUrl('https://www.facebook.com/')).toBe(true);
    expect(isFacebookRootUrl('https://facebook.com')).toBe(true);
  });

  it('is false for a marketplace search URL and for a login URL', () => {
    // A root check that also swallowed real search URLs would reject every
    // healthy scan; one that also claimed /login would blur the two causes.
    expect(isFacebookRootUrl('https://www.facebook.com/marketplace/search/?query=gpu')).toBe(false);
    expect(isFacebookRootUrl('https://www.facebook.com/login/')).toBe(false);
  });

  it('is false for a non-facebook.com root and for a malformed URL', () => {
    expect(isFacebookRootUrl('https://evil.example.com/')).toBe(false);
    expect(isFacebookRootUrl('not a url')).toBe(false);
  });
});

// Direct coverage of the Requirement 6 guard itself, independent of the
// connector's orchestration. Each of the four signals is driven on its own
// fake Page/Response with the other three set to "healthy", so a signal
// that silently stops being checked surfaces here as a missing throw
// instead of being masked by one of its three siblings throwing an
// identical AppError for the same input.
const GUARD_SEARCH_URL = 'https://www.facebook.com/marketplace/search/?query=gpu';

// The real markup signatures of Facebook's logged-out login wall, written
// out as literals here rather than imported from the module under test, so
// that a LOGIN_WALL_SELECTOR which drifts away from them fails this test
// instead of silently following it.
const LOGGED_OUT_WALL_ELEMENTS = ['input[name="pass"]', '[data-testid="royal_login_form"]'];

// A fake Page that behaves like a document containing exactly
// `presentElements`: page.$() reports a match only when some
// comma-separated part of the queried selector is one of them. That makes
// LOGIN_WALL_SELECTOR's own content testable without a real DOM — narrowing
// it so it no longer names any logged-out form element stops the wall cases
// below from throwing.
function guardPage(url: string, presentElements: string[] = []): Page {
  return {
    url: () => url,
    $: async (selector: string) =>
      selector
        .split(',')
        .map((part) => part.trim())
        .some((part) => presentElements.includes(part))
        ? { tagName: 'FORM' }
        : null,
  } as unknown as Page;
}

function guardResponse(status: number): Response {
  return { status: () => status } as unknown as Response;
}

async function captureGuardRejection(page: Page, response: Response | null): Promise<AppError> {
  const err = await captureRejection(assertSearchPageAuthenticated(page, response));
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

describe('assertSearchPageAuthenticated — Req 6 silent-failure guard', () => {
  it('throws, naming the login/checkpoint cause, when the navigation ended on a login URL', async () => {
    const err = await captureGuardRejection(guardPage('https://www.facebook.com/login/?next=%2Fmarketplace'), guardResponse(200));

    expect(err.message).toContain('redirected to a login/checkpoint page instead of search results');
    expect(err.message).toContain('npm run login-facebook-marketplace');
    expect(err.statusCode).toBe(400);
  });

  it('throws, naming the root-bounce cause specifically, when the navigation ended on the bare facebook.com root', async () => {
    const err = await captureGuardRejection(guardPage('https://www.facebook.com/'), guardResponse(200));

    expect(err.message).toContain('redirected to the facebook.com root instead of search results');
    expect(err.message).toContain('npm run login-facebook-marketplace');
    // Three sibling guards throw the same class with the same trailing
    // instruction, so pin that this is not one of them firing instead.
    expect(err.message).not.toContain('login/checkpoint page');
    expect(err.message).not.toContain('login wall');
    expect(err.message).not.toContain('HTTP');
  });

  it('throws, naming the HTTP status specifically, when the navigation answered non-OK', async () => {
    const err = await captureGuardRejection(guardPage(GUARD_SEARCH_URL), guardResponse(403));

    expect(err.message).toContain('answered the search navigation with HTTP 403 instead of search results');
    expect(err.message).toContain('npm run login-facebook-marketplace');
    expect(err.message).not.toContain('login wall');
    expect(err.message).not.toContain('root');
  });

  // Both directions of the accepted-status window, so a bound that moves
  // either way fails here: 200 and 399 must pass, 199 and 400 must throw.
  it.each([199, 400, 500, 503])('throws for a status outside the 200-399 window (%i)', async (status) => {
    const err = await captureGuardRejection(guardPage(GUARD_SEARCH_URL), guardResponse(status));

    expect(err.message).toContain(`HTTP ${status}`);
  });

  it.each([200, 302, 399])('accepts a status inside the 200-399 window (%i)', async (status) => {
    await expect(assertSearchPageAuthenticated(guardPage(GUARD_SEARCH_URL), guardResponse(status))).resolves.toBeUndefined();
  });

  it.each(LOGGED_OUT_WALL_ELEMENTS)(
    'throws, naming the login-wall cause, when the search URL itself renders %s',
    async (wallElement) => {
      const err = await captureGuardRejection(guardPage(GUARD_SEARCH_URL, [wallElement]), guardResponse(200));

      expect(err.message).toContain('rendered a login wall in place of search results');
      expect(err.message).toContain('npm run login-facebook-marketplace');
      expect(err.message).not.toContain('login/checkpoint page');
      expect(err.message).not.toContain('HTTP');
    },
  );

  it('still applies the URL and wall signals when goto produced no response at all', async () => {
    // page.goto() resolves null for a same-document navigation; the status
    // signal is then simply unavailable and must not disable the other
    // three — a guard that returned early on a null response would turn
    // every such navigation back into a silent zero-result scan.
    const wallError = await captureGuardRejection(guardPage(GUARD_SEARCH_URL, [LOGGED_OUT_WALL_ELEMENTS[0]]), null);
    expect(wallError.message).toContain('rendered a login wall in place of search results');

    const rootError = await captureGuardRejection(guardPage('https://www.facebook.com/'), null);
    expect(rootError.message).toContain('redirected to the facebook.com root');
  });

  it('resolves for an authenticated 200 search page carrying no logged-out form element', async () => {
    // Without this contrast case the seven rejections above would be
    // satisfied by a guard that simply throws for every input.
    await expect(
      assertSearchPageAuthenticated(guardPage(GUARD_SEARCH_URL, ['div[role="main"]']), guardResponse(200)),
    ).resolves.toBeUndefined();
  });
});

describe('buildSearchUrl', () => {
  it('includes query, maxPrice, radius, and location when provided', () => {
    const url = buildSearchUrl('gaming pc', { maxPrice: 300, radiusMiles: 25, location: 'Seattle, WA' });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('query')).toBe('gaming pc');
    expect(parsed.searchParams.get('maxPrice')).toBe('300');
    expect(parsed.searchParams.get('radius')).toBe('25');
    expect(parsed.searchParams.get('location')).toBe('Seattle, WA');
  });

  it('omits maxPrice/radius/location params entirely when not provided', () => {
    const url = buildSearchUrl('gaming pc', {});
    const parsed = new URL(url);
    expect(parsed.searchParams.has('maxPrice')).toBe(false);
    expect(parsed.searchParams.has('radius')).toBe(false);
    expect(parsed.searchParams.has('location')).toBe(false);
  });
});

describe('parseListingsFromResponses', () => {
  it('finds a listing node nested inside a GraphQL edges/node envelope', () => {
    const body = graphqlEnvelopeFixture([listingNodeFixture()]);
    const found = parseListingsFromResponses([body]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      externalItemId: '1234567890',
      title: 'RTX 3080 GPU',
      askingPrice: 250,
      listingUrl: 'https://www.facebook.com/marketplace/item/1234567890/',
      imageUrls: ['https://scontent.example.com/photo.jpg'],
      nonWorking: false,
    });
  });

  it('dedupes the same listing id seen in more than one response body', () => {
    const body = graphqlEnvelopeFixture([listingNodeFixture()]);
    const found = parseListingsFromResponses([body, body]);
    expect(found).toHaveLength(1);
  });

  it('ignores response bodies with no recognizable listing node', () => {
    expect(parseListingsFromResponses([{ data: { unrelated: true } }, null, 'not an object' as never])).toEqual([]);
  });
});

describe('mapRawDomListing', () => {
  it('maps a valid listing card to a CandidateListing, picking the non-price line as the title', () => {
    const mapped = mapRawDomListing({
      href: 'https://www.facebook.com/marketplace/item/999888777/',
      text: '$120\nIntel i7 9700K CPU\nSeattle, WA',
      imgSrc: 'https://scontent.example.com/thumb.jpg',
    });
    expect(mapped).toMatchObject({
      externalItemId: '999888777',
      title: 'Intel i7 9700K CPU',
      askingPrice: 120,
      listingUrl: 'https://www.facebook.com/marketplace/item/999888777/',
      imageUrls: ['https://scontent.example.com/thumb.jpg'],
      nonWorking: false,
    });
  });

  it('returns null when the href carries no numeric item id', () => {
    expect(mapRawDomListing({ href: 'https://www.facebook.com/marketplace/category/electronics', text: '$50', imgSrc: null })).toBeNull();
  });

  it('returns null when the card text has no recognizable price', () => {
    expect(mapRawDomListing({ href: 'https://www.facebook.com/marketplace/item/111/', text: 'No price shown', imgSrc: null })).toBeNull();
  });
});

describe('facebookMarketplaceConnector.search — config validation', () => {
  // Each case asserts the message, not just the AppError class: six sibling
  // guards in validateFacebookMarketplaceConnectorConfig throw the same class
  // for the same call, so the class alone cannot say which field the operator
  // actually has to fix — a guard mislabelled with another field's name (a
  // copy-paste of the maxPrice call for radiusMiles, say) stays invisible to
  // a class-only assertion.
  it.each([
    ['queries missing', {}, 'requires a non-empty array of non-blank query strings'],
    ['queries empty', { queries: [] }, 'requires a non-empty array of non-blank query strings'],
    ['queries containing a blank string', { queries: ['gpu', '  '] }, 'requires a non-empty array of non-blank query strings'],
    ['maxPrice negative', { queries: ['gpu'], maxPrice: -1 }, 'maxPrice must be a non-negative number'],
    ['radiusMiles negative', { queries: ['gpu'], radiusMiles: -5 }, 'radiusMiles must be a non-negative number'],
    ['location not a string', { queries: ['gpu'], location: 42 }, 'location must be a string'],
    ['config not an object at all', 'queries=gpu', 'connector config must be an object'],
  ])('rejects config with %s, naming that field, never touching the session or browser', async (_label, config, expectedMessage) => {
    const err = await captureRejection(facebookMarketplaceConnector.search(config));

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain(expectedMessage);
    expect(accessMock).not.toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });
});

describe('facebookMarketplaceConnector.search — missing session', () => {
  it('throws an AppError naming the login script when no session file exists, never launching a browser', async () => {
    accessMock.mockRejectedValue(new Error('ENOENT'));

    await expect(facebookMarketplaceConnector.search({ queries: ['gpu'] })).rejects.toMatchObject(
      expect.objectContaining({ message: expect.stringContaining('npm run login-facebook-marketplace') }),
    );
    await expect(facebookMarketplaceConnector.search({ queries: ['gpu'] })).rejects.toBeInstanceOf(AppError);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('identifies the missing-session cause specifically: the session file, the login script, and a client-error status that survives error-handler masking', async () => {
    accessMock.mockRejectedValue(new Error('ENOENT'));

    const err = await captureRejection(facebookMarketplaceConnector.search({ queries: ['gpu'] }));

    expect(err).toBeInstanceOf(AppError);
    const appError = err as AppError;
    expect(appError.message).toContain('No Facebook Marketplace session found at');
    expect(appError.message).toContain('facebook-marketplace-session.json');
    expect(appError.message).toContain('npm run login-facebook-marketplace');
    // The sibling expired-session guard below throws AppError and names the
    // same login command, so neither fact tells the two causes apart — this
    // pins that the message read by the operator is the missing-file one.
    expect(appError.message).not.toContain('redirected to a login/checkpoint page');
    // error-handler.ts forwards an error's own message to the client only
    // while its statusCode is a real (sub-500) status; a 5xx is rewritten to
    // 'Internal server error', which would erase the actionable text
    // Requirement 6 exists to guarantee.
    expect(appError.statusCode).toBeGreaterThanOrEqual(400);
    expect(appError.statusCode).toBeLessThan(500);
  });
});

describe('facebookMarketplaceConnector.search — login/checkpoint redirect', () => {
  it('throws an AppError naming the login script when navigation lands on a login URL, and still closes the browser', async () => {
    accessMock.mockResolvedValue(undefined);
    const { browser, context } = stubBrowserChain({ data: {} }, {
      url: vi.fn(() => 'https://www.facebook.com/login/?next=%2Fmarketplace%2Fsearch'),
    });

    await expect(facebookMarketplaceConnector.search({ queries: ['gpu'] })).rejects.toMatchObject(
      expect.objectContaining({ message: expect.stringContaining('npm run login-facebook-marketplace') }),
    );
    expect(context.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });

  it('throws the same AppError when navigation lands on a checkpoint URL instead', async () => {
    accessMock.mockResolvedValue(undefined);
    stubBrowserChain({ data: {} }, { url: vi.fn(() => 'https://www.facebook.com/checkpoint/123456/') });

    await expect(facebookMarketplaceConnector.search({ queries: ['gpu'] })).rejects.toBeInstanceOf(AppError);
  });

  it('identifies the expired-session cause specifically, distinct from the missing-session error, with a status that survives error-handler masking', async () => {
    accessMock.mockResolvedValue(undefined);
    stubBrowserChain({ data: {} }, { url: vi.fn(() => 'https://www.facebook.com/checkpoint/123456/') });

    const err = await captureRejection(facebookMarketplaceConnector.search({ queries: ['gpu'] }));

    expect(err).toBeInstanceOf(AppError);
    const appError = err as AppError;
    expect(appError.message).toContain('redirected to a login/checkpoint page instead of search results');
    expect(appError.message).toContain('npm run login-facebook-marketplace');
    expect(appError.message).not.toContain('No Facebook Marketplace session found at');
    expect(appError.statusCode).toBeGreaterThanOrEqual(400);
    expect(appError.statusCode).toBeLessThan(500);
  });

  it('throws rather than returning the listings a checkpoint navigation still produced', async () => {
    // The checkpoint guard has to run before results are returned, not after
    // "did we find anything?": Facebook can serve a challenge page whose own
    // XHR traffic still carries parseable listing nodes, and returning those
    // would import stale/unauthenticated results while hiding the expiry.
    accessMock.mockResolvedValue(undefined);
    stubBrowserChain(graphqlEnvelopeFixture([listingNodeFixture()]), {
      url: vi.fn(() => 'https://www.facebook.com/checkpoint/123456/'),
    });

    await expect(facebookMarketplaceConnector.search({ queries: ['gpu'] })).rejects.toThrow(
      /redirected to a login\/checkpoint page/,
    );
  });

  it('fails the whole scan when a later query hits a checkpoint, never returning the earlier query\'s results as if they were the full pass', async () => {
    accessMock.mockResolvedValue(undefined);
    const firstQueryPage = fakePage(graphqlEnvelopeFixture([listingNodeFixture({ id: '777000111' })]));
    const secondQueryPage = fakePage({ data: {} }, { url: vi.fn(() => 'https://www.facebook.com/checkpoint/987654/') });
    const { browser } = stubBrowserChainPerQuery([firstQueryPage, secondQueryPage]);

    await expect(facebookMarketplaceConnector.search({ queries: ['gpu', 'cpu'] })).rejects.toThrow(
      /redirected to a login\/checkpoint page/,
    );
    expect(browser.close).toHaveBeenCalled();
  });
});

describe('facebookMarketplaceConnector.search — non-redirect session rejections (Req 6)', () => {
  // The three ways Facebook refuses a stale session *without* moving the
  // URL to /login or /checkpoint. Each one, left unguarded, parses as
  // "zero listings" — exactly the silent failure Requirement 6 forbids —
  // so each is asserted on its own distinct message, not merely on
  // AppError: four sibling guards in assertSearchPageAuthenticated throw
  // the same class with the same login command, so removing the one guard
  // under test could otherwise leave a sibling raising identically and
  // keep the test green having proved nothing.
  it('throws, naming the login script, when the page lands on the search URL but renders an inline login wall', async () => {
    accessMock.mockResolvedValue(undefined);
    const { browser, context } = stubBrowserChain(
      { data: {} },
      {
        // URL is the real search URL — no redirect happened at all.
        url: vi.fn(() => 'https://www.facebook.com/marketplace/search/?query=gpu'),
        $: vi.fn(async () => ({ tagName: 'FORM' })),
      },
    );

    const err = await captureRejection(facebookMarketplaceConnector.search({ queries: ['gpu'] }));

    expect(err).toBeInstanceOf(AppError);
    const appError = err as AppError;
    expect(appError.message).toContain('rendered a login wall in place of search results');
    expect(appError.message).toContain('npm run login-facebook-marketplace');
    expect(appError.statusCode).toBeGreaterThanOrEqual(400);
    expect(appError.statusCode).toBeLessThan(500);
    expect(context.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });

  it('throws, naming the login script, when navigation bounces to the bare facebook.com root', async () => {
    accessMock.mockResolvedValue(undefined);
    const { browser } = stubBrowserChain({ data: {} }, { url: vi.fn(() => 'https://www.facebook.com/') });

    const err = await captureRejection(facebookMarketplaceConnector.search({ queries: ['gpu'] }));

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain('redirected to the facebook.com root instead of search results');
    expect((err as AppError).message).toContain('npm run login-facebook-marketplace');
    expect(browser.close).toHaveBeenCalled();
  });

  it('throws, naming the login script, when the navigation itself answers with a non-OK HTTP status', async () => {
    accessMock.mockResolvedValue(undefined);
    stubBrowserChain({ data: {} }, { navigationStatus: 403 });

    const err = await captureRejection(facebookMarketplaceConnector.search({ queries: ['gpu'] }));

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain('HTTP 403');
    expect((err as AppError).message).toContain('npm run login-facebook-marketplace');
  });

  it('throws rather than returning the listings a login-walled page still produced', async () => {
    // Same reasoning as the checkpoint case above: a wall page's own XHR
    // traffic can still carry parseable nodes, and returning them would
    // import unauthenticated results while hiding the expiry.
    accessMock.mockResolvedValue(undefined);
    stubBrowserChain(graphqlEnvelopeFixture([listingNodeFixture()]), { $: vi.fn(async () => ({ tagName: 'FORM' })) });

    await expect(facebookMarketplaceConnector.search({ queries: ['gpu'] })).rejects.toThrow(/rendered a login wall/);
  });

  it('does not reject an ordinary authenticated 200 search navigation', async () => {
    // The contrast case the three above need: a real, OK, wall-free
    // navigation must still resolve, or their rejections would prove only
    // that the guard rejects everything.
    accessMock.mockResolvedValue(undefined);
    stubBrowserChain(graphqlEnvelopeFixture([listingNodeFixture()]), { navigationStatus: 200 });

    const results = await facebookMarketplaceConnector.search({ queries: ['gpu'] });

    expect(results).toHaveLength(1);
  });
});

describe('facebookMarketplaceConnector.search — session/browser wiring (Req 6)', () => {
  it('passes the persisted storageState file and the shared UA/init-script constants into newContext', async () => {
    accessMock.mockResolvedValue(undefined);
    const { browser, context } = stubBrowserChain();

    await facebookMarketplaceConnector.search({ queries: ['gpu'] });

    // toHaveBeenCalledWith on the whole options object, not a partial
    // match: dropping either field (or adding a third, unreviewed one)
    // has to fail here, which is the entire point of this test.
    expect(browser.newContext).toHaveBeenCalledWith({
      storageState: SESSION_FILE_PATH,
      userAgent: SCAN_BROWSER_USER_AGENT,
    });
    expect(SESSION_FILE_PATH).toContain('facebook-marketplace-session.json');
    expect(context.addInitScript).toHaveBeenCalledWith(SCAN_BROWSER_INIT_SCRIPT);
  });

  it('navigates to the exact URL buildSearchUrl produces for the configured query and options', async () => {
    accessMock.mockResolvedValue(undefined);
    const { page } = stubBrowserChain();

    await facebookMarketplaceConnector.search({ queries: ['rtx 3080'], maxPrice: 400, radiusMiles: 20, location: 'Seattle, WA' });

    expect(page.goto).toHaveBeenCalledWith(
      buildSearchUrl('rtx 3080', { maxPrice: 400, radiusMiles: 20, location: 'Seattle, WA' }),
      { waitUntil: 'networkidle' },
    );
    // Pin the literal shape too, so the assertion above can't be satisfied
    // by both sides drifting together if buildSearchUrl itself changes.
    const navigatedTo = new URL(page.goto.mock.calls[0][0] as string);
    expect(navigatedTo.origin + navigatedTo.pathname).toBe('https://www.facebook.com/marketplace/search/');
    expect(navigatedTo.searchParams.get('query')).toBe('rtx 3080');
    expect(navigatedTo.searchParams.get('maxPrice')).toBe('400');
  });
});

describe('facebookMarketplaceConnector.search — genuine zero-result pass', () => {
  it('resolves an empty array, not an error, when an authenticated search page simply matched nothing', async () => {
    // The contrast case that gives the two guards above their meaning: a
    // scan that reaches real search results and finds none must look
    // different from one that was bounced to login — if this threw too, the
    // guards' rejections would prove nothing about *why* they rejected.
    accessMock.mockResolvedValue(undefined);
    const { browser, context } = stubBrowserChain({ data: { marketplace_search: { feed_units: { edges: [] } } } });

    const results = await facebookMarketplaceConnector.search({ queries: ['gpu'] });

    expect(results).toEqual([]);
    expect(context.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });
});

describe('facebookMarketplaceConnector.search — maxPrice boundary', () => {
  // Proves the exact-boundary convention at both ends: a listing priced at
  // exactly maxPrice is kept, one one cent over is dropped. Deleting the
  // `askingPrice <= maxPrice` filter (or loosening it to `<`) in
  // facebookMarketplaceConnector.ts's searchOneQuery would make this fail —
  // either both prices start coming back (filter removed) or the
  // at-ceiling item starts being dropped too (`<` instead of `<=`).
  it('keeps a listing priced at exactly maxPrice and drops one priced $0.01 over', async () => {
    accessMock.mockResolvedValue(undefined);
    const atCeiling = listingNodeFixture({ id: '111', marketplace_listing_title: 'At ceiling', listing_price: { amount: '250' } });
    const overCeiling = listingNodeFixture({ id: '222', marketplace_listing_title: 'Over ceiling', listing_price: { amount: '250.01' } });
    stubBrowserChain(graphqlEnvelopeFixture([atCeiling, overCeiling]));

    const results = await facebookMarketplaceConnector.search({ queries: ['gpu'], maxPrice: 250 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ externalItemId: '111', askingPrice: 250 });
  });

  it('returns both listings, the $250.01 one included, when no maxPrice is configured', async () => {
    // Rules out the competing explanation for the case above: the $250.01
    // listing is absent there because the ceiling filter dropped it, not
    // because a cents-bearing price fails to parse into a candidate at all.
    accessMock.mockResolvedValue(undefined);
    const atCeiling = listingNodeFixture({ id: '111', marketplace_listing_title: 'At ceiling', listing_price: { amount: '250' } });
    const overCeiling = listingNodeFixture({ id: '222', marketplace_listing_title: 'Over ceiling', listing_price: { amount: '250.01' } });
    stubBrowserChain(graphqlEnvelopeFixture([atCeiling, overCeiling]));

    const results = await facebookMarketplaceConnector.search({ queries: ['gpu'] });

    expect(results.map((candidate) => candidate.externalItemId)).toEqual(['111', '222']);
    expect(results.map((candidate) => candidate.askingPrice)).toEqual([250, 250.01]);
  });
});

describe('facebookMarketplaceConnector.search — DOM fallback', () => {
  it('falls back to scraping the DOM when no response body yields a recognizable listing node', async () => {
    accessMock.mockResolvedValue(undefined);
    stubBrowserChain(
      { data: { marketplace_search: {} } },
      {
        evaluate: vi.fn(async () => [
          { href: 'https://www.facebook.com/marketplace/item/555444333/', text: '$75\nASUS Motherboard B550\nTacoma, WA', imgSrc: 'https://scontent.example.com/mobo.jpg' },
        ]),
      },
    );

    const results = await facebookMarketplaceConnector.search({ queries: ['motherboard'] });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ externalItemId: '555444333', title: 'ASUS Motherboard B550', askingPrice: 75 });
  });
});

describe('facebookMarketplaceConnector.createDescriptionFetcher', () => {
  it('resolves the extracted description text for a listing', async () => {
    accessMock.mockResolvedValue(undefined);
    stubBrowserChain(undefined, { $eval: vi.fn(async () => 'A great GPU, barely used.') });

    const fetchDescription = facebookMarketplaceConnector.createDescriptionFetcher!();
    await expect(fetchDescription('123')).resolves.toBe('A great GPU, barely used.');
  });

  it('resolves null and logs a Warn, never throwing, when the session is missing', async () => {
    accessMock.mockRejectedValue(new Error('ENOENT'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    const fetchDescription = facebookMarketplaceConnector.createDescriptionFetcher!();
    await expect(fetchDescription('123')).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('resolves null and logs a Warn, never throwing, when launching the browser itself fails', async () => {
    accessMock.mockResolvedValue(undefined);
    launchMock.mockRejectedValue(new Error('failed to launch chromium'));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    const fetchDescription = facebookMarketplaceConnector.createDescriptionFetcher!();
    await expect(fetchDescription('123')).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('facebookMarketplaceConnector.platformType', () => {
  it("is 'facebook_marketplace'", () => {
    expect(facebookMarketplaceConnector.platformType).toBe('facebook_marketplace');
  });
});
