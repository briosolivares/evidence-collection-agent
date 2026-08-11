# Sherlock TUI — PDD Summary

Streamlined Prompt-Driven Development run, completed 2026-08-11, in worktree branch `worktree-evidence-agent-tui`.

## Artifacts

```
.agents/planning/2026-08-11-evidence-agent-tui/
├── rough-idea.md                    # initial concept
├── vision.md                        # user's verbatim experience vision (Claude Code-style)
├── idea-honing.md                   # 12 Q&As of requirements clarification
├── research/
│   ├── existing-code.md             # agent-core audit: attach seams, cancellation, evals library
│   ├── ink.md                       # Ink 7 verification: every vision interaction maps to an API
│   ├── andera-palette.md            # purple theme tokens extracted from andera.ai CSS
│   └── claude-code-source.md        # local CC source mirror: found; not used (proprietary)
├── design/detailed-design.md        # standalone design (architecture, components, data models)
├── implementation/plan.md           # 9 incremental, demoable steps with checklist
└── summary.md                       # this document
```

## Design in one paragraph

`sherlock` launches an Ink 7 TUI: a single growing transcript (Ink `<Static>`), a persistent composer, and an animated status line with whimsical investigator verbs plus subtle `tokens · elapsed` instrumentation, in the Andera purple palette. It attaches to the agent with **zero core changes** through two injection seams on `runTask`: a custom `callModel` (built from exported core primitives + SDK `AbortSignal`) provides streaming *and* Esc cancellation, and a tracing wrapper provides tool inputs/results, run-dir capture, and semantic activity lines (`●` actions, `◆` evidence) while preserving Langfuse. `/runs` browses past run directories with provenance summaries; `/evals` (menu-only: task multi-select + k) drives its own trial loop over the eval library exports for live per-trial progress; `/help` and `/exit` complete the command surface. Completion is marked with a persistent, configurable `✓ Brewed in 42s · 18.7k tokens` line.

## Implementation shape

9 steps, each demoable: shell scaffold → store/transcript → live region on a scripted `--demo` run → real runs via the bridge → Esc cancellation → semantic/evidence lines → `/runs` → `/evals` → hardening/polish. The scripted demo mode (Step 3) lets all rendering/feel iteration happen without API cost.

## Risks / areas to watch

- The injected-`callModel` seam bypasses `onProgress` — the bridge must re-emit progress events (covered by dedicated bridge tests).
- Esc granularity: model calls abort instantly; an executing tool batch settles first (seconds). Acceptable per requirements; revisit only if it feels bad in practice.
- Ink 7 raises the TUI's Node floor to 22 (repo README says 18+; local machine runs 22.17).
- Feel (motion cadence, colors, flicker) is judged by eye at each step's demo, not by tests.

## Next steps

1. Review `design/detailed-design.md` and `implementation/plan.md`.
2. Begin Step 1 of the plan; check off items in the plan's checklist as steps complete.
3. Merge `worktree-evidence-agent-tui` → `main` when the increment feels right.
