/**
 * Target-scoped CDP proxy for attached local Chrome.
 *
 * Playwright's `connectOverCDP` auto-attaches to every target already open in
 * the browser and does not resolve until each page has finished initializing.
 * A tab Chrome has discarded (Memory Saver, lazy session restore) has no
 * renderer to answer `Page.enable`, so one sleeping tab stalls the whole
 * connection until it times out. This proxy sits between Playwright and
 * Chrome, probes every pre-existing page once with a bounded command, and
 * hides the ones that never answer — plus anything they later open — so
 * Playwright never attaches to, instruments, or waits on a sleeping tab.
 *
 * Live pre-existing pages stay visible on purpose: durable run recovery must
 * still find a crashed run's own task pages by their in-page marker after a
 * fresh client reconnects, and those pages are pre-existing to that client.
 *
 * One upstream connection (one Chrome approval prompt) serves the whole
 * session. The local endpoint is loopback-only with a random path and is the
 * same session-control capability as the upstream one: this module never
 * logs or reports either, and every error it throws is safe to display.
 */

import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';

import { assertLoopbackCdpUrl, CDP_LOOPBACK_HOST } from './cdpEndpoint.js';

/** Matches Playwright's own client bound so large screenshots pass through. */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_TIMEOUT_MS = 5_000;
/** A live renderer answers in milliseconds; a discarded tab never answers. */
const PAGE_PROBE_TIMEOUT_MS = 1_500;
const CLOSE_TIMEOUT_MS = 2_000;
const CLOSE_GOING_AWAY = 1001;

/** An operator-facing error which never carries either endpoint. */
export class ScopedCdpProxyError extends Error {}

/** A live proxy: hand `endpoint` to Playwright, close it after disconnecting. */
export interface ScopedCdpProxy {
  readonly endpoint: string;
  /** Number of targets hidden so far (unresponsive at attach, or opened by
   * one that was); diagnostics only. */
  readonly hiddenTargetCount: number;
  close(): Promise<void>;
}

export interface ScopedCdpProxyOptions {
  /** Bound for the upstream handshake, which Chrome holds until the user
   * approves its remote-debugging prompt. */
  connectionTimeoutMs: number;
}

