import type { BrowserContext, CDPSession, Page } from 'playwright';

import type {
  BrowserCommandSession,
  BrowserNavigationOptions,
  BrowserNavigationResult,
} from './controller.js';
import { withBackendNodeLocator } from './backendNodeTarget.js';
import {
  localUploadEncoder,
  type BrowserUploadEncoder,
} from './uploadEncoder.js';

/** Transport URLs are session-control capabilities. Even if a driver error
 * happens to echo one, it must stop at this controller-owned boundary. */
const TRANSPORT_URL = /\b(?:https?|wss?):\/\/[^\s"'<>]+/giu;
const DETACH_DEADLINE_MS = 1_000;
const NAVIGATION_STOP_DEADLINE_MS = 1_000;
const MAX_NAVIGATION_TIMEOUT_MS = 120_000;
const MAX_NAVIGATION_URL_BYTES = 256_000;
const UPLOAD_TIMEOUT_MS = 5_000;

type ArbitraryCdpSend = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Controller-owned authority policy for browser-scoped Target commands.
 *
 * Kept on this private Playwright composition seam rather than the public
 * BrowserController contract: model-authored code receives only the filtered
 * BrowserCommandSession, never this policy or its raw target identities.
 */
export interface BrowserTargetCommandPolicy {
  ownedTargetIds(): Promise<ReadonlySet<string>>;
  createTarget(
    params: Record<string, unknown>,
    rawCreate: (params: Record<string, unknown>) => Promise<unknown>,
  ): Promise<unknown>;
}

export interface PlaywrightCommandSessionHooks {
  /** Required authority boundary for every browser-scoped Target command. */
  targetPolicy: BrowserTargetCommandPolicy;
  /** Route dialog decisions through the controller's cached Playwright
   * Dialog. A prior timed-out evaluation may still own the original CDP
   * command, so a second raw session cannot reliably address it directly. */
  handleDialogCommand?: (params: Record<string, unknown>) => Promise<unknown>;
  /** Provider-specific file preparation. Local Chrome receives the confined
   * path; a remote browser receives a Playwright FilePayload with bytes. */
  uploadEncoder?: BrowserUploadEncoder;
  /** Register the complete upload effect in the controller's shared busy
   * ledger. A timed-out child may stop awaiting it, but cleanup and later
   * exclusive calls must still see it until the real effect settles. */
  trackUploadEffect?: (effect: Promise<void>) => void;
  /** Release the caller's session. The controller may take ownership of the
   * bounded detacher until a blocking dialog is answered. */
  release?: (
    detach: () => Promise<void>,
    hadPendingCommands: boolean,
  ) => Promise<void>;
}

async function uploadToBackendNode(
  page: Page,
  send: ArbitraryCdpSend,
  uploadEncoder: BrowserUploadEncoder,
  backendDOMNodeId: number,
  absolutePath: string,
): Promise<void> {
  // Encode/read before touching the page. A missing or unreadable file must
  // fail before even the temporary marker becomes observable in the document.
  const encoded = await uploadEncoder.encode([absolutePath]);
  await withBackendNodeLocator(page, send, backendDOMNodeId, async (target) => {
    const isFileInput = await target.evaluate(
      (element) =>
        element instanceof HTMLInputElement && element.type === 'file',
    );
    if (!isFileInput) {
      throw new TypeError('browser.upload target must be an input[type=file]');
    }
    await target.setInputFiles(encoded, { timeout: UPLOAD_TIMEOUT_MS });
  });
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(TRANSPORT_URL, '[redacted URL]');
}

function commandError(operation: string, error: unknown): Error {
  // Deliberately omit `cause`: an upstream Playwright error may retain the
  // provider connection URL in its message or metadata even after the public
  // message is redacted.
  return new Error(`${operation}: ${errorText(error)}`);
}

function arbitrarySend(session: CDPSession): ArbitraryCdpSend {
  // Playwright types the method argument as the protocol methods known by the
  // installed package. This seam intentionally permits newer/experimental CDP
  // methods too; Chrome remains the runtime validator.
  return session.send.bind(session) as unknown as ArbitraryCdpSend;
}

async function detachWithoutHanging(session: CDPSession): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      session.detach().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DETACH_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validateNavigation(
  url: string,
  options: BrowserNavigationOptions,
): void {
  if (
    typeof url !== 'string' ||
    url.length === 0 ||
    Buffer.byteLength(url, 'utf8') > MAX_NAVIGATION_URL_BYTES
  ) {
    throw new TypeError(
      `browser navigation URL must contain 1 through ${MAX_NAVIGATION_URL_BYTES} UTF-8 bytes`,
    );
  }
  if (
    !Number.isInteger(options?.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > MAX_NAVIGATION_TIMEOUT_MS
  ) {
    throw new RangeError(
      `browser navigation timeoutMs must be an integer from 1 through ${MAX_NAVIGATION_TIMEOUT_MS}`,
    );
  }
  if (options.waitUntil !== 'domcontentloaded' && options.waitUntil !== 'load') {
    throw new TypeError(
      'browser navigation waitUntil must be domcontentloaded or load',
    );
  }
}

async function stopNavigationWithoutHanging(send: ArbitraryCdpSend): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      send('Page.stopLoading').catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, NAVIGATION_STOP_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseTargetId(value: unknown, operation: string): string {
  if (!isRecord(value) || !isRecord(value.targetInfo)) {
    throw new Error(`${operation} returned an invalid response.`);
  }
  const targetId = value.targetInfo.targetId;
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw new Error(`${operation} returned an invalid target identity.`);
  }
  return targetId;
}

function requiredTargetId(
  params: Record<string, unknown>,
  operation: string,
): string {
  const targetId = params.targetId;
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw new TypeError(`${operation} requires a non-empty targetId.`);
  }
  return targetId;
}

