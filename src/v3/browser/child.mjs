import { createBrowserApi } from './coreHelpers.mjs';

const PROTOCOL_VERSION = 1;
const HARD_MAX_IPC_MESSAGE_BYTES = 1_048_576;
const HARD_MAX_RESULT_BYTES = 524_288;
const MAX_ERROR_NAME_BYTES = 256;
const MAX_ERROR_MESSAGE_BYTES = 8_192;
const MAX_ERROR_STACK_BYTES = 24_576;

let started = false;
let finished = false;
let nextRequestId = 1;
let maxIpcMessageBytes = HARD_MAX_IPC_MESSAGE_BYTES;
let maxResultBytes = HARD_MAX_RESULT_BYTES;
const pending = new Map();

function truncateUtf8(value, maxBytes) {
  const text = String(value);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}…`;
}

function structuredError(thrown) {
  if (thrown instanceof Error) {
    return {
      name: truncateUtf8(thrown.name || 'Error', MAX_ERROR_NAME_BYTES),
      message: truncateUtf8(thrown.message || String(thrown), MAX_ERROR_MESSAGE_BYTES),
      ...(typeof thrown.stack === 'string'
        ? { stack: truncateUtf8(thrown.stack, MAX_ERROR_STACK_BYTES) }
        : {}),
    };
  }
  return {
    name: 'Error',
    message: truncateUtf8(String(thrown), MAX_ERROR_MESSAGE_BYTES),
  };
}

function serializedSize(value) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('value is not JSON-serializable');
  return Buffer.byteLength(json, 'utf8');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sendBounded(message, callback) {
  let size;
  try {
    size = serializedSize(message);
  } catch (error) {
    callback?.(error);
    return false;
  }
  if (size > maxIpcMessageBytes) {
    callback?.(new RangeError(`IPC message exceeds ${maxIpcMessageBytes} bytes`));
    return false;
  }
  if (typeof process.send !== 'function' || !process.connected) {
    callback?.(new Error('browser-program IPC channel is closed'));
    return false;
  }
  try {
    process.send(message, callback);
    return true;
  } catch (error) {
    callback?.(error);
    return false;
  }
}

function rejectPending(error) {
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
}

function requestCdp(method, params) {
  if (finished) return Promise.reject(new Error('browser program already finished'));
  const id = nextRequestId++;
  const message = {
    version: PROTOCOL_VERSION,
    kind: 'cdp_request',
    id,
    method,
    params,
  };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, responseKind: 'cdp_response' });
    const sent = sendBounded(message, (error) => {
      if (!error) return;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      entry.reject(error);
    });
    if (!sent && pending.has(id)) {
      pending.delete(id);
      reject(new Error('failed to send browser CDP request'));
    }
  });
}

function requestHost(operation, params) {
  if (finished) return Promise.reject(new Error('browser program already finished'));
  const id = nextRequestId++;
  const message = {
    version: PROTOCOL_VERSION,
    kind: 'host_request',
    id,
    operation,
    params,
  };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, responseKind: 'host_response' });
    const sent = sendBounded(message, (error) => {
      if (!error) return;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      entry.reject(error);
    });
    if (!sent && pending.has(id)) {
      pending.delete(id);
      reject(new Error('failed to send browser host request'));
    }
  });
}

function sendFinal(message) {
  if (finished) return;
  finished = true;
  rejectPending(new Error('browser program finished'));
  sendBounded(message, () => {
    if (process.connected) process.disconnect();
    // Do not call process.exit(): allowing stdout/stderr to drain naturally
    // avoids losing output. The parent owns the hard process-group deadline.
    process.exitCode = message.ok ? 0 : 1;
  });
}

function normalizedResult(value) {
  if (value === undefined) return { hasValue: false };
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('browser program result is not JSON-serializable');
  }
  const size = Buffer.byteLength(serialized, 'utf8');
  if (size > maxResultBytes) {
    const error = new RangeError(`browser program result exceeds ${maxResultBytes} bytes`);
    error.name = 'ResultLimitError';
    throw error;
  }
  return { hasValue: true, value: JSON.parse(serialized) };
}

async function execute(code, page) {
  try {
    const browser = createBrowserApi(requestCdp, requestHost, page);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const program = new AsyncFunction(
      'browser',
      `"use strict";\n${code}\n//# sourceURL=sherlock-browser-program.js`,
    );
    const returned = await program(browser);
    const result = normalizedResult(returned);
    sendFinal({
      version: PROTOCOL_VERSION,
      kind: 'program_result',
      ok: true,
      ...result,
    });
  } catch (error) {
    sendFinal({
      version: PROTOCOL_VERSION,
      kind: 'program_result',
      ok: false,
      failure: error?.name === 'ResultLimitError' ? 'result_limit' : 'program',
      error: structuredError(error),
    });
  }
}