type CdpMessage = {
  id?: unknown;
  method?: unknown;
  sessionId?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseMessage(data: WebSocket.RawData, isBinary: boolean): CdpMessage | undefined {
  if (isBinary) return undefined;
  try {
    const parsed: unknown = JSON.parse(rawDataToString(data));
    return isRecord(parsed) ? (parsed as CdpMessage) : undefined;
  } catch {
    return undefined;
  }
}

function rawDataToString(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/** Resolve an HTTP discovery endpoint to Chrome's browser WebSocket URL. */
async function resolveBrowserWebSocketUrl(cdpEndpoint: string): Promise<string> {
  const parsed = assertLoopbackCdpUrl(cdpEndpoint);
  if (parsed.protocol === 'ws:') return cdpEndpoint;
  if (parsed.protocol !== 'http:') {
    throw new ScopedCdpProxyError('Attached Chrome endpoint must be a loopback HTTP or ws URL.');
  }

  let body: unknown;
  try {
    const response = await fetch(new URL('/json/version', parsed), {
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    body = await response.json();
  } catch {
    throw new ScopedCdpProxyError(
      'Chrome did not answer its HTTP discovery endpoint. Chrome enabled from ' +
        'chrome://inspect exposes only its WebSocket endpoint; use automatic discovery.',
    );
  }
  const url = isRecord(body) ? body.webSocketDebuggerUrl : undefined;
  if (typeof url !== 'string') {
    throw new ScopedCdpProxyError('Chrome discovery response had no browser WebSocket URL.');
  }
  const resolved = assertLoopbackCdpUrl(url);
  if (resolved.protocol !== 'ws:') {
    throw new ScopedCdpProxyError('Chrome discovery returned a non-loopback WebSocket URL.');
  }
  return url;
}

/** Open the upstream socket; Chrome holds the handshake until approval. */
function connectUpstream(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      perMessageDeflate: false,
      maxPayload: MAX_PAYLOAD_BYTES,
      handshakeTimeout: timeoutMs,
    });
    const onOpen = (): void => {
      socket.off('error', onError);
      resolve(socket);
    };
    const onError = (error: Error): void => {
      socket.off('open', onOpen);
      socket.terminate();
      reject(
        new ScopedCdpProxyError(
          /timed out/iu.test(error.message)
            ? `Chrome did not approve the remote-debugging connection within ${Math.ceil(
                timeoutMs / 1_000,
              )} seconds.`
            : 'Chrome refused the remote-debugging connection.',
        ),
      );
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
}

/**
 * The forwarding core. Client ids are rewritten so the proxy's own commands
 * (`Target.getTargets` snapshot, `Target.detachFromTarget` for hidden
 * sessions) never collide with Playwright's id sequence.
 */
class ScopedCdpRelay {
  private readonly hiddenTargets = new Set<string>();
  private readonly hiddenSessions = new Set<string>();
  private readonly clientIds = new Map<number, unknown>();
  private readonly internal = new Map<number, (message: CdpMessage) => void>();
  private nextId = 1;
  private client: WebSocket | undefined;

  constructor(private readonly upstream: WebSocket) {
    upstream.on('message', (data, isBinary) => this.onUpstreamMessage(data, isBinary));
  }

  get hiddenTargetCount(): number {
    return this.hiddenTargets.size;
  }

  /** Probe every pre-existing page once; hide the ones that never answer. */
  async snapshot(): Promise<void> {
    const response = await this.sendInternal('Target.getTargets', {}, SNAPSHOT_TIMEOUT_MS);
    const infos = isRecord(response.result) ? response.result.targetInfos : undefined;
    if (!Array.isArray(infos)) {
      throw new ScopedCdpProxyError('Chrome returned an invalid target inventory.');
    }
    const pageIds = infos.flatMap((info) =>
      isRecord(info) && info.type === 'page' && typeof info.targetId === 'string'
        ? [info.targetId]
        : [],
    );
    await Promise.all(
      pageIds.map(async (targetId) => {
        if (!(await this.pageAnswers(targetId))) this.hiddenTargets.add(targetId);
      }),
    );
  }

  /**
   * `Target.attachToTarget` is answered by the browser process; the trivial
   * `Runtime.evaluate` needs the renderer, which a discarded tab lacks. Any
   * reply at all — even a protocol error — proves the page is live.
   */
  private async pageAnswers(targetId: string): Promise<boolean> {
    let sessionId: string | undefined;
    try {
      const attach = await this.sendInternal(
        'Target.attachToTarget',
        { targetId, flatten: true },
        PAGE_PROBE_TIMEOUT_MS,
      );
      const attached = isRecord(attach.result) ? attach.result.sessionId : undefined;
      if (typeof attached !== 'string') return false;
      sessionId = attached;
      // Nothing this session emits is for Playwright, before or after it
      // connects; the detach below retires it.
      this.hiddenSessions.add(sessionId);
      await this.sendInternal(
        'Runtime.evaluate',
        { expression: '1', returnByValue: true },
        PAGE_PROBE_TIMEOUT_MS,
        sessionId,
      );
      return true;
    } catch {
      return false;
    } finally {
      if (sessionId !== undefined) {
        this.sendInternal('Target.detachFromTarget', { sessionId }, SNAPSHOT_TIMEOUT_MS).catch(
          () => undefined,
        );
      }
    }
  }

  attachClient(client: WebSocket): void {
    this.client = client;
    client.on('message', (data, isBinary) => this.onClientMessage(data, isBinary));
  }

  private onClientMessage(data: WebSocket.RawData, isBinary: boolean): void {
    const message = parseMessage(data, isBinary);
    if (message === undefined) {
      this.client?.close(CLOSE_GOING_AWAY, 'malformed CDP message');
      return;
    }
    if (message.id !== undefined) {
      const proxyId = this.nextId++;
      this.clientIds.set(proxyId, message.id);
      message.id = proxyId;
    }
    this.sendUpstream(message);
  }

  private onUpstreamMessage(data: WebSocket.RawData, isBinary: boolean): void {
    const message = parseMessage(data, isBinary);
    if (message === undefined) return;

    if (typeof message.id === 'number') {
      const resolveInternal = this.internal.get(message.id);
      if (resolveInternal !== undefined) {
        this.internal.delete(message.id);
        resolveInternal(message);
        return;
      }
      const proxyId = message.id;
      if (!this.clientIds.has(proxyId)) return;
      message.id = this.clientIds.get(proxyId);
      this.clientIds.delete(proxyId);
      this.forwardToClient(message);
      return;
    }

    if (typeof message.sessionId === 'string' && this.hiddenSessions.has(message.sessionId)) {
      // A nested auto-attach under a hidden page session must be hidden too.
      if (message.method === 'Target.attachedToTarget') this.hideAttachedTarget(message);
      if (message.method === 'Target.detachedFromTarget') this.forgetDetached(message);
      return;
    }

    if (message.method === 'Target.attachedToTarget' && this.shouldHide(message)) {
      this.hideAttachedTarget(message);
      return;
    }

    if (message.method === 'Target.detachedFromTarget' && this.forgetDetached(message)) return;

    this.forwardToClient(message);
  }

  /** True when the detached session was one this relay hid. */
  private forgetDetached(message: CdpMessage): boolean {
    const sessionId = isRecord(message.params) ? message.params.sessionId : undefined;
    return typeof sessionId === 'string' && this.hiddenSessions.delete(sessionId);
  }

  /** Unresponsive pre-existing targets, and anything they open, stay hidden. */
  private shouldHide(message: CdpMessage): boolean {
    const info = isRecord(message.params) ? message.params.targetInfo : undefined;
    if (!isRecord(info) || typeof info.targetId !== 'string') return false;
    if (this.hiddenTargets.has(info.targetId)) return true;
    return typeof info.openerId === 'string' && this.hiddenTargets.has(info.openerId);
  }

  private hideAttachedTarget(message: CdpMessage): void {
    if (!isRecord(message.params)) return;
    const info = message.params.targetInfo;
    if (isRecord(info) && typeof info.targetId === 'string') this.hiddenTargets.add(info.targetId);
    const sessionId = message.params.sessionId;
    if (typeof sessionId !== 'string') return;
    this.hiddenSessions.add(sessionId);
    // Browser-side, so it completes even for a discarded tab. The reply is
    // consumed internally; `detachedFromTarget` is swallowed above.
    this.sendInternal('Target.detachFromTarget', { sessionId }, SNAPSHOT_TIMEOUT_MS).catch(
      () => undefined,
    );
  }

  private sendInternal(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    sessionId?: string,
  ): Promise<CdpMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.internal.delete(id);
        reject(new ScopedCdpProxyError(`Chrome did not answer ${method} in time.`));
      }, timeoutMs);
      this.internal.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.sendUpstream({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) });
    });
  }

  private sendUpstream(message: CdpMessage): void {
    if (this.upstream.readyState !== WebSocket.OPEN) return;
    this.upstream.send(JSON.stringify(message));
  }

  private forwardToClient(message: CdpMessage): void {
    if (this.client === undefined || this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(JSON.stringify(message));
  }
}

