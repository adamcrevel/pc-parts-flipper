// Minimal real-bytes image verification (ai-reference-autosourcing feature T4, Requirement 3:
// the server never trusts the model's own claim that a sourced URL is a real product photo —
// an HTTP 200 response only proves bytes were transferred, not that those bytes decode as an
// actual image). No image-decoding library (sharp, image-size, file-type, ...) is a dependency
// of this package today, so this sniffs each format's standard magic-byte signature from the
// downloaded file's own header bytes instead of adding a new dependency for one narrow check.
// Covers the four raster formats realistic for a manufacturer product-photo page: JPEG, PNG,
// GIF, WebP — the same reasoning seedReferencePhotos.ts's own Wikimedia JPEGs already rely on.
import { open } from 'node:fs/promises';

// Longest signature checked below (WebP's "RIFF"+4 size bytes+"WEBP") needs 12 header bytes;
// reading a few extra is harmless and keeps one fixed-size read for every format.
const HEADER_BYTES = 16;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Reads the first HEADER_BYTES bytes of `filePath` and returns true only if they match a known
 * raster-image magic-byte signature (JPEG/PNG/GIF/WebP). Returns false for anything else,
 * including a file that doesn't exist, can't be read, or is too short to carry any signature.
 */
export async function isDecodableImage(filePath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    if (bytesRead < 4) return false;

    // JPEG: starts with FF D8 FF.
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
    // PNG: fixed 8-byte signature.
    if (bytesRead >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return true;
    // GIF: ASCII "GIF87a" or "GIF89a".
    if (bytesRead >= 6) {
      const header6 = buffer.subarray(0, 6).toString('ascii');
      if (header6 === 'GIF87a' || header6 === 'GIF89a') return true;
    }
    // WebP: ASCII "RIFF", 4 size bytes, then ASCII "WEBP".
    if (
      bytesRead >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}
