# Evidence Collection Agent

A general browser agent for audit evidence collection: it takes a natural-language task, drives a browser to gather the evidence, and produces CSVs, screenshots, and/or written summaries suitable for audit documentation.

The core is a minimal Claude Code–style agent loop (context → model → tool calls → repeat) over a small registry of validated browser and file tools. An engine-agnostic `BrowserController` drives each session, while a `BrowserSessionProvider` decides whether that session comes from local Chrome or a hosted service.

## Install

```bash
npm install -g github:briosolivares/evidence-collection-agent
sherlock
```

Requires Node ≥ 22 and Google Chrome. On first launch Sherlock prompts for an Anthropic API key and offers to save it. An installed Sherlock keeps all of its state under `~/.sherlock/`:

```
~/.sherlock/
  chrome-profile/   # persistent Chrome profile — logins survive across runs
  runs/             # one directory per investigation (evidence + provenance)
  .env              # ANTHROPIC_API_KEY and friends (written by the first-run prompt)
```

Overrides: `--runs-dir <path>` (or `SHERLOCK_RUNS_DIR`) moves just the runs directory, `SHERLOCK_HOME` moves the whole data home, `--env-file <path>` loads a specific env file (the default order is `./.env`, then `~/.sherlock/.env`), and `SHERLOCK_CHROME_PATH` points at a non-standard Chrome/Chromium binary. In a git checkout none of this applies — state stays repo-anchored (`runs/`, `chrome-profile/`, `.env` at the repo root; see Setup).

## Sherlock (TUI)

`sherlock` is the interactive terminal UI: type a task, watch the investigation stream in (semantic activity lines, evidence highlights, a live status line), and get a persistent completion line plus the run directory.

```
npm run sherlock              # launch (or `sherlock` after npm link)
npm run sherlock -- --demo    # scripted demo investigation, no API cost
npm run sherlock -- --verbose # show raw tool input/result detail
```

Inside the TUI: `/help` lists commands, `/runs` browses past run directories, `/artifacts` browses the last run's artifacts, `/evals` runs eval tasks (multi-select + trial and concurrency settings), `/exit` quits. Esc cancels the in-flight run or every active eval trial without leaving the session; Ctrl+C quits. Requires Node ≥ 22, a TTY, local Chrome, and an Anthropic API key (prompted for on first run, or loaded from `.env`).

During a run, published artifacts appear as selectable rows the moment they land: ↑↓ select · Enter details (source URL, capture time, sha256, size) · Space preview · o open · r reveal — and with a detail card open, Esc closes it before it ever means cancel. On completion a summary panel (the concise answer plus the artifacts, requested outputs first) appears above the composer without taking focus, so the next task types immediately; Tab focuses the rows (Tab or Esc hands focus back), and `/artifacts` brings the panel back later. Space is macOS Quick Look — the same preview as Finder's spacebar, chrome-free via the bundled `sherlock-ql` helper (a universal binary committed at `bin/sherlock-ql`; `npm run build:quicklook` rebuilds it if you edit the Swift, and `qlmanage`'s debug-titled panel fills in if it's ever missing); on Linux it falls back to `xdg-open`, and reveal is macOS-only.

## How it works

Give it a task ("Create a CSV of the top 5 stories on Hacker News, with columns for title, URL, and points") and it:

1. Opens a fresh tab in a real, visible Chrome window (persistent profile, so logins survive between runs).
2. Loops: the model observes pages through a compact accessibility-tree outline, acts by element ref (`click`, `type`, `scroll`, `navigate`), and writes evidence (`write_file`, `screenshot`, `download`) — until it responds with no tool calls.
3. Leaves behind a self-contained run directory:

```
runs/2026-08-10_08-00-53pm_top-5-hacker-news_9f3a2b/   # date_time_task-slug_suffix (local time)
  artifacts/          # published outputs — the CSVs, screenshots, downloads, answer.md the task asked for
  scratch/            # the agent's private working files (never graded, still hashed)
  manifest.json       # provenance: SHA-256 hash, source URL, roles, capture time per artifact
  transcript.jsonl    # append-only record of every model call and tool call
  metrics.json        # tokens, turns, wall-clock time
```

