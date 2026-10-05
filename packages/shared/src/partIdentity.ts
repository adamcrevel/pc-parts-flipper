// The one place the structured identity of a component — `brand` plus
// `partNumber` — is turned into the single string users read. Lives in
// packages/shared because both apps need it: apps/web renders it on the
// Parts list, the teardown checklist, the Purchase's Expected Parts table
// and the Record Sale screen, while apps/server uses it to derive a Sale
// Listing's default title. Before this module the same filter-blank-then-join
// was hand-written at each call site, which is exactly how two of them
// drifted into rendering only `description`.

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
