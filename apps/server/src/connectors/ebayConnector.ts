// eBay Browse API connector (Req 6): runs one `item_summary/search` call per
// configured query term, maps eBay's response shape down to CandidateListing,
// and surfaces eBay's own error message when a call fails rather than a
// generic failure. Credentials/host are read from process.env lazily inside
// search() (never at module load) so the rest of the test suite never needs
// real eBay credentials configured — only a test that actually calls search()
// does, and those stub fetch instead of hitting the real API.
import type { EbayConnectorConfig } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import type { CandidateListing, DescriptionFetcher, ListingLiveStatus, MarketplaceConnector, StatusChecker } from './types.js';

// eBay OAuth2 app-token scope for Browse API read access. Fixed per eBay's
// docs — not configurable per Source.
const OAUTH_SCOPE = 'https://api.ebay.com/oauth/api_scope';

// Shape of a successful eBay OAuth2 client-credentials token response.
interface EbayTokenResponse {
  access_token: string;
}

// Shape of one entry in a Browse API search response's `itemSummaries[]`.
// Only the fields this connector maps are declared; eBay's real payload
// carries many more we don't use.
interface EbayItemSummary {
  itemId: string;
  title: string;
  itemWebUrl: string;
  price: { value: string; currency: string };
  itemCreationDate: string;
  /** Primary listing photo. Absent on the rare item listed without any image. */
  image?: { imageUrl: string };
  /** Up to 7 further listing photos, same shape and same CDN size as `image`. */
  /** eBay's condition identifier, e.g. '3000' (new), '4000' (refurbished), '5000' (used), '6000' (for parts), '7000' (parts only / non-working). */
  conditionId?: string;
}

// One entry of a Browse API single-item detail response's
// `estimatedAvailabilities[]` — eBay's per-item stock signal. The status
// values eBay documents are IN_STOCK / LIMITED_STOCK / OUT_OF_STOCK; only
// OUT_OF_STOCK is read as meaning "gone" here (see classifyEbayItemStatus).
interface EbayItemAvailability {
  estimatedAvailabilityStatus?: string;
  estimatedAvailableQuantity?: number;
  estimatedSoldQuantity?: number;
}

// Shape of a Browse API single-item detail response
// (`GET /buy/browse/v1/item/{itemId}`). Its image fields are identical in
// shape to the search response's, but already served at full resolution —
// fetchItemImageUrls reads the image fields; fetchItemDescription reads
// `description` and `localizedAspects` (eBay's per-item specifics list,
// e.g. 'Brand: ASUS') — only the `name`/`value` pair of each aspect is
// used, eBay's own `type` field is not read. checkItemStatus reads
// `estimatedAvailabilities[0]` and `itemEndDate` (an ISO-8601 timestamp).
interface EbayItemDetail {
  image?: { imageUrl: string };
  additionalImages?: Array<{ imageUrl: string }>;
  description?: string;
  localizedAspects?: Array<{ name: string; value: string }>;
  estimatedAvailabilities?: EbayItemAvailability[];
  itemEndDate?: string;
}

// Shape of a Browse API search response.
interface EbaySearchResponse {
  itemSummaries?: EbayItemSummary[];
}

// eBay's documented error-body shape, returned by both the OAuth token
// endpoint and the Browse API on failure.
interface EbayErrorBody {
  errors?: Array<{ message?: string }>;
}

// EBAY_ENV=sandbox targets eBay's sandbox host; any other value (including
// unset) targets production. Read lazily inside search() below, never
// cached at module scope, so tests can flip EBAY_ENV between cases.

/**
 * Pulls the client-safe error message out of an eBay error-body response,
 * falling back to a generic message when the body isn't JSON or doesn't
 * match eBay's documented `{ errors: [{ message }] }` shape (e.g. a network
 * gateway returning plain-text/HTML instead of eBay's own JSON).
 */
async function extractEbayErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as EbayErrorBody;
    const message = body.errors?.[0]?.message;
    return message && message.length > 0 ? message : fallback;
  } catch {
    // Response body wasn't valid JSON — nothing more specific to report.
    return fallback;
  }
}

