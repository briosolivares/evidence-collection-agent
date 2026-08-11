# Local Claude Code Source Archive — Finding and Decision

Researched 2026-08-11.

## What was found

A full, readable Claude Code source snapshot exists at `/Users/briosolivares/Desktop/Code/claude-code` (~1,900 `.ts`/`.tsx` files under `src/`, including the complete Ink/React TUI and a vendored fork of Ink). Other locations checked (installed CLI binaries under `~/.local/share/claude/versions/`, global npm roots, `~/.claude`, Downloads/Documents) contain only compiled binaries or no source.

## Provenance

Per the archive's README (read directly, correcting an earlier inaccurate summary that attributed it to an "npm source-map exposure incident" — the README says no such thing): it is a "mirrored `src/` snapshot for research and analysis," with "public exposure identified on: 2026-03-31," self-described as an "educational research archive" that is "not affiliated with, endorsed by, or maintained by Anthropic."

## Decision: do not copy code from it

Regardless of how the snapshot became public, it is a mirror of Anthropic's proprietary Claude Code source. Claude Code is not open-source; the archive contains no license from the copyright holder, and the archive's own "educational research" framing is the mirror maintainer's characterization, not a grant of reuse rights. Copying or closely porting its code into this project would create IP risk, so it is **not used as an implementation reference**.

What we *can* legitimately draw on:

- **Publicly observable behavior** of Claude Code as a product (the user's vision statement already captures this: growing transcript, whimsical spinner verbs, esc-to-interrupt, completion line, queued composer). Reimplementing observed behavior from scratch is fine.
- **Upstream, MIT-licensed Ink** and its documented APIs — already verified sufficient for every interaction in the vision (see the Ink research note).
- Public Ink community resources (docs, issues, open-source Ink apps) for implementation techniques.

## Practical consequence for the design

The design will be an independent implementation on upstream `ink` + companion packages, guided by the vision statement and Ink's public documentation only. Any performance concerns (e.g., `<Static>` behavior with large transcripts) will be evaluated empirically against upstream Ink rather than assumed from any other codebase.
