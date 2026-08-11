# Sherlock TUI — Revision round 1 (2026-08-11)

User feedback after first hands-on session. Three revisions, recorded verbatim in
intent, then design decisions. Same evidence discipline as the original plan:
run every mapped Verify before flipping a features.json status, append
timestamped evidence to progress.md, one commit per revision.

## User notes (as given)

1. "Can you make the commands autosuggest as you're typing them like the way
   Claude Code does" — reference screenshots: typing `/` shows a panel of
   commands (name left, description right); typing `/m` filters to matching
   commands with the typed prefix highlighted in bold; a selected row is
   visually distinct; the composer sits below the panel.
2. "When you open runs and I click on one I should be able to navigate back to
   the list of all them with my arrow keys — basically make it navigable with
   the arrow keys." Today Enter on a run appends the summary to the transcript
   and closes the overlay; there is no way back to the list without re-typing
   `/runs`.
3. "Add a visual/startup banner/welcome card on startup that shows
   'Welcome back {user's name}!', an image of a magnifying glass, the model
   being used and the path of the folder you're in (these two separated by a
   dot), a colored border with the name Sherlock — evidence collection agent
   in the border chrome." Reference screenshot: Claude Code's bordered welcome
   box (title embedded in the top border, bold welcome line, pixel-art logo,
   muted `model · path` footer).

## R1 — Slash-command autosuggest

Design:
- Single exported registry `SLASH_COMMANDS: { name, description }[]` (in
  `src/tui/store/reducer.ts` or a new `commands.ts`) — the one source for
  `routeInput`, `HELP_TEXT`, and the suggestion panel. No duplicated lists.
- In the idle composer only: when the input starts with `/` and contains no
  space, show a suggestion panel directly above the composer (dynamic region,
  not `<Static>`). Rows: command name (left column, fixed width), description
  (right column, muted, truncated to fit). The typed prefix inside each name
  renders bold/emphasis; the selected row gets the `›` marker + emphasis color.
- Keys while the panel is visible: ↑/↓ move selection (clamped or wrapping —
  pick one, test it), Tab completes the selected name into the input without
  submitting, Enter submits the selected command, Esc dismisses the panel
  (idle-mode Esc is otherwise a no-op, so no conflict with run cancellation).
  Continued typing re-filters; the panel hides when nothing matches (input
  submits as typed, hitting the existing unknown-command notice).
- Filtering is prefix-match on the name after `/` (case-insensitive).

Verify:
- R1-V1: unit tests for the registry + filter (`npx vitest run tests/tui/reducer.test.ts`
  or a new commands test) — routeInput/HELP_TEXT still driven by the registry.
- R1-V2: app-level tests — type `/` → all commands listed; type `/e` → only
  /evals + /exit; ↓ then Enter opens the expected overlay; Tab completes
  without submitting; Esc hides the panel. Snapshots re-recorded and reviewed.
- R1-V3: full battery — `npm test`, `npm run typecheck`, `git diff --check`.
- R1-H1 (agent-judged, PTY): `script -q` capture at 80 and 44 cols typing `/`
  then `/r`; panel matches the reference layout, prefix bolding visible,
  zero overflow lines at 44 cols.

## R2 — Arrow-navigable /runs browser

Design:
- The /runs overlay becomes two-level, all state inside the overlay component:
  `view: 'list' | 'detail'` plus the preserved list cursor.
- List view (unchanged rows): ↑/↓ move, Enter or → opens the highlighted run's
  detail *inside the overlay*; Esc closes the overlay.
- Detail view: renders the loadRunSummary content (task, status, artifacts
  with sizes + sha256 prefixes, tokens) in the overlay; ← or Esc returns to
  the list with the cursor where it was; ↑/↓ jump directly to the previous/
  next run's detail (arrow-navigable end to end).
- The old behavior (Enter appends a `run_summary` transcript item and closes
  the overlay) is removed. If the `show_run_summary` reducer action and the
  `run_summary` transcript body become dead, delete them and update the
  affected tests; if any existing features.json descriptions (S7-*) describe
  the transcript-append behavior, revise their descriptions to the new
  behavior and re-run their verifications before keeping them at "pass".
- Footer hints per level: list `↑↓ select · enter view · esc close`,
  detail `↑↓ prev/next run · ← back · esc back`.
- Summary loading failures show the error inside the detail view (stay in the
  overlay) rather than dumping to the transcript.

Verify:
- R2-V1: runs-list component tests — Enter opens detail in-overlay, content
  shows artifacts/sha prefixes, error path renders in-overlay.
- R2-V2: navigation tests — ← and Esc return to list with selection preserved,
  ↑/↓ in detail switch runs, Esc from list closes; app-level test of the whole
  loop. Snapshots re-recorded and reviewed.
