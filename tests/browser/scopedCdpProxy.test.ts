import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { openScopedCdpProxy, ScopedCdpProxyError } from '../../src/browser/scopedCdpProxy.js';

type CdpMessage = Record<string, unknown>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A stand-in for Chrome's browser endpoint: answers inventory, probe
 * attaches, and detaches; never answers renderer commands for a discarded
 * tab; records everything; and lets a test push events downstream. */
async function fakeChrome(
  targets: CdpMessage[],
  options: {
    discarded?: string[];
    onCommand?: (socket: WebSocket, message: CdpMessage) => boolean;
  } = {},
) {
  const discarded = new Set(options.discarded ?? []);
  const onCommand = options.onCommand ?? (() => false);
  const server = createServer((_request, response) => response.writeHead(404).end());
  const sockets = new WebSocketServer({ server });
  const received: CdpMessage[] = [];
  let socket: WebSocket | undefined;
  const closed = new Promise<void>((resolve) => {
    sockets.on('connection', (connection) => {
      socket = connection;
      connection.once('close', () => resolve());
      connection.on('message', (data) => {
        const message = JSON.parse(data.toString()) as CdpMessage;
        received.push(message);
        const params = (message.params ?? {}) as CdpMessage;
        if (message.method === 'Target.getTargets') {
          connection.send(JSON.stringify({ id: message.id, result: { targetInfos: targets } }));
        } else if (message.method === 'Target.attachToTarget') {
          connection.send(
            JSON.stringify({ id: message.id, result: { sessionId: `probe-${params.targetId}` } }),
          );
        } else if (
          typeof message.sessionId === 'string' &&
          discarded.has(message.sessionId.replace(/^probe-/u, ''))
        ) {
          // No renderer: the command is never answered.
        } else if (!onCommand(connection, message)) {
          connection.send(JSON.stringify({ id: message.id, result: {} }));
        }
      });
    });
  });
  const port = await listen(server);
  cleanups.push(async () => {
    sockets.close();
    await closeServer(server);
  });
  return {
    endpoint: `ws://127.0.0.1:${port}/devtools/browser/fake`,
    port,
    received,
    closed,
    emit: (message: CdpMessage) => socket?.send(JSON.stringify(message)),
    disconnect: () => socket?.close(1001),
  };
}

