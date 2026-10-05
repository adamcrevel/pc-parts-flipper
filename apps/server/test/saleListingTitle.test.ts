// Unit proof for saleListingValidation.ts's defaultSaleListingTitle — the
// one function that decides whether a draft Sale Listing is headlined by the
// Part's real identity ("NVIDIA RTX 3060") or by the generic fallback
// ("GPU: <condition notes>"). Kept as a pure unit test rather than folded
// into saleListings.test.ts's HTTP suite because the branch matrix (four
// brand/partNumber combinations, plus blank-string variants) is cheap to
// enumerate directly and expensive to drive through a real teardown chain.
//
// Both directions are asserted everywhere: a case that produces the identity
// title also asserts it is NOT the fallback, and vice versa — a one-sided
// check would stay green if the condition were inverted and the two strings
// happened to look similar.
import { describe, expect, it } from 'vitest';
import { defaultSaleListingTitle, validateCreateSaleListingInput } from '../src/routes/saleListingValidation.js';

const CATEGORY = 'GPU' as const;
const DESCRIPTION = 'Pulled from a working machine, light dust';
const FALLBACK = `${CATEGORY}: ${DESCRIPTION}`;

describe('defaultSaleListingTitle', () => {
  it('uses brand and part number together when both are present', () => {
    const title = defaultSaleListingTitle(CATEGORY, DESCRIPTION, 'NVIDIA', 'RTX 3060');

    expect(title).toBe('NVIDIA RTX 3060');
    expect(title).not.toBe(FALLBACK);
  });

  it('uses brand alone when the part number is unknown', () => {
    const title = defaultSaleListingTitle(CATEGORY, DESCRIPTION, 'NVIDIA', null);

    expect(title).toBe('NVIDIA');
    expect(title).not.toBe(FALLBACK);
  });

  it('uses the part number alone when the brand is unknown', () => {
    const title = defaultSaleListingTitle(CATEGORY, DESCRIPTION, null, 'RTX 3060');

    expect(title).toBe('RTX 3060');
    expect(title).not.toBe(FALLBACK);
  });

  it('falls back to `category: description` only when both are null', () => {
    const title = defaultSaleListingTitle(CATEGORY, DESCRIPTION, null, null);

    expect(title).toBe(FALLBACK);
  });

  it('treats blank/whitespace-only values as absent, not as an empty leading segment', () => {
    // The failure this guards: joining a blank brand with a real part number
    // would produce " RTX 3060" with a leading space, which looks fine in a
    // loose assertion and wrong in a real marketplace title.
    expect(defaultSaleListingTitle(CATEGORY, DESCRIPTION, '   ', 'RTX 3060')).toBe('RTX 3060');
    expect(defaultSaleListingTitle(CATEGORY, DESCRIPTION, 'NVIDIA', '')).toBe('NVIDIA');
    // Both blank is indistinguishable from both null, so the fallback runs.
    expect(defaultSaleListingTitle(CATEGORY, DESCRIPTION, '', '  ')).toBe(FALLBACK);
  });

  it('trims a padded value rather than embedding the padding in the title', () => {
    expect(defaultSaleListingTitle(CATEGORY, DESCRIPTION, '  NVIDIA ', ' RTX 3060  ')).toBe('NVIDIA RTX 3060');
  });
});

describe('validateCreateSaleListingInput title defaulting', () => {
  it('derives the title from the Part identity when no title is supplied', () => {
    const result = validateCreateSaleListingInput({}, {
      category: CATEGORY,
      description: DESCRIPTION,
      brand: 'NVIDIA',
      partNumber: 'RTX 3060',
    });

    expect(result.title).toBe('NVIDIA RTX 3060');
    // description keeps its own role — the identity does not overwrite it.
    expect(result.description).toBe(DESCRIPTION);
  });

  it('derives the fallback title for an unidentified Part', () => {
    const result = validateCreateSaleListingInput({}, {
      category: CATEGORY,
      description: DESCRIPTION,
      brand: null,
      partNumber: null,
    });

    expect(result.title).toBe(FALLBACK);
  });

  it('still prefers an explicitly-supplied title over the Part identity', () => {
    const result = validateCreateSaleListingInput({ title: 'Hand-written title' }, {
      category: CATEGORY,
      description: DESCRIPTION,
      brand: 'NVIDIA',
      partNumber: 'RTX 3060',
    });

    expect(result.title).toBe('Hand-written title');
  });
});
