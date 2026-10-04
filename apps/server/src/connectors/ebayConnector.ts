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
import type { CandidateListing, MarketplaceConnector } from './types.js';

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
  additionalImages?: Array<{ imageUrl: string }>;
}

// Shape of a Browse API single-item detail response
// (`GET /buy/browse/v1/item/{itemId}`). Its image fields are identical in
// shape to the search response's, but already served at full resolution —
// only the fields fetchItemImageUrls reads are declared here.
interface EbayItemDetail {
  image?: { imageUrl: string };
  additionalImages?: Array<{ imageUrl: string }>;
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
  };
}

/**
 * Runs one Browse API search for a single query term, applying the
 * optional maxPrice ceiling as a `filter=price:[0..maxPrice],priceCurrency:USD`
 * query param when set. Throws AppError built from eBay's own error message
 * on a non-200 response.
 */
async function searchOneQuery(
  host: string,
  token: string,
  query: string,
  maxPrice: number | undefined,
): Promise<CandidateListing[]> {
  const params = new URLSearchParams({ q: query, limit: '50' });
  if (maxPrice !== undefined) {
    params.set('filter', `price:[0..${maxPrice}],priceCurrency:USD`);
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

// The eBay MarketplaceConnector instance registered under 'ebay' in
// registry.ts.
export const ebayConnector: MarketplaceConnector = {
  platformType: 'ebay',
  search,
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
  };
}
