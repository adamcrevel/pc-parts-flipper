import { EXPECTED_PART_RESULT_OPTIONS, RESULT_LABELS, type TeardownRow, type TeardownRowErrors } from '@/features/teardown/teardown-form-state';

interface TeardownChecklistProps {
  rows: TeardownRow[];
  rowErrors: TeardownRowErrors[];
  onChange: (rows: TeardownRow[]) => void;
}

/**
 * One row per Expected Part on the originating Listing (Req 6): category,
 * description, and estimated resale value shown for reference, a result
 * selector, and a note field that becomes required (Requirement 13) once
 * 'present but different' or 'missing' is selected — enforced by the
 * caller's validateTeardownRows, not here.
 */
export function TeardownChecklist({ rows, rowErrors, onChange }: TeardownChecklistProps) {
  function updateRow(index: number, patch: Partial<TeardownRow>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">This listing had no Expected Parts recorded.</p>;
  }

  return (
    <div className="space-y-3">
      {rows.map((row, index) => {
        const errors = rowErrors[index] ?? {};
        const requiresNote = row.result === 'present_but_different' || row.result === 'missing';
        return (
          <div key={row.expectedPartId} className="space-y-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div>
                <span className="font-medium">{row.category}</span>
                <span className="text-muted-foreground"> — {row.description}</span>
              </div>
              <span className="text-muted-foreground">Est. value: ${row.estimatedResaleValue.toFixed(2)}</span>
            </div>

            <div className="space-y-1">
              <select
                value={row.result}
                onChange={(e) => updateRow(index, { result: e.target.value as TeardownRow['result'] })}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                aria-label={`${row.description} result`}
              >
                <option value="">Select result…</option>
                {EXPECTED_PART_RESULT_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {RESULT_LABELS[option]}
                  </option>
                ))}
              </select>
              {errors.result && <p className="text-xs text-destructive">{errors.result}</p>}
            </div>

            {requiresNote && (
              <div className="space-y-1">
                <textarea
                  value={row.note}
                  onChange={(e) => updateRow(index, { note: e.target.value })}
                  rows={2}
                  placeholder="Note (required)"
                  className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  aria-label={`${row.description} note`}
                />
                {errors.note && <p className="text-xs text-destructive">{errors.note}</p>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
