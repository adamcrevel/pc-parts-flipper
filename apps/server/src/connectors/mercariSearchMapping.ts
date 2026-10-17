// Mercari search response shaping (Req 6), split out of mercariConnector.ts's
// own search() purely to keep that file under this codebase's ~200-line-per-
// file convention (mirrors mercariItemDetail.ts's own split off that same
// connector). Nothing here talks to a browser or the network itself — it
// only validates connector_config, declares the `searchFacetQuery` response
// shape searchOneQuery parses (captured via page.waitForResponse against the
// page's own authenticated request, not a hand-built one — see
// mercariConnector.ts's header comment for why), and maps one raw search
// result item into a CandidateListing.
//
// This file previously also built the `searchFacetQuery` request's own
// `variables`/persisted-query-hash payload for a hand-rolled
// `page.evaluate(() => fetch(...))` call. That call is gone (it had no way
// to attach Mercari's bearer/CSRF auth, minted by the page's own JS and held
// only in memory — confirmed live absent from every cookie/localStorage/
// sessionStorage key on a real search page — so Mercari correctly rejected
// it with a 200 `{"errors":[{"status":401,"message":"Unauthorized"}]}` body
// that the old code silently read as zero results). searchOneQuery now lets
// the page's own JS issue and authenticate that request itself, so this file
// no longer needs to construct it.
import type { MercariConnectorConfig } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';
import type { CandidateListing } from './types.js';

// Shape of one `data.search.itemsList[]` entry this connector reads. Only
// the fields mapped below are declared; the real payload carries more.
export interface MercariSearchItem {
  id: string;
  name: string;
  price: number;
  status: string;
  photos?: Array<{ imageUrl: string }>;
  /** Unix seconds the listing was created, when Mercari includes it. */
  created?: number;
}

// `errors` is Mercari's own top-level error shape (confirmed live: an
// unauthenticated `searchFacetQuery` call returns HTTP 200 with
// `{"errors":[{"status":401,"message":"Unauthorized"}]}` rather than a
// non-2xx status, so this can't be caught by a response.ok() check alone).
// It's present only on failure, alongside an absent/empty `data`.
// searchOneQuery checks for it before falling through to
// `data?.search?.itemsList`, so an API-level failure throws AppError(502)
// instead of silently reading as zero results.
export interface MercariSearchFacetResponse {
  data?: { search?: { itemsList?: MercariSearchItem[] } };
  errors?: { status?: number; message: string }[];
}

/**
 * Converts one `data.search.itemsList[]` entry into a CandidateListing.
 * `price` is whole US cents (confirmed live: a card showing "$142.50"
 * carried `price: 14250`), so askingPrice divides by 100. `listingDate`
 * falls back to today when `created` is absent — Mercari never surfaced a
 * confirmed value for this field during capture.
 */
export function mapSearchItem(item: MercariSearchItem): CandidateListing {
  const listingDate =
    typeof item.created === 'number'
      ? new Date(item.created * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

  return {
    externalItemId: item.id,
    title: item.name,
    listingUrl: `https://www.mercari.com/us/item/${item.id}/`,
    askingPrice: item.price / 100,
    listingDate,
    imageUrls: (item.photos ?? []).map((photo) => photo.imageUrl),
    nonWorking: false,
  };
}

/**
 * Validates an unknown connector_config value is shaped like
 * MercariConnectorConfig: non-empty array of non-blank `queries`, optional
 * non-negative `maxPrice`. Mirrors validateEbayConnectorConfig exactly,
 * since the two configs share this shape. Throws AppError(400) otherwise.
 */
export function validateMercariConnectorConfig(config: unknown): MercariConnectorConfig {
  if (typeof config !== 'object' || config === null) {
    throw new AppError('Mercari connector config must be an object', 400);
  }
  const candidate = config as Record<string, unknown>;

  const queries = candidate.queries;
  if (!Array.isArray(queries) || queries.length === 0 || queries.some((q) => typeof q !== 'string' || q.trim().length === 0)) {
    throw new AppError('Mercari connector config requires a non-empty array of non-blank query strings', 400);
  }

  if (candidate.maxPrice !== undefined && (typeof candidate.maxPrice !== 'number' || candidate.maxPrice < 0)) {
    throw new AppError('Mercari connector config maxPrice must be a non-negative number', 400);
  }

  return { queries, maxPrice: candidate.maxPrice as number | undefined };
}
