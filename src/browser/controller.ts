import type { BusyResourceRegistry } from '../tools/registry.js';
import type { BrowserSessionDiagnostics } from './sessionProvider.js';

/** Stable identity and safe location summary for one run-owned page. */
export interface BrowserPage {
  pageId: string;
  url: string;
  active: boolean;
}

/** A native JavaScript dialog that must be answered explicitly. */
export interface BrowserDialog {
  dialogId: string;
  pageId: string;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultValue?: string;
}

export interface BrowserScreenshotOptions {
  pageId?: string;
  fullPage?: boolean;
}

export interface BrowserDownloadResult {
  finalUrl: string;
  status?: number;
  headers: Readonly<Record<string, string>>;
  bytes: Uint8Array;
  suggestedFilename?: string;
}

/** A browser-native download source the worker can actually obtain. */
export type BrowserDownloadTarget = { pageId?: string } & (
  | { backendNodeId: number }
  | { url: string }
);

/** Cancellation for task-page creation/navigation. Implementations contain
 * any late browser effect before rejecting for an aborted signal. */
export interface BrowserOperationOptions {
  signal?: AbortSignal;
}

/** One safe task-page startup transaction. */
export interface BrowserTaskPagePreparation extends BrowserOperationOptions {
  ownershipId: string;
  startUrl?: string;
}

export type BrowserNavigationWaitUntil = 'domcontentloaded' | 'load';

export interface BrowserNavigationOptions {
  timeoutMs: number;
  waitUntil: BrowserNavigationWaitUntil;
}

export interface BrowserNavigationResult {
  pageId: string;
  targetId: string;
  url: string;
  title: string;
}

/** Provider-neutral command channel pinned to one exact live page. */
export interface BrowserCommandSession {
  readonly pageId: string;
  readonly targetId: string;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Navigate the pinned page and return only after the requested lifecycle
   * state, or after containing a bounded timeout/failure. */
  navigate(url: string, options: BrowserNavigationOptions): Promise<BrowserNavigationResult>;
  /** Attach one confined local file to an exact accessibility backend node. */
  upload(backendDOMNodeId: number, absolutePath: string): Promise<void>;
  close(): Promise<void>;
}

/** Minimal browser authority used by the sole production runtime. */
export interface BrowserController {
  screenshot(options?: BrowserScreenshotOptions): Promise<Uint8Array>;
  download(target: BrowserDownloadTarget): Promise<BrowserDownloadResult>;
  currentUrl(pageId?: string): string;
  pages(): Promise<BrowserPage[]>;
  openCommandSession(pageId?: string): Promise<BrowserCommandSession>;
  refreshAfterExternalCommands(): Promise<void>;
  listPendingDialogs(): readonly BrowserDialog[];

  /** Reclaim stale pages for one durable run before opening its new page. */
  initializeRunPageOwnership?(
    ownershipId: string,
    options?: BrowserOperationOptions,
  ): Promise<void>;

  /** Atomically reclaim, create, mark, and optionally navigate a task page. */
  prepareTaskPage?(request: BrowserTaskPagePreparation): Promise<void>;

  /** Close every page owned by the current run, preserving ambient user tabs. */
  closeTaskPages(): Promise<void>;

  /** Share the abandoned-effect ledger with the sequential runtime. */
  setBusyRegistry?(registry: BusyResourceRegistry): void;

  readonly sessionDiagnostics?: BrowserSessionDiagnostics;
  close(): Promise<void>;
}
