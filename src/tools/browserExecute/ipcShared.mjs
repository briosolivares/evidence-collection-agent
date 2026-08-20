/**
 * Helpers shared by BOTH sides of the browser-program IPC boundary.
 *
 * The child runs in stock Node (no tsx loader), so this file must stay plain
 * .mjs on disk — importable by child.mjs directly and by runner.ts through
 * its ipcShared.d.mts declarations. It must never import redaction or any
 * other parent-side capability: the parent passes redaction in as the
 * `transform` argument, and the child keeps the identity default.
 */

export const MAX_ERROR_NAME_BYTES = 256;
export const MAX_ERROR_MESSAGE_BYTES = 8_192;
export const MAX_ERROR_STACK_BYTES = 24_576;

/** Truncate to a UTF-8 byte budget without splitting a multibyte sequence. */
export function truncateUtf8(value, maxBytes) {
  const text = String(value);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}…`;
}

/**
 * Bounded { name, message, stack? } form of one thrown value. `transform`
 * runs over every field before truncation; the runner passes redaction here.
 */
export function structuredError(thrown, transform = (text) => text) {
  if (thrown instanceof Error) {
    return {
      name: truncateUtf8(transform(thrown.name || 'Error'), MAX_ERROR_NAME_BYTES),
      message: truncateUtf8(transform(thrown.message || String(thrown)), MAX_ERROR_MESSAGE_BYTES),
      ...(typeof thrown.stack === 'string'
        ? { stack: truncateUtf8(transform(thrown.stack), MAX_ERROR_STACK_BYTES) }
        : {}),
    };
  }
  return {
    name: 'Error',
    message: truncateUtf8(transform(String(thrown)), MAX_ERROR_MESSAGE_BYTES),
  };
}

/** UTF-8 byte size of a value's JSON serialization; throws if unserializable. */
export function serializedSize(value) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('value is not JSON-serializable');
  return Buffer.byteLength(json, 'utf8');
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One size-bounded JSON send. The check order — serializability, byte limit,
 * channel liveness, then the actual send — is the shared invariant; failure
 * semantics stay caller-owned through `fail(kind, error?)`, where kind is
 * 'serialize' | 'oversized' | 'closed' | 'send' ('serialize' and 'send'
 * carry the thrown error, the other kinds carry none).
 */
export function sendBoundedIpc(message, { maxBytes, isConnected, send, fail }) {
  let size;
  try {
    size = serializedSize(message);
  } catch (error) {
    fail('serialize', error);
    return false;
  }
  if (size > maxBytes) {
    fail('oversized');
    return false;
  }
  if (!isConnected()) {
    fail('closed');
    return false;
  }
  try {
    send(message);
    return true;
  } catch (error) {
    fail('send', error);
    return false;
  }
}
