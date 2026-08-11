# Sherlock TUI Implementation Progress

Append-only convention: add timestamped entries at the end, with the newest entry last. Never edit, reorder, or delete an existing entry.

## 2026-08-11 02:04 PDT — Step 1 complete: scaffold `sherlock`

Implemented by the main agent (no subagent delegation this step — the scaffold sets conventions later steps copy).

- Added deps `ink@7.1.1`, `react@19.2`, `ink-text-input@6`, `ink-select-input@6`; dev `@types/react@19`, `ink-testing-library@4`. `package.json` gains `bin.sherlock=bin/sherlock.mjs` + `sherlock` script; tsconfig gains `"jsx": "react-jsx"`.
- New files: `bin/sherlock.mjs` (tsx ESM-loader shim), `src/tui/{main.tsx,theme.ts,format.ts,config.ts}`, `src/tui/components/{App.tsx,Composer.tsx}`; tests `tests/tui/{format,config}.test.ts`, `tests/tui/shell.test.tsx`, `tests/tui/helpers.ts`.
- Agent core untouched (`git status` shows no changes under `src/loop|model|tools|run|browser|tracing`).

Verification evidence:

- `S1-V1` exit 0 (package.json/tsconfig node check).
- `S1-V2` exit 0 (all seven files exist; shim executable).
- `S1-V3` exit 0 — `npx vitest run tests/tui/format.test.ts tests/tui/config.test.ts tests/tui/shell.test.tsx`: 3 files, 19 tests passed (banner, composer, submitted-text notice asserted in shell.test.tsx).
- `S1-V4` exit 0 — `npm run typecheck`.
- `S1-V5` — `npm run sherlock </dev/null` exited 1; output line "sherlock is an interactive TUI and needs an interactive terminal (TTY)…" matched `grep -Ei 'tty|interactive terminal'` (exit 0).
- `S1-H1` (human-judged visual remainder) — verified by the agent from real PTY captures (`script -q` driving `npm run sherlock`), not by a human eyeball; captures at /tmp/sherlock-tty.out. Observed: truecolor `38;2;169;161;230` (#A9A1E6 Andera purple300) on banner glyph + `›` prompt and `38;2;125;121;147` (#7D7993 w500) on muted text; typed text rendered in composer; Enter produced the styled "isn't wired up yet" notice and cleared the composer; Ctrl+C exited restoring the cursor (`[?25h`) with no stray artifacts, shell prompt returned normally.

Statuses flipped: S1-F1…S1-F8 → pass.
