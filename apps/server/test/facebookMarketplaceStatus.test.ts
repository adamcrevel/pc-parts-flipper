// T5 proof: apps/server/src/connectors/facebookMarketplaceStatus.ts (the
// classifier), facebookMarketplaceStatusDom.ts (the in-page reader) and
// facebookMarketplaceConnector.ts's createStatusChecker (Req 8 — the
// best-effort per-item live-status recheck for Facebook Marketplace).
//
// Mocks the `playwright` module's `chromium.launch` and `node:fs/promises`'s
// `access` directly, the same way facebookMarketplaceConnector.test.ts does —
// no real browser is ever launched and no real network call is ever made.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright';
import type { Page, Response } from 'playwright';
import { AppError } from '../src/error-handler.js';
import { facebookMarketplaceConnector } from '../src/connectors/facebookMarketplaceConnector.js';
import { assertListingPageAuthenticated, classifyListingPageSignals } from '../src/connectors/facebookMarketplaceStatus.js';
import { collectListingPageSignals } from '../src/connectors/facebookMarketplaceStatusDom.js';
import { SESSION_FILE_PATH } from '../src/connectors/facebookMarketplaceSession.js';
import { SCAN_BROWSER_INIT_SCRIPT, SCAN_BROWSER_USER_AGENT } from '../src/connectors/browserSession.js';

vi.mock('playwright', () => ({ chromium: { launch: vi.fn() } }));
vi.mock('node:fs/promises', () => ({ access: vi.fn() }));

const launchMock = vi.mocked(chromium.launch);
const accessMock = vi.mocked(access);

const LISTING_URL = 'https://www.facebook.com/marketplace/item/1234567890/';

// The real markup signatures the module under test is supposed to probe
// for, written out as literals here rather than imported from it, so a
// selector that drifts away from them fails these tests instead of
// silently following them.
const LOGIN_WALL_ELEMENT = 'input[name="pass"]';
const SOLD_PILL_ELEMENT = '[aria-label="Sold"]';
const PDP_CONTAINER_ELEMENT = '[data-testid="marketplace_pdp_container"]';
const UNAVAILABLE_CONTAINER_ELEMENT = '[data-testid="marketplace_pdp_unavailable"]';

// Facebook's own wording for an item that no longer exists, curly
// apostrophe and all.
const INTERSTITIAL_TEXT = "This content isn\u2019t available right now";

// Visible text of a perfectly ordinary, still-for-sale listing page. Used
// as the contrast case everywhere a gone/sold signal is asserted, so a
// classifier that simply answered 'removed'/'sold' for everything could
// never pass this file.
const ACTIVE_PAGE_TEXT = 'RTX 3080 GPU\n$250\nListed 3 days ago in Seattle, WA\nMessage seller';

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the status check to reject, but it resolved');
    },
    (err: unknown) => err,
  );
}

// The fixture honours real CSS attribute-selector semantics — the operator
// (`=`, `^=`, `$=`, `*=`, bare presence) and an optional tag — not string
// equality between a selector and an element. That difference is what lets
// a test prove a selector's *width*: `[aria-label^="Sold"]` must match an
// element declared `[aria-label="Soldering iron ..."]` here exactly as it
// does in Chromium, or no fixture could ever fail on a prefix-match leak.
interface AttributeCondition {
  name: string;
  op: string;
  value: string;
}

interface ParsedSelector {
  tag: string | null;
  attributes: AttributeCondition[];
}

const ATTRIBUTE_CONDITION_PATTERN = /\[([\w-]+)(?:([\^$*]?=)"([^"]*)")?\]/g;
// A comma that is not inside an attribute value, so a label like
// "Hakko FX-888D, photo 1 of 4" never splits a selector part in two.
const SELECTOR_LIST_SEPARATOR = /,(?![^[]*\])/;

// Parses one selector part — also how an element is declared in these
// fixtures: `input[name="pass"]` is the element with that tag and attribute.
function parseSelector(part: string): ParsedSelector {
  const tag = part.match(/^[a-z]+/i);
  const attributes = [...part.matchAll(ATTRIBUTE_CONDITION_PATTERN)].map(([, name, op, value]) => ({
    name: name ?? '',
    op: op ?? '',
    value: value ?? '',
  }));
  return { tag: tag ? tag[0].toLowerCase() : null, attributes };
}

function attributeMatches(condition: AttributeCondition, actual: string | undefined): boolean {
  if (actual === undefined) {
    return false;
  }
  switch (condition.op) {
    case '':
      return true;
    case '=':
      return actual === condition.value;
    case '^=':
      return condition.value !== '' && actual.startsWith(condition.value);
    case '$=':
      return condition.value !== '' && actual.endsWith(condition.value);
    case '*=':
      return condition.value !== '' && actual.includes(condition.value);
    default:
      return false;
  }
}

function elementMatches(selectorPart: string, elementDescriptor: string): boolean {
  const selector = parseSelector(selectorPart.trim());
  const element = parseSelector(elementDescriptor);
  if (selector.tag !== null && selector.tag !== element.tag) {
    return false;
  }
  return selector.attributes.every((condition) =>
    attributeMatches(condition, element.attributes.find((attribute) => attribute.name === condition.name)?.value),
  );
}

// True when any comma-separated part of `selector` matches one of the
// elements declared in `presentElements`.
function selectorMatches(selector: string, presentElements: string[]): boolean {
  return selector.split(SELECTOR_LIST_SEPARATOR).some((part) => presentElements.some((element) => elementMatches(part, element)));
}

interface TileOptions {
  /** The tile's anchor href — another listing's `/marketplace/item/<id>/`, or this item's own. */
  href: string;
  /** Elements rendered inside the tile's anchor. */
  elements?: string[];
  /** The tile's own visible text, part of the PDP's innerText while the tile is shown. */
  text?: string;
}

interface PdpOptions {
  /** Elements rendered *inside* the item's own PDP container. */
  elements?: string[];
  /** The PDP container's own visible text. */
  text?: string;
  /** Listing tiles nested *inside* the PDP container (a related-items rail that is not a sibling of it). */
  tiles?: TileOptions[];
}