/** The Playwright side: a plain client on the proxy endpoint. */
async function fakeClient(endpoint: string) {
  const socket = new WebSocket(endpoint);
  const received: CdpMessage[] = [];
  const waiters: Array<() => void> = [];
  socket.on('message', (data) => {
    received.push(JSON.parse(data.toString()) as CdpMessage);
    for (const wake of waiters.splice(0)) wake();
  });
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  cleanups.push(() => socket.terminate());
  return {
    received,
    closed,
    send: (message: CdpMessage) => socket.send(JSON.stringify(message)),
    close: () => socket.close(1000),
    async waitFor(predicate: (message: CdpMessage) => boolean): Promise<CdpMessage> {
      for (;;) {
        const found = received.find(predicate);
        if (found !== undefined) return found;
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function attached(targetId: string, sessionId: string, extra: CdpMessage = {}): CdpMessage {
  return {
    method: 'Target.attachedToTarget',
    params: {
      sessionId,
      targetInfo: { targetId, type: 'page', url: 'about:blank', ...extra },
      waitingForDebugger: false,
    },
  };
}

describe('openScopedCdpProxy', () => {
  it('hides unresponsive pre-existing pages, their sessions, and what they open', async () => {
    const chrome = await fakeChrome(
      [
        { targetId: 'old-page', type: 'page' },
        { targetId: 'live-page', type: 'page' },
        { targetId: 'old-worker', type: 'service_worker' },
      ],
      {
        discarded: ['old-page'],
        onCommand: (socket, message) => {
          if (message.method !== 'Target.setAutoAttach') return false;
          // Chrome reports existing targets before acknowledging auto-attach.
          socket.send(JSON.stringify(attached('live-page', 'S-live')));
          socket.send(
            JSON.stringify(attached('old-worker', 'S-worker', { type: 'service_worker' })),
          );
          socket.send(JSON.stringify(attached('old-page', 'S-old')));
          socket.send(
            JSON.stringify({ method: 'Page.frameNavigated', sessionId: 'S-old', params: {} }),
          );
          // A nested auto-attach under a hidden page session, flattened.
          socket.send(
            JSON.stringify({
              ...attached('old-frame', 'S-old-frame', { type: 'iframe' }),
              sessionId: 'S-old',
            }),
          );
          socket.send(
            JSON.stringify(attached('popup-of-old', 'S-popup', { openerId: 'old-page' })),
          );
          socket.send(JSON.stringify(attached('sherlock-page', 'S-new')));
          socket.send(
            JSON.stringify({ method: 'Page.frameNavigated', sessionId: 'S-new', params: {} }),
          );
          socket.send(
            JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'S-old' } }),
          );
          socket.send(JSON.stringify({ id: message.id, result: {} }));
          return true;
        },
      },
    );
    const started = Date.now();
    const proxy = await openScopedCdpProxy(chrome.endpoint, { connectionTimeoutMs: 2_000 });
    cleanups.push(() => proxy.close());
    // The probe is bounded by the discarded tab, not by anything else.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(proxy.hiddenTargetCount).toBe(1);
    const probed = chrome.received
      .filter((message) => message.method === 'Target.attachToTarget')
      .map((message) => (message.params as CdpMessage).targetId);
    expect(probed.sort()).toEqual(['live-page', 'old-page']);
    expect(proxy.endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{20,}$/u);

    const client = await fakeClient(proxy.endpoint);
    client.send({ id: 7, method: 'Target.setAutoAttach', params: { autoAttach: true } });
    const reply = await client.waitFor((message) => message.id === 7);
    expect(reply).toEqual({ id: 7, result: {} });
    await settle();

    const seen = client.received.map((message) => [
      message.method,
      (message.params as CdpMessage | undefined)?.sessionId ?? message.sessionId,
    ]);
    expect(seen).toEqual([
      ['Target.attachedToTarget', 'S-live'],
      ['Target.attachedToTarget', 'S-worker'],
      ['Target.attachedToTarget', 'S-new'],
      ['Page.frameNavigated', 'S-new'],
      [undefined, undefined],
    ]);
    expect(proxy.hiddenTargetCount).toBe(3);

    const detached = chrome.received
      .filter((message) => message.method === 'Target.detachFromTarget')
      .map((message) => (message.params as CdpMessage).sessionId);
    expect(detached.sort()).toEqual([
      'S-old',
      'S-old-frame',
      'S-popup',
      'probe-live-page',
      'probe-old-page',
    ]);

    // Client ids are rewritten upstream so proxy commands never collide.
    const upstreamIds = chrome.received.map((message) => message.id);
    expect(new Set(upstreamIds).size).toBe(upstreamIds.length);
  });

  it('forwards replies under the client id and keeps unrelated events', async () => {
    const chrome = await fakeChrome([]);
    const proxy = await openScopedCdpProxy(chrome.endpoint, { connectionTimeoutMs: 2_000 });
    cleanups.push(() => proxy.close());
    const client = await fakeClient(proxy.endpoint);

    client.send({ id: 1, method: 'Browser.getVersion' });
    client.send({
      id: 2,
      method: 'Runtime.evaluate',
      sessionId: 'S-x',
      params: { expression: '1' },
    });
    await client.waitFor((message) => message.id === 2);
    chrome.emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'later' } } });
    await client.waitFor((message) => message.method === 'Target.targetCreated');

    expect(client.received.map((message) => message.id ?? message.method)).toEqual([
      1,
      2,
      'Target.targetCreated',
    ]);
    const forwarded = chrome.received.find((message) => message.method === 'Runtime.evaluate');
    expect(forwarded).toMatchObject({ sessionId: 'S-x', params: { expression: '1' } });
    expect(forwarded?.id).not.toBe(2);
  });

  it('ends the Chrome session when the client disconnects, and vice versa', async () => {
    const first = await fakeChrome([]);
    const proxy = await openScopedCdpProxy(first.endpoint, { connectionTimeoutMs: 2_000 });
    const client = await fakeClient(proxy.endpoint);
    client.close();
    await first.closed;
    await proxy.close();

    const second = await fakeChrome([]);
    const other = await openScopedCdpProxy(second.endpoint, { connectionTimeoutMs: 2_000 });
    cleanups.push(() => other.close());
    const otherClient = await fakeClient(other.endpoint);
    second.disconnect();
    await expect(otherClient.closed).resolves.toBe(1001);
  });

  it('accepts exactly one client and only on its secret path', async () => {
    const chrome = await fakeChrome([]);
    const proxy = await openScopedCdpProxy(chrome.endpoint, { connectionTimeoutMs: 2_000 });
    cleanups.push(() => proxy.close());
    const origin = new URL(proxy.endpoint).origin;

    await expect(fakeClient(`${origin}/devtools/browser/guess`)).rejects.toThrow();
    await fakeClient(proxy.endpoint);
    await expect(fakeClient(proxy.endpoint)).rejects.toThrow();
  });

  it('reports an unapproved handshake as a timeout without the endpoint', async () => {
    const server = createServer();
    const held: Array<{ destroy(): void }> = [];
    // Chrome holding the handshake until the user approves its prompt.
    server.on('upgrade', (_request, socket) => held.push(socket));
    const port = await listen(server);
    cleanups.push(() => {
      for (const socket of held) socket.destroy();
      return closeServer(server);
    });

    const attempt = openScopedCdpProxy(`ws://127.0.0.1:${port}/devtools/browser/held`, {
      connectionTimeoutMs: 300,
    });
    await expect(attempt).rejects.toBeInstanceOf(ScopedCdpProxyError);
    await expect(attempt).rejects.toThrow(/did not approve.*within 1 second/u);
    await attempt.catch((error: Error) => expect(error.message).not.toContain(String(port)));
  });

  it('reports a refused connection without the endpoint', async () => {
    const server = createServer();
    server.on('upgrade', (_request, socket) => socket.destroy());
    const port = await listen(server);
    cleanups.push(() => closeServer(server));

    const attempt = openScopedCdpProxy(`ws://127.0.0.1:${port}/devtools/browser/nope`, {
      connectionTimeoutMs: 2_000,
    });
    await expect(attempt).rejects.toThrow(/refused/u);
    await attempt.catch((error: Error) => expect(error.message).not.toContain(String(port)));
  });

  it('resolves an HTTP discovery endpoint through /json/version', async () => {
    const chrome = await fakeChrome([{ targetId: 'old', type: 'page' }], { discarded: ['old'] });
    const discovery = createServer((request, response) => {
      if (request.url !== '/json/version') return response.writeHead(404).end();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ webSocketDebuggerUrl: chrome.endpoint }));
    });
    const port = await listen(discovery);
    cleanups.push(() => closeServer(discovery));

    const proxy = await openScopedCdpProxy(`http://127.0.0.1:${port}`, {
      connectionTimeoutMs: 2_000,
    });
    cleanups.push(() => proxy.close());
    expect(proxy.hiddenTargetCount).toBe(1);
  });
});
