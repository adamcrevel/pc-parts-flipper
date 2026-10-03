// Platform-type -> MarketplaceConnector lookup (Req 7). T6 (not this batch)
// resolves a Source's platformType to its connector here before calling
// search(), rather than importing each connector module directly, so adding
// a new platform later means registering it here once instead of touching
// every call site.
import type { PlatformType } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';
import { ebayConnector } from './ebayConnector.js';
import type { MarketplaceConnector } from './types.js';

// Only 'ebay' is registered for now — facebook_marketplace and other have no
// automated-scan connector yet (Req 6 scopes this batch to eBay only).
const CONNECTOR_REGISTRY: Partial<Record<PlatformType, MarketplaceConnector>> = {
  ebay: ebayConnector,
};

/**
 * Looks up the registered MarketplaceConnector for a Source's platformType.
 * Throws AppError(400) when no connector is registered for that platform
 * (currently every type except 'ebay') so callers get a clear, actionable
 * error instead of an undefined connector reaching a `.search()` call.
 */
export function getConnectorForPlatform(platformType: PlatformType): MarketplaceConnector {
  const connector = CONNECTOR_REGISTRY[platformType];
  if (!connector) {
    throw new AppError(`No automated-scan connector is registered for platform type '${platformType}'`, 400);
  }
  return connector;
}