interface PageOptions {
  url?: string;
  status?: number;
  /** Elements present in the document but outside every region below. */
  presentElements?: string[];
  /** The item's own PDP container; null when Facebook rendered none. */
  pdp?: PdpOptions | null;
  /** Text of the gone-interstitial region; omitted when none is rendered. */
  interstitialText?: string;
  /** A *neighbouring* listing's elements — related tiles, "more like this" — as siblings of the PDP. */
  foreignElements?: string[];
  /** That neighbouring listing's visible text. */
  foreignText?: string;
  /** A generic page-level alert element (e.g. cookie notice, unrelated to this listing). */
  pageAlert?: string;
  /**
   * That page-level element's own visible text. A document-scoped element
   * with no text can never be mistaken for an interstitial whatever selector
   * matches it, so a fixture that leaves this empty cannot exercise the
   * false-'removed' leak a too-broad UNAVAILABLE_CONTAINER_SELECTOR opens.
   */
  pageAlertText?: string;
}

interface FakePage {
  goto: Mock;
  url: Mock;
  evaluate: Mock;
  $: Mock;
  /** The one document every evaluate() call runs against, so a test can inspect it afterwards. */
  document: FakeDocument;
}

interface FakeTile {
  href: string;
  /** The tile's own anchor element, as declared for the selector matcher above. */
  anchor: string;
  text: string;
  elements: string[];
}

interface FakeRegion {
  selector: string;
  text: string;
  elements: string[];
  tiles: FakeTile[];
}

// The page's scoped regions: the item's own PDP, and the interstitial that
// replaces it when the item is gone. Facebook serves one or the other.
function fakeRegions(options: PageOptions): FakeRegion[] {
  const { pdp = {}, interstitialText } = options;
  const regions: FakeRegion[] = [];
  if (pdp !== null) {
    const tiles = (pdp.tiles ?? []).map((tile) => ({ href: tile.href, anchor: `a[href="${tile.href}"]`, text: tile.text ?? '', elements: tile.elements ?? [] }));
    regions.push({ selector: PDP_CONTAINER_ELEMENT, text: pdp.text ?? ACTIVE_PAGE_TEXT, elements: pdp.elements ?? [], tiles });
  }
  if (interstitialText !== undefined) {
    regions.push({ selector: UNAVAILABLE_CONTAINER_ELEMENT, text: interstitialText, elements: [], tiles: [] });
  }
  return regions;
}

// One entry per element on the page, in document order. `regionIndex` is -1
// for a document-scope element; `tileIndex` is -1 for an element not inside
// a nested tile; `isRegion`/`isTileAnchor` mark the region container and the
// tile's own anchor, which carry their own API below.
interface DocumentElement {
  descriptor: string;
  regionIndex: number;
  tileIndex: number;
  isRegion: boolean;
  isTileAnchor: boolean;
  text?: string;
}

interface FakeTileElement {
  tagName: string;
  style: { display: string };
  getAttribute(name: string): string | null;
  closest(selector: string): FakeTileElement | null;
}

interface FakeRegionElement {
  tagName: string;
  readonly innerText: string;
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): unknown[];
}

interface FakeDocument {
  querySelector(selector: string): unknown;
}

function documentElementsOf(options: PageOptions, regions: FakeRegion[]): DocumentElement[] {
  const docScope = (descriptor: string, text?: string): DocumentElement => ({ descriptor, regionIndex: -1, tileIndex: -1, isRegion: false, isTileAnchor: false, text });
  return [
    // Page-level alert (if any) comes first, before regions
    ...(options.pageAlert ? [docScope(options.pageAlert, options.pageAlertText)] : []),
    // Regions in order (PDP first, then interstitial)
    ...regions.map((region, regionIndex) => ({ descriptor: region.selector, regionIndex, tileIndex: -1, isRegion: true, isTileAnchor: false })),
    // Other page-level elements
    ...(options.presentElements ?? []).map((descriptor) => docScope(descriptor)),
    ...(options.foreignElements ?? []).map((descriptor) => docScope(descriptor)),
    // Elements inside regions, then each region's nested tiles with their contents
    ...regions.flatMap((region, regionIndex) => [
      ...region.elements.map((descriptor) => ({ descriptor, regionIndex, tileIndex: -1, isRegion: false, isTileAnchor: false })),
      ...region.tiles.flatMap((tile, tileIndex) => [
        { descriptor: tile.anchor, regionIndex, tileIndex, isRegion: false, isTileAnchor: true },
        ...tile.elements.map((descriptor) => ({ descriptor, regionIndex, tileIndex, isRegion: false, isTileAnchor: false })),
      ]),
    ]),
  ];
}

// A document whose scope actually means something: `document.querySelector`
// reaches every element on the page (including a neighbouring listing's),
// while a region element's own `querySelectorAll` reaches only what is
// inside it, a tile's `closest` climbs to its own anchor, and hiding a tile
// (`style.display = 'none'`) drops its text from the region's innerText,
// exactly as a rendered element's innerText does. `querySelector` returns
// the first element in document order matching any part of a comma-joined
// selector, never the element matching the earliest *part*.
function fakeDocument(options: PageOptions): FakeDocument {
  const regions = fakeRegions(options);
  const documentElements = documentElementsOf(options, regions);
  const tileElements: FakeTileElement[][] = regions.map((region) =>
    region.tiles.map((tile) => {
      const anchor: FakeTileElement = {
        tagName: 'A',
        style: { display: '' },
        getAttribute: (name) => (name === 'href' ? tile.href : null),
        closest: (selector) => (selectorMatches(selector, [tile.anchor]) ? anchor : null),
      };
      return anchor;
    }),
  );

  const inRegion = (selector: string, regionIndex: number): DocumentElement[] =>
    documentElements.filter((element) => element.regionIndex === regionIndex && !element.isRegion && selectorMatches(selector, [element.descriptor]));

  const regionElements: FakeRegionElement[] = regions.map((region, regionIndex) => ({
    tagName: 'DIV',
    get innerText() {
      const shownTileText = region.tiles.filter((_tile, tileIndex) => tileElements[regionIndex]![tileIndex]!.style.display !== 'none').map((tile) => tile.text);
      return [region.text, ...shownTileText].filter((text) => text.length > 0).join('\n');
    },
    querySelectorAll: (selector) => inRegion(selector, regionIndex).map(materialize),
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
  }));

  function materialize(element: DocumentElement): unknown {
    if (element.isRegion) {
      return regionElements[element.regionIndex];
    }
    if (element.isTileAnchor) {
      return tileElements[element.regionIndex]![element.tileIndex];
    }
    if (element.regionIndex >= 0) {
      const tile = element.tileIndex >= 0 ? tileElements[element.regionIndex]![element.tileIndex]! : null;
      return { tagName: 'DIV', closest: (selector: string) => tile?.closest(selector) ?? null };
    }
    // A document-scope element carries only its own text and no descendants.
    return { innerText: element.text ?? '', querySelector: () => null, querySelectorAll: () => [] };
  }

  return {
    querySelector(selector: string) {
      const found = documentElements.find((element) => selectorMatches(selector, [element.descriptor]));
      return found === undefined ? null : materialize(found);
    },
  };
}

