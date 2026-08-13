# Project Summary: Browser Runtime/Auth

A PDD-lite pass (user-led) from rough idea to implementation plan, on branch
`design/browser-runtime-auth` in the `evidence-collection-agent-browser-runtime-auth`
worktree.

## Artifacts

- `rough-idea.md` — the initial concept: a browser runtime supporting
  authenticated identity reuse, login/SSO/MFA flows, human handoff, resume.
- `idea-honing.md` — Q1–Q10: candidates confirmed (Browserbase, EGO Lite,
  local Playwright); local-now/remote-later posture; credentials never
  through the model; plain login + handoff catch-all scope; chat-like
  handoff UX; test accounts; the final directive (permission seam, two
  handoff paths, model chooses); gitignored-JSON vault decision.
- `research/runtimes.md` — three candidates scored on the five auth
  capabilities + scalability + credential features + seam fit.
- `research/credentials.md` — five vault options + broker pattern; post-fill
  leak channels; market validation (1Password × Browserbase, Steel).
- `research/existing-code.md` — pipeline/loop/TUI integration points; the
  Claude Code AskUserQuestion pause/resume pattern.
- `design/detailed-design.md` — the standalone design document.
- `implementation/plan.md` — four steps with checklist.

## Design in one paragraph

Local headed Playwright with the persistent `chrome-profile/` stays the
runtime (Browserbase remains the seam's future second implementation). A
`CredentialStore` interface over a gitignored `.credentials.json` feeds a
`fill_credentials` tool that types secrets below the model — refs in,
metadata out, atomic password-fill-and-submit — so transcripts, traces, and
TUI events are secret-free by construction. A Claude Code–style permission
gate between validation and execute powers `ask_user_question`: TUI answers
resolve a promise mid-run (conversation and page intact); headless
environments fail closed. The model chooses between the structured tool and
free text (which ends the run; the persistent profile still carries login
state across runs). The system prompt barely pushes any of it.

## Implementation steps

1. Credential store + `fill_credentials` (incl. login fixture +
   secret-leak sweep test).
2. Permission gate + `ask_user_question`, fail-closed everywhere.
3. TUI interactive channel: dialog, plumbing, abort race, PTY check.
4. System prompt + end-to-end X test-account acceptance (the Elon Musk task).

## Next steps / open ends

- Create the test X account before Step 4.
- Watch for X challenging logins from automated Chrome even with correct
  credentials (research: unverified) — the handoff path is the designed
  fallback, but expect to exercise it.
- Later phases parked in the design: SSO/MFA recognition beyond handoff,
  agent-driven signup (vault-side password minting), Browserbase behind the
  seam, REPL wiring for `requestPermission`, 1Password-backed store.
- Planning docs are uncommitted on the design branch — commit when ready.
