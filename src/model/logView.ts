import type { ImageBlock, Message } from './messages.js';

/** Pixel-free projection for transcripts and external telemetry. */
export function imageBlockLogView(image: ImageBlock, rawBytes?: number): Record<string, unknown> {
  return {
    type: image.type,
    source: {
      type: image.source.type,
      media_type: image.source.media_type,
      data:
        rawBytes === undefined
          ? `[pixel payload omitted; ${image.source.data.length} base64 characters]`
          : `[pixel payload omitted; ${rawBytes} raw bytes]`,
    },
  };
}

/** Preserve message structure and text while removing every base64 image payload. */
export function modelMessagesLogView(messages: readonly Message[]): readonly unknown[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'tool_result' || typeof block.content === 'string') return block;
      return {
        ...block,
        content: block.content.map((item) =>
          item.type === 'image' ? imageBlockLogView(item) : item,
        ),
      };
    }),
  }));
}
