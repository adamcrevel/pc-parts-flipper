import { useCallback, useEffect } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Dialog, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import { buildPhotoUrl } from '@/lib/api-client';

interface PhotoLightboxProps {
  photoPaths: string[];
  // The index into `photoPaths` currently shown full-size, or null while
  // closed. Controlled by the caller (PhotoUpload) rather than owned here,
  // the same pattern CollapsibleSection uses, so clicking a specific
  // thumbnail can open the lightbox already positioned on that photo.
  index: number | null;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}

/**
 * Full-screen viewer for a Listing's uploaded photos. Opens over whichever
 * thumbnail PhotoUpload's grid was clicked, at that photo's index, and lets
 * the viewer step backward/forward through every photo in `photoPaths`
 * without closing and reopening — Previous/Next buttons plus Left/Right
 * arrow keys, wrapping from the last photo back to the first (and vice
 * versa) rather than stopping at the edges. Built on the shared Dialog
 * primitive (Radix), which already owns focus trapping, Escape-to-close,
 * and click-outside-to-close; this component only adds the image, its own
 * close/nav chrome, and the arrow-key listener.
 */
export function PhotoLightbox({ photoPaths, index, onClose, onIndexChange }: PhotoLightboxProps) {
  const count = photoPaths.length;

  // Wraps around at both ends (count - 1 -> 0 going forward, 0 -> count - 1
  // going back) so Previous/Next and the arrow keys never need a disabled
  // edge state — every photo is always reachable in either direction.
  const goTo = useCallback(
    (nextIndex: number) => {
      if (count === 0) return;
      onIndexChange(((nextIndex % count) + count) % count);
    },
    [count, onIndexChange],
  );

  // Hooks must run on every render regardless of open state (rules of
  // hooks), so the null check lives inside the effect/callback bodies —
  // only the JSX return below is conditional.
  useEffect(() => {
    if (index === null) return;
    const openIndex = index;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'ArrowLeft') goTo(openIndex - 1);
      else if (event.key === 'ArrowRight') goTo(openIndex + 1);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [index, goTo]);

  if (index === null) return null;

  const url = buildPhotoUrl(photoPaths[index]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent
          onOpenAutoFocus={(event) => event.preventDefault()}
          onClick={onClose}
          aria-describedby={undefined}
          className="left-0 top-0 flex h-screen w-screen max-w-none translate-x-0 translate-y-0 items-center justify-center border-none bg-transparent p-0 shadow-none outline-none"
        >
          {/* Visually hidden — Radix requires an accessible Title on every DialogContent; the image itself (plus the counter below) is the visible content. */}
          <DialogTitle className="sr-only">
            Listing photo {index + 1} of {count}
          </DialogTitle>

          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            aria-label="Close"
            className="absolute right-4 top-4 rounded-full bg-background/80 p-2 text-foreground transition-colors hover:bg-background"
          >
            <X className="h-5 w-5" />
          </button>

          {count > 1 && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                goTo(index - 1);
              }}
              aria-label="Previous photo"
              className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-background/80 p-2 text-foreground transition-colors hover:bg-background"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}

          <img
            src={url}
            alt="Listing photo"
            onClick={(event) => event.stopPropagation()}
            className="max-h-[85vh] max-w-[90vw] rounded-md object-contain"
          />

          {count > 1 && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                goTo(index + 1);
              }}
              aria-label="Next photo"
              className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-background/80 p-2 text-foreground transition-colors hover:bg-background"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          )}

          {count > 1 && (
            <span className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-background/80 px-3 py-1 text-sm text-foreground">
              {index + 1} / {count}
            </span>
          )}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
