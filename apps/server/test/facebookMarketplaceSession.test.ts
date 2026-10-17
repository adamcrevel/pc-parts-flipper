// Test coverage for facebookMarketplaceSession.ts's host-spoofing guard
// (Req 6: Facebook Marketplace authentication check).
//
// The core safety-critical guard being tested is the exact/subdomain match
// check on line 86 of facebookMarketplaceSession.ts:
//   return parsed.hostname === 'facebook.com' || parsed.hostname.endsWith('.facebook.com') ? parsed : null;
//
// The OLD spoofable form would have been:
//   return parsed.hostname.endsWith('facebook.com') ? parsed : null;
//
// That old form would incorrectly accept lookalike hosts like 'evilfacebook.com'
// or 'notfacebook.com' (since 'evilfacebook.com'.endsWith('facebook.com') is true),
// which could lead to falsely treating a non-Facebook response as an auth wall.
//
// These tests drive the guard indirectly through the exported functions
// `isLoginOrCheckpointUrl` and `isFacebookRootUrl`, which call the private
// `parseFacebookUrl` helper.

import { describe, expect, it } from 'vitest';
import { isLoginOrCheckpointUrl, isFacebookRootUrl } from '../src/connectors/facebookMarketplaceSession.js';

describe('facebookMarketplaceSession host-spoofing guard (Req 6)', () => {
  describe('isLoginOrCheckpointUrl — rejects lookalike hosts', () => {
    it('rejects evilfacebook.com with a /login path (would pass old endsWith check)', () => {
      expect(isLoginOrCheckpointUrl('https://evilfacebook.com/login')).toBe(false);
    });

    it('rejects notfacebook.com with a /login path (would pass old endsWith check)', () => {
      expect(isLoginOrCheckpointUrl('https://notfacebook.com/login')).toBe(false);
    });

    it('rejects evilfacebook.com with a /checkpoint path (would pass old endsWith check)', () => {
      expect(isLoginOrCheckpointUrl('https://evilfacebook.com/checkpoint')).toBe(false);
    });

    it('rejects notfacebook.com with a /checkpoint path (would pass old endsWith check)', () => {
      expect(isLoginOrCheckpointUrl('https://notfacebook.com/checkpoint')).toBe(false);
    });

    it('rejects myfacebook.com with a /login path (would pass old endsWith check)', () => {
      expect(isLoginOrCheckpointUrl('https://myfacebook.com/login')).toBe(false);
    });
  });

  describe('isLoginOrCheckpointUrl — accepts real facebook.com and subdomains', () => {
    it('accepts facebook.com with a /login path (exact hostname match)', () => {
      expect(isLoginOrCheckpointUrl('https://facebook.com/login')).toBe(true);
    });

    it('accepts m.facebook.com with a /login path (subdomain match)', () => {
      expect(isLoginOrCheckpointUrl('https://m.facebook.com/login')).toBe(true);
    });

    it('accepts www.facebook.com with a /login path (subdomain match)', () => {
      expect(isLoginOrCheckpointUrl('https://www.facebook.com/login')).toBe(true);
    });

    it('accepts facebook.com with a /checkpoint path (exact hostname match)', () => {
      expect(isLoginOrCheckpointUrl('https://facebook.com/checkpoint')).toBe(true);
    });

    it('accepts m.facebook.com with a /checkpoint path (subdomain match)', () => {
      expect(isLoginOrCheckpointUrl('https://m.facebook.com/checkpoint')).toBe(true);
    });

    it('accepts facebook.com with a /checkpoint/123 nested path', () => {
      expect(isLoginOrCheckpointUrl('https://facebook.com/checkpoint/123')).toBe(true);
    });
  });

  describe('isLoginOrCheckpointUrl — rejects non-login/checkpoint paths', () => {
    it('rejects facebook.com with /marketplace (real path, wrong purpose)', () => {
      expect(isLoginOrCheckpointUrl('https://facebook.com/marketplace')).toBe(false);
    });

    it('rejects m.facebook.com with /search (real path, wrong purpose)', () => {
      expect(isLoginOrCheckpointUrl('https://m.facebook.com/search')).toBe(false);
    });

    it('rejects facebook.com with / (root path)', () => {
      expect(isLoginOrCheckpointUrl('https://facebook.com/')).toBe(false);
    });
  });

  describe('isFacebookRootUrl — rejects lookalike hosts', () => {
    it('rejects evilfacebook.com at root (would pass old endsWith check)', () => {
      expect(isFacebookRootUrl('https://evilfacebook.com/')).toBe(false);
    });

    it('rejects notfacebook.com with empty path (would pass old endsWith check)', () => {
      expect(isFacebookRootUrl('https://notfacebook.com')).toBe(false);
    });

    it('rejects myfacebook.com at root (would pass old endsWith check)', () => {
      expect(isFacebookRootUrl('https://myfacebook.com/')).toBe(false);
    });
  });

  describe('isFacebookRootUrl — accepts real facebook.com and subdomains at root', () => {
    it('accepts facebook.com at root with / path (exact hostname match)', () => {
      expect(isFacebookRootUrl('https://facebook.com/')).toBe(true);
    });

    it('accepts facebook.com with empty path (exact hostname match)', () => {
      expect(isFacebookRootUrl('https://facebook.com')).toBe(true);
    });

    it('accepts m.facebook.com at root with / path (subdomain match)', () => {
      expect(isFacebookRootUrl('https://m.facebook.com/')).toBe(true);
    });

    it('accepts www.facebook.com with empty path (subdomain match)', () => {
      expect(isFacebookRootUrl('https://www.facebook.com')).toBe(true);
    });

    it('accepts business.facebook.com at root (deep subdomain match)', () => {
      expect(isFacebookRootUrl('https://business.facebook.com/')).toBe(true);
    });
  });

  describe('isFacebookRootUrl — rejects non-root paths', () => {
    it('rejects facebook.com with /login path (wrong path)', () => {
      expect(isFacebookRootUrl('https://facebook.com/login')).toBe(false);
    });

    it('rejects m.facebook.com with /marketplace path (wrong path)', () => {
      expect(isFacebookRootUrl('https://m.facebook.com/marketplace')).toBe(false);
    });
  });

  describe('both functions — handle malformed/unparseable URLs gracefully', () => {
    it('isLoginOrCheckpointUrl returns false for invalid URL', () => {
      expect(isLoginOrCheckpointUrl('not a url at all')).toBe(false);
    });

    it('isFacebookRootUrl returns false for invalid URL', () => {
      expect(isFacebookRootUrl('not a url at all')).toBe(false);
    });

    it('isLoginOrCheckpointUrl returns false for empty string', () => {
      expect(isLoginOrCheckpointUrl('')).toBe(false);
    });

    it('isFacebookRootUrl returns false for empty string', () => {
      expect(isFacebookRootUrl('')).toBe(false);
    });

    it('isLoginOrCheckpointUrl returns false for unrelated domain with /login path', () => {
      expect(isLoginOrCheckpointUrl('https://example.com/login')).toBe(false);
    });

    it('isFacebookRootUrl returns false for unrelated domain at root', () => {
      expect(isFacebookRootUrl('https://example.com/')).toBe(false);
    });
  });
});