- R2-V3: full battery — `npm test`, `npm run typecheck`, `git diff --check`.
- R2-H1 (agent-judged, PTY): against the real `runs/` directory: open /runs,
  Enter into a run, ↑/↓ across runs in detail, ← back, Esc out; capture frames
  as evidence.

## R3 — Startup welcome card

Design:
- Replace the plain banner transcript item with a bordered welcome card
  (still a `<Static>` item, rendered once at startup):
  - Border: Ink `Box` `borderStyle="round"`, border color `theme.primary`,
    with the title `Sherlock — evidence collection agent` embedded in the top
    border chrome. Ink has no native border title, so render a custom top line
    (`╭─ Sherlock — evidence collection agent ─…─╮`) as a `Text` and use
    `borderTop={false}` on the Box for the remaining three sides. Title
    truncates on narrow terminals.
  - Line 1 (bold, centered): `Welcome back {name}!` — name = first word of
    `git config user.name` (→ "Brios"), falling back to `os.userInfo().username`
    capitalized; computed in `main.tsx`, never inside the reducer.
  - A small magnifying-glass glyph art (~4–6 lines, block/box-drawing chars,
    accent colors from the theme). Deterministic, no randomness.
  - Footer line (muted): `{model} · {cwd}` — model imported read-only from the
    core's `DEFAULT_MODEL` (`src/model/callModel.ts:21`, currently
    `claude-sonnet-5`; import is allowed, core stays untouched), cwd with the
    home prefix shortened to `~` and middle-truncated to fit the card.
- Identity values ({name, model, cwd}) flow main.tsx → App prop → banner body,
  so tests and --demo pass fixed values and snapshots stay deterministic.
- Card width: min(terminal columns − 2, 64). Must render with zero overflow at
  44 columns (nested-Text rule from the narrow-terminal fix applies).
- The missing-API-key warning must survive (inside or directly below the card).

Verify:
- R3-V1: shell/banner tests — card shows border title, welcome line with the
  injected name, glyph art, `model · path` line; API-key warning still
  asserted.
- R3-V2: width test at 44 columns — zero lines exceed the terminal width
  (display columns, not bytes); smoke snapshots re-recorded and reviewed.
- R3-V3: full battery — `npm test`, `npm run typecheck`, `git diff --check`.
- R3-H1 (agent-judged, PTY): real `npm run sherlock` startup capture at 80
  cols compared against the reference layout; also 44-col capture.

## Constraints carried over (unchanged)

- Zero changes to the agent core (src/loop, src/model, src/tools, src/run,
  src/browser, src/tracing). Read-only imports from core exports are fine.
- Never read or print .env values. The worktree .env is a gitignored symlink.
- Snapshot re-records must be reviewed line by line, never blind `-u`.
- Interaction-heavy new test files set `vi.setConfig({ testTimeout: 30_000 })`.
- Ink 7 defers a lone ESC byte — tests wait ~150 ms after writing ESC.
- Commit per revision; `git diff --check` clean before each commit.

## R4 — Transcript breathing room (2026-08-11, second note batch)

User notes (as given): streaming/agent text is "too close to the left edge" —
add padding; and add "a tiny bit more space between consecutive agent actions
so it doesn't feel as cluttered (only a tiny bit not too much space)".

Design:
- Agent prose — both the live streaming text (LiveRegion) and finalized
  `agent_text` items — gets `paddingLeft={2}`, aligning it with the label text
  after the `● `/`◆ ` markers. Markers stay at column 0.
- Activity and evidence items get `marginTop={1}` (one blank line — the
  smallest increment a terminal has). Pending tool lines in the LiveRegion get
  the same margin so spacing doesn't jump when a line finalizes into <Static>.
  Evidence `└ source:` sub-lines and verbose detail stay attached to their item.

Verify:
- R4-V1: updated transcript/smoke tests green; smoke snapshots re-recorded and
  reviewed line by line (only spacing/padding deltas); full battery — npm test,
  npm run typecheck, git diff --check.
- R4-H1 (agent-judged PTY): --demo capture at 80 cols shows padded prose and
  single blank lines between consecutive action rows; 44-col zero-overflow
  unchanged.

### R4 addendum (user follow-up): marker gutter

Note (as given): "the dots on the side still feel too close to the edge — move
them just a tiny bit." Design: one-column left padding on every marker row —
activity ●, evidence ◆ (sub-lines shift with their box), user task ▸,
completion ✓, cancelled/error ✗, and the LiveRegion pending rows to match.
Prose keeps its 2-column padding. Verify (R4-V2): smoke snapshot diff reviewed
line by line (only the 1-column shift), full battery green.
