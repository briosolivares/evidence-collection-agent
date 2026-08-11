# Sherlock TUI — Implementation Plan

Each step ends with a working, demoable increment. Tests are written with (or before) the code they cover, using vitest under `tests/tui/`. The design document is the reference for all component/data-model details; this plan sequences the work.

## Checklist

- [ ] Step 1: Scaffold `sherlock` — bin, deps, theme, formatting, static shell
- [ ] Step 2: Session store, transcript rendering, slash-command routing (`/help`, `/exit`)
- [ ] Step 3: Live region + status line, driven by a scripted demo run (`--demo`)
- [ ] Step 4: RunSession bridge — real agent runs stream into the TUI
- [ ] Step 5: Esc cancellation
- [ ] Step 6: Semantic activity + evidence lines via tracing seam; verbose mode
- [ ] Step 7: `/runs` — scrollable past-run list + run summary blocks
- [ ] Step 8: `/evals` — task multi-select, k prompt, live trial loop, report
- [ ] Step 9: Hardening + polish pass against the vision checklist

---

## Step 1: Scaffold `sherlock` — bin, deps, theme, formatting, static shell

**Objective:** A launchable `sherlock` command rendering the styled shell: banner, empty transcript, active composer.

**Guidance:** Add `ink`, `react`, `ink-text-input`, `ink-select-input` (+ `@types/react`, `ink-testing-library` as dev deps); add `"jsx": "react-jsx"` to tsconfig; create `bin/sherlock.mjs` (tsx loader shim → `src/tui/main.tsx`), `bin` + `sherlock` script in package.json. Implement `theme.ts` (Andera tokens, glyphs), `format.ts` (compact tokens, durations, URL shortening), `config.ts` (defaults incl. `completionVerb: 'Brewed'`, working-words list). `main.tsx` does env load (`process.loadEnvFile`), TTY/Node/API-key preflight, renders `<App/>` with composer that accepts text but only echoes a "not wired yet" notice. No browser launch yet.

**Tests:** `format.ts` — token formatting (847 / 3.2k / 18.7k boundaries), duration formatting (42s / 1m 24s), URL shortening. Config defaults (verb configurable, word list non-empty).

**Integration:** Foundation; nothing depends on prior steps.

**Demo:** `npm run sherlock` (or linked `sherlock`) opens the purple-themed shell; typing text gets a styled notice; Ctrl+C exits cleanly.

## Step 2: Session store, transcript rendering, slash routing

**Objective:** The append-only transcript works end-to-end with pure state management, and `/help` + `/exit` function.

**Guidance:** Implement `store/state.ts` + `store/reducer.ts` (modes, `TranscriptItem`s, finalization rules) and `Transcript.tsx`/`TranscriptItem.tsx` over Ink's `<Static>`. Composer submit → `user_task` item (▸, purple). Slash router: `/help` renders a `notice` block (commands + keys), `/exit` calls `useApp().exit()`; unknown `/cmd` → gentle notice.

**Tests:** Reducer — submit appends `user_task`; notices append; unknown-command handling; mode stays `idle`. Component — `ink-testing-library`: submitted text appears in output; `/help` block renders.

**Integration:** Replaces Step 1's echo notice with real store dispatch.

**Demo:** Type a task → it appears as a transcript entry; `/help` shows the command list; `/exit` quits; earlier entries persist in scrollback as new ones append.

## Step 3: Live region + status line on a scripted demo run

**Objective:** The full "agent is working" experience — streaming prose, pending tool lines, animated status line, completion line — rendered from a scripted event source, no API cost.

**Guidance:** Implement `LiveRegion.tsx` and `StatusLine.tsx` (glyph frames ~4 fps, working word re-pick ~6 s no-repeat, 1 s elapsed, token estimate that snaps at `turn_end`) with injectable clock/RNG. Extend the reducer for the full `UiEvent` set: streaming-text finalization, pending→finalized tool lines, `completion`/`cancelled` items. Add `sherlock --demo`: plays a canned `UiEvent` script (a fake investigation) through the real pipeline with realistic pacing.

