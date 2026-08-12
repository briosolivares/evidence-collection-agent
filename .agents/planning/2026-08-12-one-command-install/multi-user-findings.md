# Multi-user portability findings

Research for: "what would need to be changed in the codebase to have multiple people using this on their own local machines" (2026-08-12, full-code sweep). Two tiers, because the answer differs sharply:

- **Tier A — a teammate clones the repo** (developer/collaborator): nearly works today; a handful of doc and identity fixes.
- **Tier B — a user installs the CLI** (`npm i -g`): the ten breaks below; fixed by [plan.md](plan.md).

Per-machine isolation is otherwise natural: each person gets their own Chrome profile (own logins), own API key, own runs. There is no shared-state problem to solve — only portability.

## Tier A — teammate with a repo checkout

| Finding | Anchor | Fix |
| --- | --- | --- |
| SEC oracle sends **Brios's name and email** as the User-Agent — every other user impersonates the author to the SEC (and the SEC 403s generic UAs, so it can't just be blanked) | `evals/datasets/edgar/oracle/edgarClient.ts:30` | Read from env (e.g. `SEC_CONTACT`), fail the edgar oracle with a clear message when unset |
| `GITHUB_TOKEN` is used by the GitHub oracle but undocumented in the README — a second user running GitHub evals hits the 60 req/hr unauthenticated limit | `evals/oracles/githubApi.ts:27,57`; `README.md:50-54` | Add to README + `.env.example` |
| No `.env.example`; `.env` format only described in prose | `README.md:48-55` | Add `.env.example` with all five vars (`ANTHROPIC_API_KEY`, `LANGFUSE_*` ×3, `GITHUB_TOKEN`) |
| `evals/experiments/*.json` embed absolute `/Users/briosolivares/...` runDir paths; `analyze:browser-batch` feeds them straight into `resolveRunPath`, so analysis of any existing experiment file only works on the origin machine | `evals/analysis/browserBatch.ts:185-186` | Store runDirs repo-relative (or resolve against the local runs base at read time); treat existing files as origin-machine-only |
| README Node contradiction: "Node 18+" vs Sherlock's "≥ 22" | `README.md:17,39` | Standardize on 22; add `engines` |
| `shasum -a 256` in a demo is macOS/BSD-flavored (absent on Windows, perl-provided on Linux) | `demos/03-manifest.ts:34` | Low priority; note or switch to `node:crypto` |
| A TUI test encodes the author's directory layout as a literal (injected, so it passes anywhere — but it documents the wrong thing) | `tests/tui/shell.test.tsx:19,55` | Cosmetic; change when touched |

With just the first three fixes, a teammate can clone, `npm install`, create `.env`, and run everything including evals.

## Tier B — installed-CLI users (the ten breaks)

Ranked; items 1–5 are fatal, 6–10 are degraded UX. All are addressed by plan.md phases 1–3.

1. **`tsx` is a devDependency but a hard runtime requirement** — `bin/sherlock.mjs:6` imports `tsx/esm/api`; global installs get production deps only, so the launcher cannot start (`ERR_MODULE_NOT_FOUND`). Works today only via `npm link` from a full checkout, which keeps the checkout's `node_modules`.
2. **All output is anchored to the install directory.** `REPO_ROOT` is derived from `import.meta.url` (`src/tui/main.tsx:42`) and `runs/`, `chrome-profile/`, and `runs/eval-results` all hang off it (`main.tsx:80-82,92`). Globally installed, that's `/usr/local/lib/node_modules/...` — frequently root-owned (EACCES) and never where a user would look for their evidence.
3. **`.env` is read only from the install directory, silently** (`src/tui/main.tsx:44-51`, empty catch). An installed user would have to write secrets into `node_modules`; a typo'd path is indistinguishable from success. No cwd or home lookup exists.
4. **The non-TUI entry points are cwd-relative** — `evals/config.ts:24,33`, `src/cli/repl.ts:22-23`, `src/cli/runTask.ts:30`, plus all demos. `resolve('chrome-profile')` against the wrong cwd silently creates a fresh empty profile: every login gone, with no error. Also fragile in-repo: run `npm run agent` from a subdirectory and you get the same silent split-brain.
5. **Chrome discovery has no escape hatch.** `channel: 'chrome'` is hardcoded (`src/browser/playwrightBrowserController.ts:44-47`); no `executablePath` anywhere. Chromium-only Linux boxes and non-standard installs cannot run it. And when Chrome is missing, the rejection escapes at `src/tui/main.tsx:96` *outside* the try/finally — raw unhandled-rejection stack trace instead of a preflight message.
6. **Node ≥ 22 is enforced only in the TUI and only after Ink/React are imported** (`src/tui/main.tsx:53-59`) — on Node 20 the crash happens inside Ink before the friendly message prints. No `engines` field, no `.nvmrc`, so npm can't warn either. (`process.loadEnvFile` and `tsx` register also set real floors for the non-TUI entry points, unenforced.)
7. **A missing API key never blocks startup** — banner only (`main.tsx:102`), REPL/evals just `console.warn` (`src/cli/repl.ts:26-31`, `evals/runners/cli.ts:32-37`). Chrome launches, the user types a task, and the first model call 401s.
8. **Model ID and context ceiling are hardcoded and coupled.** `DEFAULT_MODEL = 'claude-sonnet-5'` (`src/model/callModel.ts:33`, no override path) and `DEFAULT_MAX_CONTEXT_TOKENS = 900_000` (`src/cli/runTask.ts:36-49`) assumes that model's 1M window — substitute a smaller-context model and runs 400 instead of ending `budget_exceeded`. A user without `claude-sonnet-5` access must edit source. (`ANTHROPIC_BASE_URL` does work via the SDK, but is undocumented.)
9. **Concurrency: one persistent profile = one process.** `launchPersistentContext` locks the profile dir, so a second simultaneous Sherlock/REPL/eval on the same machine fights over it. Per-machine this is a "document it" issue, not a redesign.
10. **Lifecycle/platform residue:** no SIGTERM/SIGHUP handling anywhere — a `kill` strands Chrome and leaves the run dir without a finalized manifest (the `finally` in `runTask` never runs). On Windows: manifest `filename` fields would get backslashes (`src/run/artifacts.ts:123`) — format drift vs the documented `artifacts/answer.md` shape, not a crash; TUI glyphs/truecolor assume a modern terminal. No `process.platform` branching exists at all — the codebase is macOS-only in practice, not by explicit branch, which is actually good news for Linux.

## What does NOT need to change

Worth stating, because it bounds the work:

- **The security/provenance core is already portable.** `resolveRunPath` uses `sep` correctly, all artifact writes funnel through `writeArtifact`, and nothing writes outside the run dir except the intended bases (runs/profile/eval-results). Moving the *bases* (plan.md phase 2) requires zero changes to the confinement logic.
- **Langfuse is already optional and degrades cleanly** (`src/tracing/runTracing.ts:60-76` — missing keys → no-op, exporter failures swallowed).
- **The Anthropic SDK reads `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` from the environment itself** — no key-plumbing changes needed, only *loading* the env file from the right place and documenting the vars.
- **No shared-state redesign.** "Multiple people on their own machines" needs no server, no locking, no user accounts — every stateful thing (profile, runs, keys, traces) is naturally per-machine once the paths stop pointing at the install dir.
