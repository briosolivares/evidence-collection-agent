import { Buffer } from 'node:buffer';

import type { ImageBlock } from './messages.js';

/** 3.75MB of raw bytes stays within the API's approximately 5MB base64 limit. */
export const MODEL_MAX_IMAGE_BYTES = 3_750_000;

/** The Messages API rejects an image with either dimension above 8,000 pixels. */
export const MODEL_MAX_IMAGE_DIMENSION_PX = 8_000;

export interface ImageDimensions {
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

/** Read bounded PNG/JPEG dimensions without an image-processing dependency. */
export function imageDimensions(
  bytes: Uint8Array,
  mediaType: ImageBlock['source']['media_type'],
): ImageDimensions | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return mediaType === 'image/png' ? pngDimensions(buffer) : jpegDimensions(buffer);
}

export function imageBlockFromBytes(
  bytes: Uint8Array,
  mediaType: ImageBlock['source']['media_type'],
): ImageBlock {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
    },
  };
}

function pngDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.toString('latin1', 12, 16) !== 'IHDR'
  ) {
    return undefined;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker >= 0xd0 && marker <= 0xd8) {
      offset += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}
