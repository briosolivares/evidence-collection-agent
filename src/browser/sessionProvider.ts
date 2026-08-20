import { z } from 'zod';

import type { BrowserController } from './controller.js';

/** Operator-visible state emitted while a provider prepares one session. */
export interface BrowserSessionCreationOptions {
  /** Safe setup text for the interactive UI. Must never contain a connection
   * endpoint or provider credential. Providers with no setup flow ignore it. */
  onSetupState?: (message: string) => void;
}

/**
 * Creates browser sessions without exposing where or how they are hosted.
 *
 * Local Chrome and remote services such as Browserbase can implement this
 * seam independently. Each call returns a live controller with no active
 * task tab; the caller owns that session and must close the controller.
 */
export interface BrowserSessionProvider {
  createSession(options?: BrowserSessionCreationOptions): Promise<BrowserController>;
}

/** Which runtime hosts a browser session. Provider selection is always
 * explicit (see `resolveBrowserProviderKind`) so merely holding a
 * Browserbase API key cannot silently start billable remote sessions. */
export type BrowserProviderKind = 'local' | 'browserbase';

/** The Zod counterpart of `BrowserProviderKind`, shared by every schema that
 * persists or reports a provider kind (durable run configuration, artifact
 * inspection manifests, finish facts). The `satisfies` tie keeps the two
 * declarations from drifting apart. */
export const browserProviderKindSchema = z.enum([
  'local',
  'browserbase',
] satisfies readonly BrowserProviderKind[]);

/**
 * Provider-neutral, user-facing facts about one live browser session.
 *
 * Everything here may be printed to a local terminal, recorded in runtime
 * diagnostics, or offered to a human for takeover. What is deliberately
 * ABSENT is the remote CDP connection URL: that is a full session-control
 * capability, and the invariant this codebase keeps is that it never reaches
 * a log, a transcript, a model-visible tool result, a run artifact, or a
 * child process environment. Diagnostics exist so observability does not
 * need it.
 *
 * The vendor session id is a correlation field only — the run directory and
 * its manifest remain the run's identity and provenance boundary.
 */
export interface BrowserSessionDiagnostics {
  /** Which runtime hosts this session. */
  provider: BrowserProviderKind;
  /** Vendor session id, when the provider has one (Browserbase). */
  sessionId?: string;
  /** Live View URL a human can open to watch or take over the session.
   * Local-user-interface only — never a tool result or artifact. */
  liveViewUrl?: string;
  /** Session inspector/recording URL, for after-the-fact review. */
  recordingUrl?: string;
}
