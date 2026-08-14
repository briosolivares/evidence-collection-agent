# The V2-only cutover: what it removed, what it cost in coverage, what it broke

**Date:** 2026-08-14
**Branch:** `feat/judge-harness`
**Commits:** `2ac0bfd`, `30ec7c4`, `b1fd6ea`, `ef167ce`, `0d06761`, `9c599e6`, `619dafb`, `6e15642` (baseline `0911e03`)

Five commits collapsed the codebase from two live architectures (a V1 atomic-tool loop plus a V2 contract-driven one, with compatibility shims bridging them) down to one. Three more closed it out: the `~/Downloads` leak (`9c599e6`), the leftovers the cut left behind (`619dafb`), and the `runTask.ts` split (`6e15642`).

This report verifies the headline claim about the resulting test-count drop, reports the measured size/tool metrics against what was originally claimed, and lists the behavior changes and bugs the cutover surfaced. §§6–8 cover the follow-through; §9 is what remains open. Where a claim in the original draft did not survive checking — the test runtime, the largest-file framing, and §7's "unresolved" verdict on a bug its own commit had already fixed — the correction is stated in place rather than quietly edited out.

## 1. What changed, by area

**Tool surface, 24 → 18.** Baseline `V2_TOOL_ORDER` (`src/tools/index.ts` @ `0911e03`):

`set_output_contract, upsert_output_rows, delete_output_rows, set_table_completeness, write_document, observe, browser_action, switch_page, handle_dialog, execute_javascript, read_resource, capture_text, inspect_document, screenshot, download, read_file, write_file, edit_file, grep, bash, fill_credentials, ask_user_question, run_research_jobs, submit_for_verification`

HEAD `TOOL_ORDER` (`src/tools/index.ts` @ `HEAD`):

`set_output_contract, update_table, write_document, observe, browser_action, handle_dialog, execute_javascript, capture_text, inspect_document, screenshot, download, read_file, write_file, edit_file, grep, bash, ask_user_question, submit_for_verification`

Net: `upsert_output_rows` + `delete_output_rows` + `set_table_completeness` (3 tools) merged into one `update_table` (1 tool, mode-dispatched: `{upsert}` / `{delete}` / `{completeness}`); `switch_page`, `read_resource`, `fill_credentials`, `run_research_jobs` deleted outright. 24 − 3 + 1 − 4 = 18, confirmed.

Also gone from the tool directory entirely (superseded earlier by `browser_action`/`observe`, now removed rather than kept dead): `click`, `type`, `scroll`, `navigate`, `inspectPage`, `switchPage`, `browserBatch`.

**Removed subsystems** (whole directories deleted): `src/research/` (`researchJob.ts`, `researchRegistry.ts`, `mergeResearchResults.ts` — the unwired parallel-research feature, commit `2ac0bfd`), `src/auth/` (`credentialStore.ts`, commit `30ec7c4`), `src/browser/publicResourceReader.ts` + `discoveredUrlIndex.ts` (backed `read_resource`), `src/tools/fillCredentials/`, `src/tools/runResearchJobs/`, `src/tools/browserBatch/`, and the five V1 atomic-action tool directories listed above.

**Removed compatibility layers:**
- `ToolDef.readOnly` + `LEGACY_READ_ACCESS`, gone from `src/tools/registry.ts`. Baseline's `deriveAccess` fell back to `tool.readOnly ? LEGACY_READ_ACCESS : EXCLUSIVE_ACCESS` when `getAccess` was absent; at HEAD `getAccess` is a mandatory field on `ToolDef` (no `?`), so every tool declares real read/write access and there is no silent fallback path left.
- The dual completion protocol: baseline's `src/harness/initializer.ts` had two parallel entry points, `runInitializer`/`writeInitializerFiles` (prose INTENT.md/CONTRACT.md path) and `runContractInitializer` (typed contract path), selected by the `--output-contract` CLI flag. At HEAD only `runContractInitializer` exists; `runInitializer` and `writeInitializerFiles` are deleted, and `--output-contract` is gone from the eval CLI args.
- `ToolProfile` (`'atomic' | 'batch-enabled'`) and `DEFAULT_TOOL_PROFILE`, gone from `src/tools/index.ts` along with the `browser_batch`-conditional spread that used them.
- `harness.outputContract` config branching in `runTask.ts` — every run now goes through the single initializer → worker → verifier path; there is no judge-less/no-harness branch left (see §4).
- `src/loop/agentLoop.ts` (814 lines of tests alone) replaced by `src/loop/workerSession.ts` as the one loop implementation.

