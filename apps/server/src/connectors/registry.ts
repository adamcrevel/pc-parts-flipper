// Platform-type -> MarketplaceConnector lookup (Req 7). T6 (not this batch)
// resolves a Source's platformType to its connector here before calling
// search(), rather than importing each connector module directly, so adding
// a new platform later means registering it here once instead of touching
// every call site.
import type { PlatformType } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';
import { ebayConnector } from './ebayConnector.js';
import { facebookMarketplaceConnector } from './facebookMarketplaceConnector.js';
import { mercariConnector } from './mercariConnector.js';
import type { MarketplaceConnector } from './types.js';

// Three platforms are registered: 'ebay', 'mercari', and 'facebook_marketplace'.
// Other platforms have no automated-scan connector yet.
const CONNECTOR_REGISTRY: Partial<Record<PlatformType, MarketplaceConnector>> = {
  ebay: ebayConnector,
  mercari: mercariConnector,
  facebook_marketplace: facebookMarketplaceConnector,
};

/**
 * Looks up the registered MarketplaceConnector for a Source's platformType.
 * Throws AppError(400) when no connector is registered for that platform
 * (currently all types except 'ebay', 'mercari', and 'facebook_marketplace')
 * so callers get a clear, actionable error instead of an undefined connector
 * reaching a `.search()` call.
 */
export function getConnectorForPlatform(platformType: PlatformType): MarketplaceConnector {
  const connector = CONNECTOR_REGISTRY[platformType];
  if (!connector) {
    throw new AppError(`No automated-scan connector is registered for platform type '${platformType}'`, 400);
  }
  return connector;
}
