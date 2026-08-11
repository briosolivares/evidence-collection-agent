#!/usr/bin/env node
// Sherlock launcher: registers tsx's ESM loader (already a repo
// dependency — there is no build step) and hands off to the TUI entry
// point. Kept as plain .mjs so `npm link` / a global install can run it
// with a stock Node.
import { register } from 'tsx/esm/api';

register();
await import(new URL('../src/tui/main.tsx', import.meta.url).href);
