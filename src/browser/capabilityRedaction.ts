const WEBSOCKET_CAPABILITY_URL = /\bwss?:\/\/[^\s)'"\]]+/giu;
const HTTP_CDP_CAPABILITY_URL =
  /\bhttps?:\/\/[^\s)'"\]]*(?:\/devtools\/(?:browser|page)|browserbase|\/json\/version)[^\s)'"\]]*/giu;

export function redactBrowserCapabilities(value: string): string {
  return value
    .replace(WEBSOCKET_CAPABILITY_URL, '[REDACTED_WEBSOCKET_URL]')
    .replace(HTTP_CDP_CAPABILITY_URL, '[REDACTED_CDP_URL]');
}

export function safeBrowserErrorMessage(error: unknown): string {
  return redactBrowserCapabilities(error instanceof Error ? error.message : String(error));
}
