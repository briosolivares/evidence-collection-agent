import { render as renderWithInk, type Instance, type RenderOptions } from 'ink';
import type { ReactNode } from 'react';
import wrapAnsi from 'wrap-ansi';

interface InkLogInternals {
  setCursorPosition(position: { x: number; y: number } | undefined): void;
  sync(output: string): void;
}

interface InkInstanceInternals {
  cursorPosition: { x: number; y: number } | undefined;
  lastOutputToRender: string;
  lastTerminalWidth: number;
  log: InkLogInternals;
  resized: () => void;
}

// Ink keeps renderer instances in this private map. Ink 7.1.1 clears the old
// dynamic frame when a terminal narrows, but its log still counts rows at the
// old width. Terminals reflow that frame before the resize event, so the clear
// misses the newly wrapped rows and leaves stamped borders behind. Resolve the
// map beside Ink's public entry point so nested/global installs work too.
const inkEntryUrl = import.meta.resolve('ink');
const { default: inkInstances } = (await import(new URL('./instances.js', inkEntryUrl).href)) as {
  default: WeakMap<NodeJS.WriteStream, InkInstanceInternals>;
};
const patchedInstances = new WeakSet<InkInstanceInternals>();

function installResizeFix(stdout: NodeJS.WriteStream): void {
  const instance = inkInstances.get(stdout);
  if (instance === undefined || patchedInstances.has(instance)) return;

  const inkResize = instance.resized;
  const resize = () => {
    const width = stdout.columns;
    if (
      width !== undefined &&
      width > 0 &&
      width < instance.lastTerminalWidth &&
      instance.lastOutputToRender !== ''
    ) {
      const reflowedOutput = wrapAnsi(instance.lastOutputToRender, width, {
        trim: false,
        hard: true,
      });

      // Teach Ink's log where the terminal cursor and reflowed rows now are.
      // Its own resize handler can then erase precisely the dynamic frame,
      // without clearing or replaying Sherlock's <Static> scrollback.
      instance.log.setCursorPosition(instance.cursorPosition);
      instance.log.sync(reflowedOutput);
    }

    inkResize();
  };

  stdout.off('resize', inkResize);
  instance.resized = resize;
  stdout.on('resize', resize);
  patchedInstances.add(instance);
}

/** Ink render with accurate physical-row cleanup after terminal shrink. */
export function render(node: ReactNode, options: RenderOptions = {}): Instance {
  const instance = renderWithInk(node, options);
  installResizeFix(options.stdout ?? process.stdout);
  return instance;
}
