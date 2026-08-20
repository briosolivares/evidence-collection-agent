/** Type declarations for ipcShared.mjs (plain JS so the stock-Node child can import it). */

export declare const MAX_ERROR_NAME_BYTES: number;
export declare const MAX_ERROR_MESSAGE_BYTES: number;
export declare const MAX_ERROR_STACK_BYTES: number;

export declare function truncateUtf8(value: string, maxBytes: number): string;

export declare function structuredError(
  thrown: unknown,
  transform?: (text: string) => string,
): { name: string; message: string; stack?: string };

export declare function serializedSize(value: unknown): number;

export declare function isRecord(value: unknown): value is Record<string, unknown>;

export type BoundedIpcFailureKind = 'serialize' | 'oversized' | 'closed' | 'send';

export declare function sendBoundedIpc(
  message: unknown,
  options: {
    maxBytes: number;
    isConnected: () => boolean;
    send: (message: unknown) => void;
    fail: (kind: BoundedIpcFailureKind, error?: unknown) => void;
  },
): boolean;
