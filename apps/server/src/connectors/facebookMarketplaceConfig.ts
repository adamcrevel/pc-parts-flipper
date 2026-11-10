// Facebook Marketplace connector_config validation (Req 6, T8), split out
// of facebookMarketplaceConnector.ts to keep that file near the ~200-line
// convention — the same split convention mercariSearchMapping.ts and
// mercariItemDetail.ts follow against mercariConnector.ts. Validation is a
// pure, browser-free concern: nothing here touches Playwright, the session
// file, or the network, so a config-shape change is a localized edit in
// this file rather than anywhere near the connector's session logic.
import type { FacebookMarketplaceConnectorConfig } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';

/**
 * Validates one optional numeric field (`maxPrice`, `radiusMiles`) is
 * either absent or a non-negative number. Shared by both fields in
 * validateFacebookMarketplaceConnectorConfig below so that function's own
 * branching stays low — each field it validated inline previously added
 * three decision points of its own.
 */
function validateOptionalNonNegativeNumber(value: unknown, fieldLabel: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || value < 0) {
    throw new AppError(`Facebook Marketplace connector config ${fieldLabel} must be a non-negative number`, 400);
  }
  return value;
}

/**
 * Validates an unknown connector_config value is shaped like
 * FacebookMarketplaceConnectorConfig before search() uses it: `queries`
 * must be a non-empty array of non-blank strings; `maxPrice`/`radiusMiles`
 * (if present) must be non-negative numbers; `location` (if present) must
 * be a string. Throws AppError(400) otherwise, mirroring
 * ebayConnector.ts's validateEbayConnectorConfig.
 */
export function validateFacebookMarketplaceConnectorConfig(config: unknown): FacebookMarketplaceConnectorConfig {
  if (typeof config !== 'object' || config === null) {
    throw new AppError('Facebook Marketplace connector config must be an object', 400);
  }
  const candidate = config as Record<string, unknown>;

  const queries = candidate.queries;
  if (!Array.isArray(queries) || queries.length === 0 || queries.some((q) => typeof q !== 'string' || q.trim().length === 0)) {
    throw new AppError('Facebook Marketplace connector config requires a non-empty array of non-blank query strings', 400);
  }

  const maxPrice = validateOptionalNonNegativeNumber(candidate.maxPrice, 'maxPrice');
  const radiusMiles = validateOptionalNonNegativeNumber(candidate.radiusMiles, 'radiusMiles');
  if (candidate.location !== undefined && typeof candidate.location !== 'string') {
    throw new AppError('Facebook Marketplace connector config location must be a string', 400);
  }

  return { queries, maxPrice, radiusMiles, location: candidate.location as string | undefined };
}
