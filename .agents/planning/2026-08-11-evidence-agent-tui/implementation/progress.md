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
- Tests: `tests/tui/{streamFixtures,stubBrowser}.ts` (scripted RawMessageStreamEvent builder; spy controller); `run-session.test.ts` drives the REAL runTask + registry + scheduler against scripted streams in a tmp runs dir — ordered re-emission, per-turn usage incl. cacheRead, artifact + finalized manifest + metrics on disk, budget_exceeded distinctness, run_failed mapping, abort signal presence; `browser-lifecycle.test.ts` (launch-once, same instance to all runs, close-exactly-once, not-started guard); `app.test.tsx` gained bridge wiring cases (submission calls bridge + disables composer, completion renders runDir + re-enables, --demo preserved, runner-less fallback).
- Fixed during verification: a `*/` inside runSession's doc comment terminated the block comment (TS1434) — reworded.

Verification evidence:

- `S4-V1`…`S4-V5` all exit 0 (suites: 73 TUI tests green; typecheck clean).
- `S4-H1` (human-judged, external integration) — agent-performed real-run verification via PTY (/tmp/sherlock-real.out): typed "Open https://example.com and save the main heading text of the page to heading.txt" into `npm run sherlock`; persistent Chrome launched; tool names streamed as ● lines (navigate/inspect_page/write_file observed across 12 frames); completion line `✓ Brewed in 17s · 2.1k tokens` with runDir printed dimly beneath; on disk `runs/2026-08-11T09-30-01-435Z-e5b435f01bc1/` contains heading.txt = "Example Domain", manifest.json (task verbatim, artifact heading.txt, finishedAt set), metrics.json, transcript.jsonl. Known interim artifact: 4 pending lines settled "⚠ retried" (no exec events until step 6's tracing seam) — matches the plan's sequencing.
- Note: worktree `.env` is a gitignored symlink to the main checkout's .env (needed for real-run verification; never read or printed).

Statuses flipped: S4-F1…S4-F7 → pass.

## 2026-08-11 02:43 PDT — Step 5 complete: Esc cancellation

- Reducer gained `cancel_requested` (running → cancelling; no-op in any other mode, so double-Esc and idle-Esc are safe). `App` uses `useInput`: Esc in running dispatches cancel_requested and calls `RunHandle.cancel()` (held in the ref from step 4); the bridge's post-abort rejection lands as run_cancelled → cancelled item (`✗ Interrupted after …`), idle mode, composer re-enabled. StatusLine already renders "Wrapping up…" for cancelling (built in step 3).
- Bridge abort semantics tested against the REAL runTask: (a) mid-stream — a hanging scripted stream that rejects on signal abort → run rejects → `run_cancelled`, outcome `{status:'cancelled'}`; (b) mid-tool-batch — a blocked `browser.goto` with cancel() issued while the batch executes: the batch settles first (goto completes), the next callModel entry sees the aborted signal and throws, and no second model stream is ever requested (asserted via stream-factory call count).
- New `tests/tui/cancellation-artifacts.test.ts`: a cancelled fixture run leaves manifest.json with `finishedAt` and NO metrics.json.
- Test learning: Ink 7 defers a lone ESC (~escape-sequence disambiguation), so component tests wait ~150 ms after `stdin.write(ESC)`.

Verification evidence:

- `S5-V1`…`S5-V5` all exit 0 (run-session 8 cases, reducer 30 cases, app 14 cases, cancellation-artifacts, typecheck; 86 TUI tests green).
- `S5-H1` (human-judged) — agent-performed real-run verification via PTY (/tmp/sherlock-cancel.out): started a real HN-scrape task, pressed Esc at ~12 s → status flipped to "✽ Wrapping up…" within a frame, transcript kept the task line and got `✗ Interrupted after 12s · 467 tokens`; immediately typed a second task in the same session → `✓ Brewed in 12s · 1.1k tokens` with title.txt = "Example Domain" on disk. Cancelled run dir `runs/2026-08-11T09-38-30-442Z-723820684f7b`: manifest.json finalized (finishedAt set), metrics.json absent — the design's "stopped, not crashed" contract.

Statuses flipped: S5-F1…S5-F8 → pass.

## 2026-08-11 02:52 PDT — Step 6 complete: semantic activity, evidence lines, verbose mode

- New: `src/tui/store/semantic.ts` — pure ten-tool derivation table (navigate→Opening <short url>, inspect_page→Reading the page, click/type/scroll/grep/read_file, screenshot/download/write_file as evidence) with truncation, URL shortening, graceful degradation on missing/malformed input, and bare-name fallback for unknown tools.
- New: `src/tui/bridge/tuiTracing.ts` — RunTracing whose wrapRegistry emits tool_exec_start (validated input) / tool_exec_end (ok+result or error, rethrown) with monotonic exec ids, captures ctx.runDir on first execution (one-shot run_dir event), attaches manifest-recorded sourceUrl for evidence tools (best-effort read, never breaks a run), and DELEGATES wrapCallModel/wrapRegistry/traceRun/flush/close to the composed delegate (default createRunTracing() → Langfuse preserved). Wrapper composes outside the delegate's wrapped registry.
- runSession now always passes tuiTracing into runTask (config.tracing); `tracingDelegate` is the injection seam. Reducer: tool_exec_start upgrades name-only pending lines in place (semantic line + isEvidence + verbose input); tool_exec_end finalizes as ◆ evidence (with sourceUrl) or ●/✗ activity, storing compact verbose input/result. Transcript/TranscriptItemView gained a `verbose` flag (App passes config.verbose) — raw JSON hidden by default. Demo exec events now carry small results so --verbose reads sensibly.
- run-session ordering test updated: exec events (run_dir → tool_exec_start/end) now appear between turn boundaries, run_dir matches the final runDir.

Verification evidence:

- `S6-V1`…`S6-V6` all exit 0 — semantic table (10 mappings + 3-evidence classification + truncation/URL/degradation cases), tui-tracing (validated input, error rethrow, runDir once, manifest sourceUrl, full delegation), reducer upgrades, transcript verbose on/off, typecheck. 13 files / 110 TUI tests green.
- `S6-H1` (human-judged) — agent-judged from a real PTY run (/tmp/sherlock-semantic.out): task "save top 3 HN titles to top3.csv" rendered navigation → investigation → evidence → conclusion: `● navigate…` upgraded in place to `● Opening news.ycombinator.com…` then `✓`; `● Reading the page ✓`; `◆ Evidence saved → top3.csv` (bright); `● Re-reading top3.csv ✓`; `✓ Brewed in 15s · 56.9k tokens`. No ⚠ retried artifacts remain. top3.csv on disk has exactly `rank,title` + 3 rows. `--demo --verbose` PTY capture shows dim indented `input:`/`result:` detail under each line; default mode omits it.

Statuses flipped: S6-F1…S6-F9 → pass.

## 2026-08-11 03:00 PDT — Step 7 complete: /runs past-run browser

- New: `src/tui/runScanner.ts` — scanRuns (newest first by lexically time-ordered ids; skips junk/manifest-less dirs; classification per the core's write contract: metrics ⇒ complete ✓, no finishedAt ⇒ unfinished ◐, finished without metrics ⇒ stopped ✗ — never "crashed") and loadRunSummary (manifest view with on-disk artifact sizes + 12-char sha256 prefixes + sourceUrl, metrics view with input+output tokens). `formatRelativeTime` added to format.ts.
- New: `src/tui/components/RunsList.tsx` — windowed scrollable overlay (↑↓/Enter/Esc via useInput, cursor-centered window, position indicator, friendly empty state). Store: mode `runsList` via open_runs/close_overlay actions; show_run_summary appends a run_summary item and returns to idle. Slash router gained `/runs`. App scans on open and loads summaries on select (read failures degrade to a notice).
- Tests: run-scanner (ordering, all three statuses, cancelled-never-crashed, junk skipping, missing dir, summary views ±metrics), runs-list (glyph rows, relative dates, 12-entry window scroll with indicator, Enter selection, Esc close, empty state, full summary rendering incl. sizes/sha prefix), app (/runs → overlay → Enter → inline summary through the transcript pipeline → composer restored; Esc close on empty dir).

Verification evidence:

- `S7-V1`…`S7-V5` all exit 0; 15 files / 124 TUI tests green; typecheck clean.
- `S7-H1` (human-judged) — agent-judged from a PTY session against the real run history (/tmp/sherlock-runs.out): `/runs` listed 3 real runs newest-first with correct glyphs (two ✓ completed, one ✗ for the step-5 Esc-cancelled run — displayed stopped, never "crashed") and relative dates (10m/19m ago); ↓+Enter appended the inline summary block (task, started timestamp, `completed · 4 turns · 1.1k tokens · 12s`, `◆ title.txt  14 B · sha256 162b81548a8d`, run dir) and returned to the composer; a second `/runs` then Esc closed cleanly. Noted for step 9 polish: composer placeholder reads "(waiting for agent…)" while an overlay is open.

Statuses flipped: S7-F1…S7-F8 → pass.

## 2026-08-11 03:15 PDT — Step 8 complete: /evals menu, trial loop, live progress

- New: `src/tui/bridge/evalSession.ts` — discoverEvalTasks (dirs with task.json, sorted; filesystem convention, no core API), startEvalBatch: sequential trial loop over the exported harness parts (loadEvalTask → bridged run via the SAME live pipeline → fetchOracle at grading time → grade(runDir, oracle) → summarizeTask), trial framing actions (eval_trial_started notice, eval_trial_done verdict block), final eval_report_ready via the real formatReport + writeResults, evals_finished. Esc cancels the current trial's run and skips every remaining trial (no partial report). Failed trial runs stop the batch with an eval_error item. `usableStartUrl` drops non-HTTP(S) start URLs (found via real-run verification: stub's `about:blank` startUrl is for fake-agent harness tests; runTask's goto contract is HTTP(S)-only — a fresh tab is already blank).
- New: `src/tui/components/EvalsMenu.tsx` — two-stage overlay: checkbox multi-select (space/↑↓/enter, requires ≥1) then numeric k prompt (default 3, digits only, exported `validateK` accepts only positive integers); Esc steps back then closes. Store: open_evals/evals_started/eval_trial_*/eval_report_ready/eval_error/evals_finished actions; `evalsActive` flag makes run-end events return to `evalsRunning` between trials instead of idle. Runtime/runner signatures gained startUrl pass-through. Config gained evalsDir + evalResultsDir (default runs/eval-results — matches this worktree's evals/cli.ts convention; the plan's "evals/experiments" text reflects the main-branch layout, deviation documented). Composer hints are now mode-specific (fixes the step-7 note).
- Tests: eval-session (discovery fixture tree, usableStartUrl, sequential ordering incl. exact action sequence, startUrl pass-through, grader-sees-only-runDir+oracle, verdict payloads, report assembly via real formatReport + persistence spy, Esc-skip with no report, failed-run stop), evals-menu (toggling, ≥1 required, default k=3, non-positive/non-digit rejection, corrected confirm, Esc back/close), app (/evals menu → real hermetic `stub` task through a scripted runner: trial framing, live prose, completion, verdicts, `Eval report — k=1`, composer restored; runner-less /evals notice).

Verification evidence:

- `S8-V1`…`S8-V5` all exit 0; 17 files / 139 TUI tests green; typecheck clean.
- `S8-H1` (human-judged, external integration) — agent-performed real k=2 batch via PTY (/tmp/sherlock-evals.out): `/evals` → selected `stub` → k=2 → two real Chrome+API trials streamed live (`— stub · trial 1/2 —` … `✓ Brewed in 4s · 221 tokens`; trial 2 `✓ Brewed in 18s · 5.9k tokens`); per-assertion verdicts printed (trial 1: 2 ✗ with details — the agent genuinely skipped writing answer.md; trial 2: 2 pass); report block matches the CLI presentation byte-for-byte in structure (`Eval report — k=2, started …`, `stub: accuracy 50.0%  completion 1/2  task FAIL  mean latency 11298ms`, per-trial assertion lines); results JSON persisted at runs/eval-results/2026-08-11T10-12-54-285Z-7929afc732c8.json (k=2, 2 trials, accuracy 0.5, run dirs exist on disk).

Statuses flipped: S8-F1…S8-F9 → pass.

## 2026-08-11 03:40 PDT — Step 9 complete: hardening + polish; all 72 features pass

- Runtime hardening: `isBrowserDeathMessage` classifies Playwright/controller shutdown failures; a browser-death outcome marks the session browser dead and the NEXT submit relaunches a fresh Chrome (corpse closed best-effort; relaunch failure itself degrades to a run_failed event, never a crash). startRun defers behind ensureBrowser.
- Narrow-terminal fix found during verification: rows composed of sibling `<Text>`s (marker + content) overflowed their container by ~2 columns at 44 cols; user_task/activity/evidence/pending rows now nest their Texts so each row wraps as one paragraph — re-verified 0 lines exceeding 44 display columns in a 44-col PTY demo run.
- New tests: `error-paths.test.ts` (mid-stream non-abort failure → error item + idle via real bridge + reducer fold; death-message classification; relaunch-on-next-submit; ordinary failures don't relaunch; failed relaunch → run_failed), `preflight.test.ts` (missing-key banner; real `node bin/sherlock.mjs` spawn under pipes exits non-zero with exactly one stderr line; double-Esc cancels once and stays cancelling; Ctrl+C uncaptured by App), `smoke.test.tsx` (width-controllable Ink debug harness; committed snapshots of the full scripted run at 80 and 44 columns + waiting-composer state, asserting user task/prose/finalized activity/emphasized evidence/completion/composer). README gained the Sherlock usage note.
- Deflake: interaction-heavy TUI suites (fake-stdin typing, subprocess spawn) got `vi.setConfig({testTimeout: 30_000})` after two 5 s timeouts under full-suite parallel load; two consecutive full-suite runs green after.

Verification evidence (final battery, all on the finished tree):

- `S9-V1`…`S9-V4` exit 0. `S9-V5` — `npm test`: 55 files / 372 tests passed, twice consecutively. `S9-V6` — typecheck exit 0. `S9-V7` — `git diff --exit-code main...HEAD -- src/loop src/model src/tools src/run src/browser src/tracing` AND the uncommitted variant both exit 0 (agent core untouched). `git diff --check` clean. Re-ran every earlier scripted check on the final tree: S1-V1/V2/V5, S2-V1, S3-V1, S4-V1, S6-V1, S7-V1, S8-V1 all exit 0; the full TUI suite covers the V2–V6-style checks (151 TUI tests inside the 372).
- `S9-H1` (human-judged acceptance) — agent-performed on real sessions:
  * Resize: drove `--demo` on a Python-controlled PTY, resizing 80→52→72 columns mid-run via TIOCSWINSZ+SIGWINCH (/tmp/sherlock-resize.out): Ink redrew the composer at exactly 52 then 72 columns, zero content lines exceeded the width, no corruption, run completed with the correct completion line.
  * Chrome-death recovery: killed the session Chrome (`pkill -f 'evidence-agent-tui/chrome-profile'`); next submit failed with the classified `✗ browserContext.newPage: Target page, context or browser has been closed` error item while the TUI stayed alive; the following submit relaunched Chrome and completed (`✓ Brewed in 17s · 1.9k tokens`, heading3.txt = "Example Domain" on disk) — /tmp/sherlock-chromedeath2.out.
  * Motion restraint re-confirmed on the narrow demo capture: finalized blocks painted once; only the live region repaints.
  * R1–R12 walk: R1 live runs + /runs + /evals all exercised against real Chrome/API this session; R2 single growing transcript with inline blocks + bottom composer (all captures); R3 status line `✻ Word…` + `↳ tokens · elapsed` with ticking tokens/time; R4 word list from config, several distinct words per run, no consecutive repeats (pickWord sweep + captures); R5 semantic ● lines, never raw JSON (raw detail only under --verbose), ◆ evidence emphasized with source when recorded; R6 persistent completion line, verb configurable (test uses 'Distilled'); R7 restrained motion (4 fps glyph, ~6 s word cadence, 1 s clock, no bars/percentages/layout shifts); R8 glanceability (working state, activity, elapsed, tokens, sources, evidence, finish time all visible in captures); R9 composer disabled during runs with mode-specific hints, Esc cancel verified live; R10 /help /runs /evals /exit all live-verified, Ctrl+C fallback; R11 zero agent-core changes (S9-V7); R12 Ink 7 + Andera truecolor palette (raw `38;2;169;161;230` observed in PTY bytes) + `sherlock` bin. No open gaps.

Statuses flipped: S9-F1…S9-F8 → pass. **All 72 features in features.json now pass.**

## 2026-08-11 09:47 PDT — R1 complete: slash-command autosuggest

- New: `src/tui/store/commands.ts` — the single `SLASH_COMMANDS` registry ({name, description} × /help /runs /evals /exit), `findCommand`, and `filterCommands` (leading `/`, no whitespace, case-insensitive prefix match on the name; [] hides the panel). `reducer.ts`: `routeInput` now routes via `findCommand` (registry names are `/${kind}` by construction) and `HELP_TEXT` is generated from the registry — asserted byte-identical to the old literal, so no help-text churn.
- New: `src/tui/components/CommandSuggestions.tsx` — the panel rendered directly above the composer input: `›` + emphasis on the selected row, typed prefix bold inside each name (primary/emphasis), fixed 8-col name column, muted description; each row is ONE nested-Text paragraph with `wrap="truncate-end"` (narrow-terminal rule), no new colors.
- `Composer.tsx` owns all suggestion state locally (reducer untouched, stays pure): suggestions derive from `filterCommands(value)` unless disabled/dismissed; up/down move a clamped selection (reset to 0 on every edit), Tab completes the selected name into the input without submitting, Enter submits the selected command via handleSubmit's override (TextInput ignores up/down/Tab so there is no key contention; idle-mode Esc was already a no-op in App), Esc sets a `dismissed` flag that clears on the next input change; no match or whitespace means the panel hides and the line submits as typed (unknown-command notice path unchanged).
- Tests: `tests/tui/commands.test.ts` (registry contents, exact-name lookup, all filter edges, registry-driven routeInput/HELP_TEXT incl. byte-identity); `tests/tui/command-suggest.test.tsx` (app-level: `/` lists all four with descriptions; `/e` shows only /evals + /exit; down+Enter opens Past runs; Enter submits the SELECTED command (down to /exit, then onExit); clamped ends; Tab completes without submitting; Esc dismisses (150 ms Ink ESC wait) and typing re-shows; no-match submits as typed; space hides; snapshots of the open-panel frame plus the bare panel at 80 and 44 cols with a max-44-display-columns per-line assertion). `renderAt` width harness moved from smoke.test.tsx into tests/tui/helpers.ts (shared; smoke snapshots unchanged). Arrow/Tab keys written as explicit '[A'/'[B'/'\t' escapes, never invisible bytes.

Verification evidence:

- `R1-V1`: `npx vitest run tests/tui/commands.test.ts` — 12 tests pass (also reducer.test.ts 27 pass, untouched).
- `R1-V2`: `npx vitest run tests/tui/command-suggest.test.tsx` — 12 tests pass, 3 new snapshots written and reviewed line by line (panel rows aligned `  /help   Show this list` etc., `›` on the selected row, panel sits directly above the composer box; smoke.test.tsx.snap has zero diff).
- `R1-V3`: `npm test` — 57 files / 396 tests pass (was 55/372; +24 new: 12 commands + 12 command-suggest), green on the final tree twice under normal load (a first full run before the HELP_TEXT byte-identity test was added passed 395/395). Honest flake note: two intermediate full runs, executed while the PTY-capture background processes were still winding down, hit the known step-9 load-related 30 s timeout class in pre-existing typing tests (worst case `app.test.tsx > appends submitted tasks`); that file passes twice consecutively in isolation (6.6 s / 7.9 s) and in the final full run, so the timeouts are load flake, not an R1 regression. `npm run typecheck` exit 0. `git diff --check` clean. `git diff --exit-code main...HEAD -- src/loop src/model src/tools src/run src/browser src/tracing` exit 0 (core untouched).
- `R1-H1` (agent-judged, honestly: I drove and judged this myself, no human eyes on it): Python pty+TIOCSWINSZ driver (/tmp/r1_pty.py, /tmp/r1_pty2.py) ran `npm run sherlock -- --demo`, waited 50 s for the demo to finish, then typed the script; ANSI stripped with perl. 80-col captures (/tmp/r1-pty80.out, /tmp/r1-pty80b.out): `/` renders all four rows (`› /help   Show this list` through `  /exit   Quit Sherlock`) above the composer; `r` re-filters live to only `› /runs   Browse past run directories`; raw bytes show the typed prefix bold — selected row is ESC[38;2;174;164;255m + `› ` + ESC[1m + `/r` + ESC[22m + `uns` with the description in muted ESC[38;2;125;121;147m, matching the Claude Code reference treatment; down-arrow moves `›` from /help to /runs; Tab completes the input to `/runs` without submitting; Enter then opens the real Past runs overlay (12 runs listed); Esc closes it; `/exit`+Enter (Enter submits the selected command) quits cleanly. Esc-dismissal also captured: panel gone while `› /r` stays in the composer, and the next edit re-shows it. 44-col capture (/tmp/r1-pty44.out): same panel intact, and the width scan (unicodedata.east_asian_width display columns, /tmp/r1_width.py) reports 0 of the stripped capture's lines over 44 (widest exactly 44 — the composer border).

Statuses flipped: R1-F1, R1-F2, R1-F3, R1-H1 → pass. R2/R3 untouched.

## 2026-08-11 11:13 PDT — Revision round 1 (R1–R3) complete: all 84 features pass

R1 was implemented directly on this branch; R2 and R3 ran as parallel subagents in
isolated worktrees and were combined here (R2 fast-forwarded, R3 cherry-picked as
278a619 from df2b400 with two both-added conflicts resolved in format.ts/state.ts).
Statuses were flipped only after re-verifying the MERGED tree. Sub-agent evidence
below is reproduced from their reports (agent-judged, PTY-verified in their
worktrees before the merge).

### R1 — slash-command autosuggest (commit edbada0, verified on this branch)
- R1-V1: commands.test.ts 12/12; reducer.test.ts 27/27 (routeInput/HELP_TEXT now
  derive from the single SLASH_COMMANDS registry; HELP_TEXT byte-identical).
- R1-V2: command-suggest.test.tsx 12/12 — '/' lists all four commands, '/e' filters
  to /evals+/exit, down+Enter opens the Past runs overlay, Tab completes without
  submitting, Esc dismisses (150 ms ESC wait) and typing re-shows, no-match submits
  as typed.
- R1-V3: npm test 57 files / 396 tests green; typecheck exit 0; git diff --check
  clean; core dirs zero-diff.
- R1-H1 (agent-judged PTY): Python pty+TIOCSWINSZ over `npm run sherlock -- --demo`;
  80-col frames show the panel above the composer, live filtering to
  '› /runs   Browse past run directories', raw bytes confirm prefix bolding
  (ESC[1m/rESC[22muns); down moves the marker, Tab completes unsubmitted, Enter
  opens the real overlay. 44-col capture: 0 lines over 44 display columns.

### R2 — arrow-navigable /runs browser (commit 33e6a6a, agent-verified pre-merge)
- R2-V1/V2: runs-list.test.tsx (12) + app.test.tsx — Enter and right-arrow open the
  highlighted run's detail in-overlay (artifacts + sha256 prefixes + 'completed ·
  5 turns · 31.2k tokens · 1m 24s' asserted); left/Esc return to the list with the
  cursor preserved; up/down in detail switch runs, clamped at both ends;
  load-failure path renders "Couldn't read this run: …" inside the overlay; detail
  renders with zero overflow at 44 columns; app-level test drives the whole loop
  through the real reducer and real loadRunSummary over fixture run dirs, and
  asserts no transcript summary is appended.
- R2-V3 (in the agent worktree): npm test 57 files / 401 tests green; typecheck 0;
  git diff --check clean.
- R2-H1 (agent-judged PTY, real runs/ with 12 runs): 80-col script(1) capture and
  44-col Python pty capture. Frames: list ('Past runs', 8-row window, '1/12',
  '↑↓ select · enter view · esc close') → Enter → 'Past runs · run 1/12' with
  '◆ heading.txt  31 B · sha256 e510f63c425b' and '◆ andera_homepage.png  84.1 KB ·
  sha256 89e711b881dc' → down → 'run 2/12' → left → list with '›' on row 2
  (cursor preserved) → Esc closes. Width: 0/1698 lines over 44 cols; 0/1657 over 80.
- Dead code removed: show_run_summary reducer action, run_summary transcript body +
  renderer; formatBytes moved to format.ts as a public helper. S7-F5/S7-F6
  descriptions revised in features.json to match the in-overlay behavior.

### R3 — startup welcome card (df2b400, cherry-picked as 278a619; agent-verified pre-merge)
- R3-V1: shell.test.tsx 7/7 — '╭─ Sherlock — evidence collection agent ─' in the
  border chrome; 'Welcome back Brios!' with injected identity; art rows asserted;
  footer 'claude-sonnet-5 · ~/Desktop/Code/evidence-collection-agent'; the
  ANTHROPIC_API_KEY warning still asserted at apiKeyPresent=false; generic
  no-identity fallback asserted.
- R3-V2: renderAt(44) — card lines exactly 42 wide, zero overflow, footer path
  middle-truncated; renderAt(36) — title truncates, zero overflow. Smoke +
  command-suggest snapshots re-recorded; only the banner block changed.
- R3-V3 (in the agent worktree): 400/400 total (394 in a load-constrained full run
  + playwrightBrowserController 6/6 standalone after an environmental beforeAll timeout under
  parallel load); typecheck 0; git diff --check clean.
- R3-H1 (agent-judged PTY): real startup captures at 80 and 44 cols (Python
  pty.fork + TIOCSWINSZ). Card shows title-in-border, 'Welcome back Brios!' (real
  git config), lens art, model·path footer; missing-key warning verified in a
  separate capture with the var unset via env manipulation (no .env created or
  read). 0 lines over width in both captures.
- Identity {name, model, cwd} computed in main.tsx (git config user.name first word,
  fallback os.userInfo; DEFAULT_MODEL imported read-only from src/model/callModel.ts);
  reducer stays pure; App identity prop optional with a deterministic generic
  fallback.

### Merged-tree verification (this branch, after combining all three)
- npm run typecheck → exit 0.
- npm test → 57 files / 405 tests, all passed (26.4 s).
- git diff --check → clean. Core check: `git diff --name-only edbada0..HEAD --
  src/loop src/model src/tools src/run src/browser src/tracing` → empty.
- Combined PTY session (agent-judged; /tmp/combined-pty80.out, 214 KB, 80×30,
  Python pty driver): startup card ('╭─ Sherlock — evidence collection agent ─…╮',
  'Welcome back Brios!', '│  ◆  │' lens row, 'claude-sonnet-5 ·
  ~/Desktop/Code/eviden…s/evidence-agent-tui') → demo played to '✓ Brewed in 42s'
  → '/' opened the suggestion panel ('/help' … 'Browse past run…') → 'r' filtered
  → Enter opened 'Past runs' ('enter view · esc close') → Enter opened run 1/12
  detail (sha256 prefixes visible) → down to 'run 2/12' ('◆ heading3.txt  14 B ·
  sha256 162b81548a8d', '↑↓ prev/next run · ← back · esc back') → left returned to
  the list with '›' preserved on row 2 → Esc closed → /exit quit cleanly.
  Width: 0/1982 lines over 80 display columns.
- Notable operational finding: both isolated agent worktrees were created on a
  wrong base (70af47f, pre-TUI lineage); both agents detected this and repointed to
  edbada0 before starting. Recorded in project memory.

## 2026-08-11 12:07 PDT — R4: transcript breathing room (prose padding + action spacing)

- Change: `paddingLeft={2}` on agent prose (finalized agent_text items and the
  LiveRegion streaming text, so wraps indent too); `marginTop={1}` on activity/
  evidence items and on LiveRegion pending tool rows (spacing identical before
  and after finalization into <Static>). Source/verbose sub-lines stay attached.
- R4-V1: smoke snapshots re-recorded; git diff reviewed line by line — only the
  two intended deltas (2-space prose indent incl. wrapped lines; exactly one
  blank line between consecutive action rows, none doubled; the 3-space wrap
  artifact in the 44-col frame pre-exists this change). npm test → 57 files /
  405 tests passed (28.4 s). npm run typecheck → exit 0. git diff --check → clean.
- R4-H1 (agent-judged PTY): /tmp/r4-pty80.out (80×30, Python pty driver,
  --demo). Streaming prose padded from the first token ('  I'll'); finalized
  '● Opening sec.gov/cgi-bin/browse-edgar?company=acme  ✓' followed by exactly
  one blank line then the next pending action; pending '◆ Evidence saved →
  investors.csv…' likewise carries one blank line above. Width: 0/1921 lines
  over 80 display columns. 44-col rendering covered by the re-recorded narrow
  smoke snapshot.

## 2026-08-11 12:13 PDT — R4 addendum: one-column marker gutter (user follow-up)

- Change: paddingLeft={1} on every marker row — user_task, activity, evidence,
  completion (runDir sub-line shifts with it), cancelled, error, and LiveRegion
  pending rows. Prose keeps paddingLeft={2}.
- R4-V2: smoke snapshots re-recorded; diff reviewed line by line — every marker
  row shifted exactly one column, prose lines byte-identical; the 44-col
  sec.gov action line now wraps its trailing status glyph (expected at 42
  effective columns), zero overflow. npm test → 57 files / 405 tests passed
  (27.9 s). npm run typecheck → exit 0. git diff --check → clean. The rendered
  smoke frames are the evidence surface for this one-column nudge; no separate
  PTY pass (mechanism unchanged from R4-H1).

## 2026-08-11 13:50 PDT — Merged main into the TUI branch (pre-merge-to-main integration)

- main had diverged by 8 commits (repo restructure into per-tool dirs +
  evals-by-concern, Chrome-native download tool with exactly-one-of ref/url
  schema, F1-F4 baseline mechanisms, eval baselines). Textual conflicts: only
  README.md (kept both — Sherlock section + main's restructured body) and
  package.json (kept sherlock bin/script + main's evals/runners/cli.ts path).
- Semantic fixes after the merge:
  - runSession: tool groupings now import from src/tools/index.js (per-tool
    dir restructure).
  - evalSession: loadTask/report/runner moved to evals/runners/, metrics to
    evals/metrics/; EvalReport gained a required `model` field — recorded as
    DEFAULT_MODEL (the model the TUI's injected callModel runs).
  - evalsDir default: evals -> evals/datasets (tasks moved in the restructure);
    updated in config.ts, main.tsx, and the app-level /evals test.
  - stubBrowser: BrowserController gained download() — stub returns an empty
    BrowserDownloadResult.
- Verification on the integrated tree: npm run typecheck exit 0; npm test twice
  consecutively -> 70 files / 463 tests passed both times (main's new suites +
  all 20 TUI suites); git diff --check clean.
- Note: real-API end-to-end run not re-executed for this merge (core behavior
  covered by main's own suites + the TUI's real-runTask scripted-stream tests).

## 2026-08-11 18:40 PDT — R5: composer ghost completion + purple command text

- Change: Composer renders the highlighted suggestion's untyped remainder as
  muted+dim ghost text inline after the TextInput cursor (what Tab fills);
  input starting with '/' renders in theme.emphasis via a Text wrapper around
  TextInput (nested-Text style cascade). Tab completion itself is unchanged
  from R1.
- R5-V1: command-suggest.test.tsx 14/14 — '/e' shows '/e vals' in the composer
  row, down-arrow switches the ghost to '/e xit', Tab fills '/runs' with no
  ghost letters left and the panel still up (not submitted). Panel snapshot
  re-recorded; diff reviewed — only the ghost in the composer line.
- Full battery: npx vitest run --maxWorkers=2 → 70 files / 465 tests passed.
  Two flaky failures in earlier unconstrained runs (inspectPage afterAll
  Chrome-teardown timeout; the /evals app trial) both pass standalone and in
  the constrained run — contention with a LIVE user sherlock session (pid
  14156) whose Chrome shares this machine; that session was left untouched.
  npm run typecheck exit 0; git diff --check clean.
- R5-H1 (agent-judged PTY, /tmp/r5-pty80.out): composer row raw bytes show
  border(muted) '› '(primary) then ESC[38;2;174;164;255m'/e' (emphasis purple),
  the inverse-space cursor, then ESC[38;2;125;121;147m ESC[2m 'vals' (muted dim
  ghost); down-arrow, Tab -> '/exit' completed, Enter quit the session.
