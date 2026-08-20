import { randomUUID } from 'node:crypto';

import type { Locator, Page } from 'playwright';

const BACKEND_NODE_MARKER_ATTRIBUTE = 'data-sherlock-backend-target';
const MAX_BACKEND_NODE_ID = 2_147_483_647;

export type BackendNodeCdpSend = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

function runtimeException(response: unknown): string | undefined {
  const details = (response as { exceptionDetails?: unknown })?.exceptionDetails;
  if (details === undefined) return undefined;
  const record = details as {
    text?: unknown;
    exception?: { description?: unknown; value?: unknown };
  };
  if (typeof record.exception?.description === 'string') {
    return record.exception.description;
  }
  if (record.exception?.value !== undefined) return String(record.exception.value);
  return typeof record.text === 'string' ? record.text : 'browser backend-node marker failed';
}

/**
 * Resolve one CDP backend DOM node to an exact Playwright locator without
 * trusting selector text from the model. The temporary marker is installed
 * through the node's remote object, required to be unique across every frame,
 * and removed on every exit path.
 */
export async function withBackendNodeLocator<T>(
  page: Page,
  send: BackendNodeCdpSend,
  backendDOMNodeId: number,
  action: (locator: Locator) => Promise<T>,
): Promise<T> {
  if (
    !Number.isInteger(backendDOMNodeId) ||
    backendDOMNodeId <= 0 ||
    backendDOMNodeId > MAX_BACKEND_NODE_ID
  ) {
    throw new TypeError(
      `backend DOM node id must be an integer from 1 through ${MAX_BACKEND_NODE_ID}`,
    );
  }

  const resolved = (await send('DOM.resolveNode', {
    backendNodeId: backendDOMNodeId,
  })) as { object?: { objectId?: unknown } };
  const objectId = resolved.object?.objectId;
  if (typeof objectId !== 'string' || objectId.length === 0) {
    throw new Error(`DOM.resolveNode returned no object for backend node ${backendDOMNodeId}`);
  }

  const marker = randomUUID();
  try {
    const marked = await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(attribute, marker) {
        if (!(this instanceof Element)) {
          throw new TypeError('browser backend node must resolve to an element');
        }
        this.setAttribute(attribute, marker);
      }`,
      arguments: [{ value: BACKEND_NODE_MARKER_ATTRIBUTE }, { value: marker }],
      returnByValue: true,
    });
    const markerError = runtimeException(marked);
    if (markerError !== undefined) throw new Error(markerError);

    const selector = `[${BACKEND_NODE_MARKER_ATTRIBUTE}="${marker}"]`;
    let target: Locator | undefined;
    for (const frame of page.frames()) {
      const candidate = frame.locator(selector);
      const count = await candidate.count();
      if (count === 0) continue;
      if (count !== 1 || target !== undefined) {
        throw new Error('browser backend-node target marker was not unique');
      }
      target = candidate;
    }
    if (target === undefined) {
      throw new Error('browser backend-node target disappeared before it could be used');
    }
    return await action(target);
  } finally {
    await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(attribute, marker) {
        if (this.getAttribute?.(attribute) === marker) this.removeAttribute(attribute);
      }`,
      arguments: [{ value: BACKEND_NODE_MARKER_ATTRIBUTE }, { value: marker }],
      returnByValue: true,
    }).catch(() => undefined);
    await send('Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}
