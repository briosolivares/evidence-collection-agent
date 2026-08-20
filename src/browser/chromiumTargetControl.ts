import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';

import { raceWithDeadline } from './boundedSettlement.js';
import { arbitraryCdpSend, isRecord, type ArbitraryCdpSend } from './cdpProtocol.js';
import {
  attachCdpSessionWithinDeadline,
  detachSessionWithinDeadline,
  getTargetInfoThroughSession,
  isNonEmptyCdpId,
  parseTargetInfoResponse,
  parseTargetListResponse,
  resolvePageTarget,
  type CdpTargetInfo as TargetInfo,
} from './targetResolution.js';

const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
const MAX_OPERATION_TIMEOUT_MS = 60_000;
const DETACH_TIMEOUT_MS = 1_000;
const MAX_TARGET_URL_BYTES = 16_384;
const MAX_READ_ONLY_INVENTORY_ATTEMPTS = 2;

interface TargetMetadata {
  targetId: string;
}

const TARGET_REF_BRAND: unique symbol = Symbol('ChromiumPageTargetRef');

/**
 * Opaque identity for one exact Chromium page target.
 *
 * The raw CDP target id stays inside this module. A ref is accepted only by
 * the control instance that minted it, which prevents a caller from closing
 * an arbitrary target by supplying an id from another browser or context.
 */
export interface ChromiumPageTargetRef {
  readonly [TARGET_REF_BRAND]: true;
}

export interface ChromiumTargetOperationOptions {
  /** Optional run/user cancellation. An internal deadline applies even when
   * this signal is absent or never aborts. */
  signal?: AbortSignal;
}

/** A context-scoped inventory entry. The URL is validated and the identity
 * remains opaque and control-bound. */
export interface ChromiumPageTarget {
  ref: ChromiumPageTargetRef;
  url: string;
}

interface ChromiumTargetControlBaseOptions extends ChromiumTargetOperationOptions {
  /** The exact Playwright context this capability is confined to. */
  context: BrowserContext;
  /** Per-operation hard bound. Defaults to five seconds. */
  operationTimeoutMs?: number;
}

interface ChromiumTargetControlTestHooks {
  /** Awaited immediately after a create receipt is converted to an opaque
   * ref, before any follow-up target inspection. */
  afterTargetCreated?: (target: ChromiumPageTargetRef) => Promise<void> | void;
}

export type ChromiumTargetControlOptions = ChromiumTargetControlBaseOptions &
  (
    | {
        /** A live page already known to belong to `context`. It is used only
         * to attach a Target-domain CDP session and is never navigated or
         * closed. */
        anchorPage: Page;
        browser?: never;
      }
    | {
        /** Browser-scoped session source. This variant opens no page and is
         * therefore safe for attached-provider setup across SIGKILL. */
        browser: Browser;
        anchorPage?: never;
      }
  );

/**
 * Provider-internal Chromium page-target operations.
 *
 * No endpoint, provider credential, run id, or raw CDP target id crosses this
 * boundary. Every operation is confined to the BrowserContext established by
 * the anchor page and has a finite internal deadline.
 */
export interface ChromiumTargetControl {
  listPageTargets(options?: ChromiumTargetOperationOptions): Promise<readonly ChromiumPageTarget[]>;
  createPageTarget(
    url: string,
    options?: ChromiumTargetOperationOptions,
  ): Promise<ChromiumPageTargetRef>;
  closeTarget(
    target: ChromiumPageTargetRef,
    options?: ChromiumTargetOperationOptions,
  ): Promise<void>;
  awaitPage(target: ChromiumPageTargetRef, options?: ChromiumTargetOperationOptions): Promise<Page>;
  /** Snapshot the currently tracked late-create/exact-close effects. This is
   * deliberately unbounded so a caller can use it as a truthful busy fence. */
  drainContainment(): Promise<void>;
  /** Detach the private CDP session. Idempotent and itself bounded. */
  close(): Promise<void>;
}

/** Errors intentionally contain no upstream Playwright error or `cause`:
 * either can retain a provider's session-control URL. */
export class ChromiumTargetControlError extends Error {}

/** Shared Target.* validation reports through this control's error type. */
function invalidTargetControlResponse(message: string): ChromiumTargetControlError {
  return new ChromiumTargetControlError(message);
}

function parseCreatedTargetId(value: unknown): string {
  if (!isRecord(value) || !isNonEmptyCdpId(value.targetId)) {
    throw new ChromiumTargetControlError('Target.createTarget returned an invalid response.');
  }
  return value.targetId;
}

function parseBrowserContextIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.browserContextIds)) {
    throw new ChromiumTargetControlError('Target.getBrowserContexts returned an invalid response.');
  }
  const ids: string[] = [];
  for (const candidate of value.browserContextIds) {
    if (!isNonEmptyCdpId(candidate) || ids.includes(candidate)) {
      throw new ChromiumTargetControlError(
        'Target.getBrowserContexts returned an invalid response.',
      );
    }
    ids.push(candidate);
  }
  return ids;
}

function parseCloseResponse(value: unknown): void {
  if (!isRecord(value) || typeof value.success !== 'boolean') {
    throw new ChromiumTargetControlError('Target.closeTarget returned an invalid response.');
  }
  if (!value.success) {
    throw new ChromiumTargetControlError('Chromium did not close the requested page target.');
  }
}

function validatedTargetUrl(value: unknown, operation: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_TARGET_URL_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ChromiumTargetControlError(`${operation} returned an invalid page URL.`);
  }
  try {
    if (new URL(value).href !== value) {
      throw new Error('not canonical');
    }
  } catch {
    throw new ChromiumTargetControlError(`${operation} returned an invalid page URL.`);
  }
  return value;
}

function requireTargetUrl(value: string): string {
  try {
    return validatedTargetUrl(value, 'Target URL');
  } catch {
    throw new TypeError('Chromium page target URL must be absolute and canonical.');
  }
}

function validateTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_OPERATION_TIMEOUT_MS) {
    throw new TypeError(
      `operationTimeoutMs must be an integer from 1 to ${MAX_OPERATION_TIMEOUT_MS}.`,
    );
  }
  return timeout;
}

function safeOperationError(
  operation: string,
  error: unknown,
  signal: AbortSignal | undefined,
): unknown {
  if (signal?.aborted && error === signal.reason) return error;
  if (error instanceof ChromiumTargetControlError) return error;
  return new ChromiumTargetControlError(`${operation} failed.`);
}

/** This control's deadline policy over the shared race: timeouts and driver
 * errors both surface as redacted {@link ChromiumTargetControlError}s while an
 * abort reason passes through untouched. */
function runWithDeadline<T>(
  operation: string,
  start: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return raceWithDeadline(start, {
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
    onTimeout: () => new ChromiumTargetControlError(`${operation} timed out.`),
    mapError: (error) => safeOperationError(operation, error, signal),
  });
}

function sameContext(target: TargetInfo, browserContextId: string | undefined): boolean {
  return target.browserContextId === browserContextId;
}

class PlaywrightChromiumTargetControl implements ChromiumTargetControl {
  private readonly sendRaw: ArbitraryCdpSend;
  private readonly targetIds = new WeakMap<object, TargetMetadata>();
  private readonly refsByTargetId = new Map<string, ChromiumPageTargetRef>();
  private readonly pendingContainments = new Set<Promise<void>>();
  private closePromise: Promise<void> | undefined;
  private closing = false;

  constructor(
    private readonly context: BrowserContext,
    private readonly session: CDPSession,
    private readonly browserContextId: string | undefined,
    private readonly operationTimeoutMs: number,
    private readonly afterTargetCreated:
      | ((target: ChromiumPageTargetRef) => Promise<void> | void)
      | undefined,
  ) {
    this.sendRaw = arbitraryCdpSend(session);
  }

  async listPageTargets(
    options: ChromiumTargetOperationOptions = {},
  ): Promise<readonly ChromiumPageTarget[]> {
    this.requireOpen();
    let response: unknown;
    for (let attempt = 1; attempt <= MAX_READ_ONLY_INVENTORY_ATTEMPTS; attempt += 1) {
      try {
        response = await this.send(
          'List Chromium page targets',
          'Target.getTargets',
          undefined,
          options.signal,
        );
        break;
      } catch (error) {
        if (attempt >= MAX_READ_ONLY_INVENTORY_ATTEMPTS || options.signal?.aborted) {
          throw error;
        }
        // Target.getTargets is a pure inventory read, so one bounded replay
        // is safe when an attached Chrome client transiently rejects while
        // other target sessions are detaching. Mutating commands never retry.
        await Promise.resolve();
      }
    }
    return Object.freeze(
      parseTargetListResponse(response, invalidTargetControlResponse)
        .filter((target) => target.type === 'page' && sameContext(target, this.browserContextId))
        .map((target) =>
          Object.freeze({
            ref: this.refFor(target.targetId),
            url: validatedTargetUrl(target.url, 'Target.getTargets'),
          }),
        ),
    );
  }