**Tests:** Reducer — full event-sequence fixtures: text finalizes at tool batch/turn end; pending tools finalize on exec end; dangling pending settles as `retried` at next `turn_start`; token settled/estimate math. StatusLine — word cycles on injected clock, never repeats consecutively; metrics line renders `↳ 12.4k tokens · 18s`. Completion line uses configured verb.

**Integration:** Consumes Step 2's store/transcript; the demo script stands in for the bridge built next.

**Demo:** `sherlock --demo` plays a ~30 s fake investigation: prose streams, `●` lines appear and get ✓, words cycle (several across the run), tokens tick up, and it ends with `✓ Brewed in 42s · 18.7k tokens` persisting in the transcript.

## Step 4: RunSession bridge — real runs

**Objective:** Typing a task runs the real agent with live streaming in the TUI.

**Guidance:** Implement `bridge/runSession.ts`: per-run `AbortController`; custom `callModel` composed from the core's exported `buildRequestParams` + SDK `client.messages.stream(params, {signal})` + `assembleModelResponse`; **re-emit all four progress events** (the injected `callModel` bypasses `onProgress` — this is the critical seam). Emit `tool_pending` from stream tool-use starts (name only for now). `main.tsx` now launches persistent Chrome at startup (same profile dir semantics as the REPL) and closes it on exit. `run_finished` carries `finalText` + `runDir`; completion line appends with real elapsed/tokens; `runDir` printed dimly under it.

**Tests:** Bridge with a stubbed SDK stream factory and scripted raw events — asserts emitted `UiEvent` order/fidelity (turn boundaries, deltas, usage totals) and that `budget_exceeded` maps to a distinct outcome. No live-API tests.

**Integration:** The store's submit handler dispatches to the bridge instead of the demo script; `--demo` remains for UI iteration.

**Demo:** `sherlock` → type "Create a CSV of the top 5 Hacker News stories…" → Chrome opens, prose streams, tool names appear, completion line shows real time/tokens, and the run directory on disk contains the CSV + manifest.

## Step 5: Esc cancellation

**Objective:** Esc cleanly interrupts an in-flight run without exiting the TUI.

**Guidance:** `useInput` in `App`: Esc in `running` → `cancelling` mode (status line swaps to a "wrapping up" phrase), calls `RunHandle.cancel()` (aborts the signal; in-flight tool batch settles per design). On rejection with the abort marker: append `cancelled` item (`✗ Interrupted after 18s · 9.3k tokens`), return to `idle`, composer re-enabled. Non-abort rejections → `error` item (groundwork for Step 9).

**Tests:** Bridge — abort mid-stream rejects and yields `run_cancelled`; abort between turns (during tool stub execution) still resolves cleanly after the batch. Reducer — cancelling → cancelled transitions. Component — Esc is a no-op in `idle`, triggers cancel in `running`.

**Integration:** Uses Step 4's AbortController; completes the R9 interaction contract.

**Demo:** Start a run, hit Esc mid-investigation: status flips to wrapping-up, an interrupted line lands in the transcript, and the next task can be typed immediately. The run dir has a finalized `manifest.json` and no `metrics.json`.

## Step 6: Semantic activity + evidence lines; verbose mode

**Objective:** Tool activity reads semantically (`● Opening sec.gov/…`, `◆ Evidence saved → top5.csv`) instead of bare tool names.

**Guidance:** Implement `store/semantic.ts` (pure derivation table from the design) and `bridge/tuiTracing.ts`: a `RunTracing` implementation whose `wrapRegistry` emits `tool_exec_start/end` (validated input + ok/error) and captures `runDir` from `ctx`, while **delegating to the core's `createRunTracing()`** so Langfuse still works. Evidence lines get `◆` + source URL when available. `--verbose` renders dim input/result details under each line. Pending name-only lines from Step 4 upgrade in place when exec events arrive.

