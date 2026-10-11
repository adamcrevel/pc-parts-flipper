// Type-shape consistency proof for T1's part-notes-and-unpriced-indicator
// changes: ExpectedPart.notes / ExpectedPartInput.notes (listings.ts),
// AiIdentifiedPart.notes (aiIdentification.ts), and the new
// ListingSortField 'unpriced' member / ListingSummary.hasUnpricedParts
// (listings.ts). Follows bulkIdentifyPartsTypes.test.ts's convention: these
// are pure `type`/`interface` declarations with no runtime representation
// of their own, so `vitest run`'s esbuild transform strips every type
// annotation below without checking it — a field rename here would still
// make this file *run* green. The object literals are therefore annotated
// directly against each interface (never `satisfies`), and the
// `// @ts-expect-error` cases below are checked by running
// `tsc --noEmit` against this file (this package's own `build` script
// excludes `src/**/*.test.ts`, so that check is not wired into `npm run
// build` — it must be run directly against a config that includes test
// files, same caveat bulkIdentifyPartsTypes.test.ts documents).
import { describe, expect, it } from 'vitest';
import type { AiIdentifiedPart } from './aiIdentification.js';
import type { ExpectedPart, ExpectedPartInput, ListingSortField, ListingSummary } from './listings.js';

/** Minimal valid ExpectedPart base (notes omitted), reused by each notes
 * variant below. Typed as `Omit<ExpectedPart, 'notes'>` (rather than
 * `as const`) so `identityCandidates: []` is contextually inferred as the
 * mutable `IdentityCandidate[]` the interface actually declares, not a
 * readonly tuple that would itself fail to assign. */
