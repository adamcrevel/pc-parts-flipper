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

/**
 * Converts one eBay Browse API `itemSummaries[]` entry into a
 * CandidateListing. Uses `itemWebUrl` (the human-facing listing page) rather
 * than `itemHref` (the API resource URL) for listingUrl, and truncates
 * `itemCreationDate`'s ISO timestamp down to just its date portion.
 */
function mapItemSummary(item: EbayItemSummary): CandidateListing {
  return {
    externalItemId: item.itemId,
    title: item.title,
    listingUrl: item.itemWebUrl,
    askingPrice: Number(item.price.value),
    listingDate: item.itemCreationDate.slice(0, 10),
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
