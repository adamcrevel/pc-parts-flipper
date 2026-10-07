// @vitest-environment jsdom
//
// Proof for T3's `collapsed` wiring in listing-form-state.ts: a row built
// from an already-saved Listing (expectedPartToRow, reached via
// initialExpectedPartRows/expectedPartsToRows) always starts collapsed,
// regardless of AI provenance (aiConfidence + aiSource), unlike the single
// blank row either function falls back to for a Listing with no Expected
// Parts yet (emptyExpectedPartRow) and the same default "Add Part" itself
// produces, which starts expanded. No React mounting needed here; these
// are plain data-transform functions, not components.
import { describe, expect, it } from 'vitest';
import type { ExpectedPart, ListingDetail } from '@pc-parts-flipper/shared';
import { initialExpectedPartRows, expectedPartsToRows } from '../src/features/listings/listing-form-state';

function makeExpectedPart(overrides: Partial<ExpectedPart> = {}): ExpectedPart {
  return {
    id: 'part-1',
    listingId: 'listing-1',
    componentCategory: 'GPU',
    brand: 'NVIDIA',
    partNumber: 'RTX 3070',
    description: 'pulled from a working rig',
    estimatedResaleValue: 300,
    identityCandidates: [],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  };
}

function makeListingDetail(expectedParts: ExpectedPart[]): ListingDetail {
  return {
    id: 'listing-1',
    sourceId: 'source-1',
    title: 'Test Listing',
    description: null,
    listingUrl: null,
    askingPrice: 100,
    listingDate: '2024-01-01',
    status: 'open',
    acquisitionFees: 0,
    photoPaths: [],
    externalSource: null,
    externalItemId: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    comparison: { totalExpectedResaleValue: 300, totalCost: 100, difference: 200 },
    expectedParts,
  };
}

describe('initialExpectedPartRows row-collapsing defaults', () => {
  it('starts an already-reviewed row (no AI provenance) collapsed when seeded from a Listing that already has Expected Parts', () => {
    const rows = initialExpectedPartRows(makeListingDetail([makeExpectedPart(), makeExpectedPart({ id: 'part-2', componentCategory: 'PSU' })]));

    expect(rows).toHaveLength(2);
    expect(rows[0].collapsed).toBe(true);
    expect(rows[1].collapsed).toBe(true);
  });

  it('collapses an AI-suggested row like any other saved row', () => {
    const rows = initialExpectedPartRows(
      makeListingDetail([makeExpectedPart(), makeExpectedPart({ id: 'part-2', aiConfidence: 'high', aiSource: 'image' })]),
    );

    // Row identity matters, not just "some row collapsed" — both rows
    // collapsed, and the AI-suggested one still carries aiSuggested.
    expect(rows[0].collapsed).toBe(true);
    expect(rows[1].collapsed).toBe(true);
    expect(rows[1].aiSuggested).toBe(true);
  });

  it('starts the single fallback row expanded for a brand-new Listing (no initialValue)', () => {
    const rows = initialExpectedPartRows(undefined);
    expect(rows).toHaveLength(1);
    expect(rows[0].collapsed).toBe(false);
  });

  it('starts the single fallback row expanded for a Listing with no Expected Parts yet', () => {
    const rows = initialExpectedPartRows(makeListingDetail([]));
    expect(rows).toHaveLength(1);
    expect(rows[0].collapsed).toBe(false);
  });
});

describe('expectedPartsToRows row-collapsing defaults', () => {
  it('collapses an already-reviewed re-synced row and a freshly AI-identified one alike', () => {
    const rows = expectedPartsToRows([makeExpectedPart(), makeExpectedPart({ id: 'part-2', aiConfidence: 'high', aiSource: 'image' })]);

    expect(rows).toHaveLength(2);
    expect(rows[0].collapsed).toBe(true);
    expect(rows[1].collapsed).toBe(true);
  });

  it('falls back to a single expanded blank row when the re-synced set is empty', () => {
    const rows = expectedPartsToRows([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].collapsed).toBe(false);
  });
});
