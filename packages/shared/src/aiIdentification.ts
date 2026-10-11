// Response types for AI-assisted Expected Part identification: the shapes
// `POST /api/listings/:id/identify-parts` returns, consumed by apps/server's
// route handler and apps/web's Expected Parts editor (which renders them as
// clearly-marked, freely-editable draft rows that are never auto-saved).
// Lives here (not apps/server) because apps/web may never import apps/server
// directly (standing check).
import type { ComponentCategory } from './listings.js';

/**
 * How sure the model is about one suggested part. Deliberately a coarse
 * three-way scale rather than a numeric score: the model is instructed to be
 * honest and conservative when a part cannot be fully narrowed down, and a
 * word is a more faithful rendering of that than a false-precision number.
 */
export type AiPartConfidence = 'high' | 'medium' | 'low';

/**
 * What the model based a suggestion on — the listing's title/description
 * ('text'), one of its photos ('image'), or agreement between the two
 * ('both') — so the user can tell a part read off a spec list apart from one
 * recognized in a photo when deciding whether to keep the suggested row.
 */
export type AiPartSource = 'text' | 'image' | 'both';

/**
 * The model's assessment of whether one specific part is working or broken,
 * when the listing is marked as a whole as non-working. "working" means the
 * text specifically clears this part or names a different part as broken.
 * "non_working" means the text says or clearly implies this specific part
 * doesn't work. "unclear" means the text gives no clear signal for this part.
 */
export type AiPartWorkingStatus = 'working' | 'non_working' | 'unclear';

/**
 * One alternate brand/partNumber pairing the model considered plausible but
 * did not pick as the primary identification — e.g. when a GPU's exact SKU
 * within a product line can't be pinned down from the listing. Carried
 * alongside the primary `brand`/`partNumber` on `AiIdentifiedPart` so the UI
 * can show "or NVIDIA RTX 3070, NVIDIA RTX 3080" without a second AI call.
 */
export interface IdentityCandidate {
  brand: string | null;
  partNumber: string | null;
}

/**
 * One AI-suggested Expected Part. `category` is always one of the project's
 * fixed ComponentCategory values (the server coerces anything else to
 * 'Other'), so a suggestion can drop straight into the Expected Parts editor's
 * category select without a second mapping step.
 *
 * `brand` and `partNumber` are the component's structured identity; the model
 * is instructed to return null for either it cannot support from the listing
 * text or photos, so a null here means "not identified", never "no brand".
 * `description` carries only what brand/partNumber do not — condition and
 * notable details — rather than restating them in prose. `identityCandidates`
 * holds other plausible brand/partNumber pairings the model considered but
 * did not settle on as primary (may be empty when the model was confident or
 * found no alternatives).
 *
 * `workingStatus` (optional, only populated when the listing is marked
 * non-working) reflects the model's assessment of whether this specific part
 * is working or non-working, as one of the values in AiPartWorkingStatus.
 */
export interface AiIdentifiedPart {
  category: ComponentCategory;
  brand: string | null;
  partNumber: string | null;
  description: string;
  confidence: AiPartConfidence;
  source: AiPartSource;
  identityCandidates: IdentityCandidate[];
  workingStatus?: AiPartWorkingStatus;
  /** Per-part notes (non-nullable, empty string if none). Distinct from IdentifyPartsResponse.notes (response-level caveats for the whole identification). */
  notes: string;
}

/**
 * `POST /api/listings/:id/identify-parts` response. `notes` is free text
 * (possibly empty) for caveats that belong to the identification as a whole
 * rather than to one part — e.g. "these look like stock/marketing photos,
 * not the actual item", which the model volunteers when it is true.
 */
export interface IdentifyPartsResponse {
  parts: AiIdentifiedPart[];
  notes: string;
}
