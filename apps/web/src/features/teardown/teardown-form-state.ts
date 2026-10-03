import type { ComponentCategory, ExpectedPart, SubmitTeardownInput, TeardownExpectedPartResultInput } from '@pc-parts-flipper/shared';

/** The result options a user may pick per Expected Part row (Req 6); 'additional' is never offered here — it's reserved for rows the user adds separately below. */
export const EXPECTED_PART_RESULT_OPTIONS: readonly TeardownExpectedPartResultInput['result'][] = ['present_as_expected', 'present_but_different', 'missing'];
export const RESULT_LABELS: Record<TeardownExpectedPartResultInput['result'], string> = {
  present_as_expected: 'Present as expected',
  present_but_different: 'Present but different',
  missing: 'Missing',
};

/** One Expected Part checklist row's draft state. `result` stays '' until the user picks one, so an unanswered row is distinguishable from a real choice. */
export interface TeardownRow {
  expectedPartId: string;
  category: ComponentCategory;
  description: string;
  estimatedResaleValue: number;
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
    description: part.description,
    estimatedResaleValue: part.estimatedResaleValue,
    result: '',
    note: '',
  }));
}

/** One Additional Part draft row — a part found during teardown that wasn't on the originating Listing. */
export interface AdditionalPartRow {
  category: ComponentCategory | '';
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
  return { category: '', description: '', note: '' };
}

/** Builds the POST /api/purchases/:id/teardown request body from validated checklist + additional-part rows. Callers must validate first — this does not re-check required fields. */
export function buildSubmitTeardownInput(rows: TeardownRow[], additionalRows: AdditionalPartRow[]): SubmitTeardownInput {
  return {
    results: rows.map((row) => ({
      expectedPartId: row.expectedPartId,
      result: row.result as TeardownExpectedPartResultInput['result'],
      note: row.note.trim().length > 0 ? row.note.trim() : null,
    })),
    additionalParts: additionalRows.map((row) => ({
      category: row.category as ComponentCategory,
      description: row.description.trim(),
      note: row.note.trim().length > 0 ? row.note.trim() : null,
    })),
  };
}
