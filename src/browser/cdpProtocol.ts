import type { CDPSession } from 'playwright';

export type ArbitraryCdpSend = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

/** Playwright types only the CDP methods known by its installed protocol
 * snapshot; Chrome remains the validator for newer methods. */
export function arbitraryCdpSend(session: CDPSession): ArbitraryCdpSend {
  return session.send.bind(session) as unknown as ArbitraryCdpSend;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
