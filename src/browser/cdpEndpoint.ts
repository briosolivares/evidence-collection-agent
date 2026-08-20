/** Optional explicit loopback endpoint for attached local Chrome. */
export const ATTACHED_CHROME_ENDPOINT_ENV_VAR = 'SHERLOCK_CHROME_CDP_ENDPOINT';

/** The only host Chrome session-control endpoints may use locally. */
export const CDP_LOOPBACK_HOST = '127.0.0.1';

/** Reject any CDP URL that is not addressed to loopback. */
export function assertLoopbackCdpUrl(cdpUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    throw new TypeError(`CDP URL is not a valid URL: ${cdpUrl}`);
  }
  if (parsed.hostname !== CDP_LOOPBACK_HOST && parsed.hostname !== 'localhost') {
    throw new TypeError(
      `CDP URL must use a loopback host, got ${JSON.stringify(parsed.hostname)}: ${cdpUrl}`,
    );
  }
}
