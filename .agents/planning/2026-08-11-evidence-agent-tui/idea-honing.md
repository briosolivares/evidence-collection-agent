# Idea Honing — Evidence Agent TUI

Q&A log for requirements clarification.

## Q1: What is the primary job of the TUI?

The project currently has a minimal REPL (type a task, watch text stream, get a run directory path). What should the TUI primarily be for?

Some possibilities: a richer live view of an agent run (streaming transcript, tool calls, current page/URL, token usage); browsing/inspecting past run directories; a dashboard for running evals; or some combination.

**Answer:** All of the above — a full cockpit: run tasks live, browse past runs, and kick off/watch evals from one interface.

## Q2: What matters most / what's the priority order?

Since it's a full cockpit but you want it streamlined, which capability should be built first and get the most polish?

**Answer:** Live run view first — the interactive task-running experience is the core loop; past-run browsing and evals layer on after.

## Q3: What should the live run view show, at what altitude?

During a live run, what level of detail do you want on screen?

**Answer:** The user provided a full vision statement (saved verbatim in `vision.md`). Summary: Claude Code-style single vertically growing transcript (no panes/dashboard); persistent composer at the bottom; animated status line with whimsical investigator-themed working words ("✻ Foraging…") plus subtle live metadata (`↳ 12.4k tokens · 18s`, compact token formatting); working phrases are ephemeral, not preserved in the transcript; browser/tool activity rendered semantically inline (`● Opening techcrunch.com/…`), raw JSON behind a verbose/debug mode; evidence findings get stronger visual treatment (`◆ Evidence found`); persistent completion line with configurable branded verb, default "Brewed" (`✓ Brewed in 42s · 18.7k tokens`), representing the whole investigation; restrained motion, no fake progress; glanceable at all times (working? doing what? how long? how much model work? what sources? what evidence? when finished?).

This supersedes the earlier "transcript + pinned status bar" default: live metrics attach to the animated status line above the composer rather than a persistent bottom status bar.

## Q4: What happens when you type in the composer while a run is active?

The vision has a persistent composer at the bottom. During an active run, what should typing/submitting do — steer the agent (inject as a user turn), queue for after the run, or be disabled until the run finishes? And should Esc cancel the current run without exiting the TUI?

**Answer:** Input only between runs for now (composer inert during a run). Esc cancels an in-flight run cleanly — transcript preserved with a "cancelled" line, user returned to the composer — without exiting the TUI.

## Q5: How do past runs and evals surface in the single-transcript UI?

Q1 said "full cockpit" (live runs + past runs + evals), and the vision specifies a single transcript with no panes. How should the other two capabilities be reached?

**Answer:** `/evals` slash command works, but it must support either specifying tasks + trial count (k) as arguments or selecting them from a menu. Past runs are best visualized through a scrollable run list (an interactive picker, not just printed text).

## Q6: How should semantic activity lines be produced from low-level tool calls?

The vision calls for semantic lines ("● Reading SEC filing", "◆ Evidence found") but the agent's tools are low-level (navigate, click, type, observe, write_file, screenshot, download). Options: (a) TUI derives lines purely from tool calls + args (navigate→"Opening <domain>", write_file→"◆ Evidence saved: <name>") with no agent changes; (b) also let the model narrate — its streamed text between tool calls serves as the intermediate reasoning summaries; (c) modify the agent to emit explicit semantic events (e.g., a `note_evidence` tool).

**Answer:** Zero agent changes — the TUI is purely a layer on top. Use (a)+(b): derive activity lines from tool calls/args, and render the model's streamed text between tool calls as the intermediate reasoning summaries. No new tools, no prompt changes.

## Q7: Any preference on TUI technology?

The obvious candidate is Ink (React for terminals — what Claude Code itself uses; fits the existing TypeScript/Node stack, handles the persistent composer + in-place status line updates well). Alternatives: hand-rolled ANSI rendering on the existing readline REPL (no new deps, more fiddly for in-place updates), or other frameworks (blessed — unmaintained, OpenTUI — young).

**Answer:** Ink is fine — default to it.

## Q8: For `/evals`, how are tasks and trial count chosen — args, menu, or both?

Options: args only (`/evals edgar,hacker_news --k 3`); menu only (`/evals` opens a task multi-select + k prompt); or both (args when given, menu when omitted).

**Answer:** Menu only — `/evals` opens a task multi-select plus a prompt for k. No args.

## Q10: How is the TUI launched?

**Answer:** Running `sherlock` starts the agent TUI — a named bin command (via package.json `bin` entry, so `npm link` / global install provides the `sherlock` command; `npx sherlock`-style local invocation also works). Fits the investigator branding.

## Q11: How is the TUI exited?

**Answer:** A `/exit` slash command typed into the composer exits the TUI. (Standard terminal conventions like Ctrl+C can remain as a fallback, but `/exit` is the designed path.)

## Q12: Additional slash commands?

**Answer:** A `/help` command that lists the available slash commands and key bindings (rendered as a transcript block). Slash-command surface so far: `/help`, `/evals`, `/exit`, plus the past-runs scrollable list (proposed `/runs`).

## Q9: Color theme?

**Answer:** Borrow Andera's color theme, which is purple-based: https://www.andera.ai/. Palette extracted from the site's CSS tokens (see `research/andera-palette.md`): brand anchor `#A9A1E6` (purple300, the site's `--theme`), purple scale `#CBC3F8`/`#AEA4FF`/`#786ECB`/`#4C41A9`, dark ink `#302951`/`#1D1A3B`, indigo-tinted muted grays (`#7D7993`), semantic green `#00892B` / red `#DC2626`.
