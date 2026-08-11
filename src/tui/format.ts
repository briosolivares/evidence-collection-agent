// Pure formatting helpers for the status line, completion line, and
// semantic activity lines. Kept free of Ink imports so they are trivially
// unit-testable.

/**
 * Format a token count compactly: `847 tokens` below 1000, `18.7k tokens`
 * (one decimal) from 1000 up.
 */
export function formatTokens(count: number): string {
  if (count < 1000) return `${count} tokens`;
  return `${(count / 1000).toFixed(1)}k tokens`;
}

/**
 * Format a duration naturally: `42s` below one minute, `1m 24s` from one
 * minute up. Sub-second durations round to whole seconds (`0s` minimum).
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/**
 * Truncate text to maxLength characters, replacing the overflow with a
 * single `…` so the result never exceeds maxLength.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Shorten a URL for a semantic activity line: protocol and a leading
 * `www.` are dropped, the host is kept, and the path/query is trimmed to
 * fit maxLength (`sec.gov/cgi-bin/browse-edgar…`). A string that does not
 * parse as a URL is simply truncated.
 */
export function shortenUrl(url: string, maxLength = 40): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return truncate(url, maxLength);
  }
  const host = parsed.host.replace(/^www\./, '');
  const rest = parsed.pathname === '/' && parsed.search === ''
    ? ''
    : `${parsed.pathname}${parsed.search}`;
  return truncate(`${host}${rest}`, maxLength);
}
