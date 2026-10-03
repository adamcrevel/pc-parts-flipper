import type { AdditionalPartRow, AdditionalPartRowErrors, TeardownRow, TeardownRowErrors } from '@/features/teardown/teardown-form-state';

// Field-level validation messages for the teardown checklist, mirroring the
// backend's own checks (apps/server/src/routes/teardownValidation.ts) so
// inline errors (Requirement 13) appear without a round trip wherever
// feasible, while the backend remains the source of truth.

/**
 * Validates every Expected Part checklist row: a result is always required,
 * and a non-blank note is additionally required (Requirement 13) when the
 * chosen result is `present_but_different` or `missing`.
 */
export function validateTeardownRows(rows: TeardownRow[]): TeardownRowErrors[] {
  return rows.map((row) => {
    const errors: TeardownRowErrors = {};
    if (row.result === '') {
      errors.result = 'A result is required.';
    } else if ((row.result === 'present_but_different' || row.result === 'missing') && row.note.trim().length === 0) {
      errors.note = `A note is required when marking a part '${row.result === 'missing' ? 'missing' : 'present but different'}'.`;
    }
    return errors;
  });
}

/** Validates every Additional Part row: category and description are required; note stays optional. */
export function validateAdditionalPartRows(rows: AdditionalPartRow[]): AdditionalPartRowErrors[] {
  return rows.map((row) => {
    const errors: AdditionalPartRowErrors = {};
    if (row.category === '') errors.category = 'Category is required.';
    if (row.description.trim().length === 0) errors.description = 'Description is required.';
    return errors;
  });
}
