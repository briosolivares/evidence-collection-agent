# Ink Research — TUI Framework Verification

Sources: Ink README (https://github.com/vadimdemedes/ink), npm registry metadata. Fetched 2026-08-11.

## Versions and requirements

| Package | Latest | Peer/engine requirements |
|---|---|---|
| ink | 7.1.1 | React ≥19.2, Node ≥22 |
| ink (v6 fallback) | 6.6.0 | React ≥19, Node ≥20 |
| ink-text-input | 6.0.0 | ink ≥5, react ≥18 |
| ink-select-input | 6.2.0 | ink ≥5, react ≥18 |
| ink-spinner | 5.0.0 | ink ≥4, react ≥18 |

- Local machine runs Node v22.17.0 → **Ink 7.1.1 is fine**. (Repo README states Node 18+; the TUI raises the effective floor to Node 22, or pin Ink 6 for Node 20.)
- All three companion components are compatible with Ink 6/7.

## Pattern verification — every piece of the vision maps to a documented API

1. **Growing transcript** → `<Static items={...}>{(item) => ...}</Static>`: "permanently renders its output above everything else… only renders new items in the `items` prop and ignores items that were previously rendered." Exactly the append-only transcript we need: completed blocks flow into terminal scrollback; only the dynamic region below re-renders. Ephemeral status phrases stay out of `<Static>` and thus never persist.
2. **Esc to cancel** → `useInput((input, key) => ...)` with `key.escape`; also `key.return`, arrows, etc. `isActive` option lets us scope handlers (e.g., composer active only between runs).
3. **/exit** → `useApp().exit()` unmounts cleanly. `render()` option `exitOnCtrlC` (default true) keeps Ctrl+C as fallback.
4. **Composer** → `ink-text-input` (controlled `value`/`onChange`/`onSubmit`).
5. **Menus / run list** → `ink-select-input` for single select; multi-select for evals tasks is a small custom component with `useInput` (checkbox list) — trivial. A scrollable run list = `<Box height={N} overflow="hidden">` + windowing over items (or ink-select-input's `limit` prop which pages long lists).
6. **Spinner** → `ink-spinner` (dots frames); or a tiny custom hook cycling frames + whimsical words on an interval — likely custom since we cycle words at a slower cadence than glyph frames.
7. **Colors** → `<Text color="#A9A1E6">` supports hex/truecolor directly (chalk under the hood, auto-downsamples to 256/16 colors).
8. **Restrained motion** → `render()` options: `maxFps` (default 30 — we can lower), `incrementalRendering: true` (only updates changed lines). CI/non-TTY renders final frame only.
9. **Stray console output** → `patchConsole` (default true): Ink intercepts `console.log` from anywhere in the process and splices it above the dynamic region instead of corrupting the screen. Safety net if agent internals log; a verbose/debug mode can surface these deliberately.

## Notable API details

- `useApp().suspendTerminal(cb)` — hands the terminal to a child process and restores Ink after; useful if we ever shell out (e.g., open a file in $EDITOR/pager from the run list).
- `measureElement(ref)` returns `{width,height}` post-layout — available if the run list needs precise windowing.
- `<Static>` re-render caveat: edits to already-rendered items are ignored — transcript blocks must be finalized before being appended (e.g., a tool-call line is added to `<Static>` only once its ✓/✗ status is known; while pending it lives in the dynamic region).

## Conclusion

Ink 7 supports every interaction in the vision with first-party or trivial custom components. No blockers.
