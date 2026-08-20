import { EventEmitter } from 'node:events';

import { render as renderWithInk, type Instance, type RenderOptions } from 'ink';
import type { ReactNode } from 'react';

/** One resize gesture may emit dozens of width changes. Ink repaints each one
 * relative to terminal rows whose reflow semantics differ across emulators.
 * Give the renderer only the settled size; App then performs one authoritative
 * viewport replay from reducer state. */
const RESIZE_SETTLE_MS = 100;

interface ResizeRelay {
  readonly stdout: NodeJS.WriteStream;
  dispose(): void;
}

function createResizeRelay(source: NodeJS.WriteStream): ResizeRelay {
  const resizeEvents = new EventEmitter();
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  const onSourceResize = () => {
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      resizeEvents.emit('resize');
    }, RESIZE_SETTLE_MS);
  };

  let stdout: NodeJS.WriteStream;
  const proxy = new Proxy(source, {
    get(target, property) {
      if (property === 'on' || property === 'addListener') {
        return (event: string | symbol, listener: (...args: unknown[]) => void) => {
          if (event === 'resize') resizeEvents.on(event, listener);
          else target.on(event, listener);
          return stdout;
        };
      }
      if (property === 'once') {
        return (event: string | symbol, listener: (...args: unknown[]) => void) => {
          if (event === 'resize') resizeEvents.once(event, listener);
          else target.once(event, listener);
          return stdout;
        };
      }
      if (property === 'off' || property === 'removeListener') {
        return (event: string | symbol, listener: (...args: unknown[]) => void) => {
          if (event === 'resize') resizeEvents.off(event, listener);
          else target.off(event, listener);
          return stdout;
        };
      }

      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  stdout = proxy as NodeJS.WriteStream;
  source.on('resize', onSourceResize);

  return {
    stdout,
    dispose() {
      source.off('resize', onSourceResize);
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeEvents.removeAllListeners();
    },
  };
}

/** Ink render whose stdout coalesces resize bursts into one final-width event. */
export function render(node: ReactNode, options: RenderOptions = {}): Instance {
  const relay = createResizeRelay(options.stdout ?? process.stdout);
  const instance = renderWithInk(node, { ...options, stdout: relay.stdout });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    relay.dispose();
  };

  return {
    ...instance,
    unmount() {
      dispose();
      instance.unmount();
    },
    cleanup() {
      dispose();
      instance.cleanup();
    },
    async waitUntilExit() {
      try {
        return await instance.waitUntilExit();
      } finally {
        dispose();
      }
    },
  };
}
