# Open follow-ups found on 2026-08-14

Three defects found while validating commit `3091a81` (`run: close resume and
document-output gaps`). None is fixed. Each is small, each is independently
actionable, and the first one silently corrupted an eval batch the night it was
found — so read that one before running any GitHub-heavy eval.

Nothing here blocks `feat/judge-harness`. The follow-ups that commit *did* close
are recorded in
`docs/browser-agent-local-code-execution-implementation-plan.md` §7.

---

## 1. `npm run evals` never loads `.env`, so oracles run unauthenticated

**Severity: high.** Costs whole eval batches, and does it in a way that looks
like an agent regression.

`package.json` defines:

```json
"evals": "tsx evals/runners/cli.ts"
```

No `--env-file=.env`. The repo has no `dotenv` dependency
(`src/tui/main.tsx:99`), and the two entry points diverge on what they do about
that: Sherlock's TUI implements its own loader and reads the first `.env` it
finds (`src/tui/main.tsx:99-113`, via `loadFirstEnvFile`), so a bare `sherlock`
works without flags. `evals/runners/cli.ts` has no such loader and relies purely
on Node's `--env-file`, which its npm script omits. So the eval CLI is the
outlier: it is the one entry point that reads no `.env` at all. `.env` is
gitignored and does hold a `GITHUB_TOKEN`; it is simply never read there.

`evals/oracles/githubApi.ts:1-8` states the invariant this violates, in its own
words:

> Unauthenticated GitHub API calls are limited to 60/hour per IP — too few for a
> k=3 eval whose oracles make dozens of calls per trial — while a token raises
> the limit to 5,000/hour. The token is read from the environment at call time
> **(the eval CLI runs under `--env-file=.env`)**.

The eval CLI does not. So every oracle fetch goes out unauthenticated at 60/hr,
and any k=3 GitHub task exhausts it mid-batch.

**Observed 2026-08-14:** `openclaw_merged_prs` at k=3 reported 33.3% accuracy,
1/3 completion, task FAIL. All three agent runs were actually correct. Two
trials simply could not be graded:

```
GitHub API GET /repos/openclaw/openclaw/pulls?... failed with HTTP 403
  (rate limit exhausted — set GITHUB_TOKEN in .env to raise it to 5,000/hr)
```

Regrading the same three run directories with the token loaded gave
**100%, 24/24 assertions, 3/3**. The error message tells you to set the variable
in a file that the failing process does not read.

### How to tell a grader failure from an agent failure

Read the ordering in the log. A trial that prints `run finished` and *then*
`errored` completed its work and failed in the **grader**. Both of the trials
above did exactly that. Treating them as agent failures would have sent someone
hunting a regression that does not exist.

### Recovery for an already-run batch

```
npx tsx --env-file=.env evals/runners/regrade.ts "<task>:<dir1>,<dir2>,<dir3>"
```

Do it promptly — `regrade.ts` fetches oracles at regrade time, so a moving
ground truth drifts away from what the agent saw.

### The fix, and the decision it needs first

The one-line change is `"evals": "tsx --env-file=.env evals/runners/cli.ts"`.
**Do not apply it without deciding the following**, which is why it was left
alone:

Loading `.env` into the eval process puts `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`,
and the `LANGFUSE_*` keys into the environment that the agent's own `bash` tool
inherits. `BASH_SECRET_ENV_DENYLIST` in `src/cli/runTask.ts:198-209` already
strips all of those, and its comment is explicit that it is reproducibility and
blast-radius hygiene, **not a security boundary** — commands run as the same OS
user and can read `.env` off disk regardless. So the denylist makes this
acceptable rather than safe, and that distinction should be a conscious call.

Options, roughly in order of how much they respect that boundary:

1. Add `--env-file=.env` and rely on the existing denylist. Smallest change.
2. Have `evals/runners/cli.ts` read `.env` itself and inject **only**
   `GITHUB_TOKEN` into the oracle path, never into the agent's environment.
   Narrowest blast radius; a bit more code.
3. Leave the script alone and make the missing token **loud**: have
   `githubApi.ts` warn once at startup when `GITHUB_TOKEN` is unset, naming the
   `--env-file` requirement. Fixes the silent-failure half without touching
   what the agent inherits. Worth doing regardless of 1 or 2.

Whichever is chosen, a test should pin it: today nothing fails when the CLI runs
without the token, which is precisely why this survived.

---

## 2. Eval Chrome profiles leak when a batch is killed

**Severity: medium.** Unbounded disk growth; contributed to a hard stop on
2026-08-14.

`evals/runners/browserRuntime.ts:101-125` creates a temp profile per headless
trial (`mkdtemp` with prefix `evidence-agent-eval-chrome-`, line 12) and removes
it after the browser closes. That path is correct on a normal exit — it runs
unconditionally, outside the success branch, and warns rather than throwing on
failure.

The gap is that **nothing reaps orphans**. If the process dies before reaching
cleanup — a crash, a Ctrl-C, an `ENOSPC` — the profile stays in `$TMPDIR`
forever, and no later run notices.

**Observed 2026-08-14:** seven orphaned profiles from 2026-08-12 and 2026-08-13
totalling ~260 MB, one of them alone at 158 MB. On a full disk this was the
difference between a batch running and failing.

**Suggested fix.** On runtime creation, sweep `$TMPDIR` for
`evidence-agent-eval-chrome-*` directories older than some threshold (a few
hours is generous — no live trial's profile is that old) and remove them
best-effort, warning but never failing the batch. Guard against removing a
profile belonging to a concurrently running eval: an mtime threshold does that
adequately, since a live Chrome touches its profile continuously.

Manual cleanup meanwhile:

```
ls -dlt $TMPDIR/evidence-agent-eval-chrome-*     # check mtimes first
```

Cross-check against `ps -eo args | grep -o 'evidence-agent-eval-chrome-[A-Za-z0-9]*'`
before deleting, so a running batch's profile is not pulled out from under it.

---

## 3. `npm test` is color-dependent — 51 TUI failures in a colored terminal

**Severity: low, but actively misleading.** Costs time on every fresh
environment.

Every test under `tests/tui/` asserts against plain strings, while Ink emits ANSI
escapes whenever the shell reports color support. In a colored terminal:

```
Test Files  12 failed | 136 passed (148)
     Tests  51 failed | 1737 passed (1788)
```

With color off, the same tree is fully green:

```
FORCE_COLOR=0 npm test
Test Files  148 passed (148)
     Tests  1788 passed (1788)
```

This reproduces identically on clean `HEAD`, so it predates
`3091a81` — verified by stashing all changes and re-running. Failures look like
this, which reads as a rendering regression rather than an environment
difference:

```
- ✓ Brewed in 42s · 18.7k tokens
+ [38;2;0;137;43m✓ [39mBrewed in 42s · 18.7k tokens
```

**Suggested fix**, cheapest first:

1. Set `FORCE_COLOR: '0'` in the vitest config's `env` for the TUI project, so
   the suite is deterministic regardless of who runs it. Least invasive, and
   matches what the assertions already assume.
2. Or strip ANSI in the test helper that joins frames, which additionally lets a
   test assert on colored output deliberately when that is the point.

Option 1 alone removes the trap. Whichever is picked, `npm test` should not
depend on whether it is attached to a TTY.

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
