// Proof that CreateSourceInput.connectorConfig's widened union (T1) really
// accepts all three platforms' config shapes, plus null, rather than only
// compiling for eBay by coincidence (e.g. because the other two interfaces
// happen to be structurally compatible with EbayConnectorConfig and a typo
// dropped one of them from the union silently). Interfaces are erased at
// runtime, so the only thing that can actually fail here is the TypeScript
// compiler itself: each `satisfies` below only type-checks if its named
// interface is still assignable to CreateSourceInput['connectorConfig'].
// This file's assertions are deliberately typed `vitest run`, which
// transpiles with esbuild and does not type-check — the real proof is
// `tsc --noEmit` run directly against this file (see TE1's digest for the
// exact command and the narrowed-union mutation that makes it fail).
import { describe, expect, it } from 'vitest';
import type {
  EbayConnectorConfig,
  MercariConnectorConfig,
  FacebookMarketplaceConnectorConfig,
} from './connectors.js';
import type { CreateSourceInput } from './sources.js';

describe('CreateSourceInput.connectorConfig accepts every platform config shape', () => {
  it('accepts an EbayConnectorConfig', () => {
    const input: CreateSourceInput = {
      name: 'eBay Source',
      platformType: 'ebay',
      url: 'https://ebay.com',
      notes: null,
      connectorConfig: { queries: ['rtx 3080'], maxPrice: 300 } satisfies EbayConnectorConfig,
    };

    expect(input.connectorConfig).toEqual({ queries: ['rtx 3080'], maxPrice: 300 });
  });

  it('accepts a MercariConnectorConfig', () => {
    const input: CreateSourceInput = {
      name: 'Mercari Source',
      platformType: 'mercari',
      url: 'https://mercari.com',
      notes: null,
      connectorConfig: { queries: ['ryzen 5800x'] } satisfies MercariConnectorConfig,
    };

    expect(input.connectorConfig).toEqual({ queries: ['ryzen 5800x'] });
  });

  it('accepts a FacebookMarketplaceConnectorConfig', () => {
    const input: CreateSourceInput = {
      name: 'Facebook Marketplace Source',
      platformType: 'facebook_marketplace',
      url: 'https://facebook.com/marketplace',
      notes: null,
      connectorConfig: {
        queries: ['gpu'],
        location: 'Seattle, WA',
        radiusMiles: 25,
        maxPrice: 500,
      } satisfies FacebookMarketplaceConnectorConfig,
    };

    expect(input.connectorConfig).toEqual({
      queries: ['gpu'],
      location: 'Seattle, WA',
      radiusMiles: 25,
      maxPrice: 500,
    });
  });

  it('accepts null (no automated scan configured)', () => {
    const input: CreateSourceInput = {
      name: 'Manual Source',
      platformType: 'other',
      url: 'https://example.com',
      notes: null,
      connectorConfig: null,
    };

    expect(input.connectorConfig).toBeNull();
  });
});
