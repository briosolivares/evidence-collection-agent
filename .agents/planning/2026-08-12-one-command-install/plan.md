# One-command install plan

**Status: PROPOSED — not yet implemented.** Written 2026-08-12 from a full portability audit of the codebase (see [multi-user-findings.md](multi-user-findings.md) for the raw findings with file:line anchors).

## Goal

A person who is not Brios runs **one command** on their own machine and gets a working `sherlock`:

```bash
npm install -g github:briosolivares/evidence-collection-agent
sherlock
```

No npm publish is required for this — the repo is public on GitHub and `private: true` only blocks `npm publish`, not git installs. Publishing to npm (for `npx sherlock`) is a later, optional step.

## Distribution shape (decision)

**Recommendation: keep the no-build shape — ship TypeScript source and load it through tsx at runtime.** This is already how `bin/sherlock.mjs` works (registers `tsx/esm/api`, imports `src/tui/main.tsx` module-relative). `src/` is ~624 KB; there is nothing to gain from a build step yet, and `noEmit` in tsconfig means adding one is a real project. Revisit (tsup/esbuild → `dist/`) only if install size or startup time becomes a complaint.

Alternatives considered:
- **npm publish** — same package fixes required first; adds name-squatting/versioning overhead now for no user benefit. Do later.
- **curl | bash installer** (clone + `npm install` + `npm link`) — works almost today but installs a full dev checkout, hides failures in a script, and normalizes piping shell from the internet. Not recommended.
- **Homebrew tap** — wraps the npm install anyway. Not now.

## Phase 1 — make the package globally installable at all

These are the changes without which `npm install -g github:…` produces a binary that cannot start.

1. **Move `tsx` from `devDependencies` to `dependencies`** (`package.json`). `bin/sherlock.mjs:6` imports `tsx/esm/api` at runtime; a global install only gets production deps, so today the launcher dies with `ERR_MODULE_NOT_FOUND`. This is the single biggest break.
2. **Add `"engines": { "node": ">=22" }`** to package.json, and move the Node-version check from `src/tui/main.tsx:53-59` into `bin/sherlock.mjs` *before* `register()` and the dynamic import. Today the check runs after Ink 7/React 19 are already imported, so Node 20 users crash inside Ink before ever seeing the friendly message. Fix the README contradiction (line 39 says "Node 18+", line 17 says "≥ 22" — 22 is correct).
3. **Add a `files` field**: `["bin", "src", "!src/**/*.test.ts", "!src/**/*.test.tsx"]`. Without it, a git install packs everything git tracks — evals, demos, tests, docs, `.agents/` planning history. End users need only `bin/` + `src/`.
4. **Keep `"private": true`** until/unless publishing to npm; it does not affect git installs.

**Acceptance check:** `npm pack`, install the tarball globally in a scratch prefix, `cd ~ && sherlock` on a machine-simulacrum (fresh shell, no repo checkout) — TUI starts.

## Phase 2 — stop writing into the install directory

Everything Sherlock writes today is anchored to `REPO_ROOT` (resolved from `import.meta.url` at `src/tui/main.tsx:42`): `runs/`, `chrome-profile/`, `runs/eval-results` (`main.tsx:80-82,92`). Under a global install that becomes `/usr/local/lib/node_modules/...` — often root-owned (EACCES) and invisible to the user. The REPL and eval CLI are worse: bare cwd-relative strings (`src/cli/repl.ts:22-23`, `src/cli/runTask.ts:30`, `evals/config.ts:24,33`), so running from any other directory silently creates a fresh empty Chrome profile (all logins lost).

5. **Create one path-resolution module** (e.g. `src/config/paths.ts`) as the single authority:
   - `dataHome` = `$SHERLOCK_HOME` ?? `~/.sherlock/`
   - `profileDir` = `<dataHome>/chrome-profile`
   - `runsBaseDir` = `$SHERLOCK_RUNS_DIR` ?? `<dataHome>/runs`
   - `evalResultsDir` = `<dataHome>/runs/eval-results`
   All directories created lazily. This respects the existing binding rule that every path already flows through `resolveRunPath` — only the *base* moves.
