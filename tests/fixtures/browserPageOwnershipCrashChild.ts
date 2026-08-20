import { AttachedChromeBrowserSessionProvider } from '../../src/browser/attachedChromeBrowserSessionProvider.js';
import { createBusyResourceRegistry } from '../../src/tools/registry.js';

interface Arguments {
  endpoint: string;
  ownershipId: string;
  mode: 'marked-pages' | 'committed-sentinel';
}

void main().catch(async (error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    await send({ type: 'error', message });
  } catch {
    // The parent may already have disconnected while killing this fixture.
  }
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const { endpoint, ownershipId, mode } = parseArguments(process.argv.slice(2));
  const controller = await new AttachedChromeBrowserSessionProvider({
    cdpEndpoint: endpoint,
    ...(mode === 'committed-sentinel'
      ? {
          afterTargetCreated: async () => {
            await send({
              type: 'sentinel_committed',
              processId: process.pid,
            });
            await new Promise<never>(() => undefined);
          },
        }
      : {}),
  }).createSession();
  controller.setBusyRegistry?.(createBusyResourceRegistry());
  if (mode === 'committed-sentinel') {
    if (controller.prepareTaskPage === undefined) {
      throw new Error('Attached controller omitted atomic task-page preparation.');
    }
    await controller.prepareTaskPage({ ownershipId });
    throw new Error('Sentinel crash fixture unexpectedly completed page preparation.');
  }
  if (controller.prepareTaskPage === undefined) {
    throw new Error('Attached controller omitted task-page preparation.');
  }
  await controller.prepareTaskPage({ ownershipId });
  const popupSession = await controller.openCommandSession();
  try {
    await popupSession.send('Runtime.evaluate', {
      expression: "window.open('about:blank#crash-popup', '_blank'); true",
      awaitPromise: true,
      returnByValue: true,
    });
  } finally {
    await popupSession.close();
  }

  const pages = await waitForPages(controller, 2);
  await Promise.all(
    pages.map(async (page, index) => {
      const session = await controller.openCommandSession(page.pageId);
      try {
        await session.send('Page.navigate', {
          url:
            index === 0
              ? 'data:text/html,<title>crash-main</title><h1>main</h1>'
              : 'data:text/html,<title>crash-popup</title><h1>popup</h1>',
        });
      } finally {
        await session.close();
      }
    }),
  );
  await waitForPages(controller, 2);
  await send({ type: 'ready', processId: process.pid, pageCount: 2 });
  await new Promise<never>(() => undefined);
}

async function waitForPages(
  controller: Awaited<ReturnType<AttachedChromeBrowserSessionProvider['createSession']>>,
  count: number,
): Promise<Awaited<ReturnType<typeof controller.pages>>> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const pages = await controller.pages();
    if (pages.length === count) return pages;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${count} owned pages.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function parseArguments(argv: string[]): Arguments {
  const [endpoint, ownershipId, mode = 'marked-pages'] = argv;
  if (endpoint === undefined || ownershipId === undefined) {
    throw new Error('Expected endpoint and ownership id arguments.');
  }
  if (mode !== 'marked-pages' && mode !== 'committed-sentinel') {
    throw new Error('Unknown browser ownership crash fixture mode.');
  }
  return { endpoint, ownershipId, mode };
}

function send(message: Record<string, unknown>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error('Crash fixture requires an IPC parent.'));
      return;
    }
    process.send(message, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}
