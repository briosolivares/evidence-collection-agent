# Artifact UX plan — live rows, provenance detail, completion summary

**Status: REVIEWED 2026-08-12, ready to implement.** Written from a full code map of the artifact pipeline and TUI layer (see [code-map.md](code-map.md) for file:line anchors behind every claim here). The three open decisions were ruled on 2026-08-12 — see "Resolved decisions" below; the phases already reflect the rulings.

## Goal

When the agent finishes a task, the TUI presents a **completion summary**: a concise answer (what was completed) plus the published artifacts. During the run, published artifacts appear as **selectable rows the moment they land**. On any artifact row:

- **Enter** — small detail view with provenance: source URL, capture time, sha256, size
- **Space** — Quick Look preview (`qlmanage -p`: the system preview, identical to Finder's spacebar)
- **o** — open the file in the native app
- **r** — reveal in Finder

Entirely in the TUI layer. The agent core keeps doing exactly what it does today — publish artifact metadata through `writeArtifact` into `manifest.json` — and the UI decides how to present, preview, and open it.

## What already exists (and what's missing)

Everything the detail view needs is **already captured at publish time**: `writeArtifact` (`src/run/artifacts.ts:108`) returns a full `ManifestEntry` — `filename`, full `sha256`, `sourceUrl`, `roles`, `capturedAt` — and `roles` presence is the published-vs-scratch marker (enforced at `artifacts.ts:165-189`). It is then thrown away twice: tools return only `{path, size}` to the model, and the TUI tracing seam (`tuiTracing.ts:29-57`) re-reads `manifest.json` off disk per evidence call just to recover `sourceUrl`, discarding hash, capture time, and roles. Hash and capture time never reach the live TUI at all.

Three latent bugs this feature fixes in passing:
- `write_file` to `scratch/` renders as evidence today (`semantic.ts:121-130` classifies by tool *name*, not path)
- `browser_batch` captures never surface (inner registry hides them from tracing; `browserBatch.ts:98-126`)
- offloaded tool output (`scratch/tool-output/`) sits in `manifest.artifacts` and would pollute any naive artifact list

## Design decisions

1. **Data source: manifest-diff at the tracing seam → a new `artifact_published` UiEvent.** After each tool execution, `tuiTracing` re-reads `manifest.json`, diffs against the last snapshot (keyed by `filename`, compared by `sha256` so re-publishes update), and emits one `artifact_published { entry, toolExecId }` per new/changed entry **with `roles` present** (published ⟺ under `artifacts/`). Scratch entries are never emitted. This subsumes and deletes `lookupSourceUrl`.
   - *Why not widen tool results to carry the `ManifestEntry`?* Tool results are model-visible — changing their shape changes agent behavior and token counts (eval-relevant), and it still misses `browser_batch`'s inner writes. The manifest **is** the published-metadata channel; reading it is exactly what graders already do. Cost is negligible: the manifest is small and the seam already re-reads it today; same try/catch posture ("tracing must never break a run").
   - Emit `artifact_published` *before* that exec's `tool_exec_end`, linked by `toolExecId`, so the reducer has the data in hand when it renders the evidence line.
2. **Selectable rows cannot live in the transcript.** The transcript is Ink `<Static>` — emitted items never repaint (documented at `state.ts:1-4`, `Transcript.tsx:6-10`, `reducer.ts:5-10`), so a moving selection cursor is impossible there. Interactive rows live in **live (non-Static) surfaces**: an artifact rail below `LiveRegion` during the run, and an artifacts overlay for the completion summary. The `<Static>` transcript keeps a permanent, non-interactive record (item 8).
3. **Focus model: the reducer owns the artifact UI substate** (`cursor`, `view: 'rows' | 'detail'`). This deviates from the RunsList precedent of component-local view state, deliberately: during a run, Esc is owned by App's global handler (cancel), and closing the detail card must win over cancelling the run — that precedence check needs shared state (`App.tsx:88-99` consults it before treating Esc as cancel). Bonus: the whole interaction becomes reducer-testable without Ink.
4. **Completion summary renders passively; Tab focuses it** (ruling: no forced Esc after each run). On completion the summary panel appears above the composer but the composer keeps focus — typing the next task works immediately. Pressing **Tab** enters the `'artifacts'` overlay mode (new `SessionMode` variant, consistent with the invariant "overlays are modes so exactly one surface owns input", `state.ts:6`) where ↑↓/Enter/Space/o/r operate; Esc (or Tab again) returns focus to the composer, panel still visible. Tab is safe: the composer only consumes it while the slash-suggestion panel is up (`Composer.tsx:82-99`, `isActive: panelVisible`; `TextInput` ignores Tab). `/artifacts` reopens the panel after it's been superseded.
5. **Open/reveal/preview is a small injectable helper**, `spawn`-based with `stdio: 'ignore'` + detached so the child can never write into Ink's raw-mode TTY. macOS: `open`, `open -R`, and `qlmanage -p` for Quick Look (the OS-default preview; long-stable despite its debug-tool origins, and it runs as a separate GUI process that never touches our TTY). Linux: `xdg-open` for **o** and as the **Space** fallback; **r** shows a "not supported on this platform" notice. Failures render as a notice line, never a crash.

## Phase 1 — publish the metadata to the UI (plumbing)

1. **`artifact_published` UiEvent + manifest-diff emitter.** Add the event to the union (`state.ts:143-170`, payload = full `ManifestEntry` + `sizeBytes` + `toolExecId`); implement snapshot/diff in `tuiTracing.ts`; delete `lookupSourceUrl` and the `sourceUrl` field threading on `tool_exec_end`. Tests: tracing tests against a fixture run dir covering screenshot/download/write_file, a `browser_batch` inner write (must emit), a scratch offload (must not emit), and a re-publish to the same filename (must re-emit).
2. **Reducer: `state.artifacts` + evidence lines driven by publishes.** Upsert by `filename`; cleared on `run_started`; retained after the run ends (feeds `/artifacts`). `tool_exec_end` renders an evidence item iff that exec published ≥ 1 artifact (via `toolExecId`), taking `sourceUrl` from the entry — this fixes the scratch-write misclassification and surfaces `browser_batch` captures as evidence lines. Update `semantic.ts` and `runFixtures.ts` (which lacks `roles`) accordingly. Tests: reducer + semantic tests.

**Acceptance check:** in a dev run, every published file shows an evidence line with its real source URL; a `write_file` to `scratch/` shows as plain activity; the reducer's `state.artifacts` holds full provenance for exactly the published set.

## Phase 2 — open/reveal/preview helper

3. **`src/tui/openExternal.ts`**: `openPath(absPath)`, `revealPath(absPath)`, and `quickLookPath(absPath)`, platform-aware per decision 5, spawn function injectable for tests, returns a result (ok / message) instead of throwing. Unit tests with an injected spawn recorder, including the non-darwin reveal and Quick Look fallback paths.

## Phase 3 — live artifact rail (during the run)

4. **`ArtifactRail` component**, mounted when `mode === 'running'` and `state.artifacts` is non-empty, rendered with `LiveRegion`. Rows follow the house list idiom (`› ` + `theme.emphasis` cursor, windowing like `RunsList.tsx:110-114`, muted hint line: `↑↓ select · enter details · space preview · o open · r reveal`). Its `useInput` owns ↑↓/Enter/Space/o/r — all dead keys in `running` mode today, so no conflicts; App's Esc handler is extended per decision 3 (detail open → close detail; otherwise cancel as today). Tests: key navigation, Esc precedence (Esc with detail open must NOT cancel the run), zero-overflow at 44 columns.
5. **Detail card** (shared component, also used by the overlay in phase 4): filename + role tag (`requested output` / `evidence`), source URL, captured-at in local time, full sha256 (wrapped), size on disk, hint `space preview · o open · r reveal · esc back`. Space/o/r work from both the row list and the detail card.

**Acceptance check:** during a live run, a screenshot lands and its row is selectable within the same turn; Enter shows full provenance; Space Quick-Looks it; o opens Preview.app; r reveals in Finder; Esc from detail returns to the rail without cancelling the run.

## Phase 4 — completion summary

6. **Summary panel + Tab focus** (`ArtifactsPanel`): header line (✓ verb · elapsed · tokens · runDir), a **concise answer block** — `run_finished.finalText`, which the reducer currently discards (`state.ts:163`), clamped to a few lines (full prose is already in the transcript as `agent_text`; fallback "Task completed" when empty) — then the artifact rows, requested outputs first. Per decision 4 the panel renders **passively** when idle with a completed-run summary in state (cleared on the next `run_started`); the composer keeps focus, so `run_finished` transitions to `idle` exactly as today. **Tab** dispatches into mode `'artifacts'` where selection/detail/Space/o/r behave as in the rail; Esc/Tab returns to idle with the panel still visible. Muted hint on the passive panel: `tab to browse artifacts`. The panel is suppressed mid-eval-batch (`evalsRunning`); cancelled/budget-exceeded runs don't render it, but their artifacts remain reachable via `/artifacts`.
7. **Static transcript record.** Extend the `completion` item (`state.ts`, `TranscriptItem.tsx:62-73`) with an artifact digest — one line per published artifact (filename · size · role) under the ✓ line — so scrollback keeps a permanent, if inert, copy of the summary after the overlay is dismissed.
8. **`/artifacts` command**: re-renders the panel for the most recent run and focuses it, while idle (gated like `open_runs`, `reducer.ts:193-203`); add to `commands.ts`, suggestions, and `/help`.
9. **Demo + snapshots.** Add `artifact_published` events to the demo script so the rail and summary appear in `--demo`; update the smoke snapshots (they fold the demo through the real reducer at 80 and 44 columns and **will** break otherwise).

**Acceptance check:** run a real task producing a CSV + screenshots; on completion the summary shows the answer and the rows; typing the next task immediately works with no Esc; Tab instead focuses the rows and Enter/Space/o/r work; `/artifacts` brings the panel back later.

## Phase 5 — polish and docs

10. **Platform fallback polish**: Linux `xdg-open` for open/Space, reveal notice, and a graceful notice when `qlmanage`/`open` are missing; verify no spawned child can disturb the Ink frame.
11. **Docs**: README key reference (`↑↓ · enter · space · o · r · tab · /artifacts`); AGENTS.md TUI section note that `artifact_published` is derived from the manifest at the tracing seam (the manifest remains the single source of truth).

## Resolved decisions (ruled 2026-08-12)

- **No auto-focus of the completion summary** — the user does not want to press Esc after each run. The panel renders passively; **Tab** focuses it (Tab is unused by the composer outside the slash-suggestion panel). This replaces the earlier auto-open recommendation; phases above reflect it.
- **Rail vs transcript duplication: keep both** (chronological log vs live interactive state); revisit only if the demo reads as clutter.
- **Preview via the system default: yes — macOS Quick Look** (`qlmanage -p`), bound to **Space** to match Finder muscle memory. Supersedes the earlier in-terminal text-preview idea (originally phase 5), which is dropped. Space/o/r work from both the row list and the detail card.

## Out of scope (deliberately)

- **Any agent-core change.** No system-prompt edits (byte-stable prefix), no tool-result shape changes (model-visible surface stays identical — evals unaffected), no new writes: the TUI reads `manifest.json` from the run dir exactly as graders do. `writeArtifact`/`resolveRunPath` chokepoints untouched.
- **In-terminal previews / mime detection** — Quick Look (Space) delegates previewing to the OS, which does it better than any terminal rendering could; the detail card stays provenance-only.
- **Retrofitting the `/runs` browser** with selectable artifact rows — natural follow-up; the phase-3/4 detail card and a widened `loadRunSummary` (which today drops `capturedAt`/`roles` and truncates the hash, `runScanner.ts:88-101`) are built to be reusable there.
- **Windows** — untested platform posture unchanged.

## Effort estimate

Roughly eleven commits, one per numbered item, each leaving the suite green. Phase 1 is the substance (the event + reducer contract); phases 3–4 are component work on well-worn house idioms (RunsList selection, mode-gated overlays); phases 2 and 5 are small. Interaction-heavy suites need the standing 30s-timeout convention, and the smoke snapshots are expected to churn once (item 9).