  async createPageTarget(
    url: string,
    options: ChromiumTargetOperationOptions = {},
  ): Promise<ChromiumPageTargetRef> {
    this.requireOpen();
    const exactUrl = requireTargetUrl(url);
    options.signal?.throwIfAborted();

    let effect: Promise<unknown>;
    try {
      effect = this.sendRaw('Target.createTarget', {
        url: exactUrl,
        ...(this.browserContextId === undefined ? {} : { browserContextId: this.browserContextId }),
      });
    } catch (error) {
      throw safeOperationError('Create Chromium page target', error, options.signal);
    }
    let createdTargetId: string | undefined;

    try {
      const response = await runWithDeadline(
        'Create Chromium page target',
        () => effect,
        this.operationTimeoutMs,
        options.signal,
      );
      createdTargetId = parseCreatedTargetId(response);
      const ref = this.refFor(createdTargetId);
      if (this.afterTargetCreated !== undefined) {
        await runWithDeadline(
          'Run Chromium target-created hook',
          () => Promise.resolve(this.afterTargetCreated!(ref)),
          this.operationTimeoutMs,
          options.signal,
        );
      }
      const target = await this.targetInfo(createdTargetId, options.signal);
      this.requireScopedPage(target, 'Created Chromium target');
      if (validatedTargetUrl(target.url, 'Target.getTargetInfo') !== exactUrl) {
        throw new ChromiumTargetControlError(
          'Created Chromium target did not retain its exact requested URL.',
        );
      }
      return ref;
    } catch (error) {
      if (createdTargetId !== undefined) {
        this.trackContainment(this.containCreatedTarget(createdTargetId));
      } else {
        const containment = effect.then(
          (response) => this.containCreatedTarget(parseCreatedTargetId(response)),
          () => undefined,
        );
        this.trackContainment(containment);
      }
      throw safeOperationError('Create Chromium page target', error, options.signal);
    }
  }

  async closeTarget(
    target: ChromiumPageTargetRef,
    options: ChromiumTargetOperationOptions = {},
  ): Promise<void> {
    this.requireOpen();
    const targetId = this.targetIdFor(target);
    const info = await this.targetInfo(targetId, options.signal);
    this.requireScopedPage(info, 'Requested Chromium target');

    let effect: Promise<unknown>;
    try {
      effect = this.sendRaw('Target.closeTarget', { targetId });
    } catch (error) {
      throw safeOperationError('Close Chromium page target', error, options.signal);
    }
    try {
      const response = await runWithDeadline(
        'Close Chromium page target',
        () => effect,
        this.operationTimeoutMs,
        options.signal,
      );
      parseCloseResponse(response);
      this.targetIds.delete(target as object);
      this.refsByTargetId.delete(targetId);
    } catch (error) {
      // Bounding the caller must not discard an already-issued exact-target
      // close. Retain the provider effect until it really settles so an epoch
      // cannot be declared quiescent while its mutation remains in flight.
      this.trackContainment(
        effect.then(
          (response) => {
            parseCloseResponse(response);
            this.targetIds.delete(target as object);
            this.refsByTargetId.delete(targetId);
          },
          () => undefined,
        ),
      );
      throw safeOperationError('Close Chromium page target', error, options.signal);
    }
  }

  async awaitPage(
    target: ChromiumPageTargetRef,
    options: ChromiumTargetOperationOptions = {},
  ): Promise<Page> {
    this.requireOpen();
    const targetId = this.targetIdFor(target);

    let stop = (): void => undefined;
    try {
      return await runWithDeadline(
        'Await exact Playwright page',
        () => {
          let settled = false;
          const inspected = new WeakSet<Page>();

          return new Promise<Page>((resolve, reject) => {
            const finish = (complete: () => void): void => {
              if (settled) return;
              settled = true;
              this.context.off('page', onPage);
              complete();
            };
            stop = () => finish(() => undefined);
            const inspect = (page: Page): void => {
              if (settled || inspected.has(page) || page.isClosed()) return;
              inspected.add(page);
              void this.targetIdForPage(page, options.signal).then(
                (pageTargetId) => {
                  if (pageTargetId === targetId) finish(() => resolve(page));
                },
                (error) => {
                  if (!page.isClosed()) finish(() => reject(error));
                },
              );
            };
            const onPage = (page: Page): void => inspect(page);

            this.context.on('page', onPage);
            let pages: Page[];
            try {
              pages = this.context.pages();
            } catch {
              finish(() =>
                reject(
                  new ChromiumTargetControlError(
                    'Could not enumerate the scoped Playwright context.',
                  ),
                ),
              );
              return;
            }
            for (const page of pages) inspect(page);
          });
        },
        this.operationTimeoutMs,
        options.signal,
      );
    } finally {
      stop();
    }
  }

