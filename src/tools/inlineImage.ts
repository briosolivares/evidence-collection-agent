import type { ImageBlock } from '../model/messages.js';
import {
  imageBlockFromBytes,
  imageDimensions,
  MODEL_MAX_IMAGE_BYTES,
  MODEL_MAX_IMAGE_DIMENSION_PX,
  type ImageDimensions,
} from '../model/imageContent.js';

export const INLINE_IMAGE_OUTPUT_KIND = 'inline_image' as const;

/** Trusted in-process executor output that the pipeline converts to a multimodal result. */
export interface InlineImageToolOutput {
  kind: typeof INLINE_IMAGE_OUTPUT_KIND;
  text: string;
  mediaType: ImageBlock['source']['media_type'];
  bytes: Uint8Array;
  dimensions: ImageDimensions;
}

export function createInlineImageToolOutput(
  text: string,
  mediaType: ImageBlock['source']['media_type'],
  bytes: Uint8Array,
): InlineImageToolOutput {
  if (bytes.byteLength > MODEL_MAX_IMAGE_BYTES) {
    throw new Error(
      `image is ${bytes.byteLength} bytes, over the ${MODEL_MAX_IMAGE_BYTES}-byte model limit`,
    );
  }
  const dimensions = imageDimensions(bytes, mediaType);
  if (dimensions === undefined) {
    throw new Error(`captured bytes are not a readable ${mediaType} image`);
  }
  if (
    dimensions.width > MODEL_MAX_IMAGE_DIMENSION_PX ||
    dimensions.height > MODEL_MAX_IMAGE_DIMENSION_PX
  ) {
    throw new Error(
      `image is ${dimensions.width}x${dimensions.height} pixels, over the ` +
        `${MODEL_MAX_IMAGE_DIMENSION_PX}-pixel per-dimension model limit`,
    );
  }
  return {
    kind: INLINE_IMAGE_OUTPUT_KIND,
    text,
    mediaType,
    bytes,
    dimensions,
  };
}

export function isInlineImageToolOutput(value: unknown): value is InlineImageToolOutput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<InlineImageToolOutput>;
  return (
    candidate.kind === INLINE_IMAGE_OUTPUT_KIND &&
    typeof candidate.text === 'string' &&
    (candidate.mediaType === 'image/png' || candidate.mediaType === 'image/jpeg') &&
    candidate.bytes instanceof Uint8Array &&
    typeof candidate.dimensions?.width === 'number' &&
    typeof candidate.dimensions.height === 'number'
  );
}

export function inlineImageBlock(output: InlineImageToolOutput): ImageBlock {
  return imageBlockFromBytes(output.bytes, output.mediaType);
}

/** Pixel-free telemetry representation; raw image bytes stay in the run/model boundary. */
export function inlineImageTraceView(output: InlineImageToolOutput): Record<string, unknown> {
  return {
    kind: output.kind,
    mediaType: output.mediaType,
    bytes: output.bytes.byteLength,
    width: output.dimensions.width,
    height: output.dimensions.height,
    text: output.text,
  };
}
