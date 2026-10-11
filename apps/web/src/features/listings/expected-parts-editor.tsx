import type { AiPartConfidence, AiPartSource, ComponentCategory, IdentityCandidate } from '@pc-parts-flipper/shared';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CollapsibleSection } from '@/components/ui/collapsible';
import { AiSuggestedBadge } from '@/features/listings/ai-suggested-badge';
import { IdentityCandidatesPicker } from '@/features/listings/identity-candidates-picker';

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
  // Manufacturer/brand (e.g. 'NVIDIA', 'Corsair'). Optional: left blank
  // whenever the part hasn't been identified that far, never guessed — a
  // blank here becomes `null` in the request payload, not placeholder text.
  brand: string;
  // Manufacturer part/model number (e.g. 'RTX 3070', 'RM750'). Same
  // optional-and-never-guessed rule as `brand`.
  partNumber: string;
  description: string;
  // Free-text per-part notes (Req 1), separate from `description` which
  // holds condition notes shown alongside the AI badge. Round-trips
  // through listing-form-state.ts's expectedPartToRow and
  // listing-form.tsx's persistListing, same treatment as description.
  notes: string;
  estimatedResaleValue: string;
  // Client-only draft state, never part of CreateListingInput/
  // UpdateListingInput: true while this row is an unreviewed AI suggestion
  // from `POST /api/listings/:id/identify-parts`. Cleared by updateRow on
  // the user's first edit of the row — editing a suggestion is reviewing
  // it. listing-form.tsx builds its ExpectedPartInput payload field by
  // field, so this and the two below never reach the backend.
  aiSuggested?: boolean;
  // Who owns this row's estimatedResaleValue — three-state (assumption
  // A22, correcting A8). Undefined means *undecided*: nobody has claimed
  // the price, so the server may claim it for the background pipeline the
  // first time the row is fully identified. 'auto' means the server is
  // still allowed to overwrite this row's price when the shared cache
  // refreshes (Req 14). 'manual' means the user has taken it over —
  // updateRow below flips 'auto' to 'manual' the instant the user edits
  // the row (Req 15), rather than merely clearing it, because a cleared
  // value would read as undecided and be re-claimed on the next save.
  // Round-trips through listing-form-state.ts's expectedPartToRow and
  // listing-form.tsx's persistListing — never guessed client-side.
  priceSource?: 'auto' | 'manual';
  // The working/non-working status of this component. Round-trips through
  // listing-form-state.ts's expectedPartToRow and listing-form.tsx's persistListing.
  workingStatus?: 'working' | 'non_working';
  // How sure the model was, and whether it read the listing text, the
  // photos, or both. Shown as a caption beside the badge so that
  // provenance doesn't have to pollute `description`, which is the value
  // actually saved.
  aiConfidence?: AiPartConfidence;
  aiSource?: AiPartSource;
  // Alternate brand/partNumber pairings the AI considered but did not pick
  // as primary (T1); always [] for rows never produced by AI
  // identification. Rendered via IdentityCandidatesPicker when non-empty.
  identityCandidates: IdentityCandidate[];
  // Whether this row is showing only its compact identification summary
  // (category/brand/part number/estimated value) or its full fields
  // (description, AI badge, identity candidates). Purely a draft-state UI
  // toggle — never sent to the backend, same treatment as aiSuggested/
  // aiConfidence/aiSource above. Optional so a row built without it (e.g.
  // directly in a test) behaves as expanded via `!row.collapsed`, matching
  // a brand-new "Add Part" row.
  collapsed?: boolean;
}

/** Per-row field errors, keyed the same way ListingForm's other field errors are. */
export interface ExpectedPartRowErrors {
  componentCategory?: string;
  description?: string;
  estimatedResaleValue?: string;
}

/** An empty draft row, used both for the initial row and "Add Part". */
export function emptyExpectedPartRow(): ExpectedPartRow {
  return { componentCategory: '', brand: '', partNumber: '', description: '', estimatedResaleValue: '', notes: '', identityCandidates: [], collapsed: false };
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
  // Whether the listing has nonWorking status, gating visibility of
  // the per-row working-status control.
  listingNonWorking?: boolean;
  // Whether this editor is for an existing (already-created) Listing
  // rather than a brand-new one (Req 13). Gates the "not priced" row
  // highlight below: an unpriced row is expected and unremarkable while
  // still drafting a new listing, but worth flagging once the listing is
  // saved and the user may be reviewing/finishing it later.
  isExistingListing?: boolean;
}

