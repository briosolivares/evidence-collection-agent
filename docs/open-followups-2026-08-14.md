# Follow-ups found on 2026-08-14 — all three resolved

Three defects were found while validating commit `3091a81` (`run: close resume
and document-output gaps`). **All three are now fixed on `feat/judge-harness`.**
Each section below keeps the original diagnosis — the reasoning is the part
worth preserving — and records what was actually done.

Verified together at **1799/1799 tests** (up from 1788: +11 new) and a clean
typecheck, with `FORCE_COLOR=1` in the ambient environment, which is precisely
the configuration that produced 51 failures before item 3 was fixed.

The follow-ups that `3091a81` itself closed are recorded in
`docs/browser-agent-local-code-execution-implementation-plan.md` §7.

---

## 1. `npm run evals` never loaded `.env`, so oracles ran unauthenticated

**Severity: high.** Cost whole eval batches, and did it in a way that looked
like an agent regression.

`package.json` defined:

```json
"evals": "tsx evals/runners/cli.ts"
```

No `--env-file=.env`. The repo has no `dotenv` dependency
(`src/tui/main.tsx:99`), and the two entry points diverged on what they did
about that: Sherlock's TUI implements its own loader and reads the first `.env`
it finds (`src/tui/main.tsx:99-113`, via `loadFirstEnvFile`), so a bare
`sherlock` works without flags. `evals/runners/cli.ts` has no such loader and
relied purely on Node's `--env-file`, which its npm script omitted. So the eval
CLI was the outlier: the one entry point that read no `.env` at all. `.env` is
gitignored and does hold a `GITHUB_TOKEN`; it was simply never read there.

`evals/oracles/githubApi.ts` stated the invariant this violated, in its own
words:

> Unauthenticated GitHub API calls are limited to 60/hour per IP — too few for a
> k=3 eval whose oracles make dozens of calls per trial — while a token raises
> the limit to 5,000/hour. The token is read from the environment at call time
> **(the eval CLI runs under `--env-file=.env`)**.

It did not. So every oracle fetch went out unauthenticated at 60/hr, and any
k=3 GitHub task exhausted it mid-batch.

**Observed 2026-08-14:** `openclaw_merged_prs` at k=3 reported 33.3% accuracy,
1/3 completion, task FAIL. All three agent runs were actually correct. Two
trials simply could not be graded:

```
GitHub API GET /repos/openclaw/openclaw/pulls?... failed with HTTP 403
  (rate limit exhausted — set GITHUB_TOKEN in .env to raise it to 5,000/hr)
```

Regrading the same three run directories with the token loaded gave
**100%, 24/24 assertions, 3/3**. The error message told you to set the variable
in a file that the failing process did not read.

### How to tell a grader failure from an agent failure

Read the ordering in the log. A trial that prints `run finished` and *then*
`errored` completed its work and failed in the **grader**. Both of the trials
above did exactly that. Treating them as agent failures would have sent someone
hunting a regression that does not exist. This distinction is now also recorded
in `AGENTS.md`, since it is the part that costs time.

### Recovery for an already-run batch

```
npx tsx --env-file=.env evals/runners/regrade.ts "<task>:<dir1>,<dir2>,<dir3>"
```

Do it promptly — `regrade.ts` fetches oracles at regrade time, so a moving
ground truth drifts away from what the agent saw.

### What was done

Options 1 and 3 of the three originally sketched, together:

1. **`package.json`** — `"evals": "tsx --env-file-if-exists=.env evals/runners/cli.ts"`.
   Note `--env-file-if-exists`, not `--env-file`: the latter makes Node exit
   when the file is absent, which would break anyone running on ambient
   environment variables. Verified that `tsx` forwards the flag to Node and
   tolerates a missing file.
2. **`evals/oracles/githubApi.ts`** — `githubHeaders` now takes a warn sink and
   emits a once-per-process warning on the first *unauthenticated* call, naming
   both the HTTP 403 symptom and how to load the token. First-use rather than
   startup, so a batch of non-GitHub tasks stays quiet.
3. **`evals/runners/cliEnv.test.ts`** (new) — pins the npm script: it must load
   `.env`, must use the `-if-exists` form, and must still point at the runner.
   Nothing failed when this was wrong, which is exactly why it survived.
4. `githubApi.test.ts` grew warn-once, silent-when-authenticated, and
   warns-after-authenticated-calls cases; `AGENTS.md` and `README.md` now
   describe the real behavior.

