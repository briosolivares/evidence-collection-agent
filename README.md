# Evidence Collection Agent

A general browser agent for audit evidence collection: it takes a natural-language task, drives a browser to gather the evidence, and produces CSVs, screenshots, and/or written summaries suitable for audit documentation.

The core is a minimal Claude Code–style agent loop (context → model → tool calls → repeat) over a small registry of validated browser and file tools, driving local Chrome through Playwright behind an engine-agnostic adapter.

## Sherlock (TUI)

`sherlock` is the interactive terminal UI: type a task, watch the investigation stream in (semantic activity lines, evidence highlights, a live status line), and get a persistent completion line plus the run directory.

```
npm run sherlock              # launch (or `sherlock` after npm link)
npm run sherlock -- --demo    # scripted demo investigation, no API cost
npm run sherlock -- --verbose # show raw tool input/result detail
```

Inside the TUI: `/help` lists commands, `/runs` browses past run directories, `/evals` runs eval tasks (multi-select + trial count), `/exit` quits. Esc cancels the in-flight run (or eval trial) without leaving the session; Ctrl+C quits. Requires Node ≥ 22, a TTY, local Chrome, and `ANTHROPIC_API_KEY` (loaded from `.env`).
