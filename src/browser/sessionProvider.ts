import type { BrowserController } from './controller.js';

/**
 * Creates browser sessions without exposing where or how they are hosted.
 *
 * Local Chrome and remote services such as Browserbase can implement this
 * seam independently. Each call returns a live controller with no active
 * task tab; the caller owns that session and must close the controller.
 */
export interface BrowserSessionProvider {
  createSession(): Promise<BrowserController>;
}
