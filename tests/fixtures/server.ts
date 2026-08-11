import { readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACK_HOST = '127.0.0.1';
const FIXTURE_ROOT = fileURLToPath(new URL('.', import.meta.url));

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
};

const AUTHENTICATED_BODY = Buffer.from('browser-session-authenticated\n');
const SESSION_COOKIE = 'fixture-session=ready';

export interface FixtureServer {
  /** Absolute HTTP origin on the IPv4 loopback interface. */
  readonly baseUrl: string;

  /**
   * Build an absolute URL served by this fixture server.
   *
   * @param pathname - an origin-relative fixture path, with or without a leading slash
   * @returns an absolute loopback URL for the requested fixture path
   */
  url(pathname?: string): string;

  /**
   * Stop accepting fixture requests and release the ephemeral port.
   *
   * @returns a promise that settles after the server is closed; repeated calls are safe
   */
  close(): Promise<void>;
}

/**
 * Start an in-process HTTP server for the deterministic browser fixtures.
 *
 * @returns a loopback-only server on an ephemeral port, with URL helpers and
 *   deterministic, idempotent cleanup
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer((request, response) => {
    void serveFixture(request, response);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const rejectOnError = (error: Error): void => {
      rejectListen(error);
    };

    server.once('error', rejectOnError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', rejectOnError);
      resolveListen();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Fixture server did not bind to an IP port');
  }

  const baseUrl = `http://${LOOPBACK_HOST}:${address.port}`;
  let closePromise: Promise<void> | undefined;

  return {
    baseUrl,
    url(pathname = '/') {
      const originRelativePath = pathname.replace(/^\/+/, '');
      return new URL(`./${originRelativePath}`, `${baseUrl}/`).href;
    },
    close() {
      closePromise ??= new Promise<void>((resolveClose, rejectClose) => {
        if (!server.listening) {
          resolveClose();
          return;
        }

        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });

      return closePromise;
    },
  };
}

async function serveFixture(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const { method } = request;
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }

  let fixturePath: string | undefined;
  try {
    const pathname = decodeURIComponent(
      new URL(request.url ?? '/', 'http://fixture.invalid').pathname,
    );

    if (pathname === '/authenticated.bin') {
      serveAuthenticatedFixture(request, response, method);
      return;
    }

    if (pathname === '/redirect-to-second') {
      response.writeHead(302, { Location: '/second.html' });
      response.end();
      return;
    }

    fixturePath = resolveFixturePath(pathname);
  } catch {
    respondNotFound(response);
    return;
  }

  if (fixturePath === undefined) {
    respondNotFound(response);
    return;
  }

  try {
    const body = await readFile(fixturePath);
    response.writeHead(200, {
      'Content-Length': body.byteLength,
      'Content-Type': CONTENT_TYPES[extname(fixturePath)] ?? 'application/octet-stream',
      ...(fixturePath === resolve(FIXTURE_ROOT, 'index.html')
        ? { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Lax` }
        : {}),
    });
    response.end(method === 'HEAD' ? undefined : body);
  } catch {
    respondNotFound(response);
  }
}

function serveAuthenticatedFixture(
  request: IncomingMessage,
  response: ServerResponse,
  method: 'GET' | 'HEAD',
): void {
  const cookies = request.headers.cookie?.split(';').map((cookie) => cookie.trim()) ?? [];
  if (!cookies.includes(SESSION_COOKIE)) {
    response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(method === 'HEAD' ? undefined : 'Missing browser session cookie');
    return;
  }

  response.writeHead(200, {
    'Content-Length': AUTHENTICATED_BODY.byteLength,
    'Content-Type': 'application/octet-stream',
  });
  response.end(method === 'HEAD' ? undefined : AUTHENTICATED_BODY);
}

function resolveFixturePath(pathname: string): string | undefined {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = resolve(FIXTURE_ROOT, relativePath);
  const pathFromRoot = relative(FIXTURE_ROOT, candidate);

  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    return undefined;
  }

  return candidate;
}

function respondNotFound(response: ServerResponse): void {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}