function closeSocket(socket: WebSocket | undefined, code: number): Promise<void> {
  if (socket === undefined || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      finish();
    }, CLOSE_TIMEOUT_MS);
    const finish = (): void => {
      clearTimeout(timer);
      socket.off('close', finish);
      resolve();
    };
    socket.once('close', finish);
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket.close(code);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/**
 * Connect to Chrome, snapshot its targets, and serve a loopback endpoint
 * that Playwright can connect to as if it were the browser itself.
 */
export async function openScopedCdpProxy(
  cdpEndpoint: string,
  options: ScopedCdpProxyOptions,
): Promise<ScopedCdpProxy> {
  const upstreamUrl = await resolveBrowserWebSocketUrl(cdpEndpoint);
  const upstream = await connectUpstream(upstreamUrl, options.connectionTimeoutMs);
  const relay = new ScopedCdpRelay(upstream);

  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  const path = `/${randomBytes(24).toString('base64url')}`;
  let client: WebSocket | undefined;
  let closing = false;

  const teardown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.all([
      closeSocket(client, CLOSE_GOING_AWAY),
      closeSocket(upstream, CLOSE_GOING_AWAY),
      closeServer(server),
    ]);
  };

  server.on('upgrade', (request, socket, head) => {
    if (client !== undefined || closing || request.url !== path) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (accepted) => {
      client = accepted;
      relay.attachClient(accepted);
      // Playwright disconnecting ends the Chrome session; Chrome dropping
      // the session ends Playwright's, so `browser.on('disconnected')` fires.
      accepted.once('close', () => void teardown());
    });
  });
  upstream.once('close', () => void teardown());
  upstream.once('error', () => void teardown());

  try {
    await relay.snapshot();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, CDP_LOOPBACK_HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await teardown();
    throw error instanceof ScopedCdpProxyError
      ? error
      : new ScopedCdpProxyError('Could not start the local Chrome attach proxy.');
  }

  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `ws://${CDP_LOOPBACK_HOST}:${port}${path}`,
    get hiddenTargetCount() {
      return relay.hiddenTargetCount;
    },
    close: teardown,
  };
}
