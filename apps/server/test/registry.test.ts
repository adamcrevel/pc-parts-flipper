// T9: Test coverage for CONNECTOR_REGISTRY (Req 7 — platform lookup).
// Verifies that registered platform types resolve to the correct
// MarketplaceConnector instances.
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/error-handler.js';
import { ebayConnector } from '../src/connectors/ebayConnector.js';
import { mercariConnector } from '../src/connectors/mercariConnector.js';
import { facebookMarketplaceConnector } from '../src/connectors/facebookMarketplaceConnector.js';
import { getConnectorForPlatform } from '../src/connectors/registry.js';

describe('getConnectorForPlatform (Req 7 — platform lookup)', () => {
  it('resolves "ebay" to the ebayConnector instance', () => {
    const connector = getConnectorForPlatform('ebay');
    expect(connector).toBe(ebayConnector);
  });

  it('resolves "mercari" to the mercariConnector instance', () => {
    const connector = getConnectorForPlatform('mercari');
    expect(connector).toBe(mercariConnector);
  });

  it('resolves "facebook_marketplace" to the facebookMarketplaceConnector instance', () => {
    const connector = getConnectorForPlatform('facebook_marketplace');
    expect(connector).toBe(facebookMarketplaceConnector);
  });

  it('throws AppError(400) with descriptive message for an unregistered platform type', () => {
    expect(() => getConnectorForPlatform('unknown_platform')).toThrow(AppError);
    try {
      getConnectorForPlatform('unknown_platform');
      expect.fail('Should have thrown AppError');
    } catch (e) {
      const appError = e as AppError;
      expect(appError.statusCode).toBe(400);
      expect(appError.message).toMatch(/no automated-scan connector/i);
    }
  });
});