async function requireOwnedTarget(
  targetId: string,
  policy: BrowserTargetCommandPolicy,
): Promise<void> {
  if (!(await policy.ownedTargetIds()).has(targetId)) {
    throw new Error('Target command refused because the target is outside this run.');
  }
}

function filteredTargetInventory(
  response: unknown,
  ownedTargetIds: ReadonlySet<string>,
): Record<string, unknown> {
  if (!isRecord(response) || !Array.isArray(response.targetInfos)) {
    throw new Error('Target.getTargets returned an invalid response.');
  }
  const targetInfos = response.targetInfos.map((value) => {
    if (!isRecord(value) || typeof value.targetId !== 'string' || value.targetId.length === 0) {
      throw new Error('Target.getTargets returned an invalid target record.');
    }
    return value;
  });
  return {
    ...response,
    targetInfos: targetInfos.filter((target) =>
      ownedTargetIds.has(target.targetId as string),
    ),
  };
}

async function sendTargetCommand(
  method: string,
  params: Record<string, unknown>,
  pinnedTargetId: string,
  send: ArbitraryCdpSend,
  policy: BrowserTargetCommandPolicy,
): Promise<unknown> {
  switch (method) {
    case 'Target.createTarget': {
      const response = await policy.createTarget(
        params,
        (rawParams) => send('Target.createTarget', rawParams),
      );
      if (!isRecord(response) || typeof response.targetId !== 'string' || response.targetId.length === 0) {
        throw new Error('Target.createTarget returned an invalid response.');
      }
      await requireOwnedTarget(response.targetId, policy);
      return response;
    }
    case 'Target.getTargets': {
      const ownedTargetIds = await policy.ownedTargetIds();
      return filteredTargetInventory(
        await send('Target.getTargets', params),
        ownedTargetIds,
      );
    }
    case 'Target.getTargetInfo': {
      if (!Object.hasOwn(params, 'targetId')) {
        const response = await send('Target.getTargetInfo', params);
        if (responseTargetId(response, 'Target.getTargetInfo') !== pinnedTargetId) {
          throw new Error('Target.getTargetInfo did not return the pinned target.');
        }
        return response;
      }
      const targetId = requiredTargetId(params, 'Target.getTargetInfo');
      await requireOwnedTarget(targetId, policy);
      const response = await send('Target.getTargetInfo', params);
      if (responseTargetId(response, 'Target.getTargetInfo') !== targetId) {
        throw new Error('Target.getTargetInfo returned a different target.');
      }
      return response;
    }
    case 'Target.activateTarget':
    case 'Target.closeTarget': {
      await requireOwnedTarget(requiredTargetId(params, method), policy);
      return send(method, params);
    }
    default:
      throw new Error(`CDP command ${method} is not allowed for browser programs.`);
  }
}

/**
 * Attach one Playwright CDP session to an already-resolved page.
 *
 * The caller resolves controller page identity before entering this helper;
 * this function never lists pages or chooses a fallback. It verifies liveness
 * on both sides of attachment, gets the target id through the exact attached
 * session, and detaches on every failed setup path.
 */