  async drainContainment(): Promise<void> {
    await Promise.allSettled([...this.pendingContainments]);
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await runWithDeadline(
        'Drain Chromium target containment',
        () => this.drainContainment(),
        DETACH_TIMEOUT_MS,
      ).catch(() => undefined);
      await detachSessionWithinDeadline(this.session);
    })();
    return this.closePromise;
  }

  private requireOpen(): void {
    if (this.closing) {
      throw new ChromiumTargetControlError('Chromium target control is closed.');
    }
  }

  private async send(
    operation: string,
    method: string,
    params: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    this.requireOpen();
    return runWithDeadline(
      operation,
      () => this.sendRaw(method, params),
      this.operationTimeoutMs,
      signal,
    );
  }

  private async targetInfo(targetId: string, signal: AbortSignal | undefined): Promise<TargetInfo> {
    const response = await this.send(
      'Inspect Chromium page target',
      'Target.getTargetInfo',
      { targetId },
      signal,
    );
    const target = parseTargetInfoResponse(
      response,
      'Target.getTargetInfo',
      invalidTargetControlResponse,
    );
    if (target.targetId !== targetId) {
      throw new ChromiumTargetControlError(
        'Target.getTargetInfo returned a different target identity.',
      );
    }
    return target;
  }

  private requireScopedPage(target: TargetInfo, operation: string): void {
    if (target.type !== 'page' || !sameContext(target, this.browserContextId)) {
      throw new ChromiumTargetControlError(
        `${operation} is outside the bound Playwright browser context.`,
      );
    }
  }

  private refFor(targetId: string): ChromiumPageTargetRef {
    const existing = this.refsByTargetId.get(targetId);
    if (existing !== undefined) return existing;

    const ref = Object.freeze({ [TARGET_REF_BRAND]: true }) as ChromiumPageTargetRef;
    this.targetIds.set(ref, { targetId });
    this.refsByTargetId.set(targetId, ref);
    return ref;
  }

  private targetIdFor(target: ChromiumPageTargetRef): string {
    if ((typeof target !== 'object' && typeof target !== 'function') || target === null) {
      throw new ChromiumTargetControlError(
        'Chromium page target identity was not issued by this control.',
      );
    }
    const metadata = this.targetIds.get(target as object);
    if (metadata === undefined) {
      throw new ChromiumTargetControlError(
        'Chromium page target identity was not issued by this control.',
      );
    }
    return metadata.targetId;
  }

  private async targetIdForPage(page: Page, signal: AbortSignal | undefined): Promise<string> {
    const info = await resolvePageTarget(this.context, page, {
      failureMode: 'deadline',
      attachOperation: 'Attach to Playwright page target',
      inspectOperation: 'Inspect Playwright page target',
      timeoutMs: this.operationTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
      makeError: invalidTargetControlResponse,
      mapError: (operation, error) => safeOperationError(operation, error, signal),
      onLateAttachment: (containment) => this.trackContainment(containment),
    });
    this.requireScopedPage(info, 'Playwright page target');
    return info.targetId;
  }

  private containCreatedTarget(targetId: string): Promise<void> {
    // The create caller has already received its bounded failure. This is the
    // truthful fence: it stays pending until Chrome answers the exact close,
    // rather than timing out and permitting late mutation after quiescence.
    return this.sendRaw('Target.closeTarget', { targetId })
      .then((response) => {
        parseCloseResponse(response);
        const ref = this.refsByTargetId.get(targetId);
        if (ref !== undefined) this.targetIds.delete(ref as object);
        this.refsByTargetId.delete(targetId);
      })
      .catch(() => undefined);
  }

  private trackContainment(effect: Promise<void>): void {
    const observed = effect.catch(() => undefined);
    this.pendingContainments.add(observed);
    void observed.finally(() => this.pendingContainments.delete(observed));
  }
}

/**
 * Bind a Target-domain control to one exact Playwright BrowserContext.
 *
 * A managed provider may bind through a known-safe session page. An attached
 * provider instead supplies its Browser, which yields a browser-scoped CDP
 * session without creating an internal page whose commit could outlive a
 * SIGKILLed setup process.
 */