**The decision this needed, and how it was made.** Loading `.env` into the eval
process puts `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, and the `LANGFUSE_*` keys into
the environment the agent's own `bash` tool inherits. `BASH_SECRET_ENV_DENYLIST`
in `src/cli/runTask.ts` already strips all of those, and its comment is explicit
that it is reproducibility and blast-radius hygiene, **not a security
boundary** — commands run as the same OS user and can read `.env` off disk
regardless.

What settled it: the repo's own documented invocation was already
`npx tsx --env-file=.env evals/runners/cli.ts` (`README.md`, `AGENTS.md`,
`.agents/summary/*`). The sanctioned way to run evals *already* loaded the whole
`.env` into the eval process, and the denylist was written for exactly that
arrangement. So option 1 widens nothing relative to accepted practice — it only
makes the npm alias match the command the docs already tell people to run.

Option 2 (have `cli.ts` parse `.env` itself and inject **only** `GITHUB_TOKEN`
into the oracle path) remains available and is strictly narrower. It was not
taken because it buys nothing against the documented workflow and costs a
hand-rolled parser; the case for revisiting it is a `.env` holding secrets
beyond the enumerated set, since the denylist protects only names it knows.

---

## 2. Eval Chrome profiles leaked when a batch was killed

**Severity: medium.** Unbounded disk growth; contributed to a hard stop on
2026-08-14.

`evals/runners/browserRuntime.ts` creates a temp profile per headless trial
(`mkdtemp` with prefix `evidence-agent-eval-chrome-`) and removes it after the
browser closes. That path is correct on a normal exit — it runs unconditionally,
outside the success branch, and warns rather than throwing on failure.

The gap was that **nothing reaped orphans**. If the process died before reaching
cleanup — a crash, a Ctrl-C, an `ENOSPC` — the profile stayed in `$TMPDIR`
forever, and no later run noticed.

**Observed 2026-08-14:** seven orphaned profiles from 2026-08-12 and 2026-08-13
totalling ~260 MB, one of them alone at 158 MB. On a full disk this was the
difference between a batch running and failing.

### What was done

`createEvalBrowserRuntime` now sweeps on construction (`reapStaleProfiles`):

- Lists `evidence-agent-eval-chrome-*` **directories** in the temp root and
  removes any whose mtime is 4+ hours old. mtime is what protects a
  concurrently running batch — a live Chrome writes to its profile
  continuously — so age alone is never the criterion.
- Forgiving at every step, because reclaiming disk must never be why a batch
  dies: an unreadable temp root warns and returns, a profile that vanishes
  between listing and `stat` is skipped, and a failed removal warns and the
  sweep continues.
- Started at construction so it overlaps the first trial's browser launch
  rather than delaying it, and awaited by `close()` so a batch never outruns
  its own housekeeping.
- New options: `tempProfileRoot` (defaults to the system temp dir) and a
  `listTempProfiles` test seam. **Existing tests pass `listTempProfiles: noReaping`** —
  without it, constructing a runtime in a test scans the developer's real
  `$TMPDIR`, which breaks hermeticity and leaks their leftover profiles into
  warning assertions. New tests use a real fixture directory with real
  `utimes` mtimes, so `readdir`/`stat`/`rm` are genuinely exercised; a mocked
  filesystem would have agreed with the buggy version too.

Five new cases cover the threshold on both sides, prefix/non-directory
filtering, the unreadable root, per-failure warnings mid-sweep, and completion
by the time `close()` resolves. Mutation-checked: neutralizing the age
comparison fails two of them.

Manual inspection, if ever needed again:

```
ls -dlt $TMPDIR/evidence-agent-eval-chrome-*     # check mtimes first
```

Cross-check against `ps -eo args | grep -o 'evidence-agent-eval-chrome-[A-Za-z0-9]*'`
before deleting by hand.

---

## 3. `npm test` was color-dependent — 51 TUI failures in a colored terminal

**Severity: low, but actively misleading.** Cost time on every fresh
environment.

Every test under `tests/tui/` asserts against plain strings, while Ink emits
ANSI escapes whenever the shell reports color support. In a colored terminal:

```
Test Files  12 failed | 136 passed (148)
     Tests  51 failed | 1737 passed (1788)
```

With color off, the same tree was fully green. This reproduced identically on
clean `HEAD`, so it predated `3091a81` — verified by stashing all changes and
re-running. Failures looked like this, which reads as a rendering regression
rather than an environment difference:

```
- ✓ Brewed in 42s · 18.7k tokens
+ [38;2;0;137;43m✓ [39mBrewed in 42s · 18.7k tokens
```

### What was done

`vitest.config.ts` now sets `env: { FORCE_COLOR: '0' }` for the suite, which is
what the assertions already assumed. Applied suite-wide rather than to a TUI
project because the config defines a single project, and nothing anywhere in the
repo asserts on colored output — `FORCE_COLOR` appeared in no source file before
this change.

Verified by reproducing first (`FORCE_COLOR=1 npx vitest run tests/tui` → 51
failures), then confirming 320/320 in `tests/tui` and 1799/1799 suite-wide with
`FORCE_COLOR=1` still set in the ambient shell. `npm test` no longer depends on
whether it is attached to a TTY.

---

## Known adjacent gap, deliberately not fixed here

`npm run agent` (`tsx src/cli/repl.ts`) has the same missing-`--env-file` shape
as the `evals` script did, and `evals/runners/regrade.ts` has no npm script at
all, so both still need `npx tsx --env-file=.env …` by hand. Neither was touched
because neither fails silently: they surface immediately as a failed first model
call rather than as a plausible-looking eval result. Left out to keep this
change scoped to the three defects above.

---

## Validation state at the time these were found

For context on what was and was not established, so a fresh session does not
re-run it: commit `3091a81` was validated at **1788/1788 tests** (with
`FORCE_COLOR=0`, per item 3) and a clean typecheck, plus live evals on the prose
protocol at k=3 against the 2026-08-13 baselines:

| task | difficulty | 2026-08-14 | baseline |
| --- | --- | --- | --- |
| `hacker_news` | Easy | 100%, 18/18 assertions | 100%, 18/18 |
| `openclaw_merged_prs` | Medium | 100%, 24/24 assertions | 100%, 24/24 |

Latency was unchanged: the medium task ran 676 s mean against a 699 s baseline,
and the easy task's 87 s mean sits within a second of the 2026-08-13 03:46am
baseline's 88 s (a second, faster 48 s baseline exists — comparing against only
that one produces a misleading "1.8× slower" reading).

Also worth knowing: the worker **has** taken up the new tools. `bash` was the
single most-used tool in two of three medium-task trials, ahead of `navigate`
and `inspect_page`, with `edit_file` in use as well. Behavior changed
substantially while accuracy held.

**Not re-validated after these three fixes.** The changes are harness-side
(npm script, temp-directory sweep, test config) and touch nothing the agent
sees — no prompt text, no tool surface — so the table above should still hold.
The first GitHub-graded batch run under the fixed script is what confirms item 1
end-to-end.
