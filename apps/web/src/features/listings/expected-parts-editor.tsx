import type { AiPartConfidence, AiPartSource, ComponentCategory } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { AiSuggestedBadge } from '@/features/listings/ai-suggested-badge';

// The fixed category list (assumption A8) the <select> below renders.
const CATEGORY_OPTIONS: readonly ComponentCategory[] = ['CPU', 'GPU', 'Motherboard', 'RAM', 'Storage', 'PSU', 'Case', 'Cooler', 'Other'];

/**
 * One row's draft state in the editor. Values are kept as strings (not
 * ComponentCategory/number) while editing so an empty/invalid entry can be
 * rendered and validated before being coerced — matching ListingForm's own
 * string-state-until-submit convention.
 */
export interface ExpectedPartRow {
  componentCategory: ComponentCategory | '';
  description: string;
  estimatedResaleValue: string;
  // Client-only draft state, never part of CreateListingInput/
  // UpdateListingInput: true while this row is an unreviewed AI suggestion
  // from `POST /api/listings/:id/identify-parts`. Cleared by updateRow on
  // the user's first edit of the row — editing a suggestion is reviewing
  // it. listing-form.tsx builds its ExpectedPartInput payload field by
  // field, so this and the two below never reach the backend.
  aiSuggested?: boolean;
  // How sure the model was, and whether it read the listing text, the
  // photos, or both. Shown as a caption beside the badge so that
  // provenance doesn't have to pollute `description`, which is the value
  // actually saved.
  aiConfidence?: AiPartConfidence;
  aiSource?: AiPartSource;
}

/** Per-row field errors, keyed the same way ListingForm's other field errors are. */
export interface ExpectedPartRowErrors {
  componentCategory?: string;
  description?: string;
  estimatedResaleValue?: string;
}

/** An empty draft row, used both for the initial row and "Add Part". */
export function emptyExpectedPartRow(): ExpectedPartRow {
  return { componentCategory: '', description: '', estimatedResaleValue: '' };
}

/** Human-readable wording for which evidence the model drew a suggestion from. */
const AI_SOURCE_LABELS: Record<AiPartSource, string> = {
  text: 'the listing text',
  image: 'the photos',
  both: 'the listing text and photos',
};

/** The provenance caption shown beside the "AI suggested" badge, or '' for a row carrying no provenance. */
function aiProvenanceCaption(row: ExpectedPartRow): string {
  if (!row.aiConfidence || !row.aiSource) return '';
  return `${row.aiConfidence} confidence · from ${AI_SOURCE_LABELS[row.aiSource]}`;
}

interface ExpectedPartsEditorProps {
  rows: ExpectedPartRow[];
  rowErrors: ExpectedPartRowErrors[];
  onChange: (rows: ExpectedPartRow[]) => void;
}

/**
 * Repeatable Expected Parts editor (Req 2): add/remove rows, each with a
 * category select, free-text description/model, and estimated resale value.
 * Split out of listing-form.tsx to keep that file under the ~200-line
 * standing check and because this row-editing logic is self-contained.
 */
export function ExpectedPartsEditor({ rows, rowErrors, onChange }: ExpectedPartsEditorProps) {
  // Any edit to a row also clears its AI-suggested draft marking: reviewing
  // the model's guess is exactly what the badge asks the user to do, so
  // touching the row is that confirmation (product decision, confirmed with
  // the user). A no-op on rows that were never AI-suggested.
  function updateRow(index: number, patch: Partial<ExpectedPartRow>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch, aiSuggested: false } : row)));
  }

  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Expected Parts</h3>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, emptyExpectedPartRow()])}>
          Add Part
        </Button>
      </div>

      {rows.length === 0 && <p className="text-sm text-muted-foreground">No expected parts yet. Add one below.</p>}

      {rows.map((row, index) => {
        const errors = rowErrors[index] ?? {};
        return (
          <div key={index} className="grid grid-cols-[1fr_2fr_1fr_auto] items-start gap-2 rounded-md border border-border p-2">
            {/* Full-width first grid item (col-span-4) so the badge sits above the row's fields rather than stealing a column from them. */}
            {row.aiSuggested === true && (
              <div className="col-span-4 flex items-center gap-2">
                <AiSuggestedBadge />
                <span className="text-xs text-muted-foreground">{aiProvenanceCaption(row)}</span>
              </div>
            )}
            <div className="space-y-1">
              <select
                value={row.componentCategory}
                onChange={(e) => updateRow(index, { componentCategory: e.target.value as ComponentCategory })}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                aria-label={`Expected part ${index + 1} category`}
              >
                <option value="">Category…</option>
                {CATEGORY_OPTIONS.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
              {errors.componentCategory && <p className="text-xs text-destructive">{errors.componentCategory}</p>}
            </div>

            <div className="space-y-1">
              <input
                value={row.description}
                onChange={(e) => updateRow(index, { description: e.target.value })}
                placeholder="Description / model"
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                aria-label={`Expected part ${index + 1} description`}
              />
              {errors.description && <p className="text-xs text-destructive">{errors.description}</p>}
            </div>

            <div className="space-y-1">
              <input
                type="number"
                step="0.01"
                value={row.estimatedResaleValue}
                onChange={(e) => updateRow(index, { estimatedResaleValue: e.target.value })}
                placeholder="Est. value"
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                aria-label={`Expected part ${index + 1} estimated resale value`}
              />
              {errors.estimatedResaleValue && <p className="text-xs text-destructive">{errors.estimatedResaleValue}</p>}
            </div>

            <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => removeRow(index)}>
              Remove
            </Button>
          </div>
        );
      })}
    </div>
  );
}