## 2. Measured metrics vs the claimed numbers

| Metric | Claimed | Measured | Match? |
| --- | --- | --- | --- |
| Production SLOC (0911e03 → HEAD) | 27,247 → 22,893 (−16.0%) | 27,209 → 23,383 (−14.1%) | close, not exact |
| Test SLOC (0911e03 → HEAD) | 32,192 → 28,168 (−12.5%) | 32,192 → 28,168 (−12.5%) | **exact** |
| Total SLOC | 59,439 → 51,061 (−14.1%) | 59,401 → 51,551 (−13.2%) | close, not exact |
| Tools | 24 → 18 | 24 → 18 | **exact**, full lists above |
| Tests passing | 1,844 → 1,653 | 1,653 at HEAD, measured | **HEAD side exact** (baseline not re-run) |
| Test runtime | 83.0s → 76.5s | 123.1s at HEAD, under load | **does not reproduce** — see below |
| Largest file | playwrightBrowserController.ts: 2,347 → 1,811 | 2,330 → 1,859 | **and it is not the largest file** — see below |

Two independent SLOC passes (different tools, different comment-stripping) both land production at ~23.2–23.4k and total at ~51.4–51.6k, so the direction and magnitude — a mid-teens percent cut — are confirmed; the claimed −16.0% is about two points optimistic. Test SLOC reproduces the claim *exactly* on both sides, which pins the method: the count covers `src/`, `evals/`, `demos/`, `scripts/`, `vitest.config.ts` **and the `tests/` directory**. That last inclusion is not optional — the four source dirs alone yield 25,687 test SLOC, not 32,192, so any re-measurement that omits `tests/` will silently disagree.

**The largest-file claim needs restating twice over.** At baseline `playwrightBrowserController.ts` was the largest file in the repo (2,330 lines, ahead of `runTask.ts` at 2,111) and the split in `0d06761` genuinely cut it. But (a) the 1,811/1,812 figure predates commit `9c599e6`, which added 47 lines back for the download fix, leaving it at 1,859; and (b) `runTask.ts` barely moved during the cutover (2,111 → 2,061) and so *inherited* the title — it was the largest file in the repo at HEAD, 202 lines ahead of the controller. Splitting it (`6e15642`, 2,061 → 956) was the last piece of this refactor; see §8. The largest file in the repo is now `playwrightBrowserController.ts` at 1,864.