function fakeStatusPage(options: PageOptions = {}): FakePage {
  const { url = LISTING_URL, status } = options;
  const regions = fakeRegions(options);
  const everyElement = documentElementsOf(options, regions).map((element) => element.descriptor);
  const document = fakeDocument(options);
  return {
    goto: vi.fn(async () => (status === undefined ? null : { status: () => status })),
    url: vi.fn(() => url),
    document,
    // Runs the real in-page reader against the fake document above, so the
    // scope it queries at is what these tests actually exercise. `location`
    // is the navigated URL, the way the reader finds this item's own id.
    evaluate: vi.fn(async (fn: (arg: unknown) => unknown, arg: unknown) => {
      const browserGlobal = globalThis as unknown as { document?: unknown; location?: unknown };
      const previousDocument = browserGlobal.document;
      const previousLocation = browserGlobal.location;
      browserGlobal.document = document;
      browserGlobal.location = { pathname: new URL(url).pathname };
      try {
        return fn(arg);
      } finally {
        browserGlobal.document = previousDocument;
        browserGlobal.location = previousLocation;
      }
    }),
    $: vi.fn(async (selector: string) => (selectorMatches(selector, everyElement) ? { tagName: 'DIV' } : null)),
  };
}

function stubBrowserChain(options: PageOptions = {}) {
  const page = fakeStatusPage(options);
  const context = {
    addInitScript: vi.fn(async () => undefined),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
  launchMock.mockResolvedValue(browser as never);
  return { browser, context, page };
}

// A Page carrying only what assertListingPageAuthenticated reads.
function guardPage(url: string, presentElements: string[] = []): Page {
  return {
    url: () => url,
    $: async (selector: string) => (selectorMatches(selector, presentElements) ? { tagName: 'FORM' } : null),
  } as unknown as Page;
}

function guardResponse(status: number): Response {
  return { status: () => status } as unknown as Response;
}

async function captureGuardRejection(page: Page, response: Response | null): Promise<AppError> {
  const err = await captureRejection(assertListingPageAuthenticated(page, response));
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

beforeEach(() => {
  accessMock.mockReset();
  launchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classifyListingPageSignals', () => {
  it("answers 'sold' for a page carrying the sold pill, whatever its text says", () => {
    expect(classifyListingPageSignals({ httpStatus: 200, soldIndicator: true, pdpText: ACTIVE_PAGE_TEXT, interstitialText: '' })).toBe('sold');
  });

  it.each([
    ['a bare Sold line', 'RTX 3080 GPU\nSold\n$250'],
    ['a Sold pill rendered as text with a separator', 'RTX 3080 GPU\nSold • Listed 2 weeks ago'],
    ['an explicit listing-sold sentence', 'RTX 3080 GPU\nThis listing was sold\n$250'],
  ])("answers 'sold' for %s even with no pill element", (_label, pdpText) => {
    expect(classifyListingPageSignals({ httpStatus: 200, soldIndicator: false, pdpText, interstitialText: '' })).toBe('sold');
  });

  it("answers 'active', not 'sold', when the word sold only appears inside the seller's prose", () => {
    // The whole reason the text patterns are line-anchored: "sold as is" in
    // a description must never retire a listing that is still for sale.
    const pdpText = 'RTX 3080 GPU\n$250\nBeing sold as is, I already sold my other one.\nMessage seller';
    expect(classifyListingPageSignals({ httpStatus: 200, soldIndicator: false, pdpText, interstitialText: '' })).toBe('active');
  });

  it("answers 'active' for a title line that merely starts with the hyphenated word Sold-out", () => {
    // The text twin of the pill selector's prefix leak: the PDP's first line
    // is the listing's own title, and `^sold\s*-` accepted "Sold-out edition".
    const pdpText = 'Sold-out edition Funko Pop\n$40\nListed 3 days ago in Seattle, WA';
    expect(classifyListingPageSignals({ httpStatus: 200, soldIndicator: false, pdpText, interstitialText: '' })).toBe('active');
  });

  it.each([
    ['a spaced hyphen', 'RTX 3080 GPU\nSold - Listed 2 weeks ago'],
    ['an en-dash', 'RTX 3080 GPU\nSold – Listed 2 weeks ago'],
    ['a pipe', 'RTX 3080 GPU\nSold | Listed 2 weeks ago'],
    ['a bullet', 'RTX 3080 GPU\nSold \u2022 Listed 2 weeks ago'],
  ])("still answers 'sold' for a Sold pill rendered as text with %s separator", (_label, pdpText) => {
    expect(classifyListingPageSignals({ httpStatus: 200, soldIndicator: false, pdpText, interstitialText: '' })).toBe('sold');
  });

  it.each([
    ['a hyphen', 'RTX 3080 GPU\nSold -\nListed 2 weeks ago'],
    ['an en-dash', 'RTX 3080 GPU\nSold \u2013\nListed 2 weeks ago'],
    ['a pipe', 'RTX 3080 GPU\nSold |\nListed 2 weeks ago'],
    ['a bullet', 'RTX 3080 GPU\nSold \u2022\nListed 2 weeks ago'],
  ])("still answers 'sold' for a Sold line that ends on %s with the rest wrapped onto the next line", (_label, pdpText) => {
    // The end-of-line half of the separator boundary: the pill's trailing
    // text may wrap onto its own block, leaving "Sold –" as a whole line.
    expect(classifyListingPageSignals({ httpStatus: 200, soldIndicator: false, pdpText, interstitialText: '' })).toBe('sold');
  });

  it.each([
    ['an en-dash', 'Sold\u2013out edition Funko Pop\n$40\nListed 3 days ago in Seattle, WA'],
    ['a pipe', 'Sold|Trade bundle, RTX 3080\n$250\nListed 3 days ago in Seattle, WA'],
    ['a bullet', 'Sold\u2022out vinyl reissue box set\n$60\nListed 3 days ago in Seattle, WA'],
  ])("answers 'active' for a title line whose opening word is merely joined by %s", (_label, pdpText) => {
    // The hyphen case above has a sibling one character over. The
    // whitespace requirement was added to `-` alone, so the other three
    // separators in `[•|–]` still match a title directly: "Sold–out
    // edition Funko Pop" is a live listing whose title starts with a
    // dash-joined word, exactly as "Sold-out edition Funko Pop" is.
    // Nothing is lost by requiring the space on all four — every genuine
    // separator rendering ("Sold – Listed 2 weeks ago", asserted directly
    // above) carries one.
    expect(classifyListingPageSignals({ httpStatus: 200, soldIndicator: false, pdpText, interstitialText: '' })).toBe('active');
  });

  // Validation sweep (TE9), beyond the four separators named above: this
  // bare-prefix leak has now been found five rounds running, each time at
  // a separator the previous fix did not reach. So rather than name a
  // sixth candidate by hand, these two push every BMP code point through
  // the real classifier — a fifth separator added later without its
  // boundary, or a character class that silently widens into a range,
  // fails here the moment it is written. U+000A is excluded because it is
  // not a separator at all: it ends the line, leaving a bare "Sold" line
  // that /^sold$/i answers 'sold' for, correctly.
  const LINE_FEED = 0x0a;

  it("answers 'active' for a title joined to Sold by any code point, not only the four named separators", () => {
    const leaks: string[] = [];
    for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
      if (codePoint === LINE_FEED) continue;
      const pdpText = `Sold${String.fromCharCode(codePoint)}out edition Funko Pop\n$40\nListed 3 days ago in Seattle, WA`;
      if (classifyListingPageSignals({ httpStatus: 200, soldIndicator: false, pdpText, interstitialText: '' }) !== 'active') {
        leaks.push(`U+${codePoint.toString(16).padStart(4, '0')}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('treats exactly four code points as a Sold status-line separator, and no others', () => {
    const separators: string[] = [];
    for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
      if (codePoint === LINE_FEED) continue;
      const pdpText = `Sold${String.fromCharCode(codePoint)} Listed 2 weeks ago\n$250`;
      if (classifyListingPageSignals({ httpStatus: 200, soldIndicator: false, pdpText, interstitialText: '' }) === 'sold') {
        separators.push(`U+${codePoint.toString(16).padStart(4, '0')}`);
      }
    }
    // hyphen, pipe, en-dash, bullet — spelled out as literals so that
    // widening the class (or dropping a member) fails here instead of
    // following whatever the source happens to say.
    expect(separators).toEqual(['U+002d', 'U+007c', 'U+2013', 'U+2022']);
  });

  it.each([404, 410])("answers 'removed' for a gone HTTP status (%i)", (httpStatus) => {
    expect(classifyListingPageSignals({ httpStatus, soldIndicator: false, pdpText: '', interstitialText: '' })).toBe('removed');
  });

  it.each([
    ["Facebook's curly-apostrophe unavailable interstitial", "This content isn\u2019t available right now"],
    ['a no-longer-available notice', 'This item is no longer available.'],
    ['a plain-apostrophe listing-unavailable notice', "This listing isn't available"],
  ])("answers 'removed' for %s on an otherwise-OK page", (_label, interstitialText) => {
    expect(classifyListingPageSignals({ httpStatus: 200, soldIndicator: false, pdpText: '', interstitialText })).toBe('removed');
  });

  it("answers 'active' for unavailable-sounding prose in the item's own description", () => {
    // The scoping fix's mirror direction: a live listing whose description
    // happens to say "no longer available at retail" is still for sale, and
    // only the interstitial region — never the PDP's own text — may answer
    // 'removed'.
    const pdpText = 'RTX 3080 GPU\n$250\nThis model is no longer available at retail, grab it while you can.';
    expect(classifyListingPageSignals({ httpStatus: 200, soldIndicator: false, pdpText, interstitialText: '' })).toBe('active');
  });

  it("answers 'sold' rather than 'removed' when a page carries both signals", () => {
    // sold is the strictly more specific answer, and a sold listing's page
    // routinely also carries a generic unavailable line.
    expect(
      classifyListingPageSignals({ httpStatus: 200, soldIndicator: false, pdpText: 'Sold', interstitialText: INTERSTITIAL_TEXT }),
    ).toBe('sold');
  });

  it.each([200, 302, null])("answers 'active' for an ordinary listing page (status %s)", (httpStatus) => {
    expect(classifyListingPageSignals({ httpStatus, soldIndicator: false, pdpText: ACTIVE_PAGE_TEXT, interstitialText: '' })).toBe('active');
  });

  it("answers 'active' for an unrecognized but healthy page shape", () => {
    // Fail-safe direction: an unfamiliar page must leave the Listing where
    // it is, never silently retire it.
    expect(classifyListingPageSignals({ httpStatus: 200, soldIndicator: false, pdpText: '', interstitialText: '' })).toBe('active');
  });
});

describe('collectListingPageSignals', () => {
  it("reads the navigation status, the sold pill and the page text from the item's own PDP container", async () => {
    const page = fakeStatusPage({ status: 200, pdp: { elements: [SOLD_PILL_ELEMENT], text: 'Sold' } });

    const signals = await collectListingPageSignals(page as unknown as Page, guardResponse(200));

    expect(signals).toEqual({ httpStatus: 200, soldIndicator: true, pdpText: 'Sold', interstitialText: '' });
  });

  it('reports a null status and no pill for a navigation that produced no response', async () => {
    const page = fakeStatusPage();

    const signals = await collectListingPageSignals(page as unknown as Page, null);

    expect(signals).toEqual({ httpStatus: null, soldIndicator: false, pdpText: ACTIVE_PAGE_TEXT, interstitialText: '' });
  });

  it('reads no signal at all from a page carrying neither a PDP container nor an interstitial', async () => {
    // Fail-safe: an unreadable page shape must yield nothing to classify
    // on, whatever else the document happens to contain.
    const page = fakeStatusPage({ status: 200, pdp: null, foreignElements: [SOLD_PILL_ELEMENT], foreignText: 'Sold\nThis item is no longer available.' });

    const signals = await collectListingPageSignals(page as unknown as Page, guardResponse(200));

    expect(signals).toEqual({ httpStatus: 200, soldIndicator: false, pdpText: '', interstitialText: '' });
    expect(classifyListingPageSignals(signals)).toBe('active');
  });
});

describe("every sold/removed signal is read inside the item's own PDP container", () => {
  // Each case drives the real in-page reader over a document that
  // distinguishes PDP scope from page scope, so a signal read off the
  // whole document (as this connector did before) answers differently
  // from one read inside the container.
  async function statusOf(options: PageOptions): Promise<string> {
    const page = fakeStatusPage(options);
    const signals = await collectListingPageSignals(page as unknown as Page, guardResponse(options.status ?? 200));
    return classifyListingPageSignals(signals);
  }

  it("answers 'active' for a live listing whose own description says the part is no longer available", async () => {
    // Read at document scope this prose matched /no longer available/ and
    // retired a listing that was still for sale.
    const text = 'RTX 3080 GPU\n$250\nThis card is no longer available at retail — mint, boxed, local pickup only.';

    await expect(statusOf({ status: 200, pdp: { text } })).resolves.toBe('active');
  });

  it("answers 'active' for an en-dash-joined title read off the item's own PDP container", async () => {
    // The same separator-sibling leak, driven through the real in-page
    // reader rather than hand-built signals, so it is proven on the path a
    // live recheck actually takes.
    const text = 'Sold\u2013out edition Funko Pop\n$40\nListed 3 days ago in Seattle, WA';

    await expect(statusOf({ status: 200, pdp: { text } })).resolves.toBe('active');
  });

  it("answers 'removed' when Facebook's interstitial replaced the PDP entirely", async () => {
    await expect(statusOf({ status: 200, pdp: null, interstitialText: INTERSTITIAL_TEXT })).resolves.toBe('removed');
  });

  it("answers 'active' when only a neighbouring listing's tile carries the sold signal", async () => {
    // A related-items carousel renders other sellers' sold tiles on a
    // perfectly live listing's page; at document scope every one of them
    // marked *this* item sold.
    await expect(
      statusOf({ status: 200, pdp: { text: ACTIVE_PAGE_TEXT }, foreignElements: [SOLD_PILL_ELEMENT], foreignText: 'More like this\nSold' }),
    ).resolves.toBe('active');
  });

  it("answers 'sold' for a sold pill inside the item's own PDP container", async () => {
    await expect(statusOf({ status: 200, pdp: { elements: [SOLD_PILL_ELEMENT], text: ACTIVE_PAGE_TEXT } })).resolves.toBe('sold');
  });

  it("answers 'active' when no PDP is found but only a page-level alert (not a marketplace interstitial) is present", async () => {
    // Before the fix, [role="alert"] in UNAVAILABLE_CONTAINER_SELECTOR would
    // match any generic page-level alert (cookie notice, region warning, etc.),
    // causing a false 'removed' classification even when no real interstitial was present.
    // Now that [role="alert"] is removed, only the PDP-specific selector matches
    // an actual interstitial region.
    await expect(
      statusOf({
        status: 200,
        pdp: null,
        pageAlert: '[role="alert"]',
        presentElements: ['[role="alert"]'],
      }),
    ).resolves.toBe('active');
  });

  it("answers 'active' when a page-level alert with unavailable-pattern text is present but the PDP is live", async () => {
    // The narrowed selector no longer matches generic [role="alert"] banners.
    // A cookie notice, privacy warning, or other page-level alert unrelated
    // to this listing — even one carrying unavailable-pattern text like
    // "feature no longer available in your region" — must never retire a live listing.
    await expect(
      statusOf({
        status: 200,
        pdp: { text: ACTIVE_PAGE_TEXT },
        pageAlert: '[role="alert"]',
        pageAlertText: 'This feature is no longer available in your region',
        presentElements: ['[role="alert"]'],
      }),
    ).resolves.toBe('active');
  });
  it("answers 'removed' for the marketplace_pdp_unavailable interstitial even when a different alert banner is also present", async () => {
    // After the narrowing, only the marketplace_pdp_unavailable element matches
    // the UNAVAILABLE_CONTAINER_SELECTOR — the real PDP-specific element.
    await expect(
      statusOf({
        status: 200,
        pdp: null,
        interstitialText: INTERSTITIAL_TEXT,
        pageAlert: '[role="alert"]',
        presentElements: ['[role="alert"]'],
      }),
    ).resolves.toBe('removed');
  });

  it("answers 'sold' (not 'removed') when both a live PDP with sold pill and an unrelated alert are present", async () => {
    // The PDP container match short-circuits the interstitial selector query.
    // Even if an unrelated alert with unavailable-pattern text was present,
    // it would never be consulted because the PDP was found first.
    await expect(
      statusOf({
        status: 200,
        pdp: { elements: [SOLD_PILL_ELEMENT], text: ACTIVE_PAGE_TEXT },
        pageAlert: '[role="alert"]',
        presentElements: ['[role="alert"]'],
      }),
    ).resolves.toBe('sold');
  });

  // The four cases above all place a page-level element carrying *no text*,
  // which no selector width can turn into a gone signal. The cases below give
  // that element real unavailable wording — the only shape in which a
  // document-scoped match actually leaks into the classification.

  it("answers 'active' when a generic ARIA alert banner is the only element carrying unavailable wording", async () => {
    // The exact shape the previous attempt shipped: every PDP container
    // testid is an unverified guess, so a real page plausibly matches none of
    // them and falls through to the interstitial query. With [role="alert"]
    // in that selector, an ordinary region/rate-limit banner on a live
    // listing is read as the gone-interstitial and the listing is retired.
    await expect(
      statusOf({
        status: 200,
        pdp: null,
        pageAlert: '[role="alert"]',
        pageAlertText: 'Marketplace is no longer available in your region',
      }),
    ).resolves.toBe('active');
  });

  it("answers 'active' when a generic error_page shell carries the unavailable wording", async () => {
    // The sibling member dropped alongside [role="alert"]:
    // [data-testid="error_page"] is a site-wide error shell, unverified as
    // Marketplace-specific. Nothing else in this file covers it, so re-adding
    // it to UNAVAILABLE_CONTAINER_SELECTOR has to fail here or the narrowing
    // is only half guarded.
    await expect(
      statusOf({
        status: 200,
        pdp: null,
        pageAlert: '[data-testid="error_page"]',
        pageAlertText: INTERSTITIAL_TEXT,
      }),
    ).resolves.toBe('active');
  });

  it("answers 'active', never 'removed', when a page shell matching a PDP guess shadows a real gone-interstitial", async () => {
    // Structural precedence: the interstitial selector is consulted only when
    // no PDP container matched, so a shell carrying one of the three PDP
    // guesses hides a genuine interstitial. That costs a missed retirement —
    // the deliberate fail-safe direction (A9), never a live listing wrongly
    // retired — and is pinned here so any future widening of
    // PDP_CONTAINER_SELECTOR has to face this consequence explicitly.
    await expect(
      statusOf({
        status: 200,
        pdp: null,
        interstitialText: INTERSTITIAL_TEXT,
        pageAlert: '[data-pagelet="MarketplacePDP"]',
      }),
    ).resolves.toBe('active');
  });

  it.each([404, 410])("answers 'removed' for a gone status (%i) even when a PDP container did render", async (status) => {
    // The one page-independent signal: 404/410 retires the listing whatever
    // the body shows, so a soft-404 shell that still renders a PDP cannot
    // keep a gone item alive.
    await expect(statusOf({ status, pdp: { text: ACTIVE_PAGE_TEXT } })).resolves.toBe('removed');
  });

  it('reads the first PDP-matching element in document order, not the one matching the earliest part of the selector string', async () => {
    // Guards the fixture every case above depends on. Real
    // document.querySelector returns the earliest *element* matching any part
    // of a comma-joined selector, never the element matching the earliest
    // *part*. Here a bare [data-pagelet="MarketplacePDP"] shell precedes the
    // [data-testid="marketplace_pdp_container"] region that carries the sold
    // pill and the page text, even though that testid is listed first in
    // PDP_CONTAINER_SELECTOR — so the shell must win and neither the pill nor
    // the text may reach the classifier.
    const shadowed = fakeStatusPage({
      status: 200,
      pageAlert: '[data-pagelet="MarketplacePDP"]',
      pdp: { elements: [SOLD_PILL_ELEMENT], text: ACTIVE_PAGE_TEXT },
    });

    await expect(collectListingPageSignals(shadowed as unknown as Page, guardResponse(200))).resolves.toEqual({
      httpStatus: 200,
      soldIndicator: false,
      pdpText: '',
      interstitialText: '',
    });

    // The same two elements with their document order reversed: the container
    // now comes first, and its own pill and text are what the reader sees.
    const notShadowed = fakeStatusPage({
      status: 200,
      foreignElements: ['[data-pagelet="MarketplacePDP"]'],
      pdp: { elements: [SOLD_PILL_ELEMENT], text: ACTIVE_PAGE_TEXT },
    });

    await expect(collectListingPageSignals(notShadowed as unknown as Page, guardResponse(200))).resolves.toEqual({
      httpStatus: 200,
      soldIndicator: true,
      pdpText: ACTIVE_PAGE_TEXT,
      interstitialText: '',
    });
  });

  describe('the sold pill selector matches a whole label, never a prefix of the listing title', () => {
    // A listing's photos carry its title as their aria-label, so a prefix
    // match on "Sold" sold every live listing whose title merely began with
    // those letters — reproduced live in Chromium against this reader.
    it.each([
      ['a photo whose label starts with the letters Sold', '[aria-label="Soldering iron Hakko FX-888D, photo 1 of 4"]'],
      ['a photo whose label starts with the word Sold', '[aria-label="Sold as is - RTX 3080, photo 1 of 4"]'],
      ['a photo whose label starts with Sold out', '[aria-label="Sold out of patience with this GPU, photo 1 of 4"]'],
    ])("answers 'active' for a live listing with %s", async (_label, photo) => {
      await expect(statusOf({ status: 200, pdp: { elements: [photo], text: ACTIVE_PAGE_TEXT } })).resolves.toBe('active');
    });

    it.each(['[aria-label="Sold"]', '[aria-label="Sold out"]', '[data-testid="marketplace_pdp_sold_pill"]'])(
      "answers 'sold' for the exact pill %s inside the item's own PDP container",
      async (pill) => {
        await expect(statusOf({ status: 200, pdp: { elements: [pill], text: ACTIVE_PAGE_TEXT } })).resolves.toBe('sold');
      },
    );

    it('is proven by a fixture that honours CSS attribute operators, so the prefix case above is not vacuous', () => {
      // If the fixture compared selector strings for equality, the
      // "Soldering iron" case would pass against a `^=` selector too and
      // prove nothing. Pin the operators the production selectors use.
      const photo = '[aria-label="Soldering iron Hakko FX-888D, photo 1 of 4"]';
      expect(selectorMatches('[aria-label^="Sold"]', [photo])).toBe(true);
      expect(selectorMatches('[aria-label="Sold"]', [photo])).toBe(false);
      expect(selectorMatches('[data-testid="x"], [aria-label^="Sold"]', [photo])).toBe(true);
      expect(selectorMatches('a[href*="/marketplace/item/"]', ['a[href="https://www.facebook.com/marketplace/item/999/"]'])).toBe(true);
      expect(selectorMatches('a[href*="/marketplace/item/"]', ['div[href="https://www.facebook.com/marketplace/item/999/"]'])).toBe(false);
      expect(selectorMatches('input[name="pass"]', ['[name="pass"]'])).toBe(false);
    });
  });

  describe('a related-items rail nested *inside* the PDP container is still another listing', () => {
    // Round 1 excluded a rail that is a DOM sibling of the PDP; whether
    // Facebook nests it inside the container instead is unknowable without
    // a live session, and nested it leaked both reads — reproduced live two
    // ways. A tile is recognised by its `/marketplace/item/<id>/` anchor,
    // and only one whose id differs from this page's own is excluded.
    const OTHER_ITEM_URL = 'https://www.facebook.com/marketplace/item/9876543210/';

    it("answers 'active' when only a nested neighbour tile carries its own Sold pill", async () => {
      await expect(
        statusOf({ status: 200, pdp: { text: ACTIVE_PAGE_TEXT, tiles: [{ href: OTHER_ITEM_URL, elements: [SOLD_PILL_ELEMENT] }] } }),
      ).resolves.toBe('active');
    });

    it("answers 'active' when only a nested neighbour tile's text carries a bare Sold line", async () => {
      await expect(
        statusOf({ status: 200, pdp: { text: ACTIVE_PAGE_TEXT, tiles: [{ href: OTHER_ITEM_URL, text: 'Sold\nRTX 3070\n$300' }] } }),
      ).resolves.toBe('active');
    });

    it("answers 'sold' for the item's own pill when it sits inside a link to this very listing", async () => {
      // The exclusion is by item id, not by "any item link": the PDP's own
      // photo/title link points back at this listing and must stay in scope.
      await expect(
        statusOf({ status: 200, pdp: { text: ACTIVE_PAGE_TEXT, tiles: [{ href: LISTING_URL, elements: [SOLD_PILL_ELEMENT] }] } }),
      ).resolves.toBe('sold');
    });

    it("answers 'sold' for the item's own Sold line inside a link to this very listing", async () => {
      await expect(
        statusOf({ status: 200, pdp: { text: ACTIVE_PAGE_TEXT, tiles: [{ href: LISTING_URL, text: 'Sold' }] } }),
      ).resolves.toBe('sold');
    });

    it("answers 'sold' for the item's own pill outside every tile while a nested neighbour tile is also present", async () => {
      await expect(
        statusOf({
          status: 200,
          pdp: { elements: [SOLD_PILL_ELEMENT], text: ACTIVE_PAGE_TEXT, tiles: [{ href: OTHER_ITEM_URL, elements: [SOLD_PILL_ELEMENT], text: 'Sold' }] },
        }),
      ).resolves.toBe('sold');
    });

    it.each([
      ['the page URL carries no item id', 'https://www.facebook.com/marketplace/item/pending/', LISTING_URL],
      ["the tile's href carries no item id", LISTING_URL, 'https://www.facebook.com/marketplace/item/?ref=rail'],
    ])("answers 'active', never 'sold', when %s — an unidentifiable tile counts as foreign", async (_label, url, href) => {
      await expect(
        statusOf({ status: 200, url, pdp: { text: ACTIVE_PAGE_TEXT, tiles: [{ href, elements: [SOLD_PILL_ELEMENT], text: 'Sold' }] } }),
      ).resolves.toBe('active');
    });

    it('leaves every neighbour tile visible again after the read', async () => {
      // The reader hides foreign tiles to drop them from innerText; it must
      // put them back, or a later read of the same page would see less.
      const page = fakeStatusPage({ status: 200, pdp: { text: ACTIVE_PAGE_TEXT, tiles: [{ href: OTHER_ITEM_URL, text: 'Sold\nRTX 3070' }] } });

      await expect(collectListingPageSignals(page as unknown as Page, guardResponse(200))).resolves.toMatchObject({ soldIndicator: false, pdpText: ACTIVE_PAGE_TEXT });

      const pdp = page.document.querySelector(PDP_CONTAINER_ELEMENT) as { innerText: string };
      expect(pdp.innerText).toBe(`${ACTIVE_PAGE_TEXT}\nSold\nRTX 3070`);
    });
  });
});

describe('assertListingPageAuthenticated — the recheck must never read an auth wall as "gone"', () => {
  // Each signal is driven on its own fake Page/Response with the other
  // three healthy, and asserted on its own distinct message: all four
  // guards throw AppError naming the same login command, so the class
  // alone cannot say which one actually fired.
  it('throws, naming the login/checkpoint cause, when the navigation ended on a login URL', async () => {
    const err = await captureGuardRejection(guardPage('https://www.facebook.com/login/?next=%2Fmarketplace'), guardResponse(200));

    expect(err.message).toContain('redirected to a login/checkpoint page instead of the listing page');
    expect(err.message).toContain('npm run login-facebook-marketplace');
    expect(err.statusCode).toBe(400);
  });

  it('throws, naming the root-bounce cause, when the navigation ended on the bare facebook.com root', async () => {
    const err = await captureGuardRejection(guardPage('https://www.facebook.com/'), guardResponse(200));

    expect(err.message).toContain('redirected to the facebook.com root instead of the listing page');
    expect(err.message).not.toContain('login/checkpoint page');
    expect(err.message).not.toContain('login wall');
    expect(err.message).not.toContain('HTTP');
  });

  it.each([403, 429, 500])('throws, naming the HTTP status specifically, when Facebook refused the navigation (%i)', async (status) => {
    const err = await captureGuardRejection(guardPage(LISTING_URL), guardResponse(status));

    expect(err.message).toContain(`answered the listing navigation with HTTP ${status} instead of the listing page`);
    expect(err.message).not.toContain('login wall');
    expect(err.message).not.toContain('root');
  });

  it('throws, naming the login-wall cause, when the listing URL itself renders a logged-out form', async () => {
    const err = await captureGuardRejection(guardPage(LISTING_URL, [LOGIN_WALL_ELEMENT]), guardResponse(200));

    expect(err.message).toContain('rendered a login wall in place of the listing page');
    expect(err.message).not.toContain('login/checkpoint page');
    expect(err.message).not.toContain('HTTP');
  });

  it.each([404, 410])('lets a gone status (%i) through instead of treating it as a refusal', async (status) => {
    // The one deliberate difference from the search guard: on a listing
    // page 404/410 is the genuine "this item is gone" signal, so it must
    // reach the classifier rather than reject as a session problem.
    await expect(assertListingPageAuthenticated(guardPage(LISTING_URL), guardResponse(status))).resolves.toBeUndefined();
  });

  it('resolves for an ordinary authenticated 200 listing page', async () => {
    await expect(
      assertListingPageAuthenticated(guardPage(LISTING_URL, ['div[role="main"]']), guardResponse(200)),
    ).resolves.toBeUndefined();
  });

  it('still applies the URL and wall signals when goto produced no response at all', async () => {
    const wallError = await captureGuardRejection(guardPage(LISTING_URL, [LOGIN_WALL_ELEMENT]), null);
    expect(wallError.message).toContain('rendered a login wall in place of the listing page');

    const rootError = await captureGuardRejection(guardPage('https://www.facebook.com/'), null);
    expect(rootError.message).toContain('redirected to the facebook.com root');
  });
});

describe('facebookMarketplaceConnector.createStatusChecker', () => {
  it('navigates to the item\'s own listing URL in the persisted authenticated session', async () => {
    accessMock.mockResolvedValue(undefined);
    const { browser, context, page } = stubBrowserChain({ status: 200 });

    await facebookMarketplaceConnector.createStatusChecker!()('1234567890');

    expect(browser.newContext).toHaveBeenCalledWith({
      storageState: SESSION_FILE_PATH,
      userAgent: SCAN_BROWSER_USER_AGENT,
    });
    expect(context.addInitScript).toHaveBeenCalledWith(SCAN_BROWSER_INIT_SCRIPT);
    expect(page.goto).toHaveBeenCalledWith(LISTING_URL, { waitUntil: 'networkidle' });
  });

  it.each([
    ["'sold' for a page carrying the sold pill", { status: 200, pdp: { elements: [SOLD_PILL_ELEMENT] } }, 'sold'],
    ["'removed' for a 404 listing page", { status: 404, pdp: null, interstitialText: INTERSTITIAL_TEXT }, 'removed'],
    ["'removed' for a 200 page rendering the unavailable interstitial", { status: 200, pdp: null, interstitialText: INTERSTITIAL_TEXT }, 'removed'],
    ["'active' for an ordinary live listing page", { status: 200 }, 'active'],
  ])('resolves %s', async (_label, pageOptions, expected) => {
    accessMock.mockResolvedValue(undefined);
    const { browser, context } = stubBrowserChain(pageOptions as PageOptions);

    await expect(facebookMarketplaceConnector.createStatusChecker!()('1234567890')).resolves.toBe(expected);
    // Every call opens its own short-lived context/browser; neither may
    // outlive the check, or a scan pass would leak a Chromium process per
    // missing listing.
    expect(context.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });

  it('rejects, naming the missing session, rather than reporting a status — and never launches a browser', async () => {
    accessMock.mockRejectedValue(new Error('ENOENT'));

    const err = await captureRejection(facebookMarketplaceConnector.createStatusChecker!()('1234567890'));

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain('No Facebook Marketplace session found at');
    expect((err as AppError).message).toContain('npm run login-facebook-marketplace');
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('rejects, naming the login wall, rather than reporting the walled page as removed', async () => {
    // The single most damaging failure this recheck could have: an expired
    // session renders a login wall for every item, and reading that as
    // "gone" would retire every open Listing on the Source at once.
    accessMock.mockResolvedValue(undefined);
    const { browser, context } = stubBrowserChain({ status: 200, presentElements: [LOGIN_WALL_ELEMENT], pdp: { text: 'Log in to Facebook' } });

    const err = await captureRejection(facebookMarketplaceConnector.createStatusChecker!()('1234567890'));

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain('rendered a login wall in place of the listing page');
    expect((err as AppError).message).not.toContain('No Facebook Marketplace session found at');
    expect(context.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });

  it('rejects, rather than reporting a status, when Facebook answers the navigation with HTTP 403', async () => {
    accessMock.mockResolvedValue(undefined);
    const { browser } = stubBrowserChain({ status: 403 });

    const err = await captureRejection(facebookMarketplaceConnector.createStatusChecker!()('1234567890'));

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain('HTTP 403');
    expect(browser.close).toHaveBeenCalled();
  });

  it('rejects, rather than reporting a status, when launching the browser itself fails', async () => {
    accessMock.mockResolvedValue(undefined);
    launchMock.mockRejectedValue(new Error('failed to launch chromium'));

    const err = await captureRejection(facebookMarketplaceConnector.createStatusChecker!()('1234567890'));

    expect((err as Error).message).toContain('failed to launch chromium');
  });

  it('percent-encodes the external item id into the listing URL', async () => {
    accessMock.mockResolvedValue(undefined);
    const { page } = stubBrowserChain({ status: 200 });

    await facebookMarketplaceConnector.createStatusChecker!()('12 34/56');

    expect(page.goto).toHaveBeenCalledWith('https://www.facebook.com/marketplace/item/12%2034%2F56/', { waitUntil: 'networkidle' });
  });

  it("resolves 'removed' from the navigation's own 404 status alone, on a page whose text carries no gone signal", async () => {
    // The it.each case above pairs a 404 with the unavailable interstitial,
    // so either signal on its own would satisfy it. This one isolates the
    // HTTP-status path end-to-end: the page reads like an ordinary live
    // listing, so only 404 being honoured as "gone" — and the auth guard
    // letting 404 through instead of rejecting it as a refusal — can
    // produce this answer.
    accessMock.mockResolvedValue(undefined);
    const { browser } = stubBrowserChain({ status: 404, pdp: { text: ACTIVE_PAGE_TEXT } });

    await expect(facebookMarketplaceConnector.createStatusChecker!()('1234567890')).resolves.toBe('removed');
    expect(browser.close).toHaveBeenCalled();
  });

  it('rejects, naming the login/checkpoint redirect, when the item navigation lands on a login page', async () => {
    // Facebook bounces a rejected session to /login for *every* item, so
    // reading that bounce as any status would retire the whole Source.
    accessMock.mockResolvedValue(undefined);
    const { browser, context } = stubBrowserChain({
      url: 'https://www.facebook.com/login/?next=%2Fmarketplace%2Fitem%2F1234567890%2F',
      status: 200,
      pdp: { text: 'Log in to Facebook' },
    });

    const err = await captureRejection(facebookMarketplaceConnector.createStatusChecker!()('1234567890'));

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain('redirected to a login/checkpoint page instead of the listing page');
    expect((err as AppError).message).not.toContain('login wall');
    expect((err as AppError).message).not.toContain('HTTP');
    expect(context.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });

  it("rejects, rather than resolving 'removed', when a login-walled page also carries the unavailable interstitial", async () => {
    // Proves the auth guard runs *before* the classifier rather than
    // alongside it: this page's own text classifies as 'removed', so a
    // checker that classified first (or caught the guard's throw) would
    // resolve a confident "gone" for a listing it never actually saw.
    accessMock.mockResolvedValue(undefined);
    stubBrowserChain({
      status: 200,
      presentElements: [LOGIN_WALL_ELEMENT],
      pdp: null,
      interstitialText: INTERSTITIAL_TEXT,
    });

    const err = await captureRejection(facebookMarketplaceConnector.createStatusChecker!()('1234567890'));

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain('rendered a login wall in place of the listing page');
  });

  it.each([429, 503])('rejects, naming the HTTP status (%i), rather than reporting a status for a refused navigation', async (status) => {
    // The 403 case above pins one refusal status; a rate-limit and a server
    // error must fail the same way, or a throttled scan pass would read as
    // a live listing.
    accessMock.mockResolvedValue(undefined);
    const { browser } = stubBrowserChain({ status, pdp: { text: ACTIVE_PAGE_TEXT } });

    const err = await captureRejection(facebookMarketplaceConnector.createStatusChecker!()('1234567890'));

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain(`answered the listing navigation with HTTP ${status} instead of the listing page`);
    expect(browser.close).toHaveBeenCalled();
  });
});
