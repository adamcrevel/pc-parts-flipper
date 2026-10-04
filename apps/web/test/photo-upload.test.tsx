// @vitest-environment jsdom
//
// Proof for PhotoUpload's thumbnail grid (photo-upload.tsx): previously this
// rendered a bare bulleted list of filenames with nothing clickable — this
// suite pins the actual contract it was rewritten for: each photoPaths
// entry renders as a real <img> pointed at the URL buildPhotoUrl() would
// construct for it, wrapped in a link to that same full-size URL, and the
// "No photos uploaded yet" empty state still renders when there are none.
// Mounts the real component with react-dom/client + act(), following
// ebay-scan-ui.test.tsx's pattern (no React Testing Library in this
// workspace).
//
// Expected URLs below are literal strings, not buildPhotoUrl(photoPath)
// calls: deriving "expected" from the same function the component calls to
// produce "actual" would only prove the component calls buildPhotoUrl, and
// would stay green even if buildPhotoUrl's own `/` join were broken (e.g.
// producing `http://localhost:3001photos/x.jpg`), since both sides would be
// equally wrong. buildPhotoUrl's own correctness is pinned independently in
// api-client.test.ts. The literal base URL here is this project's
// documented default VITE_API_BASE_URL (see .env.example), which this
// workspace's vite/vitest config leaves unset.
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { PhotoUpload } from '../src/features/listings/photo-upload';

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
  await act(async () => {
    root = createRoot(container!);
    root.render(element);
  });
  return container;
}

describe('PhotoUpload thumbnail grid', () => {
  it('renders each photoPaths entry as an <img> inside a link to its full-size URL', async () => {
    const photoPaths = ['photos/listing-1-aaaa.jpg', 'photos/listing-1-bbbb.png'];
    const el = await mount(<PhotoUpload listingId="listing-1" photoPaths={photoPaths} onUploaded={() => {}} />);

    const links = Array.from(el.querySelectorAll('a')) as HTMLAnchorElement[];
    expect(links).toHaveLength(photoPaths.length);

    const expectedUrls = ['http://localhost:3001/photos/listing-1-aaaa.jpg', 'http://localhost:3001/photos/listing-1-bbbb.png'];
    for (const [index, photoPath] of photoPaths.entries()) {
      const expectedUrl = expectedUrls[index];
      const link = links[index];
      // href resolves relative to jsdom's base URL, so compare via the
      // underlying attribute rather than the resolved `.href` property.
      expect(link.getAttribute('href')).toBe(expectedUrl);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noreferrer');

      const img = link.querySelector('img');
      expect(img, `expected an <img> inside the link for ${photoPath}`).not.toBeNull();
      expect(img!.getAttribute('src')).toBe(expectedUrl);
      expect(img!.getAttribute('alt')).toBe('Listing photo');
    }
  });

  it('renders the empty state and no thumbnails when photoPaths is empty', async () => {
    const el = await mount(<PhotoUpload listingId="listing-1" photoPaths={[]} onUploaded={() => {}} />);

    expect(el.textContent).toContain('No photos uploaded yet.');
    expect(el.querySelectorAll('img')).toHaveLength(0);
  });
});