export async function createChromiumTargetControl(
  options: ChromiumTargetControlOptions,
  testHooks: ChromiumTargetControlTestHooks = {},
): Promise<ChromiumTargetControl> {
  const timeoutMs = validateTimeout(options.operationTimeoutMs);
  options.signal?.throwIfAborted();

  const session = await attachCdpSessionWithinDeadline(
    () => {
      if (options.browser !== undefined) {
        let contexts: BrowserContext[];
        try {
          contexts = options.browser.contexts();
        } catch {
          throw new ChromiumTargetControlError(
            'Could not enumerate browser contexts for target control.',
          );
        }
        if (!contexts.includes(options.context)) {
          throw new ChromiumTargetControlError(
            'Chromium target control requires its exact Playwright browser context.',
          );
        }
        return options.browser.newBrowserCDPSession();
      }
      const anchorPage = options.anchorPage;
      let pages: Page[];
      try {
        pages = options.context.pages();
      } catch {
        throw new ChromiumTargetControlError(
          'Could not enumerate the Playwright context for target control.',
        );
      }
      if (anchorPage.isClosed() || !pages.includes(anchorPage)) {
        throw new ChromiumTargetControlError(
          'Chromium target control requires a live anchor page from its exact context.',
        );
      }
      return options.context.newCDPSession(anchorPage);
    },
    {
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onTimeout: () => new ChromiumTargetControlError('Open Chromium target control timed out.'),
      mapError: (error) =>
        safeOperationError('Open Chromium target control', error, options.signal),
    },
  );

  try {
    const browserContextId =
      options.browser === undefined
        ? await inspectAnchorBrowserContextId(
            options.context,
            options.anchorPage,
            session,
            timeoutMs,
            options.signal,
          )
        : await inspectBrowserScopedContextId(options.context, session, timeoutMs, options.signal);
    return new PlaywrightChromiumTargetControl(
      options.context,
      session,
      browserContextId,
      timeoutMs,
      testHooks.afterTargetCreated,
    );
  } catch (error) {
    await detachSessionWithinDeadline(session);
    throw safeOperationError('Inspect Chromium target-control anchor', error, options.signal);
  }
}

async function inspectAnchorBrowserContextId(
  context: BrowserContext,
  anchorPage: Page,
  session: CDPSession,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  let pages: Page[];
  try {
    pages = context.pages();
  } catch {
    throw new ChromiumTargetControlError(
      'Could not enumerate the Playwright context for target control.',
    );
  }
  if (anchorPage.isClosed() || !pages.includes(anchorPage)) {
    throw new ChromiumTargetControlError('Chromium target-control anchor closed during setup.');
  }
  const anchor = await getTargetInfoThroughSession(session, {
    operation: 'Inspect Chromium target-control anchor',
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
    makeError: invalidTargetControlResponse,
    mapError: (operation, error) => safeOperationError(operation, error, signal),
  });
  if (anchor.type !== 'page') {
    throw new ChromiumTargetControlError('Chromium target-control anchor is not a page target.');
  }
  return anchor.browserContextId;
}

async function inspectBrowserScopedContextId(
  context: BrowserContext,
  browserSession: CDPSession,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  let pages: Page[];
  try {
    pages = context.pages();
  } catch {
    throw new ChromiumTargetControlError(
      'Could not enumerate the Playwright context for target control.',
    );
  }
  const page = pages.find((candidate) => !candidate.isClosed());
  if (page !== undefined) {
    const target = await resolvePageTarget(context, page, {
      failureMode: 'deadline',
      attachOperation: 'Inspect Chromium target-control context',
      inspectOperation: 'Inspect Chromium target-control context',
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
      makeError: invalidTargetControlResponse,
      mapError: (operation, error) => safeOperationError(operation, error, signal),
    });
    if (target.type !== 'page') {
      throw new ChromiumTargetControlError(
        'Chromium target-control context probe is not a page target.',
      );
    }
    return target.browserContextId;
  }

  const response = await runWithDeadline(
    'Inspect empty Chromium target-control context',
    () => arbitraryCdpSend(browserSession)('Target.getBrowserContexts'),
    timeoutMs,
    signal,
  );
  const browserContextIds = parseBrowserContextIds(response);
  if (browserContextIds.length > 1) {
    throw new ChromiumTargetControlError(
      'An empty Playwright context could not be mapped to one Chromium context.',
    );
  }
  return browserContextIds[0];
}
