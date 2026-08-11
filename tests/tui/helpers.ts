// Shared helpers for TUI component tests (ink-testing-library drives a
// fake stdin/stdout; state updates settle on the microtask/timer queue).

/** Let queued React/Ink work settle before asserting on frames. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The terminal Enter key, as ink-text-input expects it on stdin. */
export const ENTER = '\r';

/** The Escape key. */
export const ESC = '\u001b';

/** Type text into a rendered component's stdin one write at a time. */
export async function typeText(
  stdin: { write: (data: string) => void },
  text: string,
): Promise<void> {
  for (const char of text) {
    stdin.write(char);
    await tick();
  }
}
