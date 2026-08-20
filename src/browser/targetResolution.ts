/**
 * Shared CDP target resolution.
 *
 * One home for "which Chromium target is behind this Playwright Page" and for
 * validating Target.* protocol responses. The controller, the target-control
 * capability, and the command session previously each carried a private copy
 * of this flow; their genuinely different per-site semantics — silent
 * undefined versus throw-with-deadline, error redaction/wrapping, containment
 * of a late attachment — remain parameterized at each call site rather than
 * flattened here.
 */
import type { BrowserContext, CDPSession, Page } from 'playwright';

import { raceWithDeadline, settleWithin } from './boundedSettlement.js';
import { arbitraryCdpSend, isRecord } from './cdpProtocol.js';

const MAX_CDP_ID_BYTES = 4_096;
const SESSION_DETACH_TIMEOUT_MS = 1_000;

/** The Target.getTargetInfo fields this codebase consumes. Fields it ignores
 * are deliberately not validated. */
export interface CdpTargetInfo {
  targetId: string;
  type: string;
  url: string;
  browserContextId?: string;
}

export function isNonEmptyCdpId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_CDP_ID_BYTES
  );
}

function optionalNonEmptyCdpId(value: unknown, present: boolean): value is string | undefined {
  return !present || isNonEmptyCdpId(value);
}

/** Strictly validate one Target.* target record. `invalid` supplies each call
 * site's exact error type; the message is uniform per operation. */
export function parseTargetInfo(
  value: unknown,
  operation: string,
  invalid: (message: string) => Error,
): CdpTargetInfo {
  if (!isRecord(value)) {
    throw invalid(`${operation} returned an invalid target record.`);
  }

  const hasBrowserContextId = Object.hasOwn(value, 'browserContextId');
  if (
    !isNonEmptyCdpId(value.targetId) ||
    typeof value.type !== 'string' ||
    value.type.length === 0 ||
    typeof value.url !== 'string' ||
    !optionalNonEmptyCdpId(value.browserContextId, hasBrowserContextId)
  ) {
    throw invalid(`${operation} returned an invalid target record.`);
  }

  return {
    targetId: value.targetId,
    type: value.type,
    url: value.url,
    ...(hasBrowserContextId ? { browserContextId: value.browserContextId } : {}),
  };
}

/** Strictly validate a `{ targetInfo }` response envelope. */
export function parseTargetInfoResponse(
  value: unknown,
  operation: string,
  invalid: (message: string) => Error,
): CdpTargetInfo {
  if (!isRecord(value) || !Object.hasOwn(value, 'targetInfo')) {
    throw invalid(`${operation} returned an invalid response.`);
  }
  return parseTargetInfo(value.targetInfo, operation, invalid);
}

/** Strictly validate a Target.getTargets `{ targetInfos }` response. */
export function parseTargetListResponse(
  value: unknown,
  invalid: (message: string) => Error,
): CdpTargetInfo[] {
  if (!isRecord(value) || !Array.isArray(value.targetInfos)) {
    throw invalid('Target.getTargets returned an invalid response.');
  }
  return value.targetInfos.map((target) => parseTargetInfo(target, 'Target.getTargets', invalid));
}

/** Lenient extraction: the target id behind a Target.getTargetInfo response,
 * or undefined when the envelope or id is unusable. For call sites whose
 * policy is "no evidence" rather than a loud protocol failure. */
export function targetIdFromTargetInfoResponse(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.targetInfo)) return undefined;
  const targetId = value.targetInfo.targetId;
  return typeof targetId === 'string' && targetId.length > 0 ? targetId : undefined;
}

/** Require the target id behind a Target.getTargetInfo response, with the
 * call site supplying its exact per-shape error. */
export function requireTargetIdFromResponse(
  value: unknown,
  invalidResponse: () => Error,
  invalidTargetId: () => Error,
): string {
  if (!isRecord(value) || !isRecord(value.targetInfo)) throw invalidResponse();
  const targetId = value.targetInfo.targetId;
  if (typeof targetId !== 'string' || targetId.length === 0) throw invalidTargetId();
  return targetId;
}

/** Detach a CDP session as bounded cleanup: never rejects, never hangs, and
 * cannot mask the outcome the caller is already propagating. */
export async function detachSessionWithinDeadline(session: CDPSession): Promise<void> {
  let effect: Promise<unknown>;
  try {
    effect = session.detach();
  } catch {
    return;
  }
  await settleWithin(effect, SESSION_DETACH_TIMEOUT_MS);
}

export interface CdpSessionAttachment {
  /** Hard bound on the attachment await. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Error rejected at the deadline. */
  onTimeout: () => Error;
  /** Per-site redaction/wrapping of a synchronous throw or rejection. */
  mapError: (error: unknown) => unknown;
  /** Receives the bounded-detach containment of a session that attaches after
   * the caller's deadline. When omitted, that containment is still created
   * and fully observed, just not tracked by the caller. */
  onLateAttachment?: (containment: Promise<void>) => void;
}