/**
 * Fetches a fresh eBay OAuth2 application token via the client-credentials
 * grant. Called once per search() invocation (not cached) since a single
 * scan pass is infrequent enough that token reuse isn't worth the added
 * expiry-tracking complexity. Reads EBAY_CLIENT_ID/EBAY_CLIENT_SECRET from
 * the environment at call time, not module load, so importing this module
 * never requires real credentials to be set.
 */
async function fetchAppToken(host: string): Promise<string> {
  const clientId = process.env.EBAY_CLIENT_ID ?? '';
  const clientSecret = process.env.EBAY_CLIENT_SECRET ?? '';
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(`https://${host}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: OAUTH_SCOPE }).toString(),
  });

  if (!response.ok) {
    const message = await extractEbayErrorMessage(response, 'Failed to obtain eBay OAuth token');
    logger.warn({ host, status: response.status }, 'eBay OAuth token request failed');
    throw new AppError(message, 502);
  }

  const body = (await response.json()) as EbayTokenResponse;
  return body.access_token;
}

// eBay serves every listing photo from its image CDN at a resolution encoded
// in the URL's own filename segment — `.../g/ROUAAeSwDJpqwcxR/s-l225.jpg` is
// the 225px variant of exactly the same image as `.../s-l1600.jpg`. Swapping
// that segment is not an inference from eBay's docs: both variants of the
// same real production URL were fetched directly and both returned HTTP 200,
// with the 1600 variant roughly 3x the bytes of the 225 one. This matters
// because item_summary/search only ever returns the small variant, so
// upsizing here is what gets full-resolution photos for AI part
// identification at zero additional API calls.
const EBAY_IMAGE_SIZE_SEGMENT = /\/s-l\d+\.(jpg|jpeg|png|webp)$/i;
const EBAY_FULL_SIZE_SEGMENT = '/s-l1600.jpg';

// eBay returns at most 8 photos per item (1 primary + up to 7 additional).
// Capping defensively anyway means a future API change that returns more
// can't turn one scanned listing into an unbounded download loop.
const MAX_IMAGE_URLS = 8;

/**
 * Collects every photo URL for one item — primary image first, then each
 * additionalImages entry — upsized to eBay's full-resolution variant,
 * de-duplicated, and capped at MAX_IMAGE_URLS.
 *
 * A URL that doesn't match eBay's documented size-segment pattern is kept
 * exactly as received rather than dropped or rewritten blindly: an image at
 * an unexpected URL shape is still a usable image, and the worst case is
 * simply a smaller photo, not a missing one.
 */
function collectImageUrls(item: { image?: { imageUrl: string }; additionalImages?: Array<{ imageUrl: string }> }): string[] {
  const raw = [item.image?.imageUrl, ...(item.additionalImages ?? []).map((i) => i.imageUrl)];
  const upsized: string[] = [];
  for (const url of raw) {
    if (typeof url !== 'string' || url.length === 0) {
      continue;
    }
    const fullSize = EBAY_IMAGE_SIZE_SEGMENT.test(url) ? url.replace(EBAY_IMAGE_SIZE_SEGMENT, EBAY_FULL_SIZE_SEGMENT) : url;
    // Dedup guards against eBay repeating the primary image inside
    // additionalImages, and against two small variants collapsing onto the
    // same full-size URL after upsizing.
    if (!upsized.includes(fullSize)) {
      upsized.push(fullSize);
    }
    if (upsized.length === MAX_IMAGE_URLS) {
      break;
    }
  }
  return upsized;
}

// Common HTML entities seen in eBay's seller-authored descriptions, mapped
// to their plain-text characters. Numeric entities (`&#NNN;`) are decoded
// separately below since they can't be enumerated.
const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/**
 * Strips an eBay item description down to plain text. eBay descriptions are
 * seller-authored HTML (often a full fragment with inline styles), so this
 * removes `<script>`/`<style>` blocks entirely (tags and content both,
 * since their content is never human-readable text), turns block-level
 * boundaries (`<br>`, `</p>`, `</div>`, `</li>`) into newlines so the
 * result still reads as separated lines rather than one run-on paragraph,
 * strips every remaining tag, decodes HTML entities (named and numeric),
 * and finally collapses excess whitespace eBay's HTML commonly introduces
 * (nested divs each starting their own line, repeated blank lines).
 */
function stripHtml(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  text = text.replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)));
  text = text.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/g, (match) => HTML_ENTITIES[match] ?? match);

  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// eBay descriptions can run up to 500,000 characters; capping here bounds
