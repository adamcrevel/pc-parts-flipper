import { useState } from 'react';
import type { AiIdentifiedPart, ListingDetail } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/error-banner';
import { InfoBanner } from '@/components/info-banner';
import { ApiError } from '@/lib/api-client';
import { identifyListingParts } from '@/features/listings/listings-api';

interface IdentifyPartsButtonProps {
  // The saved Listing, or `undefined` while it's still unsaved (create
  // mode): there is no id to identify against yet, so the save-first hint
  // renders in place of the button. Taking the whole Listing rather than
  // `listingId: string | undefined` lets ListingForm hand its own `saved`
  // state straight over, with no `?.`/ternary of its own — one more branch in
  // a component that already measures a cyclomatic complexity of exactly 10.
  // Keeping it there is a convention this codebase watches by hand; no eslint
  // `complexity` rule enforces it.
  listing: ListingDetail | undefined;
  // Receives the parts the model proposed, in response order. The parent
  // appends them to the Expected Parts editor's existing rows — this
  // component deliberately never owns or replaces those rows.
  onIdentified: (parts: AiIdentifiedPart[]) => void;
}

/**
 * On-demand "Identify Parts" control for an existing Listing: posts to
 * `POST /api/listings/:id/identify-parts`, which runs an AI vision model
 * over the Listing's title/description and photos, then hands the suggested
 * parts back to ListingForm to append as draft rows. Owns its own
 * in-flight/notes/error state the same way PhotoUpload does, and like
 * PhotoUpload it needs a saved Listing (the route reads that Listing's
 * stored photos) — so with no id yet it renders a save-first hint instead.
 *
 * The call is genuinely slow — roughly 9s for one photo and 30s+ for
 * several — so the button stays disabled with explicit "working" copy for
 * the whole round trip rather than leaving the user with a silent wait.
 */
export function IdentifyPartsButton({ listing, onIdentified }: IdentifyPartsButtonProps) {
  const [isIdentifying, setIsIdentifying] = useState(false);
  const [identifyError, setIdentifyError] = useState<string | null>(null);
  // Free-text caveats from the model that belong to the run as a whole
  // rather than any one part (e.g. "these look like stock photos").
  // Dismissible: it is advisory, and nothing depends on it staying up.
  const [notes, setNotes] = useState<string | null>(null);

  // Takes the id as an argument rather than reading the prop, so the render
  // below can hand it over already narrowed to a string by the create-mode
  // guard — no non-null assertion needed.
  async function handleIdentify(id: string) {
    setIdentifyError(null);
    setNotes(null);
    setIsIdentifying(true);
    try {
      const response = await identifyListingParts(id);
      onIdentified(response.parts);
      // Empty notes is the normal "nothing to flag" case, not a banner.
      setNotes(response.notes.trim().length > 0 ? response.notes : null);
    } catch (err) {
      setIdentifyError(err instanceof ApiError ? err.message : 'Failed to identify parts.');
    } finally {
      setIsIdentifying(false);
    }
  }

  // Create mode: nothing exists server-side to identify against yet, so the
  // control is replaced by the same kind of save-first hint PhotoUpload's
  // gate shows. Declared after the hooks above so hook order stays stable.
  if (listing === undefined) {
    return <p className="text-sm text-muted-foreground">Save the listing to identify parts with AI.</p>;
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" size="sm" onClick={() => void handleIdentify(listing.id)} disabled={isIdentifying}>
        {isIdentifying ? 'Identifying parts…' : 'Identify Parts'}
      </Button>

      {isIdentifying && (
        <p className="text-sm text-muted-foreground">Reading the listing text and photos with AI — this can take 30 seconds or more…</p>
      )}
      {notes !== null && <InfoBanner message={notes} onDismiss={() => setNotes(null)} />}
      {identifyError && <ErrorBanner message={identifyError} />}
    </div>
  );
}