/**
 * Attach a CDP session within a deadline, guaranteeing a session that arrives
 * after the caller has been released is still detached rather than leaked.
 */
export async function attachCdpSessionWithinDeadline(
  begin: () => Promise<CDPSession>,
  options: CdpSessionAttachment,
): Promise<CDPSession> {
  let attachment: Promise<CDPSession>;
  try {
    attachment = begin();
  } catch (error) {
    throw options.mapError(error);
  }
  try {
    return await raceWithDeadline(() => attachment, {
      timeoutMs: options.timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onTimeout: options.onTimeout,
      mapError: options.mapError,
    });
  } catch (error) {
    const containment = attachment.then(
      (lateSession) => detachSessionWithinDeadline(lateSession),
      () => undefined,
    );
    options.onLateAttachment?.(containment);
    throw error;
  }
}

export interface SessionTargetInspection {
  /** Operation label used in deadline and driver-error messages. */
  operation: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Constructs the call site's error type for timeouts and invalid protocol
   * shapes. The parse-failure message is always labeled Target.getTargetInfo. */
  makeError: (message: string) => Error;
  /** Per-site redaction/wrapping of driver errors, given the operation label. */
  mapError: (operation: string, error: unknown) => unknown;
}

/** Send Target.getTargetInfo over an existing session within a deadline and
 * strictly validate the response. The session's lifecycle stays with the
 * caller. */
export async function getTargetInfoThroughSession(
  session: CDPSession,
  options: SessionTargetInspection,
): Promise<CdpTargetInfo> {
  const response = await raceWithDeadline(() => arbitraryCdpSend(session)('Target.getTargetInfo'), {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onTimeout: () => options.makeError(`${options.operation} timed out.`),
    mapError: (error) => options.mapError(options.operation, error),
  });
  return parseTargetInfoResponse(response, 'Target.getTargetInfo', options.makeError);
}

/** Silent variant: any failure — attach, inspect, or shape — is "no
 * evidence", never an error, and the throwaway session always detaches
 * (unbounded, error-swallowed, exactly as the ownership scans have always
 * behaved). */
export interface SilentPageTargetResolution {
  failureMode: 'silent';
}

/** Loud variant: every phase runs under the caller's deadline, driver errors
 * pass through the caller's redaction, and a late attachment is contained. */
export interface DeadlinePageTargetResolution extends Omit<SessionTargetInspection, 'operation'> {
  failureMode: 'deadline';
  /** Label for attachment-phase deadline/driver errors. */
  attachOperation: string;
  /** Label for inspection-phase deadline/driver errors. */
  inspectOperation: string;
  onLateAttachment?: (containment: Promise<void>) => void;
}

export type PageTargetResolution = SilentPageTargetResolution | DeadlinePageTargetResolution;

/**
 * Resolve the CDP target behind a Playwright Page through a throwaway
 * attached session: attach → Target.getTargetInfo → validate → detach.
 *
 * The failure mode is the call site's choice: 'silent' answers ownership
 * scans that must treat an unreadable page as no evidence, while 'deadline'
 * serves capability paths that must fail loudly, boundedly, and redacted.
 */
export function resolvePageTarget(
  context: BrowserContext,
  page: Page,
  resolution: DeadlinePageTargetResolution,
): Promise<CdpTargetInfo>;
export function resolvePageTarget(
  context: BrowserContext,
  page: Page,
  resolution: SilentPageTargetResolution,
): Promise<string | undefined>;
export async function resolvePageTarget(
  context: BrowserContext,
  page: Page,
  resolution: PageTargetResolution,
): Promise<CdpTargetInfo | string | undefined> {
  if (resolution.failureMode === 'silent') {
    let session: CDPSession | undefined;
    try {
      session = await context.newCDPSession(page);
      const response = await arbitraryCdpSend(session)('Target.getTargetInfo');
      return targetIdFromTargetInfoResponse(response);
    } catch {
      return undefined;
    } finally {
      await session?.detach().catch(() => undefined);
    }
  }

  const session = await attachCdpSessionWithinDeadline(() => context.newCDPSession(page), {
    timeoutMs: resolution.timeoutMs,
    ...(resolution.signal === undefined ? {} : { signal: resolution.signal }),
    onTimeout: () => resolution.makeError(`${resolution.attachOperation} timed out.`),
    mapError: (error) => resolution.mapError(resolution.attachOperation, error),
    ...(resolution.onLateAttachment === undefined
      ? {}
      : { onLateAttachment: resolution.onLateAttachment }),
  });
  try {
    return await getTargetInfoThroughSession(session, {
      operation: resolution.inspectOperation,
      timeoutMs: resolution.timeoutMs,
      ...(resolution.signal === undefined ? {} : { signal: resolution.signal }),
      makeError: resolution.makeError,
      mapError: resolution.mapError,
    });
  } finally {
    await detachSessionWithinDeadline(session);
  }
}
