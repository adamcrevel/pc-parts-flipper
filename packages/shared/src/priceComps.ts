// Shape of one real-market comparable the price-estimation model found while
// researching a part's resale value (pricing-comps feature T1). Distinct
// from the single priceUsd estimate parsed by priceEstimationParser.ts's
// parsePriceEstimationResponse: a comp is the supporting evidence (an actual
// listing or sale the model cites), not the estimate itself, so the user can
// judge the number against what it was based on instead of trusting it
// blind.
/**
 * One real listing or sale the model found as supporting evidence for its
 * price estimate. `priceUsd` and `condition` are nullable because the model
 * may surface a comp (e.g. a sold listing) without a clean price or
 * condition string attached. `saleType` distinguishes a completed sale
 * ('sold') from a current asking price ('listed') — null when the model
 * could not tell which it found. `linkStatus` records the outcome of
 * link-liveness verification (pricing-comps feature T7): 'live' means the
 * URL was checked and is still reachable, 'archived' means the original
 * link was confirmed dead and `url` has been swapped for a Wayback Machine
 * snapshot of it, and null means the link has not been checked yet or the
 * check was inconclusive (timeout, network error, or a blocking response
 * that doesn't prove the link is actually dead) and `url` was left as-is.
 */
export interface PriceComp {
  title: string;
  url: string;
  priceUsd: number | null;
  condition: string | null;
  saleType: 'sold' | 'listed' | null;
  linkStatus: 'live' | 'archived' | null;
}

// Response shape of GET /api/price-comps (pricing-comps feature T3).
/**
 * The current price-research state for one (category, brand, partNumber)
 * combo. All three fields are null/empty together for a combo that has
 * never been queued for research — that is a normal "not yet priced" state
 * (never a 404), not an error, so the frontend can render "no estimate yet"
 * without special-casing a missing-row response differently from a
 * researched-but-comp-less one.
 */
export interface GetPriceCompsResponse {
  estimatedResaleValue: number | null;
  lastResearchedAt: string | null;
  comps: PriceComp[];
}
