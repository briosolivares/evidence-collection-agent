/** Decode bytes as fatal UTF-8, returning undefined for any invalid sequence.
 * TextDecoder's default BOM handling is preserved. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
