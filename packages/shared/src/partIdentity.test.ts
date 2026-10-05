// Unit proof for formatIdentityCandidates (and, incidentally, the
// formatPartIdentity it delegates to per-candidate). packages/shared has no
// test runner wired up yet ("no tests yet in packages/shared" in
// package.json) and no other pure function here has a direct unit test
// today — formatPartIdentity is only ever exercised indirectly through
// apps/server/test/saleListingTitle.test.ts. This file follows that
// directory's vitest describe/it/expect convention directly, since
// formatIdentityCandidates' branch matrix (primary-pair exclusion,
// multi-candidate joining, brand-only near-miss) is cheap to enumerate here
// and does not need a real HTTP/DB round trip to prove.
import { describe, expect, it } from 'vitest';
import { formatIdentityCandidates } from './partIdentity.js';

describe('formatIdentityCandidates', () => {
  it('returns an empty string for an empty candidate list', () => {
    expect(formatIdentityCandidates([], 'NVIDIA', 'RTX 3070')).toBe('');
    // Also empty when there is no primary identification yet either.
    expect(formatIdentityCandidates([], null, null)).toBe('');
  });

  it('excludes a candidate that exactly repeats the primary brand+partNumber pair', () => {
    const result = formatIdentityCandidates(
      [{ brand: 'NVIDIA', partNumber: 'RTX 3070' }],
      'NVIDIA',
      'RTX 3070'
    );

    // The only candidate given is a verbatim repeat of the primary pair, so
    // nothing is left to render.
    expect(result).toBe('');
  });

  it('joins multiple distinct candidates with the "or " prefix, comma-separated via formatPartIdentity', () => {
    const result = formatIdentityCandidates(
      [
        { brand: 'NVIDIA', partNumber: 'RTX 3070' },
        { brand: 'NVIDIA', partNumber: 'RTX 3080' },
      ],
      'NVIDIA',
      'RTX 3060'
    );

    // Each candidate is rendered as "brand partNumber" (formatPartIdentity's
    // join), then the whole list is comma-joined behind a single "or " —
    // not "or NVIDIA RTX 3070or NVIDIA RTX 3080" or any other mis-join.
    expect(result).toBe('or NVIDIA RTX 3070, NVIDIA RTX 3080');
  });

  it('keeps a candidate that matches the primary brand but has a different part number', () => {
    // Exact-pair match only: same brand alone must not be enough to drop a
    // candidate, or a genuinely different model from the same brand would
    // silently vanish from the alternates list.
    const result = formatIdentityCandidates(
      [{ brand: 'NVIDIA', partNumber: 'RTX 3080' }],
      'NVIDIA',
      'RTX 3070'
    );

    expect(result).toBe('or NVIDIA RTX 3080');
  });

  it('renders distinct brand candidates when the brand itself is unresolved', () => {
    // Req 3: a short list of likely brands, not just alternate models within
    // one known brand — primaryBrand/primaryPartNumber are both null since
    // the AI has no single answer to compare candidates against.
    const result = formatIdentityCandidates(
      [
        { brand: 'AMD', partNumber: null },
        { brand: 'NVIDIA', partNumber: null },
        { brand: 'Intel', partNumber: null },
      ],
      null,
      null
    );

    expect(result).toBe('or AMD, NVIDIA, Intel');
  });
});
