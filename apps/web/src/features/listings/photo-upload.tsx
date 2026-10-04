import { useRef, useState, type ChangeEvent } from 'react';
import type { ListingDetail } from '@pc-parts-flipper/shared';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError, buildPhotoUrl } from '@/lib/api-client';
import { uploadListingPhotos } from '@/features/listings/listings-api';

interface PhotoUploadProps {
  listingId: string;
  photoPaths: string[];
  onUploaded: (updated: ListingDetail) => void;
}

/**
 * Photo upload control for an existing Listing (Req 2, assumption A4):
 * a file input that posts straight to `POST /api/listings/:id/photos`
 * (uploads require a Listing id, so this only renders once one exists —
 * ListingForm shows a disabled hint instead while still in create mode),
 * plus a grid of clickable thumbnails for already-uploaded photos (each
 * opens the full-size original in a new tab). Split out of
 * listing-form.tsx to keep that file under the ~200-line standing check.
 */
export function PhotoUpload({ listingId, photoPaths, onUploaded }: PhotoUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
        // Each thumbnail links out to the full-size original in a new tab —
        // same `<a target="_blank" rel="noreferrer">` idiom as
        // ebay-scan-badge.tsx's outbound link, rather than a custom
        // lightbox/modal (none exists elsewhere in this app).
        <div className="flex flex-wrap gap-2">
          {photoPaths.map((path) => {
            const url = buildPhotoUrl(path);
            return (
              <a key={path} href={url} target="_blank" rel="noreferrer">
                <img src={url} alt="Listing photo" className="h-20 w-20 rounded-md border border-border object-cover" />
              </a>
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
        className="text-sm"
      />
      {isUploading && <p className="text-sm text-muted-foreground">Uploading…</p>}
      {uploadError && <ErrorBanner message={uploadError} />}
    </div>
  );
}