export async function openPlaywrightCommandSession(
  context: BrowserContext,
  page: Page,
  pageId: string,
  hooks: PlaywrightCommandSessionHooks,
): Promise<BrowserCommandSession> {
  if (page.isClosed()) {
    throw new Error(`Cannot open a browser command session: pageId ${pageId} is closed.`);
  }

  let session: CDPSession;
  try {
    session = await context.newCDPSession(page);
  } catch (error) {
    throw commandError(
      `Could not attach a browser command session to pageId ${pageId}`,
      error,
    );
  }

  const send = arbitrarySend(session);
  const uploadEncoder = hooks.uploadEncoder ?? localUploadEncoder;
  let targetId: string;
  try {
    const response = await send('Target.getTargetInfo');
    const candidate = (response as { targetInfo?: { targetId?: unknown } })
      .targetInfo?.targetId;
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new Error('Target.getTargetInfo returned no target id');
    }
    targetId = candidate;
    if (page.isClosed()) {
      throw new Error(`pageId ${pageId} closed while its command session was opening`);
    }
  } catch (error) {
    await detachWithoutHanging(session);
    throw commandError(
      `Could not resolve the browser target for pageId ${pageId}`,
      error,
    );
  }

  let closed = false;
  let closePromise: Promise<void> | undefined;
  const inFlightCommands = new Set<Promise<void>>();
  const inFlightUploads = new Set<Promise<void>>();
  const trackCommand = async <Result>(operation: Promise<Result>): Promise<Result> => {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    inFlightCommands.add(settled);
    try {
      return await operation;
    } finally {
      inFlightCommands.delete(settled);
    }
  };
  const commandSession: BrowserCommandSession = {
    pageId,
    targetId,
    async send(method, params) {
      if (closed) {
        throw new Error(`Browser command session for pageId ${pageId} is closed.`);
      }
      const operation = (async (): Promise<unknown> => {
        try {
          if (method.startsWith('Browser.')) {
            throw new Error(`CDP command ${method} is not allowed for browser programs.`);
          }
          if (method.startsWith('Target.')) {
            return await sendTargetCommand(
              method,
              params ?? {},
              targetId,
              send,
              hooks.targetPolicy,
            );
          }
          return method === 'Page.handleJavaScriptDialog' &&
            hooks.handleDialogCommand !== undefined
            ? await hooks.handleDialogCommand(params ?? {})
            : await send(method, params);
        } catch (error) {
          throw commandError(
            `CDP command ${JSON.stringify(method)} failed for pageId ${pageId}`,
            error,
          );
        }
      })();
      return trackCommand(operation);
    },
    async navigate(url, options): Promise<BrowserNavigationResult> {
      if (closed) {
        throw new Error(`Browser command session for pageId ${pageId} is closed.`);
      }
      validateNavigation(url, options);
      const operation = (async () => {
        try {
          await page.goto(url, {
            timeout: options.timeoutMs,
            waitUntil: options.waitUntil,
          });
          return {
            pageId,
            targetId,
            url: page.url(),
            title: await page.title(),
          };
        } catch (error) {
          await stopNavigationWithoutHanging(send);
          throw commandError(
            `Browser navigation failed for pageId ${pageId}`,
            error,
          );
        }
      })();
      return trackCommand(operation);
    },
    upload(backendDOMNodeId, absolutePath) {
      if (closed) {
        return Promise.reject(
          new Error(`Browser command session for pageId ${pageId} is closed.`),
        );
      }
      const effect = uploadToBackendNode(
        page,
        send,
        uploadEncoder,
        backendDOMNodeId,
        absolutePath,
      ).catch((error: unknown) => {
        throw commandError(
          `Browser upload failed for pageId ${pageId}`,
          error,
        );
      });
      const settled = effect.then(
        () => undefined,
        () => undefined,
      );
      inFlightUploads.add(settled);
      void settled.then(() => inFlightUploads.delete(settled));
      hooks.trackUploadEffect?.(effect);
      return effect;
    },
    close() {
      if (closePromise !== undefined) {
        return closePromise;
      }
      closed = true;
      closePromise = (async () => {
        // A child timeout can abandon its awaited host reply while the
        // provider is still reading bytes or setting the input. Keep this
        // exact session attached, and block the caller's refresh, until every
        // effect that began before close has really stopped touching it.
        await Promise.all([...inFlightUploads]);
        // Detach is cleanup: it is attempted exactly once and cannot mask the
        // command/program outcome merely because the target disappeared first.
        const detach = () => detachWithoutHanging(session);
        await (hooks.release?.(detach, inFlightCommands.size > 0) ?? detach());
      })();
      return closePromise;
    },
  };

  return Object.freeze(commandSession);
}