6. **Dev entry points override explicitly.** `repl.ts`, `evals/config.ts`, and demos should pass repo-anchored bases (the way `main.tsx` already does), so a checkout keeps writing to `./runs` and `./chrome-profile` and nothing changes for current workflows. The home-anchored defaults are what an installed `sherlock` gets when nothing overrides them.
   - *Decision point recorded:* runs default to `~/.sherlock/runs`, not `./runs`, for installed users — an evidence tool scattering `runs/` dirs into whatever cwd the user launched from is worse than one predictable location; the TUI already prints the absolute run path and `/runs` browses it. Flag `--runs-dir` (add to `sherlock` arg parsing, `src/tui/main.tsx:77-79`) covers "put it here" cases.
7. **Fix `.env` loading** (`src/tui/main.tsx:44-51` currently loads only `<install-dir>/.env`, silently): load in order — explicit `--env-file` flag → `./.env` (cwd) → `~/.sherlock/.env` — and log which file (if any) was loaded at startup in verbose mode. Keep the ambient environment as the final fallback. Add `.env.example` to the repo.
8. **Migration note for existing checkouts:** none needed — dev overrides in (6) preserve current behavior; Brios's existing `runs/` and `chrome-profile/` stay where they are.

**Acceptance check:** installed `sherlock` run from three different cwds uses one profile (logins persist), writes runs under `~/.sherlock/runs`, and picks up the API key from `~/.sherlock/.env`.

## Phase 3 — first-run experience and preflight

9. **Preflight before launching Chrome or the loop**, with friendly errors instead of stack traces:
   - Chrome present? Playwright's `channel: 'chrome'` throw currently escapes at `src/tui/main.tsx:96`, which sits *outside* the try/finally — the user gets a raw unhandled rejection. Wrap it; on failure print "Google Chrome not found — install it or run `npx playwright install chrome`".
   - API key present? Today a missing key only shows a banner and Chrome still launches, then the first model call 401s mid-run (`main.tsx:102`). On first run with no key, prompt for it in the TUI and offer to save to `~/.sherlock/.env`.
   - TTY check stays as-is (`main.tsx:61-67`).
10. **Add a Chrome escape hatch:** `SHERLOCK_CHROME_PATH` → Playwright `executablePath` (there is currently no override anywhere; `src/browser/playwrightBrowserController.ts:44-47` hardcodes `channel: 'chrome'`). This is the difference between "works" and "doesn't" on Linux boxes with only Chromium.

**Acceptance check:** on a machine with no Chrome and no key, `sherlock` exits with two clear instructions and no stack trace.

## Phase 4 — docs and the command itself

11. **README quickstart** becomes:
    ```bash
    npm install -g github:briosolivares/evidence-collection-agent
    sherlock
    ```
    with requirements (Node ≥ 22, Google Chrome, Anthropic API key) and the `~/.sherlock/` layout documented. Keep the existing dev-checkout instructions in a separate "Developing" section.
12. **Optional, later:** publish to npm under an available name → `npx <name>` becomes the one command; consider `npm deprecate`-safe naming now (check availability before choosing `sherlock` — that name is almost certainly taken on npm; the bin can stay `sherlock` regardless).

## Out of scope (deliberately)

- Evals, demos, oracles, graders — dev-only; excluded from the package by the `files` field. Multi-dev eval portability issues are catalogued in [multi-user-findings.md](multi-user-findings.md) §Tier A.
- Windows support — nothing hard-blocks it, but it's untested; see findings §7. Ship for macOS/Linux, note Windows as untested.
- Headless/CI operation — headed Chrome is a deliberate design posture (per AGENTS.md), not an install problem.
- Build step / npm publish / Homebrew — revisit after the git-install path is proven.

## Effort estimate

Phases 1–2 are the substance: ~6 focused edits plus a new paths module and its tests. Phase 3 is UX polish on two failure paths. Phase 4 is docs. No architectural change — the binding rules (writeArtifact chokepoint, resolveRunPath confinement, byte-stable prompt prefix) are untouched; only path *bases* and packaging metadata move.
