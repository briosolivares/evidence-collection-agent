import type { BrowserContext, CDPSession, Page } from 'playwright';

import type { BrowserCommandSession } from './controller.js';

/** Transport URLs are session-control capabilities. Even if a driver error
 * happens to echo one, it must stop at this controller-owned boundary. */
const TRANSPORT_URL = /\b(?:https?|wss?):\/\/[^\s"'<>]+/giu;
const DETACH_DEADLINE_MS = 1_000;

type ArbitraryCdpSend = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

export interface PlaywrightCommandSessionHooks {
  /** Replace raw Target.createTarget with a controller-owned crash-recoverable
   * creation path. The hook returns the ordinary CDP result shape, but the
   * target is durably claimed before that result reaches the caller. */
  createTargetCommand?: (params: Record<string, unknown>) => Promise<unknown>;
  /** Called after Chrome confirms a raw Target.createTarget command. The
   * controller uses the returned target id to claim only that page for task
   * cleanup; a concurrent user-created page is never inferred as owned. */
  onTargetCreated?: (targetId: string) => Promise<void>;
  /** Route dialog decisions through the controller's cached Playwright
   * Dialog. A prior timed-out evaluation may still own the original CDP
   * command, so a second raw session cannot reliably address it directly. */
  handleDialogCommand?: (params: Record<string, unknown>) => Promise<unknown>;
  /** Release the caller's session. The controller may take ownership of the
   * bounded detacher until a blocking dialog is answered. */
  release?: (detach: () => Promise<void>) => Promise<void>;
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
  hooks: PlaywrightCommandSessionHooks = {},
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
  const commandSession: BrowserCommandSession = {
    pageId,
    targetId,
    async send(method, params) {
      if (closed) {
        throw new Error(`Browser command session for pageId ${pageId} is closed.`);
      }
      try {
        const result =
          method === 'Page.handleJavaScriptDialog' &&
          hooks.handleDialogCommand !== undefined
            ? await hooks.handleDialogCommand(params ?? {})
            : method === 'Target.createTarget' &&
                hooks.createTargetCommand !== undefined
              ? await hooks.createTargetCommand(params ?? {})
              : await send(method, params);
        if (method === 'Target.createTarget' && hooks.onTargetCreated !== undefined) {
          const createdTargetId = (result as { targetId?: unknown })?.targetId;
          if (typeof createdTargetId !== 'string' || createdTargetId.length === 0) {
            throw new Error('Target.createTarget returned no target id');
          }
          await hooks.onTargetCreated(createdTargetId);
        }
        return result;
      } catch (error) {
        throw commandError(
          `CDP command ${JSON.stringify(method)} failed for pageId ${pageId}`,
          error,
        );
      }
    },
    close() {
      if (closePromise !== undefined) {
        return closePromise;
      }
      closed = true;
      // Detach is cleanup: it is attempted exactly once and cannot mask the
      // command/program outcome merely because the target disappeared first.
      const detach = () => detachWithoutHanging(session);
      closePromise = hooks.release?.(detach) ?? detach();
      return closePromise;
    },
  };

  return Object.freeze(commandSession);
}
