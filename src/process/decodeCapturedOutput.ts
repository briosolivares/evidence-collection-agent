import { StringDecoder } from 'node:string_decoder';

/** Decode retained output while dropping only an incomplete final UTF-8 sequence. */
export function decodeCapturedOutput(chunks: readonly Buffer[]): string {
  const decoder = new StringDecoder('utf8');
  return chunks.map((chunk) => decoder.write(chunk)).join('');
}
