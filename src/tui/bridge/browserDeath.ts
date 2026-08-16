/**
 * Recognize failures that make a session controller unsafe to reuse.
 *
 * Bare transport errors such as `socket hang up` and `ECONNRESET` are
 * intentionally excluded: they more often belong to a page request or model
 * call. Control-channel shutdown and failed task-page cleanup are included,
 * even if the user cancelled concurrently, because the next run needs a fresh
 * controller.
 */
export function isBrowserDeathMessage(message: string): boolean {
  return /browser has been closed|context or browser has been closed|browser session is closed|browserContext\.|Target closed|browser process crashed|has been disconnected|Browser closed|Connection closed|remains bound after failed task-page cleanup|task-page ownership cleanup previously failed|terminal cleanup failed:\s*browser pages/i.test(
    message,
  );
}