The manifest makes evidence tamper-evident — re-hash any artifact to prove it hasn't changed since collection.

## Requirements

- Node 22+ and Google Chrome installed locally (the agent drives system Chrome, not bundled Chromium).
- An Anthropic API key. Optionally Langfuse keys for tracing.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` at the repo root and fill in your keys (gitignored; `sherlock` and `npm run evals` load it automatically, every other entry point takes it explicitly with `--env-file`):

```
ANTHROPIC_API_KEY=...
LANGFUSE_PUBLIC_KEY=...    # optional — tracing is a no-op without these
LANGFUSE_SECRET_KEY=...
LANGFUSE_BASE_URL=...      # optional
GITHUB_TOKEN=...           # optional — authenticated GitHub eval oracles
```

## Usage

**Interactive agent** (a REPL: type a task, watch it stream, get the run directory path):

```bash
npx tsx --env-file=.env src/cli/repl.ts
```

**Evals** — each task runs k independent trials, then a grader checks the run directory against live ground truth (the grader never sees the agent's conversation):

```bash
npm run evals -- --tasks hacker_news,edgar,openclaw_pr --k 3 --concurrency 3
```

Set `GITHUB_TOKEN` before running any GitHub-graded task. Without it the oracles fall back to GitHub's unauthenticated 60 requests/hour, which a k=3 batch exhausts partway through — and because grading happens *after* a run completes, the batch reports correct runs as failures. The first unauthenticated request warns; `evals/runners/regrade.ts` re-grades finished run directories once the token is in place.

Normal eval trials run in parallel in separate headless Chrome processes, each with a temporary profile that is removed afterward. `--concurrency` limits this pool and defaults to 3. A task with `"headed": true` in `task.json` instead runs serially in a visible Chrome window backed by the persistent `chrome-profile/` — for tasks that need a real login or that bot-block headless browsers; currently `mit_sororities`, `edgar`, and `elon_tweets` use that policy. The headed lane may overlap the normal pool.

Results print to stdout and persist to `evals/experiments/`. Task packages are the directories under `evals/datasets/`.

**Tests and typecheck** (no API keys or network needed; Chrome required):

```bash
npm test
npm run typecheck
```

**Demos** — fourteen numbered scripts under `demos/` walk each subsystem in build order (`npx tsx demos/07-loop-fake-model.ts` runs the full loop with a scripted model and zero tokens; 09 and 14 call the real API). They are manual walkthroughs, not tests — see [demos/README.md](demos/README.md).

## Project layout

| Path | Contents |
| --- | --- |
| `src/` | The agent: loop, model client, tools (one directory per tool under `src/tools/`), browser controller/session providers, run/provenance layer, CLI |
| `evals/` | Eval harness: `runners/` (run-triggering scripts), `metrics/` (metric definitions), `datasets/` (per-task `task.json` + oracle + grader), `experiments/` (past-run results JSON), `config.ts` |
| `demos/` | Build-order walkthrough scripts (manual, not tests — see its README) |
| `tests/` | Fixture pages + loopback server (`fixtures/`) and shared test helpers (`helpers/`) |
| `docs/` | Baseline reports and browser-layer research |
| `.agents/summary/` | Generated codebase knowledge base (start at `index.md`) |
| `.agents/planning/` | Design doc, implementation plan, baseline failure log |

## Design highlights

- **Provenance first**: every file-producing tool routes through one `writeArtifact` chokepoint that hashes bytes into the manifest at capture time.
- **Bounded context**: tool results over 50 KB are offloaded to disk; the model gets a preview plus the path and reads selectively.
- **Prompt caching by construction**: a byte-stable system-prompt + tool-definition prefix, verified by tests and by `cache_read_input_tokens` in traces.
- **No shell access**: the agent has no `bash` tool, so a prompt-injecting web page cannot execute code on the host.
- **General mechanisms only**: eval failures are never fixed with task-specific logic — the eval suite is treated as a test set for general capability.

Full documentation: [.agents/summary/index.md](.agents/summary/index.md). Design rationale: `.agents/planning/evidence-collection-agent-checkpoint-1/design/detailed-design.md`.