**Tests passing is confirmed, runtime is not.** A full `npm test` at the cutover HEAD reports **1,653 passing across 130 files with zero assertion failures**, matching the claim exactly. (After this session's follow-up commits it is 1,659 across 131 files — the six new download-pin cases in §7.)

The runtime claim does not hold. Two full-suite samples, both well above 76.5s:

| Sample | Duration | Load average | Free disk |
| --- | --- | --- | --- |
| at cutover HEAD | 123.1s (125.2s wall) | 4.2–5.8 | 2.7 GiB |
| after the split, all commits in | 106.0s | 2.4 | 673 MiB |

The second sample ran at less than half the load of the first and still came in 39% above the claim. Neither machine state was clean enough to call this a code fact — the volume was at 99–100% capacity throughout — but a claim missed by 39% at low load is not explained by load. Treat 76.5s as **unsupported**: it needs one re-measurement on an idle machine with free disk, recording both conditions next to the number, which is the standing rule here for exactly this reason. The baseline 1,844 / 83.0s pair was not re-run; the coverage arithmetic in §3, counted `it(`/`test(` file-by-file, is what corroborates the baseline count independently.

One run-level fact worth recording because it will recur: `src/browser/playwrightBrowserController.test.ts` failed in the batch on a 10s `afterAll` teardown timeout and passed 52/52 in isolation. That is the known under-load teardown flake, not a regression — a suite-level failure with zero failing assertions is the signature.

## 3. Coverage verification — does the 191-test drop track deleted subsystems?

Method: diffed the test-file tree between `0911e03` and `HEAD`, then counted `^\s*(it|test)\(` occurrences per file at each commit with `git show <rev>:<path> | grep -c`.

**File inventory:** 150 test files at baseline, 130 at HEAD. 20 files deleted outright, 1 renamed (`src/tools/outputRows/outputRows.test.ts` → `src/tools/updateTable/updateTable.test.ts`), 46 modified in place (case count unchanged or changed), the remaining ~83 untouched.

**Deleted test files, cases at baseline (220 total):**

| File | Cases | Deleted capability |
| --- | --- | --- |
| `src/research/researchJob.test.ts` | 26 | parallel research |
| `src/research/mergeResearchResults.test.ts` | 17 | parallel research |
| `src/research/researchRegistry.test.ts` | 8 | parallel research |
| `src/tools/runResearchJobs/runResearchJobs.test.ts` | 12 | parallel research |
| `src/browser/publicResourceReader.test.ts` | 40 | `read_resource` |
| `src/tools/readResource/readResource.test.ts` | 17 | `read_resource` |
| `src/tools/readResource/parseResource.test.ts` | 15 | `read_resource` |
| `src/browser/discoveredUrlIndex.test.ts` | 11 | `read_resource` |
| `src/auth/credentialStore.test.ts` | 13 | `fill_credentials` |
| `src/tools/fillCredentials/fillCredentials.test.ts` | 10 | `fill_credentials` |
| `src/loop/agentLoop.test.ts` | 29 | V1 loop, replaced by `workerSession.ts` |
| `src/tools/switchPage/switchPage.test.ts` | 6 | V1 atomic tool |
| `src/tools/click/click.test.ts` | 2 | V1 atomic tool |
| `src/tools/type/type.test.ts` | 2 | V1 atomic tool |
| `src/tools/navigate/navigate.test.ts` | 2 | V1 atomic tool |
| `src/tools/scroll/scroll.test.ts` | 1 | V1 atomic tool |
| `src/tools/inspectPage/inspectPage.test.ts` | 2 | V1 atomic tool |
| `src/tools/browserBatch/browserBatch.test.ts` | 3 | `browser_batch`/`ToolProfile` |
| `evals/analysis/browserBatch.test.ts` | 3 | `browser_batch`/`ToolProfile` |
| `src/cli/runTask.secretSweep.test.ts` | 1 | folded elsewhere (secret-sweep behavior; not chased further, single case) |

Every deleted file maps cleanly to one of the named removed subsystems (parallel research, `read_resource`, `fill_credentials`, the V1 atomic tool set, `browser_batch`/`ToolProfile`).

**Renamed file:** `outputRows.test.ts` (7 cases) → `updateTable.test.ts` (10 cases), +3 — the rename tracks the tool merge (`upsert_output_rows`/`delete_output_rows`/`set_table_completeness` → `update_table`) and gained cases.

**Modified files, net delta across the 46 touched files: +24** (48 gained across files like `workerSession.test.ts` +21, `screenshot.test.ts` +5, `download.test.ts` +3, `completionCheck.test.ts` +3, `semantic.test.ts` +3, `bash.test.ts` +2, `readFile.test.ts` +2; 24 lost across 8 files, itemized below).

**The 8 files that lost cases, checked one by one for category (a) vs (b):**

| File | Lost | What was removed | Category |
| --- | --- | --- | --- |
| `evals/runners/cliArgs.test.ts` | 5 | `--output-contract` flag parsing/defaulting, `--contract-author`, tool-profile flag defaulting to `atomic` | (a) — dual protocol / `ToolProfile`, both confirmed removed from source |
| `src/harness/initializer.test.ts` | 6 | `runInitializer`'s malformed-response retry/recovery tests, `writeInitializerFiles`'s file-write test | (a) — `runInitializer`/`writeInitializerFiles` deleted; confirmed zero references left outside this test file. The retained `runContractInitializer` has its own equivalent retry coverage ("re-asks once... then succeeds", "fails after a second bad response") — the behavior class isn't uncovered, just the deleted sibling function is gone |
| `src/cli/runTask.checkpoint.test.ts` | 3 | "a judge-less run writes NO checkpoint", a prose-initializer resume test, a `browser_batch`-survives-resume test | (a) — judge-less runs no longer exist (§4), prose initializer deleted, `browser_batch`/`ToolProfile` deleted |
| `src/cli/runTask.test.ts` | 1 | "harness mode... unaffected when config.harness is absent: single loop, no INTENT.md/CONTRACT.md/harness.json" | (a) — the no-harness branch itself was deleted (§4) |
| `src/cli/runTask.initializerBinding.test.ts` | 2 net (5 removed, 3 replaced) | "picks the contract/prose binding" tests, the frozen `V2_TOOL_ORDER` position test | (a) — dual-binding selection deleted along with the prose path |
| `src/outputs/outputTable.test.ts` | 3 | row `version`/`expectedVersion` optimistic-concurrency-conflict tests | (a), but not one of the three named subsystems — checked `src/outputs/outputTable.ts` directly: the word "version" does not appear anywhere in the HEAD file outside an unrelated comment ("inversion"). Row versioning was actually deleted from production code, not just left untested. Legitimate but worth flagging since it's a smaller, previously-unnamed casualty of the merge into `update_table` |
| `src/tools/index.test.ts` | 2 | bash-omission-from-atomic-profile test, "keeps atomic stable and appends browser_batch only in its explicit profile" | (a) — `ToolProfile`/`browser_batch` deleted |
| `src/tools/registry.test.ts` | 2 | "falls back to `LEGACY_READ_ACCESS` for a readOnly tool with no `getAccess`", "falls back to `EXCLUSIVE_ACCESS` for a non-readOnly tool with no `getAccess`" | (a) — confirmed `LEGACY_READ_ACCESS` and the `readOnly` fallback are gone from `registry.ts`; `getAccess` is now a mandatory field, so there is no fallback path left to test |

**No category (b) findings.** Every removed case in a surviving file traces to a genuinely deleted capability, either one of the three subsystems named in the brief or two smaller casualties the cutover also swept up: the prose-protocol initializer functions and the output-table row-versioning feature. None of the losses represent thinned coverage on behavior the codebase still exercises.

**Arithmetic:** deleted-file cases −220, renamed file +3, modified files net +24 → predicted total delta −196 (with 130 surviving/renamed files at HEAD carrying 793 cases vs 769 at baseline, plus ~855 untouched-file cases carried unchanged either side). The claimed real total is −191 (1,844 → 1,653), a residual of 5 against my grep-based delta. That gap is consistent with `it.each`/`describe.each` parameterized blocks, which my line-count regex sees as one `it(` call but Vitest reports as N runtime tests — a handful of such blocks anywhere in the 130 surviving files fully explains a residual this small. **The claim holds**: the 191-test drop is coverage leaving with the subsystems it tested, not a thinning of coverage on retained behavior.

## 4. Behavior changes a reader must know

- **Every run is now a harness run.** The no-harness/"judge-less" branch in `runTask.ts` is gone; `RunTaskResult.status` is only `'verified' | 'incomplete'` (never `'completed'`) at HEAD, whereas baseline still had a live judge-less path returning `'completed'` for configs with no `harness` set.
- **Checkpoints from older builds no longer load.** No migration path was written; this is intentional, not an oversight.
- **The agent no longer holds credentials.** `fill_credentials` and `credentialStore.ts` are gone; a login wall now surfaces as an `ask_user_question` handoff to a human rather than the agent filling in stored secrets itself.
- **`read_file` refuses binary input** rather than returning mangled bytes (see the bug list below — this used to silently return U+FFFD garbage).
- **Screenshot `roles` derive from the output contract, not the model's self-report** — `createScreenshotTool` is now contract-aware (it takes the contract store as a dependency) instead of trusting whatever role string the model passed in the tool call.

## 5. Five latent bugs the cutover exposed

All five were re-verified against HEAD after the fact: each is fixed in code, not merely described. Four carry direct unit-test coverage; the fifth is closed structurally (see 3).

1. **Context collapse silently stopped firing.** The collapse logic in `src/loop/contextView.ts` matched on the tool name `inspect_page` — which no longer exists once the V1 atomic tools were removed (`inspect_document`/`observe` replaced it) — so on a V2 run the collapse path never triggered at all. Now `OBSERVE_TOOL_NAME = 'observe'` (`src/loop/contextView.ts:27`), guarded by a test that asserts the constant equals the real tool's registry name rather than a hard-coded string — the specific guard this bug's class needed.
2. **`read_file` returned U+FFFD replacement-character garbage for binary files** instead of refusing them; fixed by adding an explicit binary-format detector that throws a model-readable error (now covered by `readFile.test.ts`'s "binary files are refused, not silently mangled" suite).
3. **The `readOnly` fallback was a false safety net.** A tool with no `getAccess` and `readOnly: true` fell back to `LEGACY_READ_ACCESS` (`{reads: [], writes: []}`) — an access declaration that conflicts with *nothing*, meaning such a tool could run in parallel with a concurrent write to the same page it was reading. Fixed by making `getAccess` mandatory on every `ToolDef`, closing the silent-fallback path rather than papering over it.
4. **A "hermetic" TUI test was making a live API call.** `runTask` had no `createStream` seam, so a TUI test that believed itself fully mocked was in fact reaching the real model endpoint. The seam is at `src/cli/runTask.ts` and the test that used to escape is `tests/tui/run-session.test.ts`.
5. **The TUI transcript rendered every real tool call as a bare registry name** rather than a human-readable per-operation line, losing the semantic detail (e.g. which row/URL/file a call touched) that the transcript is supposed to surface. The mapping is `src/tui/store/semantic.ts`, covered by `tests/tui/semantic.test.ts`.

Note for anyone verifying these: the TUI tests are **not** colocated under `src/tui/` the way the rest of this codebase colocates tests — they live in `tests/tui/`.

## 6. Leftovers the cutover left behind — swept

An audit of the whole repo for the removed V1/compat surface (`read_resource`, `fill_credentials`, `run_research_jobs`, `switch_page`, `browser_batch`, `ToolProfile`, `runInitializer`, `LEGACY_READ_ACCESS`, `credentialStore`, `publicResourceReader`, `INTENT.md`, and the rest) found the *code* cutover clean: every remaining mention under `src/`, `evals/`, `demos/`, `scripts/` is a comment or test explicitly documenting that the thing is gone.

The **model-facing text was not clean**, and that is worse than dead code, because a tool description naming a deleted tool is instruction the agent actually follows:

- `src/tools/bash/bash.ts` — the `bash` description told the model to "call `inspect_page` again afterward before trusting page state." Now `observe`.
- `src/tools/download/download.ts` (two places) — the `ref` field's `.describe()` and the tool's own description both offered an "`inspect_page` ref". Both reach the model in every request. Now `observe`.
- `src/tools/executeJavascript/executeJavascript.ts` — the error thrown when `javascriptPolicy: 'deny'` fires (a reachable `RunTaskConfig` option) told the model to "extract with `observe`/`inspect_page`, `scroll`" — two dead tools in one sentence. Now `observe` and `browser_action scroll`.

Dead code deleted: `formatPageHeader`, `actByRef`, `requireRefDescription` and its private helper — everything in `src/tools/shared/browser.ts` except `requireBrowser`, all of it V1-era ref-resolution machinery with zero references anywhere, not even a test; `SUBMIT_FOR_VERIFICATION_ACCESS`, an exported constant whose own doc comment cited "this module's test" — a file that does not exist (its reasoning is kept as a comment, since the invariant it named is real); and `validateExpectedOutputs`, a wrapper around `expectedOutputsOutcome` with no callers including its own test file.

Stale documentation corrected: `observe.ts` still announced itself as "NOT registered in the production registry yet" while sitting in `TOOL_ORDER`; `callModel.ts` described the cache-collapse frontier as "the newest `inspect_page` stub" in three places; and both `src/tui/store/state.ts` and `src/loop/workerSession.ts` attributed the `'completed'`/`'budget_exceeded'` statuses to "judge-less runs," a path that no longer exists. Those two status values are **not** dead and were left in place: the `--demo` stream still emits them and `tests/tui/reducer.test.ts` and `tests/tui/app.test.tsx` still exercise their rendering. Only the false explanation was fixed — narrowing the union would have deleted tested behavior to chase a tidier type.

## 7. The `~/Downloads` leak — fixed, and how

**Correction to this report's first draft**, which described this as unresolved: it was fixed in `9c599e6`, the same commit that added this file. The draft listed the four approaches that failed and omitted the fifth, which worked and shipped in its own diff. What follows is the corrected account.

The symptom: the test suite deposited one real file per run into the user's actual `~/Downloads` (`javascript-evidence.bin`, the `downloads.html` fixture payload) and never cleaned one up. This also affected real runs — same launch path — so it was never only a test-hygiene problem.

The cause: **Chrome, not Playwright, decides where a download Chrome handles itself lands**, and it reads `download.default_directory` from the profile's Preferences *at startup*. Unset, that resolves to the OS Downloads folder.

The fix (`pinProfileDownloadDirectory`, `src/browser/playwrightBrowserController.ts`): seed that preference to a `downloads/` directory inside the run's own profile, before `launchPersistentContext`, since Chrome reads it at launch. The value is **merged** into any existing Preferences rather than replacing the file — the persistent profile is a real logged-in one whose other settings must survive — and the whole thing is best-effort, so an unparseable Preferences file cannot stop a session from launching.

Four approaches were measured first and none worked. Recorded so they are not retried:
- Playwright's `downloadsPath` launch option — governs downloads Playwright accepts and hands back as `Download` objects, not ones Chrome writes itself.
- CDP `Page.setDownloadBehavior` (per page) — no effect on this trigger path.
- CDP `Browser.setDownloadBehavior` (browser scope) — same.
- Calling `download.delete()` in the controller's page-level download listener — actively wrong: the listener sees *every* download, including the ones `downloadCapture` is reading, so it raced the download tool and broke it.

Two measurement traps cost most of the debugging, and both generalize. Globbing only for the known filename hid whether anything *else* leaked; diffing the whole directory is what made the result trustworthy. And the leak was timing-dependent — the producing test leaked 0 of 3 times run alone and 1 of 1 run after the other 51 in its file — so single samples pointed at the wrong test entirely.

**Verification.** Independently re-checked after the fact: a full `npm test` with a complete `ls -1a ~/Downloads` listing captured before and after showed 1,453 entries both times and an empty diff. Still 1,453 after the final full-suite run with every follow-up commit in.

**The fix shipped untested, and no longer is.** `pinProfileDownloadDirectory` was unexported with zero test references; its only verification was the manual runs cited in the commit message. Given that the failure mode wrote into a real user directory and only reproduced under a specific ordering, that was the wrong thing to leave on trust. It is now exported and covered by `src/browser/playwrightBrowserController.downloadDirectory.test.ts` (6 cases): the directory seed, merge-don't-replace against a profile carrying unrelated settings, overwriting a pre-pinned directory, and both best-effort paths (unparseable Preferences left untouched, unwritable profile dir). One thing those tests deliberately do not cover, because `chromium` is not injectable here: the *ordering* requirement that the pin precede launch. That invariant rests on a comment at the call site and on the whole-directory diff above.

## 8. Splitting `runTask.ts` — the last piece

The cutover left `runTask.ts` holding the title the Playwright controller gave up (§2). Commit `6e15642` splits it: **2,061 → 956 lines**, six satellites in `src/cli/`, and it is now the 5th-largest file in the repo rather than the 1st.

| Module | Owns | Lines |
| --- | --- | --- |
| `harnessCycles.ts` | `runHarnessCycles`, `runVerificationHarness`, the two feedback formatters, `DEFAULT_MAX_COMPLETION_CHECK_FAILURES` | 486 |
| `runToolchain.ts` | `buildRunToolchain` + `rehydrateContractStore` | 312 |
| `resumeRecovery.ts` | `resumeTask`'s six single-caller helpers + `RECOVERY_NOTICE` | 181 |
| `toolCallCheckpoint.ts` | `createToolCallCheckpointHooks` and its types | 140 |
| `localExecution.ts` | `prepareLocalExecution`, bash shell/denylist consts | 69 |
| `cancellationGuard.ts` | `withCancellationGuard` | 50 |

The split follows `0d06761`'s conventions deliberately, so the two read the same: satellites flat in the same directory and named for their mechanism, free functions with explicit parameters rather than anything reaching back into hub state, and the hub keeping the entire public surface (`runTask`, `resumeTask`, `usableStartUrl`, `defaultInitializerCallModel`, the config types) so no importer outside `src/cli/` changed. **No test file changed**, which is the same proof the controller split leaned on.

Three things worth recording about the seams, because they were findings, not just plumbing:

- **`rehydrateContractStore` sat 600 lines from its only caller**, under the `resumeTask` banner, which is where a bottom-up reader would look for it and exactly where it does not belong. It now sits next to `buildRunToolchain`.
- **There is no shared mutable state anywhere in the file.** Every seam was a call-graph or shared-constant seam, which is why a pure-motion split was possible at all. `withCancellationGuard` got its own module precisely because three clusters need it and every other home creates an import cycle; satellites take hub types via `import type` (erased at compile time) and never import a runtime value from the hub.
- **`runTask` and `resumeTask` were left as two entry points.** They call the same four clusters but share no abstraction that exists today, and inventing one to make the diff look tidier would have been a behavior risk for no reader benefit.

Verification: typecheck clean; full suite green; and independently of the trust placed in any single pass, every deleted content line was checked for a home in the new files — 489 lines, all accounted for except the single intended `export` keyword drop on `InitializerBindings`.

## 9. What is still open

- **`resumeTask` has no production caller.** Its only caller in the repo is `runTask.checkpoint.test.ts` — not `repl.ts`, not the TUI bridge, not `bin/sherlock.mjs`. It is not dead code (it is a documented recovery API with 11 tests behind it), but nothing a user can invoke reaches it, so checkpoint resume is currently a library capability rather than a product one. Deciding whether to wire it up or retire it is out of scope here and deliberately untouched.
- **The 76.5s test-runtime claim is unsupported** in both directions (§2). It needs one re-measurement on an idle machine with free disk, recording load average and free space alongside the number.
- **Disk pressure on this machine is a live hazard, not a code issue.** The measurement runs above happened with the volume at 99–100% capacity (2.7 GiB, then 651 MiB free), with `runs/` alone holding 637 MiB across 58 run directories. Eval batches will need that space cleared first, and any timing figure taken under those conditions should be distrusted.
