import type { ComponentCategory } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { emptyAdditionalPartRow, type AdditionalPartRow, type AdditionalPartRowErrors } from '@/features/teardown/teardown-form-state';

// The fixed category list (assumption A8), matching expected-parts-editor.tsx's own CATEGORY_OPTIONS.
const CATEGORY_OPTIONS: readonly ComponentCategory[] = ['CPU', 'GPU', 'Motherboard', 'RAM', 'Storage', 'PSU', 'Case', 'Cooler', 'Other'];

interface AdditionalPartsEditorProps {
  rows: AdditionalPartRow[];
  rowErrors: AdditionalPartRowErrors[];
  onChange: (rows: AdditionalPartRow[]) => void;
}

/**
 * Repeatable "Additional Parts found" editor (Req 6): add/remove rows for
 * parts recovered during teardown that weren't on the originating Listing —
 * category select, free-text description, and an optional note. Mirrors
 * apps/web/src/features/listings/expected-parts-editor.tsx's row-editing
 * shape.
 */
export function AdditionalPartsEditor({ rows, rowErrors, onChange }: AdditionalPartsEditorProps) {
  function updateRow(index: number, patch: Partial<AdditionalPartRow>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, emptyAdditionalPartRow()])}>
          Add Part
        </Button>
      </div>

      {rows.length === 0 && <p className="text-sm text-muted-foreground">No additional parts found. Add one if the teardown turned up something unexpected.</p>}

      {rows.map((row, index) => {
        const errors = rowErrors[index] ?? {};
        return (
          <div key={index} className="grid grid-cols-[1fr_2fr_2fr_auto] items-start gap-2 rounded-md border border-border p-2">
            <div className="space-y-1">
              <select
                value={row.category}
                onChange={(e) => updateRow(index, { category: e.target.value as ComponentCategory })}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                aria-label={`Additional part ${index + 1} category`}
              >
                <option value="">Category…</option>
                {CATEGORY_OPTIONS.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
              {errors.category && <p className="text-xs text-destructive">{errors.category}</p>}
            </div>

            <div className="space-y-1">
              <input
                value={row.description}
                onChange={(e) => updateRow(index, { description: e.target.value })}
                placeholder="Description / model"
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                aria-label={`Additional part ${index + 1} description`}
              />
              {errors.description && <p className="text-xs text-destructive">{errors.description}</p>}
            </div>

            <input
              value={row.note}
              onChange={(e) => updateRow(index, { note: e.target.value })}
              placeholder="Note (optional)"
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              aria-label={`Additional part ${index + 1} note`}
            />

            <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => removeRow(index)}>
              Remove
            </Button>
          </div>
        );
      })}
    </div>
  );
}