function failProtocol(message) {
  sendFinal({
    version: PROTOCOL_VERSION,
    kind: 'program_result',
    ok: false,
    failure: 'protocol',
    error: structuredError(new Error(message)),
  });
}

process.on('message', (message) => {
  if (!isRecord(message) || message.version !== PROTOCOL_VERSION || typeof message.kind !== 'string') {
    failProtocol('parent sent a malformed browser-program IPC message');
    return;
  }

  if (message.kind === 'start') {
    if (started) {
      failProtocol('browser program received more than one start message');
      return;
    }
    if (
      typeof message.code !== 'string' ||
      !isRecord(message.page) ||
      typeof message.page.pageId !== 'string' ||
      message.page.pageId.length === 0 ||
      Buffer.byteLength(message.page.pageId, 'utf8') > 4_096 ||
      typeof message.page.targetId !== 'string' ||
      message.page.targetId.length === 0 ||
      Buffer.byteLength(message.page.targetId, 'utf8') > 4_096 ||
      !Number.isInteger(message.maxIpcMessageBytes) ||
      message.maxIpcMessageBytes <= 0 ||
      message.maxIpcMessageBytes > HARD_MAX_IPC_MESSAGE_BYTES ||
      !Number.isInteger(message.maxResultBytes) ||
      message.maxResultBytes <= 0 ||
      message.maxResultBytes > HARD_MAX_RESULT_BYTES
    ) {
      failProtocol('browser program received an invalid start message');
      return;
    }
    started = true;
    maxIpcMessageBytes = message.maxIpcMessageBytes;
    maxResultBytes = message.maxResultBytes;
    void execute(message.code, {
      pageId: message.page.pageId,
      targetId: message.page.targetId,
    });
    return;
  }

  if (message.kind === 'cdp_response' || message.kind === 'host_response') {
    if (!started || !Number.isSafeInteger(message.id) || message.id <= 0 || typeof message.ok !== 'boolean') {
      failProtocol('browser program received a malformed request response');
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      failProtocol(`browser program received a response for unknown request ${message.id}`);
      return;
    }
    if (entry.responseKind !== message.kind) {
      failProtocol(
        `browser program received ${message.kind} for a pending ${entry.responseKind}`,
      );
      return;
    }
    pending.delete(message.id);
    if (message.ok) {
      entry.resolve(message.value);
    } else {
      const error = isRecord(message.error) ? message.error : {};
      const requestError = new Error(
        typeof error.message === 'string'
          ? error.message
          : message.kind === 'cdp_response'
            ? 'CDP command failed'
            : 'browser host request failed',
      );
      requestError.name =
        typeof error.name === 'string'
          ? error.name
          : message.kind === 'cdp_response'
            ? 'CdpError'
            : 'HostError';
      entry.reject(requestError);
    }
    return;
  }

  failProtocol(`browser program received unknown IPC message kind ${message.kind}`);
});

process.once('disconnect', () => {
  rejectPending(new Error('browser-program IPC channel disconnected'));
});

sendBounded({ version: PROTOCOL_VERSION, kind: 'ready' });