const baseExpectedPart: Omit<ExpectedPart, 'notes'> = {
  id: 'part-1',
  listingId: 'listing-1',
  componentCategory: 'GPU',
  brand: 'NVIDIA',
  partNumber: 'RTX 3070',
  description: 'Good condition',
  estimatedResaleValue: 250,
  identityCandidates: [],
  workingStatus: 'working',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** Minimal valid ExpectedPartInput base (notes omitted), reused by each
 * notes variant below. Same `Omit<...>` reasoning as baseExpectedPart. */
const baseExpectedPartInput: Omit<ExpectedPartInput, 'notes'> = {
  componentCategory: 'GPU',
  brand: 'NVIDIA',
  partNumber: 'RTX 3070',
  description: 'Good condition',
  estimatedResaleValue: 250,
  identityCandidates: [],
  aiConfidence: null,
  aiSource: null,
};

describe('ExpectedPart.notes (nullable, required key)', () => {
  it('accepts a non-null string note', () => {
    const part: ExpectedPart = { ...baseExpectedPart, notes: 'Buyer says this is actually the Ti variant' };
    expect(part.notes).toBe('Buyer says this is actually the Ti variant');
  });

  it('accepts null (existing rows get NULL after the DB migration, never backfilled)', () => {
    const part: ExpectedPart = { ...baseExpectedPart, notes: null };
    expect(part.notes).toBeNull();
  });

  it('rejects an object literal that omits the notes key entirely (required, unlike ExpectedPartInput.notes)', () => {
    // ExpectedPart.notes is nullable but NOT optional: the key itself must
    // be present even though its value may be null. If a future edit
    // changes `notes: string | null;` to `notes?: string | null;`, this
    // omission would stop erroring and the @ts-expect-error directive
    // below becomes "unused", which tsc reports as its own error — so this
    // case fails loudly in either direction rather than silently.
    // @ts-expect-error - ExpectedPart.notes is a required key; omitting it must fail even though its value type allows null.
    const partMissingNotesKey: ExpectedPart = { ...baseExpectedPart };
    expect(partMissingNotesKey).toBeTruthy();
  });
});

describe('ExpectedPartInput.notes (optional, nullable)', () => {
  it('accepts the key omitted entirely (backward-compatible: a client built before this feature simply omits it)', () => {
    const input: ExpectedPartInput = { ...baseExpectedPartInput };
    expect('notes' in input).toBe(false);
  });

  it('accepts an explicit null', () => {
    const input: ExpectedPartInput = { ...baseExpectedPartInput, notes: null };
    expect(input.notes).toBeNull();
  });

  it('accepts a non-null string', () => {
    const input: ExpectedPartInput = { ...baseExpectedPartInput, notes: 'Seller confirmed this is the 8GB card' };
    expect(input.notes).toBe('Seller confirmed this is the 8GB card');
  });
});

describe('AiIdentifiedPart.notes (non-nullable string)', () => {
  it('accepts an empty string (the no-corresponding-previous-note convention, Req 5)', () => {
    const part: AiIdentifiedPart = {
      category: 'GPU',
      brand: 'NVIDIA',
      partNumber: 'RTX 3070',
      description: 'Good condition',
      confidence: 'high',
      source: 'text',
      identityCandidates: [],
      notes: '',
    };
    expect(part.notes).toBe('');
  });

  it('accepts a non-empty carried-forward note', () => {
    const part: AiIdentifiedPart = {
      category: 'GPU',
      brand: 'NVIDIA',
      partNumber: 'RTX 3070',
      description: 'Good condition',
      confidence: 'high',
      source: 'text',
      identityCandidates: [],
      notes: 'Buyer says this is actually the Ti variant',
    };
    expect(part.notes).toBe('Buyer says this is actually the Ti variant');
  });

  it('rejects null (non-nullable, unlike ExpectedPart.notes/ExpectedPartInput.notes)', () => {
    // Note: a `@ts-expect-error` directive only suppresses a diagnostic
    // reported on the very next line, so the real directive below sits
    // directly above `notes: null,` itself (where tsc actually reports the
    // TS2322 mismatch), not above the whole multi-line object literal. If a
    // future edit widens `notes: string;` to `notes: string | null;`, that
    // directive stops erroring and becomes "unused", which tsc reports as
    // its own error.
    const partWithNullNotes: AiIdentifiedPart = {
      category: 'GPU',
      brand: 'NVIDIA',
      partNumber: 'RTX 3070',
      description: 'Good condition',
      confidence: 'high',
      source: 'text',
      identityCandidates: [],
      // @ts-expect-error - AiIdentifiedPart.notes is non-nullable string; null must be rejected.
      notes: null,
    };
    expect(partWithNullNotes).toBeTruthy();
  });
});

describe('ListingSortField', () => {
  it('is exactly the 8 columns the Listings table allows sorting by, including the new \'unpriced\' member', () => {
    const fields: ListingSortField[] = [
      'title',
      'source',
      'status',
      'askingPrice',
      'expectedResale',
      'difference',
      'identifyParts',
      'unpriced',
    ];
    expect(fields.slice().sort()).toEqual(
      ['askingPrice', 'difference', 'expectedResale', 'identifyParts', 'source', 'status', 'title', 'unpriced'].slice().sort()
    );
  });

  it('rejects a string literal that is not one of the 8 union members', () => {
    // @ts-expect-error - 'notarealcolumn' is not a member of ListingSortField; proves the union is closed, not just permissive of 'unpriced'.
    const invalidSortField: ListingSortField = 'notarealcolumn';
    expect(invalidSortField).toBeTruthy();
  });
});

describe('ListingSummary.hasUnpricedParts', () => {
  it('is a required, non-optional boolean (both true and false are valid, omitting the key is not)', () => {
    const unpriced: Pick<ListingSummary, 'hasUnpricedParts'> = { hasUnpricedParts: true };
    const priced: Pick<ListingSummary, 'hasUnpricedParts'> = { hasUnpricedParts: false };
    expect(unpriced.hasUnpricedParts).toBe(true);
    expect(priced.hasUnpricedParts).toBe(false);
  });

  it('rejects an object literal that omits hasUnpricedParts (required, not optional)', () => {
    // If a future edit makes this field optional (`hasUnpricedParts?:
    // boolean`), this omission stops erroring and the directive below
    // becomes "unused", which tsc reports as its own error.
    // @ts-expect-error - hasUnpricedParts is required; omitting the key entirely must fail.
    const missingField: Pick<ListingSummary, 'hasUnpricedParts'> = {};
    expect(missingField).toEqual({});
  });
});
