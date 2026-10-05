// The one place the structured identity of a component — `brand` plus
// `partNumber` — is turned into the single string users read. Lives in
// packages/shared because both apps need it: apps/web renders it on the
// Parts list, the teardown checklist, the Purchase's Expected Parts table
// and the Record Sale screen, while apps/server uses it to derive a Sale
// Listing's default title. Before this module the same filter-blank-then-join
// was hand-written at each call site, which is exactly how two of them
// drifted into rendering only `description`.
import type { IdentityCandidate } from './aiIdentification.js';

/**
 * Joins a component's brand and part number into the identity string a user
 * reads (e.g. "NVIDIA RTX 3070"), or either half alone when only one was
 * identified.
 *
 * Both fields are nullable by design — they are never guessed or defaulted at
 * identification or teardown time — so this returns an empty string when
 * neither is known. Callers decide what that means for their screen: a '—'
 * placeholder in a table cell, or a fallback to the free-text `description`.
 * Blank-but-not-null values are treated as absent too: the validation layer
 * normalizes those away, but a row written before this feature (or by another
 * caller) can still hold an empty string.
 */
export function formatPartIdentity(brand: string | null, partNumber: string | null): string {
  return [brand, partNumber]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .join(' ');
}

/**
 * Renders the alternate brand/partNumber pairings the AI identification
 * considered but did not pick as primary (`AiIdentifiedPart.identityCandidates`,
 * carried through to `ExpectedPart`/`Part`) into a short "or ..." suffix the
 * UI can append after the primary identity string — e.g.
 * "or NVIDIA RTX 3070, NVIDIA RTX 3080". The candidate exactly matching the
 * primary `brand`/`partNumber` pair is dropped, since it is already shown as
 * the primary identification and would otherwise read as a pointless
 * duplicate; any candidate left fully blank after formatting is dropped too.
 * Returns '' when nothing is left to show, so callers can render
 * conditionally without an extra emptiness check of their own.
 */
export function formatIdentityCandidates(
  candidates: IdentityCandidate[],
  primaryBrand: string | null,
  primaryPartNumber: string | null
): string {
  const rendered = candidates
    // Drop the candidate that's just a repeat of the primary identification.
    .filter((candidate) => candidate.brand !== primaryBrand || candidate.partNumber !== primaryPartNumber)
    .map((candidate) => formatPartIdentity(candidate.brand, candidate.partNumber))
    .filter((text) => text.length > 0);

  return rendered.length > 0 ? `or ${rendered.join(', ')}` : '';
}