**Tests:** `semantic.ts` — every tool mapping, truncation, URL shortening edge cases. Tracing wrapper — stub registry: events emitted with validated input, errors marked, `runDir` captured on first call, Langfuse delegate invoked. Reducer — pending line upgraded by exec events; evidence items flagged.

**Integration:** Bridge now passes `tracing` into `runTask`; the runDir is known mid-run (used by Step 7's freshness and the completion line).

**Demo:** A real run now reads like the vision mockup: semantic `●` lines with ✓, `◆` evidence entries with sources, skimmable afterward; `sherlock --verbose` shows the raw detail beneath each action.

## Step 7: `/runs` — past-run browser

**Objective:** A scrollable, selectable list of past run directories with inline summaries.

**Guidance:** `RunsList.tsx` overlay (mode `runsList`): read `runs/`, newest first; rows = task snippet · relative date · status glyph (✓ metrics present / ◐ unfinished / ✗ stopped — never "crashed"). Enter → `run_summary` transcript block (task, duration, tokens from metrics when present, artifact table with sizes + SHA-256 prefixes from manifest); Esc closes overlay. Windowed scrolling for long lists.

**Tests:** Run-scanning logic (pure, against fixture dirs) — ordering, status classification incl. the cancelled-run case (manifest finalized, no metrics). Component — navigation, selection emits summary, Esc closes.

**Integration:** Slash router gains `/runs`; summary blocks reuse the transcript pipeline.

**Demo:** After a few runs (including the Step 5 cancelled one), `/runs` lists them with correct statuses; selecting one prints its provenance summary inline; Esc returns to the composer.

## Step 8: `/evals` — menu, trial loop, live progress

**Objective:** Kick off eval batches from the TUI and watch trials stream live.

**Guidance:** `EvalsMenu.tsx`: checkbox multi-select of tasks (discovered by reading `evals/*/task.json`) → numeric k prompt (default 3) → `evalsRunning`. `bridge/evalSession.ts`: sequential trial loop over the core's exported parts (`loadEvalTask` → bridge `startRun` → `fetchOracle` → `grade` → `summarizeTask`), emitting trial-header items, per-assertion verdicts, and a final `eval_report` block (`formatReport`), persisted with `writeResults`. Esc cancels the current trial and skips the rest.

**Tests:** Task discovery against a fixture evals tree. Trial loop with stubbed runTask/oracle/grader — ordering, verdict items, report assembly, Esc-skip semantics. Menu component — toggle/confirm/k validation (positive integer).

**Integration:** Trials reuse the entire live-run pipeline (Steps 4–6), so eval runs look identical to interactive runs with trial framing around them.

**Demo:** `/evals` → select `stub` (+ another task), k=2 → trials stream with live status; assertions print pass/fail; the report block matches the CLI's format and lands in `evals/experiments/`.

## Step 9: Hardening + polish against the vision

**Objective:** The failure paths and the feel are finished.

**Guidance:** Error handling per design: non-abort run failures → `error` item + recovery (browser-death detection and relaunch offer on next submit); missing-API-key banner; non-TTY exit message; double-Esc/Ctrl+C during cancelling. Motion tuning (`maxFps`, `incrementalRendering`, cadence constants) on real runs; verify no flicker/layout shift on narrow terminals and terminal resize. Walk the R1–R12 requirements and the vision's glanceability checklist as a manual acceptance pass; fix gaps.

**Tests:** Reducer/bridge error-path fixtures (failed run mid-stream, browser-death rejection classification). A final smoke test snapshotting a full scripted-run frame sequence via `ink-testing-library` to lock the rendering contract.

**Integration:** Touches all prior steps; ends with README usage note for `sherlock` (kept minimal).

**Demo:** Kill Chrome mid-run → TUI reports the failure and recovers on the next task. Run in a narrow terminal — no layout breakage. The completed transcript of a real investigation reads: navigation → investigation → evidence → conclusion, at a glance.