/**
 * Repeatable Expected Parts editor (Req 2): add/remove rows, each with a
 * category select, free-text description/model, and estimated resale value.
 * Split out of listing-form.tsx to keep that file under the ~200-line
 * standing check and because this row-editing logic is self-contained.
 */
export function ExpectedPartsEditor({ rows, rowErrors, onChange, listingNonWorking, isExistingListing }: ExpectedPartsEditorProps) {
  // Two independent triggers claim this row's price for the user, so the
  // server can tell "never claimed" apart from "typed then cleared":
  // directly editing the price field itself — typed into OR cleared —
  // always claims 'manual', regardless of the row's prior priceSource,
  // because a cleared price would otherwise look identical to an
  // undecided one and get silently re-claimed (and re-filled from the
  // shared cache) on the very next save; and touching ANY other field on
  // a row that was already 'auto' also hands that row to the user (Req
  // 15), since the server was actively managing its price. A row that is
  // still undecided and only has a non-price field touched stays
  // undecided — it has no price to protect yet.
  function updateRow(index: number, patch: Partial<ExpectedPartRow>) {
    onChange(
      rows.map((row, i) =>
        i === index
          ? { ...row, ...patch, aiSuggested: false, priceSource: 'estimatedResaleValue' in patch || row.priceSource === 'auto' ? 'manual' : row.priceSource }
          : row,
      ),
    );
  }

  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }

  // Applies a picked IdentityCandidate's brand/partNumber to the row
  // without clearing aiSuggested — unlike updateRow, picking an alternate
  // the AI itself proposed is still reviewing its suggestion, not a
  // free-text edit of it.
  function pickIdentityCandidate(index: number, candidate: IdentityCandidate) {
    onChange(rows.map((row, i) => (i === index ? { ...row, brand: candidate.brand ?? '', partNumber: candidate.partNumber ?? '' } : row)));
  }

  // Flips only this row's collapsed flag — deliberately separate from
  // updateRow, which also clears aiSuggested on the theory that any edit
  // is the user reviewing a suggestion. Collapsing/expanding a row isn't
  // reviewing anything, so this must never touch aiSuggested or any other
  // field.
  function toggleRowCollapsed(index: number) {
    onChange(rows.map((row, i) => (i === index ? { ...row, collapsed: !row.collapsed } : row)));
  }

  // Handles working-status control selection: sets workingStatus and, if the
  // row's price is not manually-claimed, resets it to undecided (clearing
  // estimatedResaleValue and priceSource). Unlike updateRow's
  // "any edit claims manual ownership" behavior, changing working status is
  // the inverse: a price reset on condition change. If the user has already
  // manually set this row's price, touching the status doesn't re-reset it
  // — they've taken ownership. Re-clicking the already-active status is a
  // no-op — the status hasn't actually changed, so a real already-researched
  // price must not be cleared.
  function updateWorkingStatus(index: number, newStatus: 'working' | 'non_working') {
    if (rows[index].workingStatus === newStatus) return;
    onChange(
      rows.map((row, i) =>
        i === index
          ? {
              ...row,
              workingStatus: newStatus,
              // Preserve manually-set prices; reset auto/undecided prices
              ...(row.priceSource === 'manual'
                ? {}
                : { estimatedResaleValue: '', priceSource: undefined }),
            }
          : row,
      ),
    );
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
        const rowHasError = Boolean(errors.componentCategory || errors.description || errors.estimatedResaleValue);
        // Req 13: flags a row with no estimated resale value yet, but only
        // once the listing itself already exists — an unpriced row on a
        // brand-new, not-yet-saved listing is just the normal unfilled
        // starting state, not something worth highlighting.
        const rowUnpriced = Boolean(isExistingListing) && row.estimatedResaleValue.trim() === '';
        return (
          <div key={index} className="space-y-1">
            <CollapsibleSection
              open={!row.collapsed}
              onOpenChange={() => toggleRowCollapsed(index)}
              trigger={
                // Category/brand/part number/estimated value live in the
                // trigger, not CollapsibleContent below, specifically so a
                // collapsed row never unmounts them — CollapsibleContent
                // unmounts its children while closed (collapsible.tsx), which
                // would otherwise make a collapsed row's own identification
                // fields unreachable without first expanding it. stopPropagation
                // keeps clicking/typing in them from also toggling the row —
                // only the chevron (outside this div) does that.
                <div className="flex flex-1 flex-wrap items-start gap-2" onClick={(e) => e.stopPropagation()}>
                  {rowHasError && <AlertCircle className="mt-2 h-4 w-4 shrink-0 text-destructive" aria-label={`Expected part ${index + 1} has an error`} />}
                  {rowUnpriced && <AlertCircle className="mt-2 h-4 w-4 shrink-0 text-destructive" aria-label={`Expected part ${index + 1} is not priced`} />}
                  <div className="space-y-1">
                    <select
                      value={row.componentCategory}
                      onChange={(e) => updateRow(index, { componentCategory: e.target.value as ComponentCategory })}
                      className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
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

                  <input
                    value={row.brand}
                    onChange={(e) => updateRow(index, { brand: e.target.value })}
                    placeholder="Brand (optional)"
                    className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                    aria-label={`Expected part ${index + 1} brand`}
                  />

                  <input
                    value={row.partNumber}
                    onChange={(e) => updateRow(index, { partNumber: e.target.value })}
                    placeholder="Part/Model # (optional)"
                    className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                    aria-label={`Expected part ${index + 1} part number`}
                  />

                  <div className="space-y-1">
                    <input
                      type="number"
                      step="0.01"
                      value={row.estimatedResaleValue}
                      onChange={(e) => updateRow(index, { estimatedResaleValue: e.target.value })}
                      placeholder="Est. value"
                      className="w-24 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                      aria-label={`Expected part ${index + 1} estimated resale value`}
                    />
                    {errors.estimatedResaleValue && <p className="text-xs text-destructive">{errors.estimatedResaleValue}</p>}
                  </div>
                </div>
              }
            >
              <div className="space-y-2">
                {row.aiSuggested === true && (
                  <div className="flex items-center gap-2">
                    <AiSuggestedBadge />
                    <span className="text-xs text-muted-foreground">{aiProvenanceCaption(row)}</span>
                  </div>
                )}

                {row.identityCandidates.length > 0 && (
                  <IdentityCandidatesPicker candidates={row.identityCandidates} brand={row.brand} partNumber={row.partNumber} onPick={(candidate) => pickIdentityCandidate(index, candidate)} />
                )}

                {listingNonWorking && (
                  <div className="space-y-1">
                    <label className="block text-sm font-medium">Working Status</label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => updateWorkingStatus(index, 'working')}
                        className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                          row.workingStatus === 'working'
                            ? 'bg-emerald-600 text-white'
                            : 'border border-input bg-background text-foreground hover:bg-muted'
                        }`}
                        aria-pressed={row.workingStatus === 'working'}
                      >
                        Working
                      </button>
                      <button
                        type="button"
                        onClick={() => updateWorkingStatus(index, 'non_working')}
                        className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                          row.workingStatus === 'non_working'
                            ? 'bg-amber-600 text-white'
                            : 'border border-input bg-background text-foreground hover:bg-muted'
                        }`}
                        aria-pressed={row.workingStatus === 'non_working'}
                      >
                        Not Working
                      </button>
                    </div>
                  </div>
                )}

                <div className="space-y-1">
                  <input
                    value={row.description}
                    onChange={(e) => updateRow(index, { description: e.target.value })}
                    placeholder="Description / condition notes"
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                    aria-label={`Expected part ${index + 1} description`}
                  />
                  {errors.description && <p className="text-xs text-destructive">{errors.description}</p>}
                </div>

                <div className="space-y-1">
                  <input
                    value={row.notes}
                    onChange={(e) => updateRow(index, { notes: e.target.value })}
                    placeholder="Notes"
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                    aria-label={`Expected part ${index + 1} notes`}
                  />
                </div>
              </div>
            </CollapsibleSection>

            <div className="flex justify-end">
              <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => removeRow(index)}>
                Remove
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