// the AI prompt's token cost rather than passing the whole thing through.
const MAX_FORMATTED_DETAIL_LENGTH = 5000;
const TRUNCATION_MARKER = '... [truncated]';

/**
 * Formats an eBay item's description and item specifics (localizedAspects)
 * into one plain-text block suitable for an AI prompt. The description
 * (HTML-stripped) and the specifics (one `name: value` line each, under a
 * header) are joined with a blank line between whichever parts are present;
 * either part is omitted entirely when it contributes nothing — a blank
 * description, or an absent/empty aspects array. Returns null (not an empty
 * string) when neither part produced any content, since an eBay item that
 * genuinely has no description and no specifics is different from a
 * formatting result that failed. The combined result is capped at
 * MAX_FORMATTED_DETAIL_LENGTH characters, truncated with a trailing marker
 * when the cap is hit.
 */
export function formatEbayItemDetails(detail: {
  description?: string;
  localizedAspects?: Array<{ name: string; value: string }>;
}): string | null {
  const parts: string[] = [];

  const description = detail.description ? stripHtml(detail.description) : '';
  if (description.length > 0) {
    parts.push(description);
  }

  if (detail.localizedAspects && detail.localizedAspects.length > 0) {
    const lines = detail.localizedAspects.map((aspect) => `${aspect.name}: ${aspect.value}`);
    parts.push(['Item Specifics (per eBay):', ...lines].join('\n'));
  }

  if (parts.length === 0) {
    return null;
  }

  const combined = parts.join('\n\n');
  if (combined.length <= MAX_FORMATTED_DETAIL_LENGTH) {
    return combined;
  }
  return combined.slice(0, MAX_FORMATTED_DETAIL_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * Converts one eBay Browse API `itemSummaries[]` entry into a
 * CandidateListing. Uses `itemWebUrl` (the human-facing listing page) rather
 * than `itemHref` (the API resource URL) for listingUrl, truncates
 * `itemCreationDate`'s ISO timestamp down to just its date portion, and
 * carries the item's photo URLs through at full resolution — all from this
 * one search response, with no extra eBay API call per item.
 */
function mapItemSummary(item: EbayItemSummary): CandidateListing {
  return {
    externalItemId: item.itemId,
    title: item.title,
    listingUrl: item.itemWebUrl,
    askingPrice: Number(item.price.value),
    listingDate: item.itemCreationDate.slice(0, 10),
    imageUrls: collectImageUrls(item),
    nonWorking: item.conditionId === '7000',
  };
}

/**
 * Runs one Browse API search for a single query term. Always applies a
 * `filter` param with conditionIds:{3000|4000|5000|6000|7000} (working
 * conditions only, excluding 7000 in future filtering). When maxPrice is
 * set, combines it into one comma-joined filter value with the price segment:
 * `filter=conditionIds:{...},price:[0..maxPrice],priceCurrency:USD`. Throws
 * AppError built from eBay's own error message on a non-200 response.
 */
async function searchOneQuery(
  host: string,
  token: string,
  query: string,
  maxPrice: number | undefined,
): Promise<CandidateListing[]> {
  const params = new URLSearchParams({ q: query, limit: '50' });
  const conditionIdFilter = 'conditionIds:{3000|4000|5000|6000|7000}';
  if (maxPrice !== undefined) {
    params.set('filter', `${conditionIdFilter},price:[0..${maxPrice}],priceCurrency:USD`);
  } else {
    params.set('filter', conditionIdFilter);
  }

  const response = await fetch(`https://${host}/buy/browse/v1/item_summary/search?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const message = await extractEbayErrorMessage(response, 'eBay item search failed');
    logger.warn({ host, query, status: response.status }, 'eBay item search request failed');
    throw new AppError(message, 502);
  }

  const body = (await response.json()) as EbaySearchResponse;
  return (body.itemSummaries ?? []).map(mapItemSummary);
}

/**
 * Validates an unknown connector_config value is shaped like
 * EbayConnectorConfig before search() uses it: `queries` must be a
 * non-empty array of non-blank strings, and `maxPrice` (if present) must be
 * a non-negative number. Throws AppError(400) otherwise — this is the
 * connector's own defense against a malformed config reaching it, distinct
 * from (and in addition to) the route-level validation in T3's
 * sourceValidation.ts.
 */
function validateEbayConnectorConfig(config: unknown): EbayConnectorConfig {
  if (typeof config !== 'object' || config === null) {
    throw new AppError('eBay connector config must be an object', 400);
  }
  const candidate = config as Record<string, unknown>;

  const queries = candidate.queries;
  if (!Array.isArray(queries) || queries.length === 0 || queries.some((q) => typeof q !== 'string' || q.trim().length === 0)) {
    throw new AppError('eBay connector config requires a non-empty array of non-blank query strings', 400);
  }

  if (candidate.maxPrice !== undefined && (typeof candidate.maxPrice !== 'number' || candidate.maxPrice < 0)) {
    throw new AppError('eBay connector config maxPrice must be a non-negative number', 400);
  }

  return { queries, maxPrice: candidate.maxPrice as number | undefined };
}

/**
 * Runs one automated eBay scan pass: validates the Source's connector_config,
 * fetches a fresh OAuth app token, then issues one Browse API search call
 * per configured query term (so N queries means at least N HTTP search
 * calls), concatenating every query's results into one candidate list.
 */
async function search(config: unknown): Promise<CandidateListing[]> {
  const { queries, maxPrice } = validateEbayConnectorConfig(config);
  const host = process.env.EBAY_ENV === 'sandbox' ? 'api.sandbox.ebay.com' : 'api.ebay.com';

  logger.info({ host, queryCount: queries.length, maxPrice }, 'Starting eBay scan pass');
  const token = await fetchAppToken(host);

  const results: CandidateListing[] = [];
  for (const query of queries) {
    const found = await searchOneQuery(host, token, query, maxPrice);
    results.push(...found);
  }

  logger.info({ queryCount: queries.length, foundCount: results.length }, 'Finished eBay scan pass');
  return results;
}

/**
 * Builds the lazily-initialized description fetcher the scan service calls
 * once per scan pass. `createEbayItemDetailClient()` performs its own OAuth
 * app-token call, so it must not run on a scan that imports zero new
 * candidates; this defers that call to the returned function's own first
 * invocation, memoizes the in-flight/resolved client promise, and reuses it
 * for every later candidate in the same scan — one shared OAuth token per
 * scan rather than one per candidate.
 */
function createDescriptionFetcher(): DescriptionFetcher {
  let clientPromise: Promise<EbayItemDetailClient> | undefined;
  return async (externalItemId: string): Promise<string | null> => {
    if (clientPromise === undefined) {
      clientPromise = createEbayItemDetailClient();
    }
    const client = await clientPromise;
    return client.fetchItemDescription(externalItemId);
  };
}

/**
 * Classifies a 200 item-detail body as `'active'`, `'sold'` or `'removed'`.
 * The rule is grounded in what eBay's production Browse API was observed
 * to return for 166 real stale listings (feature UAT, cycle 2) — a gone
 * item does not 404, it answers 200 with `estimatedAvailabilityStatus:
 * 'OUT_OF_STOCK'` and/or an `itemEndDate` in the past:
 *  - OUT_OF_STOCK with a past itemEndDate and estimatedSoldQuantity > 0
 *    (the common sold case, 118 of 166);
 *  - OUT_OF_STOCK with no itemEndDate, estimatedAvailableQuantity 0 and
 *    estimatedSoldQuantity 2-6 (19 of 166);
 *  - IN_STOCK with a past itemEndDate (8 of 166 — ended; 6 never sold,
 *    2 multi-quantity listings sold some units before ending);
 *  - IN_STOCK, not ended (the ~20 genuinely live ones).
 * So an item is still available only when it is not OUT_OF_STOCK and has
 * no past itemEndDate; otherwise it is gone, and eBay's own
 * estimatedSoldQuantity decides `'sold'` vs `'removed'`. A missing
 * availability block or an unparseable itemEndDate contributes no "gone"
 * signal — an item is never retired on the absence of data. `now` is
 * injectable so the end-date comparison is testable against fixed dates.
 */
export function classifyEbayItemStatus(detail: EbayItemDetail, now: Date = new Date()): ListingLiveStatus {
  const availability = detail.estimatedAvailabilities?.[0];
  const outOfStock = availability?.estimatedAvailabilityStatus === 'OUT_OF_STOCK';
  const endedAt = detail.itemEndDate === undefined ? Number.NaN : Date.parse(detail.itemEndDate);
  const ended = endedAt < now.getTime();
  if (!outOfStock && !ended) {
    return 'active';
  }
  return (availability?.estimatedSoldQuantity ?? 0) > 0 ? 'sold' : 'removed';
}

/**
 * Builds the lazily-initialized status checker the scan service calls once
 * per scan pass, mirroring createDescriptionFetcher's shared-client pattern
 * above: `createEbayItemDetailClient()` performs its own OAuth app-token
 * call, so this defers it to the returned function's own first invocation,
 * memoizes the in-flight/resolved client promise, and reuses it for every
 * missing-candidate lookup in the same scan pass.
 */
function createStatusChecker(): StatusChecker {
  let clientPromise: Promise<EbayItemDetailClient> | undefined;
  return async (externalItemId: string): Promise<ListingLiveStatus> => {
    if (clientPromise === undefined) {
      clientPromise = createEbayItemDetailClient();
    }
    const client = await clientPromise;
    return client.checkItemStatus(externalItemId);
  };
}

// The eBay MarketplaceConnector instance registered under 'ebay' in
// registry.ts.
export const ebayConnector: MarketplaceConnector = {
  platformType: 'ebay',
  search,
  createDescriptionFetcher,
  createStatusChecker,
};

/**
 * Fetches full-resolution photo URLs for already-known eBay items, one item
 * at a time, over a single OAuth token shared by every call. Used by the
 * photo backfill (apps/server/src/photos/photoBackfill.ts) for Listings
 * imported before scans captured images.
 */
export interface EbayItemDetailClient {
  /**
   * Returns every photo URL eBay holds for `externalItemId`, or an empty
   * array when the item has none. Throws AppError(502) carrying eBay's own
   * error message when the detail call fails (e.g. 404 for an item since
   * removed from the marketplace), matching this connector's error
   * convention everywhere else.
   */
  fetchItemImageUrls(externalItemId: string): Promise<string[]>;

  /**
   * Returns the formatted description/specifics text for `externalItemId`
   * (see formatEbayItemDetails), or null when the item has neither. Throws
   * AppError(502) carrying eBay's own error message when the detail call
   * fails, matching this connector's error convention everywhere else.
   */
  fetchItemDescription(externalItemId: string): Promise<string | null>;

  /**
   * Checks whether `externalItemId` is still live on eBay (Req 6). Resolves
   * `'removed'` on a 404, the same reasoning backfillOneListing's own doc
   * comment already uses for an eBay 404 meaning "a listing since removed"
   * (apps/server/src/scan/descriptionBackfill.ts). A 404 is NOT, however,
   * how eBay usually reports a gone item: observed live against the
   * production Browse API, a sold or ended item still answers HTTP 200 with
   * a full item body, so a 2xx response is classified from that body's
   * `estimatedAvailabilities[0]` and `itemEndDate` fields by
   * classifyEbayItemStatus — `'active'` only while the item is genuinely
   * still available, otherwise `'sold'` when eBay's own
   * `estimatedSoldQuantity` is positive and `'removed'` when it is not.
   * Any other non-2xx/non-404 response throws AppError(502) carrying
   * eBay's own error message rather than resolving to any status, matching
   * this connector's error convention everywhere else — never read an
   * unexpected failure response as a mundane, successful outcome (the
   * lesson this project already learned the hard way from the Mercari
   * connector's own auth-bypass bug, where a malformed request's error
   * body was once silently read as zero results instead of a failure; see
   * mercariSearchMapping.ts's header comment).
   */
  checkItemStatus(externalItemId: string): Promise<ListingLiveStatus>;
}

/**
 * Builds an EbayItemDetailClient, resolving the host and fetching one OAuth
 * app token up front. The token is fetched once per client rather than once
 * per item because a backfill run visits many items in a row and eBay's app
 * tokens are valid for two hours — far longer than a backfill takes — so
 * one token per item would be hundreds of needless OAuth round-trips.
 *
 * Unlike search(), this uses eBay's single-item detail endpoint
 * (`GET /buy/browse/v1/item/{itemId}`), which is the only reliable way to
 * reach a specific known item: re-running a search cannot be targeted at an
 * item id, and its ranking shifts between runs. That endpoint already
 * returns full-resolution image URLs, so the size-segment upsizing search
 * results need is a harmless no-op here.
 */
export async function createEbayItemDetailClient(): Promise<EbayItemDetailClient> {
  const host = process.env.EBAY_ENV === 'sandbox' ? 'api.sandbox.ebay.com' : 'api.ebay.com';
  logger.info({ host }, 'Creating eBay item-detail client');
  const token = await fetchAppToken(host);

  return {
    async fetchItemImageUrls(externalItemId: string): Promise<string[]> {
      // eBay item ids contain `|` separators (e.g. `v1|227551136880|0`),
      // which must be percent-encoded to survive the URL path.
      const response = await fetch(`https://${host}/buy/browse/v1/item/${encodeURIComponent(externalItemId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const message = await extractEbayErrorMessage(response, 'eBay item detail lookup failed');
        logger.warn({ host, externalItemId, status: response.status }, 'eBay item detail request failed');
        throw new AppError(message, 502);
      }

      const body = (await response.json()) as EbayItemDetail;
      const imageUrls = collectImageUrls(body);
      logger.debug({ externalItemId, imageCount: imageUrls.length }, 'Fetched eBay item detail image URLs');
      return imageUrls;
    },
    async fetchItemDescription(externalItemId: string): Promise<string | null> {
      const response = await fetch(`https://${host}/buy/browse/v1/item/${encodeURIComponent(externalItemId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const message = await extractEbayErrorMessage(response, 'eBay item detail lookup failed');
        logger.warn({ host, externalItemId, status: response.status }, 'eBay item detail request failed');
        throw new AppError(message, 502);
      }

      const body = (await response.json()) as EbayItemDetail;
      return formatEbayItemDetails(body);
    },
    async checkItemStatus(externalItemId: string): Promise<ListingLiveStatus> {
      const response = await fetch(`https://${host}/buy/browse/v1/item/${encodeURIComponent(externalItemId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 404) {
        logger.debug({ host, externalItemId }, 'eBay item status check: item not found (removed)');
        return 'removed';
      }

      if (!response.ok) {
        const message = await extractEbayErrorMessage(response, 'eBay item status check failed');
        logger.warn({ host, externalItemId, status: response.status }, 'eBay item status check request failed');
        throw new AppError(message, 502);
      }

      const body = (await response.json()) as EbayItemDetail;
      const status = classifyEbayItemStatus(body);
      const availability = body.estimatedAvailabilities?.[0];
      logger.debug(
        {
          externalItemId,
          status,
          availabilityStatus: availability?.estimatedAvailabilityStatus,
          availableQuantity: availability?.estimatedAvailableQuantity,
          soldQuantity: availability?.estimatedSoldQuantity,
          itemEndDate: body.itemEndDate,
        },
        'eBay item status check: classified from item detail body',
      );
      return status;
    },
  };
}
