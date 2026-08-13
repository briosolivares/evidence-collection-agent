# Code map — artifact pipeline & TUI (research behind plan.md)

Mapped 2026-08-12 on `main` @ c9c7e69, working tree clean. Every claim carries a file:line anchor.

## Artifact pipeline

- **Chokepoint**: `writeArtifact(runDir, relPath, bytes, meta)` at `src/run/artifacts.ts:108-143`. Returns the full `ManifestEntry`. Manifest is `manifest.json` (one pretty-printed doc, rewritten whole per write, `artifacts.ts:8`, `:205-209`); entries **upsert by filename** (`:135-140`) — the TUI can key rows on `filename` safely.
- **`ManifestEntry`** (`artifacts.ts:27-40`): `filename` (run-dir-relative), `sha256` (full lowercase hex, hashed from in-memory bytes at capture time, `:129`), `sourceUrl?`, `roles?: ('requested_output'|'evidence')[]`, `capturedAt` (ISO, `:132`). **`roles` present ⟺ file under `artifacts/`** — that presence is the published/private marker, enforced by `assertWorkspacePartition` (`:165-189`): non-`artifacts/`+`scratch/` paths throw; `artifacts/` without roles throws; `scratch/` with roles throws.
- **Publishers** and their provenance:
  - `screenshot` (`src/tools/screenshot/screenshot.ts:51-57`): `sourceUrl = browser.currentUrl()` captured before the shot; roles default `['evidence']`.
  - `download` (`src/tools/download/download.ts:99-106`): `sourceUrl = finalUrl` if HTTP(S), else initiating page URL (blob case, captured at `:81`); non-2xx throws (`:85-92`); roles default `['evidence']`.
  - `write_file` (`src/tools/writeFile/writeFile.ts:56-64`): no sourceUrl; roles default `['requested_output']`; returns a prose string (path only in `input.file_path`).
  - offload (`src/tools/capResult.ts:127-152`): writes `scratch/tool-output/` with no meta, outside any traced tool call. **Manifest includes scratch entries — always filter on `roles`.**
- **No mime type exists anywhere** in `src/` (verified by grep).
- **Completion is not a tool**: zero `tool_use` blocks → `{status:'completed', finalText}` (`src/loop/agentLoop.ts:285-290`); `stop_reason` deliberately ignored (`:145-149`). `finalizeManifest` stamps `finishedAt` from the composition root's `finally` (`src/cli/runTask.ts:180-192`).

## The two loss points (why hash/capture-time never reach the live TUI)

1. **Tool boundary**: `EvidenceResult = {path, size}` (`src/tools/shared/evidence.ts:16-21`) — tools hold the full `ManifestEntry` and return only path+size (model-visible, so widening it changes agent behavior/tokens).
2. **Tracing seam re-derives from disk**: `lookupSourceUrl` (`src/tui/bridge/tuiTracing.ts:29-57`) re-reads `manifest.json` after each evidence call, guesses the filename from `result.path`/`input.file_path`/`input.filename`, returns **only** `sourceUrl`; blanket try/catch ("tracing must never break a run"). `EVIDENCE_TOOLS = {write_file, screenshot, download}` (`tuiTracing.ts:24`) — name-based, misses `browser_batch` (inner registry, `src/tools/browserBatch/browserBatch.ts:98-126`) and misclassifies scratch writes (`src/tui/store/semantic.ts:121-130`).

## TUI layer

- **Event surface**: `UiEvent` union at `src/tui/store/state.ts:143-170`; plain callback stream (`dispatch` passed straight to the runner, `App.tsx:107`); producers are `runSession.ts` (turns/text/usage) and `tuiTracing.ts` (`run_dir` once, `tool_exec_start/_end`). Ordering contract at `runSession.ts:96-103`; exactly one terminal event. **No artifact event exists today.** `run_finished` carries `finalText` + `runDir` (`state.ts:163`) — reducer currently discards `finalText` (`reducer.ts:420-447`).
- **Transcript is Ink `<Static>`** — emitted items never repaint (`state.ts:1-4`, `Transcript.tsx:6-10`, `reducer.ts:5-10`). Selection cursors are impossible inside it; interactive surfaces must be live regions/overlays.
- **Item model**: discriminated union `TranscriptItemBody` (`state.ts:75-101`); exhaustive switch in `TranscriptItem.tsx:20-103` (no default — new kinds force a case); single `append()` assigns ids (`reducer.ts:135-141`). Completion renders `✓ Brewed in 1m 24s · 31.2k tokens` + runDir (`TranscriptItem.tsx:62-73`); verb from `config.completionVerb` (`config.ts:56`).
- **Focus model**: no Ink focus manager anywhere; `ink-select-input` declared but never imported. Modes own input — `SessionMode` (`state.ts:7-13`), invariant comment at `state.ts:6`. Four `useInput` sites: `App.tsx:88-99` (global Esc: cancel when running), `Composer.tsx:82-99`, `RunsList.tsx:63-88`, `EvalsMenu.tsx:31-92`. Composer is unmounted-when-disabled (`App.tsx:189`, `Composer.tsx:113-130`).
- **Selectable-list idiom to copy**: `RunsList.tsx:60-88` — local `view: 'list'|'detail'` + `cursor`; Enter/→ opens detail; ←/Esc unwinds one level; only top-level Esc calls `onClose`; `› ` + `theme.emphasis` selected row; windowing at `:110-114` (limit 8); hint lines are the level markers tests assert on (`runs-list.test.tsx:18-19`). Overlay open/close gating at `reducer.ts:193-203` (idle-only).
- **`/runs` browser today**: `runScanner.ts` — `scanRuns` (`:42-77`, status from files alone, ruling at `:1-6`), `loadRunSummary` (`:80-126`) **drops `capturedAt` and `roles`, truncates sha256 to 12 chars** (`:95-100`); `RunsList.tsx:208-219` renders artifacts as inert text, `sourceUrl` loaded but never rendered.
- **External open**: nothing exists; only shell-out precedent is `execFileSync('git', …)` in `main.tsx:31` (stdio-suppressed, failure-tolerant). Ink owns the TTY in raw mode → spawn with `stdio:'ignore'` + detached.
- **Demo/snapshots**: `smoke.test.tsx:13-16` folds the demo script through the real reducer and snapshots at 80/44 columns — any new item kind in the demo breaks them (expected churn).

## Test conventions

- `tests/tui/helpers.ts`: `tick()`, `ENTER='\r'`, `ESC=''`, `typeText`, `renderAt(width, …)` for 44/36/80-column asserts. Arrow keys defined per-file (`runs-list.test.tsx:12-16`). Esc needs `await tick(150)` (Ink debounce).
- 30s timeout header verbatim in every interaction-heavy suite (`vi.setConfig({ testTimeout: 30_000 })`).
- `tests/tui/runFixtures.ts` builds real run dirs; **lacks `roles`** (`:43`) — must be extended.
- Injectable seams (`now`, `rng`, `loadSummary`, `limit` props) for determinism; every panel has a zero-overflow-at-44-columns test.

## Binding rules touched (all respected by this plan)

`AGENTS.md:24-31` and `.agents/summary/architecture.md:73-82`: no task-specific logic; byte-stable prompt prefix; every write through `writeArtifact`, every path through `resolveRunPath`; graders select deliverables via `requestedOutputs()` only; completion = zero tool_use. The feature only *reads* `manifest.json` (as graders do) and adds TUI-side events/components.
