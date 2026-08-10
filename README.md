# Evidence Collection Agent

A general browser agent for audit evidence collection: it takes a natural-language task, drives a browser to gather the evidence, and produces CSVs, screenshots, and/or written summaries suitable for audit documentation.

The core is a minimal Claude Code–style agent loop (context → model → tool calls → repeat) over a small registry of validated browser and file tools, driving local Chrome through Playwright behind an engine-agnostic adapter.
