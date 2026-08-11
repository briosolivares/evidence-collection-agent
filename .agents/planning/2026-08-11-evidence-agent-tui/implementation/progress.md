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

## 2026-08-11 02:12 PDT — Step 2 complete: session store, transcript, slash routing

- New: `src/tui/store/state.ts` (full design data model: SessionMode, TranscriptItemBody/TranscriptItem with stable ids, LiveRunState, UiEvent — run_started/run_finished/run_cancelled/run_failed carry an `at` epoch-ms stamp added by the dispatcher so the reducer stays pure for elapsed-time math; documented deviation from the design's bare union), `src/tui/store/reducer.ts` (pure reduce + routeInput + HELP_TEXT + unknownCommandNotice), `src/tui/components/{Transcript,TranscriptItem}.tsx` (renderers for every item kind, over `<Static>`). `App.tsx` now dispatches through the store; step 1's echo notice replaced per plan. Banner became the first transcript item so it stays above `<Static>` scrollback.
- Tests: `tests/tui/reducer.test.ts` (submit/notice appends, unknown-command, idle retention, id monotonicity, persistence), `tests/tui/transcript.test.tsx`, `tests/tui/app.test.tsx` (/help, /exit via injected onExit spy, unknown-cmd notice, multi-submit persistence); `shell.test.tsx` updated to the store-backed behavior.
- Fixed during verification: `Omit<union>` collapse broke typecheck → exported `TranscriptItemBody` union instead.

Verification evidence:

- `S2-V1` exit 0 (all four files exist).
- `S2-V2` exit 0 — reducer suite passes.
- `S2-V3` exit 0 — transcript + app suites pass.
- `S2-V4` exit 0 — `npm run typecheck` (after the Omit fix; full tui suite 35/35 green).
- `S2-H1` (human-judged) — verified by the agent from a PTY capture (/tmp/sherlock-tty2.out): four submissions ("first investigation", /help, "second investigation", /frobnicate) each landed as persistent scrollback blocks (▸ entries, help block, gentle notice) with the bordered composer repainted anchored beneath after every append; Ctrl+C exited cleanly.

Statuses flipped: S2-F1…S2-F6 → pass.

## 2026-08-11 02:23 PDT — Step 3 complete: live region, status line, --demo

- Reducer now covers the full UiEvent set with the design's finalization rules: streaming text finalizes at first tool_pending of a batch and at turn_end; pending tool lines finalize (✓/✗) on tool_exec_end; dangling pending settle as ⚠ retried at next turn_start and at run end; tokens = settled sum of turn_end (input+output) plus in-turn estimate (chars/4) snapped at turn_end; run_finished(completed) → completion item using the session's configured verb; budget_exceeded → distinct error item carrying reason + runDir; run_cancelled/run_failed supported. Stale run events with no live run are ignored.
- New: `src/tui/components/StatusLine.tsx` (✢✳✻✽ glyph at config.glyphFps, working word re-picked every config.wordCycleMs via exported no-repeat `pickWord`, 1 s clock, `↳ tokens · elapsed (esc to interrupt)`; injectable now/rng), `LiveRegion.tsx` (streaming prose + pending ● lines + StatusLine), `src/tui/demo.ts` (createDemoScript(baseAt) — logical 42 s / 18 700-token investigation incl. one errored click; playDemo with cancel). `--demo` flag wired in main.tsx/App.
- SessionState gained `completionVerb` (fixed at init from config) so the pure reducer can build completion items.

Verification evidence:

- `S3-V1` exit 0 (both components exist).
- `S3-V2` exit 0 — reducer suite (now 21 cases) covers text finalization at batch/turn end, pending→finalized, dangling→retried at turn_start and run end, settled-vs-estimate snap math, budget_exceeded distinctness, cancel/fail paths.
- `S3-V3` exit 0 — status-line suite: injected clock/RNG; pickWord no-repeat sweep; `↳ 12.4k tokens · 18s` exact; 'Wrapping up…' while cancelling; configured verb 'Distilled in 1m 24s · 31.2k tokens' assertion.
- `S3-V4` exit 0 — demo suite: script finite → idle; final rendered transcript contains `✓ Brewed in 42s · 18.7k tokens`; error-activity survives; playDemo order + cancellation.
- `S3-V5` exit 0 — typecheck (61 TUI tests green overall).
- `S3-H1` (human-judged) — agent-judged from a 32 s PTY capture of `npm run sherlock -- --demo` (/tmp/sherlock-demo.out, 192 KB): prose streams in place (growing text repainted only in the live region, 13 partial paints, single final paint once static); 4 distinct working words over the ~19 s playback (Consulting the archives / Sifting / Brewing / Reading the fine print); token meter ticks up from 0 → 18.7k; ● lines get ✓; completion line `✓ Brewed in 42s · 18.7k tokens` + dim runDir painted exactly once; user_task painted exactly once (no layout shift of finalized content); composer re-enabled after completion.

Statuses flipped: S3-F1…S3-F9 → pass.

## 2026-08-11 02:33 PDT — Step 4 complete: RunSession bridge, real runs

- New: `src/tui/bridge/runSession.ts` — per-run AbortController; injected callModel composed from the core's exported `buildRequestParams` + an abortable stream factory (default: Anthropic SDK `client.messages.stream(params, {signal})`, constructed lazily so a missing key fails inside the run) + `assembleModelResponse`; **re-emits all four progress events** (turn_start / text_delta / tool_use_start→tool_pending / turn_end) since injecting callModel bypasses onProgress; maps LoopResult to run_finished (completed vs budget_exceeded+reason), post-cancel rejections to run_cancelled, others to run_failed. `done` never rejects. Tool defs rebuilt from the same exported tool arrays runTask registers, so the prompt prefix stays byte-identical.
- New: `src/tui/bridge/runtime.ts` — one persistent browser launched at startup, same instance handed to every run, closed once at teardown; injectable launcher/bridge for tests. `main.tsx` launches Chrome (worktree-root `chrome-profile`, absolute) before render and shuts down after `waitUntilExit()`; `--demo` skips the browser entirely (demo never leaves the UI pipeline — documented deviation from "launch at startup" for demo mode only). `App` gained a `runner` prop; submit dispatches `submit_task` then starts the bridge run, holding the RunHandle in a ref (Esc uses it in step 5).
- Tests: `tests/tui/{streamFixtures,stubBrowser}.ts` (scripted RawMessageStreamEvent builder; spy adapter); `run-session.test.ts` drives the REAL runTask + registry + scheduler against scripted streams in a tmp runs dir — ordered re-emission, per-turn usage incl. cacheRead, artifact + finalized manifest + metrics on disk, budget_exceeded distinctness, run_failed mapping, abort signal presence; `browser-lifecycle.test.ts` (launch-once, same instance to all runs, close-exactly-once, not-started guard); `app.test.tsx` gained bridge wiring cases (submission calls bridge + disables composer, completion renders runDir + re-enables, --demo preserved, runner-less fallback).
- Fixed during verification: a `*/` inside runSession's doc comment terminated the block comment (TS1434) — reworded.

Verification evidence:

- `S4-V1`…`S4-V5` all exit 0 (suites: 73 TUI tests green; typecheck clean).
- `S4-H1` (human-judged, external integration) — agent-performed real-run verification via PTY (/tmp/sherlock-real.out): typed "Open https://example.com and save the main heading text of the page to heading.txt" into `npm run sherlock`; persistent Chrome launched; tool names streamed as ● lines (navigate/inspect_page/write_file observed across 12 frames); completion line `✓ Brewed in 17s · 2.1k tokens` with runDir printed dimly beneath; on disk `runs/2026-08-11T09-30-01-435Z-e5b435f01bc1/` contains heading.txt = "Example Domain", manifest.json (task verbatim, artifact heading.txt, finishedAt set), metrics.json, transcript.jsonl. Known interim artifact: 4 pending lines settled "⚠ retried" (no exec events until step 6's tracing seam) — matches the plan's sequencing.
- Note: worktree `.env` is a gitignored symlink to the main checkout's .env (needed for real-run verification; never read or printed).

Statuses flipped: S4-F1…S4-F7 → pass.
