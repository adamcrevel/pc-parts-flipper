// Facebook Marketplace search-URL building and JSON response parsing
// (Req 6, T8), split out of facebookMarketplaceConnector.ts to keep that
// file near the ~200-line convention and so correcting any one of the
// guesses below is a small, localized edit here rather than a rewrite of
// the connector's session/orchestration logic. The DOM-scraping fallback
// and the detail page's description extraction live in the sibling
// facebookMarketplaceDom.ts; this file is the preferred,
// network-response-first strategy only.
//
// *** UNVERIFIED AGAINST A REAL LOGGED-IN SESSION. *** No real, dedicated
// Facebook account is available in this sandbox. Everything below —
// buildSearchUrl's query params and the GraphQL/JSON field names
// parseListingsFromResponses looks for — is a best-evidenced guess
// (public search URL docs, and field names consistent with public
// Facebook-Marketplace-scraping write-ups), not a confirmed live shape.
// Confirm and correct once a real account exists; see
// facebookMarketplaceConnector.ts's own top comment.
import type { CandidateListing } from './types.js';

const SEARCH_BASE_URL = 'https://www.facebook.com/marketplace/search/';

/**
 * Builds a Facebook Marketplace search URL for one query term.
 * `query`/`maxPrice`/`radius` are Facebook's own publicly documented public
 * search URL params (radius in miles). `location` has no documented
 * free-text query-param equivalent — Facebook normally resolves location
 * from the logged-in account's own profile/cookie location, or from a
 * resolved city-id path segment, neither of which this connector has a way
 * to derive without a real session to probe against. Passed through here as
 * a bare `location` param as the most plausible guess.
 */
export function buildSearchUrl(query: string, options: { maxPrice?: number; radiusMiles?: number; location?: string }): string {
  const params = new URLSearchParams({ query });
  if (options.maxPrice !== undefined) {
    params.set('maxPrice', String(options.maxPrice));
  }
  if (options.radiusMiles !== undefined) {
    params.set('radius', String(options.radiusMiles));
  }
  if (options.location !== undefined) {
    params.set('location', options.location);
  }
  return `${SEARCH_BASE_URL}?${params.toString()}`;
}

// Shape of one GraphQL/JSON listing node this connector knows how to map.
// Only the fields read below are declared; a real response carries many
// more. Field names (`marketplace_listing_title`, `listing_price`,
// `primary_listing_photo`) are a best-evidenced guess, not confirmed live.
interface RawListingNode {
  id?: unknown;
  marketplace_listing_title?: unknown;
  listing_price?: unknown;
  primary_listing_photo?: unknown;
}

function isListingNode(value: unknown): value is RawListingNode {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (typeof candidate.id === 'string' || typeof candidate.id === 'number') &&
    typeof candidate.marketplace_listing_title === 'string' &&
    typeof candidate.listing_price === 'object' &&
    candidate.listing_price !== null
  );
}

function extractPriceAmount(node: RawListingNode): number | null {
  const price = node.listing_price as Record<string, unknown>;
  const raw = price.amount ?? price.amount_with_offset_in_currency;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return null;
  }
  const numeric = Number(String(raw).replace(/[^0-9.]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function extractPhotoUrl(node: RawListingNode): string | null {
  const photo = node.primary_listing_photo as Record<string, unknown> | undefined;
  const image = (photo?.image ?? photo?.listing_image) as Record<string, unknown> | undefined;
  const uri = image?.uri;
  return typeof uri === 'string' ? uri : null;
}

/**
 * Maps one recognized listing node to a CandidateListing. listingDate has
 * no equivalent among the fields this connector reads from a search-result
 * node (unlike eBay's itemCreationDate) — stamped with today's date as the
 * best available proxy; confirm whether Facebook exposes a real listing
 * date once a real session is available. nonWorking is always false:
 * Facebook Marketplace has no condition taxonomy equivalent to eBay's
 * conditionId.
 */
function mapListingNode(node: RawListingNode): CandidateListing | null {
  const price = extractPriceAmount(node);
  if (price === null) {
    return null;
  }
  const id = String(node.id);
  const photoUrl = extractPhotoUrl(node);
  return {
    externalItemId: id,
    title: node.marketplace_listing_title as string,
    listingUrl: `https://www.facebook.com/marketplace/item/${id}/`,
    askingPrice: price,
    listingDate: new Date().toISOString().slice(0, 10),
    imageUrls: photoUrl ? [photoUrl] : [],
    nonWorking: false,
  };
}

// GraphQL connection envelopes (edges/node/data wrappers) nest listing
// objects several levels deep and that nesting depth is itself unverified;
// capped defensively so a pathological or unexpectedly deep/circular-ish
// payload can't turn one response into an unbounded walk.
const MAX_WALK_DEPTH = 12;

function collectListingNodes(value: unknown, depth: number, seenIds: Set<string>, out: CandidateListing[]): void {
  if (depth > MAX_WALK_DEPTH || value === null || typeof value !== 'object') {
    return;
  }
  if (isListingNode(value)) {
    const mapped = mapListingNode(value);
    if (mapped && !seenIds.has(mapped.externalItemId)) {
      seenIds.add(mapped.externalItemId);
      out.push(mapped);
    }
    return;
  }
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const entry of entries) {
    collectListingNodes(entry, depth + 1, seenIds, out);
  }
}

/**
 * Walks every response body collected during a search navigation looking
 * for recognizable listing nodes, regardless of how deep the surrounding
 * GraphQL envelope (query name, edges/node wrappers) nests them — that
 * envelope shape is exactly what tends to change between Facebook's own
 * deploys, so matching on the inner node's own fields rather than a fixed
 * path is this strategy's resilience story.
 */
export function parseListingsFromResponses(bodies: unknown[]): CandidateListing[] {
  const out: CandidateListing[] = [];
  const seenIds = new Set<string>();
  for (const body of bodies) {
    collectListingNodes(body, 0, seenIds, out);
  }
  return out;
}
