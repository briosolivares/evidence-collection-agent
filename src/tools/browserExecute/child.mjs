import { createBrowserApi } from './coreHelpers.mjs';
import { isRecord, sendBoundedIpc, structuredError } from './ipcShared.mjs';

const PROTOCOL_VERSION = 1;
const HARD_MAX_IPC_MESSAGE_BYTES = 1_048_576;
const HARD_MAX_RESULT_BYTES = 524_288;

let started = false;
let finished = false;
let nextRequestId = 1;
let maxIpcMessageBytes = HARD_MAX_IPC_MESSAGE_BYTES;
let maxResultBytes = HARD_MAX_RESULT_BYTES;
const pending = new Map();

function sendBounded(message, callback) {
  return sendBoundedIpc(message, {
    maxBytes: maxIpcMessageBytes,
    isConnected: () => typeof process.send === 'function' && process.connected,
    send: (payload) => process.send(payload, callback),
    fail: (kind, error) => {
      callback?.(
        kind === 'oversized'
          ? new RangeError(`IPC message exceeds ${maxIpcMessageBytes} bytes`)
          : kind === 'closed'
            ? new Error('browser-program IPC channel is closed')
            : error,
      );
    },
  });
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
  if (
    !isRecord(message) ||
    message.version !== PROTOCOL_VERSION ||
    typeof message.kind !== 'string'
  ) {
    failProtocol('parent sent a malformed browser-program IPC message');
    return;
  }

  if (message.kind === 'start') {
    if (started) {
      failProtocol('browser program received more than one start message');
      return;
    }
    // The parent is trusted and already validated the page identity (shape,
    // non-empty, 4096-byte bounds) before sending `start`, and coreHelpers
    // re-normalizes it when building the browser API. Only the child's own
    // hard IPC/result ceilings are enforced here.
    if (
      typeof message.code !== 'string' ||
      !isRecord(message.page) ||
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
    if (
      !started ||
      !Number.isSafeInteger(message.id) ||
      message.id <= 0 ||
      typeof message.ok !== 'boolean'
    ) {
      failProtocol('browser program received a malformed request response');
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      failProtocol(`browser program received a response for unknown request ${message.id}`);
      return;
    }
    if (entry.responseKind !== message.kind) {
      failProtocol(`browser program received ${message.kind} for a pending ${entry.responseKind}`);
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
