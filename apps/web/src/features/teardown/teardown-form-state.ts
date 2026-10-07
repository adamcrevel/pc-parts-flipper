import type { ComponentCategory, ExpectedPart, IdentityCandidate, SubmitTeardownInput, TeardownExpectedPartResultInput } from '@pc-parts-flipper/shared';

/** The result options a user may pick per Expected Part row (Req 6); 'additional' is never offered here — it's reserved for rows the user adds separately below. */
export const EXPECTED_PART_RESULT_OPTIONS: readonly TeardownExpectedPartResultInput['result'][] = ['present_as_expected', 'present_but_different', 'missing'];
export const RESULT_LABELS: Record<TeardownExpectedPartResultInput['result'], string> = {
  present_as_expected: 'Present as expected',
  present_but_different: 'Present but different',
  missing: 'Missing',
};

/**
 * One Expected Part checklist row's draft state. `result` stays '' until the
 * user picks one, so an unanswered row is distinguishable from a real choice.
 *
 * `brand`/`partNumber` are carried through read-only, purely so the checklist
 * can show *which* part a row is about ("NVIDIA RTX 3070") rather than only
 * its free-text condition notes — they are never edited here and never sent
 * back, since a teardown reconciles Expected Parts rather than re-identifying
 * them. Both stay nullable: neither is ever guessed or defaulted.
 */
export interface TeardownRow {
  expectedPartId: string;
  category: ComponentCategory;
  brand: string | null;
  partNumber: string | null;
  description: string;
  estimatedResaleValue: number | null;
  identityCandidates: IdentityCandidate[];
  result: TeardownExpectedPartResultInput['result'] | '';
  note: string;
}

/** Per-row field errors, keyed the same way ExpectedPartsEditor's are. */
export interface TeardownRowErrors {
  result?: string;
  note?: string;
}

/** Builds the checklist's initial rows from the Expected Parts the GET /api/purchases/:id/teardown endpoint returned — one unanswered row per Expected Part, in listing order. */
export function initialTeardownRows(expectedParts: ExpectedPart[]): TeardownRow[] {
  return expectedParts.map((part) => ({
    expectedPartId: part.id,
    category: part.componentCategory,
    brand: part.brand,
    partNumber: part.partNumber,
    description: part.description,
    estimatedResaleValue: part.estimatedResaleValue,
    identityCandidates: part.identityCandidates,
    result: '',
    note: '',
  }));
}

/**
 * One Additional Part draft row — a part found during teardown that wasn't
 * on the originating Listing. `brand`/`partNumber` mirror the Expected Parts
 * editor's: strings while editing, optional, and sent as null (never
 * guessed or defaulted) when left blank.
 */
export interface AdditionalPartRow {
  category: ComponentCategory | '';
  brand: string;
  partNumber: string;
  description: string;
  note: string;
}

/** Per-row field errors for the Additional Parts section. */
export interface AdditionalPartRowErrors {
  category?: string;
  description?: string;
}

/** An empty draft Additional Part row, used both for the initial state and "Add Part". */
export function emptyAdditionalPartRow(): AdditionalPartRow {
  return { category: '', brand: '', partNumber: '', description: '', note: '' };
}

/** Builds the POST /api/purchases/:id/teardown request body from validated checklist + additional-part rows. Callers must validate first — this does not re-check required fields. */
export function buildSubmitTeardownInput(rows: TeardownRow[], additionalRows: AdditionalPartRow[]): SubmitTeardownInput {
  return {
    results: rows.map((row) => ({
      expectedPartId: row.expectedPartId,
      result: row.result as TeardownExpectedPartResultInput['result'],
      note: row.note.trim().length > 0 ? row.note.trim() : null,
    })),
    // Built field by field, so client-only row state can never leak into
    // the request body; blank brand/part number send as null.
    additionalParts: additionalRows.map((row) => ({
      category: row.category as ComponentCategory,
      brand: row.brand.trim() || null,
      partNumber: row.partNumber.trim() || null,
      description: row.description.trim(),
      note: row.note.trim().length > 0 ? row.note.trim() : null,
    })),
  };
}
