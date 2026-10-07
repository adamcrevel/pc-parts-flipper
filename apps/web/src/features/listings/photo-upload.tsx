import { useRef, useState, type ChangeEvent } from 'react';
import { Upload } from 'lucide-react';
import type { ListingDetail } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError, buildPhotoUrl } from '@/lib/api-client';
import { uploadListingPhotos } from '@/features/listings/listings-api';
import { PhotoLightbox } from '@/features/listings/photo-lightbox';

interface PhotoUploadProps {
  listingId: string;
  photoPaths: string[];
  onUploaded: (updated: ListingDetail) => void;
}

/**
 * Photo upload control for an existing Listing (Req 2, assumption A4): a
 * modern file-choose button (a styled trigger for a hidden native file
 * input, so it picks up the shared Button component's light/dark theming
 * instead of the browser's own unstyled file-input chrome) that posts
 * straight to `POST /api/listings/:id/photos`, plus a grid of clickable
 * thumbnails for already-uploaded photos. Clicking a thumbnail opens
 * PhotoLightbox at that photo's index instead of navigating away, so
 * browsing every photo full-size — forward or backward — never leaves this
 * screen. Split out of listing-form.tsx to keep that file under the
 * ~200-line standing check.
 */
export function PhotoUpload({ listingId, photoPaths, onUploaded }: PhotoUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Which photo the lightbox is showing, or null while closed — see
  // PhotoLightbox's own doc comment for why this is controlled here rather
  // than owned by the lightbox itself.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  async function handleFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setUploadError(null);
    setIsUploading(true);
    try {
      const updated = await uploadListingPhotos(listingId, Array.from(files));
      onUploaded(updated);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : 'Failed to upload photo(s).');
    } finally {
      setIsUploading(false);
      // Clear the input so re-selecting the same file still fires onChange.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Photos</h3>

      {photoPaths.length === 0 && <p className="text-sm text-muted-foreground">No photos uploaded yet.</p>}
      {photoPaths.length > 0 && (
        // Each thumbnail opens PhotoLightbox at its own index, rather than
        // linking out to the full-size original in a new tab.
        <div className="flex flex-wrap gap-2">
          {photoPaths.map((path, index) => {
            const url = buildPhotoUrl(path);
            return (
              <button
                key={path}
                type="button"
                onClick={() => setLightboxIndex(index)}
                aria-label={`Open photo ${index + 1} of ${photoPaths.length}`}
                className="overflow-hidden rounded-md border border-border transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <img src={url} alt="Listing photo" className="h-20 w-20 object-cover" />
              </button>
            );
          })}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => void handleFilesSelected(e)}
        disabled={isUploading}
        className="hidden"
      />
      <Button type="button" variant="outline" size="sm" disabled={isUploading} onClick={() => fileInputRef.current?.click()}>
        <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
        Choose Photos
      </Button>
      {isUploading && <p className="text-sm text-muted-foreground">Uploading…</p>}
      {uploadError && <ErrorBanner message={uploadError} />}

      <PhotoLightbox photoPaths={photoPaths} index={lightboxIndex} onClose={() => setLightboxIndex(null)} onIndexChange={setLightboxIndex} />
    </div>
  );
}
