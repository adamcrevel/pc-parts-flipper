// @vitest-environment jsdom
//
// Proof for PhotoUpload's thumbnail grid and lightbox (photo-upload.tsx,
// photo-lightbox.tsx): clicking a thumbnail opens PhotoLightbox positioned
// on that photo rather than navigating to it in a new tab, and the lightbox
// lets the viewer step backward/forward through every photo — via its
// Previous/Next buttons and via the Left/Right arrow keys — wrapping at
// both ends. Also pins the empty state and the "Choose Photos" trigger for
// the (hidden) native file input. Mounts the real component with
// react-dom/client + act(), following ebay-scan-ui.test.tsx's pattern (no
// React Testing Library in this workspace).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { PhotoUpload } from '../src/features/listings/photo-upload';
import { PhotoLightbox } from '../src/features/listings/photo-lightbox';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container); // Dialog portals render into document.body.
  await act(async () => {
    root = createRoot(container!);
    root.render(element);
  });
  return container;
}

// Polls the DOM until `predicate` is true, flushing React's act() queue (and
// real macrotask-scheduled promise continuations) between checks. Needed
// because Radix's own portal/dismissal teardown after a backdrop click is
// not guaranteed to have fully flushed the instant the act() block above it
// returns — asserting synchronously right after is an intermittent race.
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 20);
      await promise;
    });
  }
}

function thumbnailButtons(el: HTMLElement): HTMLButtonElement[] {
  return Array.from(el.querySelectorAll('button[aria-label^="Open photo"]'));
}

function lightboxImage(): HTMLImageElement | null {
  return document.body.querySelector('[role="dialog"] img');
}

describe('PhotoUpload thumbnail grid', () => {
  it('renders each photoPaths entry as an image inside a clickable thumbnail button, with no lightbox open yet', async () => {
    const photoPaths = ['photos/listing-1-aaaa.jpg', 'photos/listing-1-bbbb.png'];
    const el = await mount(<PhotoUpload listingId="listing-1" photoPaths={photoPaths} onUploaded={() => {}} />);

    const buttons = thumbnailButtons(el);
    expect(buttons).toHaveLength(photoPaths.length);

    const expectedUrls = ['http://localhost:3001/photos/listing-1-aaaa.jpg', 'http://localhost:3001/photos/listing-1-bbbb.png'];
    buttons.forEach((button, index) => {
      const img = button.querySelector('img');
      expect(img, `expected an <img> inside the thumbnail for ${photoPaths[index]}`).not.toBeNull();
      expect(img!.getAttribute('src')).toBe(expectedUrls[index]);
      expect(img!.getAttribute('alt')).toBe('Listing photo');
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders the empty state and no thumbnails when photoPaths is empty', async () => {
    const el = await mount(<PhotoUpload listingId="listing-1" photoPaths={[]} onUploaded={() => {}} />);

    expect(el.textContent).toContain('No photos uploaded yet.');
    expect(thumbnailButtons(el)).toHaveLength(0);
  });

  it('renders a "Choose Photos" button that triggers the hidden native file input', async () => {
    const el = await mount(<PhotoUpload listingId="listing-1" photoPaths={[]} onUploaded={() => {}} />);

    const chooseButton = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Choose Photos'));
    expect(chooseButton, 'expected a "Choose Photos" button').not.toBeUndefined();

    const fileInput = el.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput.className).toContain('hidden');

    let clicked = false;
    fileInput.addEventListener('click', () => {
      clicked = true;
    });
    await act(async () => {
      chooseButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(clicked).toBe(true);
  });
});

describe('PhotoUpload lightbox navigation', () => {
  const photoPaths = ['photos/listing-1-aaaa.jpg', 'photos/listing-1-bbbb.png', 'photos/listing-1-cccc.png'];
  const expectedUrls = [
    'http://localhost:3001/photos/listing-1-aaaa.jpg',
    'http://localhost:3001/photos/listing-1-bbbb.png',
    'http://localhost:3001/photos/listing-1-cccc.png',
  ];

  it('opens on the clicked photo, and Next/Previous buttons step through and wrap at both ends', async () => {
    const el = await mount(<PhotoUpload listingId="listing-1" photoPaths={photoPaths} onUploaded={() => {}} />);

    await act(async () => {
      thumbnailButtons(el)[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(lightboxImage()!.getAttribute('src')).toBe(expectedUrls[1]);

    const nextButton = document.body.querySelector('[aria-label="Next photo"]') as HTMLButtonElement;
    await act(async () => {
      nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(lightboxImage()!.getAttribute('src')).toBe(expectedUrls[2]);

    // Wraps from the last photo back to the first.
    await act(async () => {
      nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(lightboxImage()!.getAttribute('src')).toBe(expectedUrls[0]);

    const previousButton = document.body.querySelector('[aria-label="Previous photo"]') as HTMLButtonElement;
    // Wraps from the first photo back to the last.
    await act(async () => {
      previousButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(lightboxImage()!.getAttribute('src')).toBe(expectedUrls[2]);
  });

  it('steps through photos with the Left/Right arrow keys', async () => {
    const el = await mount(<PhotoUpload listingId="listing-1" photoPaths={photoPaths} onUploaded={() => {}} />);

    await act(async () => {
      thumbnailButtons(el)[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(lightboxImage()!.getAttribute('src')).toBe(expectedUrls[0]);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });
    expect(lightboxImage()!.getAttribute('src')).toBe(expectedUrls[1]);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });
    expect(lightboxImage()!.getAttribute('src')).toBe(expectedUrls[0]);
  });

  it('closes on the close button and clears the lightbox from the DOM', async () => {
    const el = await mount(<PhotoUpload listingId="listing-1" photoPaths={photoPaths} onUploaded={() => {}} />);

    await act(async () => {
      thumbnailButtons(el)[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    const closeButton = document.body.querySelector('[aria-label="Close"]') as HTMLButtonElement;
    await act(async () => {
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('clicking the dialog backdrop closes the lightbox, but clicking the photo itself does not', async () => {
    const el = await mount(<PhotoUpload listingId="listing-1" photoPaths={photoPaths} onUploaded={() => {}} />);

    await act(async () => {
      thumbnailButtons(el)[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    // The photo itself must not close the lightbox — the click must stop
    // before it reaches the backdrop's own handler.
    await act(async () => {
      lightboxImage()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    // The dialog's own root element is the backdrop — there is no pixel
    // structurally "outside" it since it covers the full viewport, so a
    // click landing directly on it (not on the image or a button) is what
    // closes the lightbox.
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    await act(async () => {
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => document.body.querySelector('[role="dialog"]') === null);
  });
});

describe('PhotoLightbox onClose call count', () => {
  // PhotoUpload's own onClose handler (`() => setLightboxIndex(null)`) is
  // idempotent, so none of the PhotoUpload-mounted tests above can tell a
  // single onClose call apart from a double-fire — this mounts
  // PhotoLightbox directly with a spy so a regression that lets the Close
  // button's click reach both its own handler and the backdrop's
  // onClick={onClose} (i.e. a missing/broken stopPropagation) is caught.
  it('clicking the Close button calls onClose exactly once', async () => {
    const photoPaths = ['photos/listing-1-aaaa.jpg'];
    const onClose = vi.fn();
    await mount(<PhotoLightbox photoPaths={photoPaths} index={0} onClose={onClose} onIndexChange={() => {}} />);

    const closeButton = document.body.querySelector('[aria-label="Close"]') as HTMLButtonElement;
    expect(closeButton, 'expected a Close button in the DOM').not.toBeNull();

    await act(async () => {
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
