import type { IdentityCandidate } from '@pc-parts-flipper/shared';

interface IdentityCandidatesPickerProps {
  // The row's full set of alternate brand/partNumber pairings the model
  // considered — may include one matching the row's current brand/partNumber,
  // which this component filters out before rendering.
  candidates: IdentityCandidate[];
  brand: string;
  partNumber: string;
  // Called with the candidate the user clicked. The caller is responsible
  // for writing it into the row's brand/partNumber fields and must NOT clear
  // the row's aiSuggested flag when doing so — picking an alternate is still
  // reviewing the AI's suggestion, not a free-text edit of it.
  onPick: (candidate: IdentityCandidate) => void;
}

/**
 * Renders the alternate brand/partNumber pairings the AI considered for one
 * Expected Parts row, excluding whichever one (if any) matches the row's
 * current brand/partNumber — there is nothing to pick if it's already the
 * current value. Each remaining candidate renders as a small clickable chip;
 * clicking one calls `onPick` so the caller can apply it to the row. Renders
 * nothing when no candidates remain after filtering.
 */
export function IdentityCandidatesPicker({ candidates, brand, partNumber, onPick }: IdentityCandidatesPickerProps) {
  // Normalized (blank string reads the same as null, matching
  // IdentityCandidate's own "not identified" convention) current brand/part
  // number, so a candidate equal to the row's current value is recognized
  // regardless of which of '' and null it was typed as.
  const currentBrand = brand.trim() || null;
  const currentPartNumber = partNumber.trim() || null;
  const remaining = candidates.filter((candidate) => {
    const candidateBrand = candidate.brand?.trim() || null;
    const candidatePartNumber = candidate.partNumber?.trim() || null;
    return candidateBrand !== currentBrand || candidatePartNumber !== currentPartNumber;
  });
  if (remaining.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Also possible:</span>
      {remaining.map((candidate, index) => (
        <button
          key={index}
          type="button"
          onClick={() => onPick(candidate)}
          className="rounded-full border border-input bg-background px-2 py-0.5 text-xs hover:bg-accent"
        >
          {[candidate.brand, candidate.partNumber].filter(Boolean).join(' ') || 'Unknown'}
        </button>
      ))}
    </div>
  );
}
