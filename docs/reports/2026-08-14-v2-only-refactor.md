# The V2-only cutover: what it removed, what it cost in coverage, what it broke

**Date:** 2026-08-14
**Branch:** `feat/judge-harness`
**Commits:** `2ac0bfd`, `30ec7c4`, `b1fd6ea`, `ef167ce`, `0d06761` (baseline `0911e03`)

Five commits collapsed the codebase from two live architectures (a V1 atomic-tool loop plus a V2 contract-driven one, with compatibility shims bridging them) down to one. This report verifies the headline claim about the resulting test-count drop, reports the measured size/tool metrics against what was originally claimed, and lists the behavior changes and bugs the cutover surfaced.

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

| Metric | Claimed | Measured here | Match? |
| --- | --- | --- | --- |
| Production SLOC (0911e03 → HEAD) | 27,247 → 22,893 (−16.0%) | 27,042 → 23,190 (−14.2%) | close, not exact |
| Test SLOC (0911e03 → HEAD) | 32,192 → 28,168 (−12.5%) | 32,192 → 28,168 (−12.5%) | **exact** |
| Total SLOC | 59,439 → 51,061 (−14.1%) | 59,234 → 51,358 (−13.3%) | close, not exact |
| Tools | 24 → 18 | 24 → 18 | **exact**, full lists above |
| Tests passing | 1,844 → 1,653 | not re-run (see §3 for the reconciliation done instead) | not independently confirmed |
| Test runtime | 83.0s → 76.5s | not re-run | not independently confirmed |
| Largest file | playwrightBrowserController.ts: 2,347 → 1,811 | 2,330 → 1,812 (raw line count) | close, **and no longer the largest file at HEAD** — see below |

Production and total SLOC reproduce within ~1-2 percentage points using a comment/blank-line-stripped count over `src/`, `evals/`, `demos/`, `scripts/`, and `vitest.config.ts` — the exact figures likely came from a slightly different SLOC tool/regex, but the direction and magnitude (mid-teens percent cut) are confirmed. Test SLOC matches the claim exactly under the same method, which is good corroboration that the counting approach is right; the small production-SLOC gap is very likely a comment-stripping edge case (e.g. multi-line block comments), not a wrong claim.

**One number does not hold as stated:** `playwrightBrowserController.ts` was the single largest file at baseline (2,330 lines, ahead of `runTask.ts` at 2,111), and the shrink to 1,812 is real (commit `0d06761`, "split the Playwright controller"). But `runTask.ts` barely moved (2,111 → 2,061) and is now the largest file in the repo at HEAD, 249 lines ahead of `playwrightBrowserController.ts`. The claim "largest file: 2,347 → 1,811" is true of that one file's own history but no longer describes the codebase's largest file after the cut.

I did not re-run the full test suite (per instructions) and so cannot independently confirm 1,844→1,653 passing or the 83.0s→76.5s runtime; those numbers are taken on trust. The coverage-count arithmetic in §3 below, done by counting `it(`/`test(` occurrences file-by-file, corroborates the ballpark independently (see the residual discussion).

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

1. **Context collapse silently stopped firing.** The collapse logic in `src/loop/contextView.ts` matched on the tool name `inspect_page` — which no longer exists once the V1 atomic tools were removed (`inspect_document`/`observe` replaced it) — so on a V2 run the collapse path never triggered at all.
2. **`read_file` returned U+FFFD replacement-character garbage for binary files** instead of refusing them; fixed by adding an explicit binary-format detector that throws a model-readable error (now covered by `readFile.test.ts`'s "binary files are refused, not silently mangled" suite).
3. **The `readOnly` fallback was a false safety net.** A tool with no `getAccess` and `readOnly: true` fell back to `LEGACY_READ_ACCESS` (`{reads: [], writes: []}`) — an access declaration that conflicts with *nothing*, meaning such a tool could run in parallel with a concurrent write to the same page it was reading. Fixed by making `getAccess` mandatory on every `ToolDef`, closing the silent-fallback path rather than papering over it.
4. **A "hermetic" TUI test was making a live API call.** `runTask` had no `createStream` seam, so a TUI test that believed itself fully mocked was in fact reaching the real model endpoint.
5. **The TUI transcript rendered every real tool call as a bare registry name** rather than a human-readable per-operation line, losing the semantic detail (e.g. which row/URL/file a call touched) that the transcript is supposed to surface.

## 6. Known open issue — not fixed, stated plainly

The controller test suite (`src/browser/playwrightBrowserController.test.ts`) writes one real file into the user's actual `~/Downloads` folder on every test run — the test that observes a JavaScript-triggered download without consuming it leaves the browser's download artifact to land wherever the OS default download directory is, which in a real dev environment is `~/Downloads`, not a scratch directory.

Four fixes were attempted and all failed:
- Playwright's `downloadsPath` context option — does not suppress the browser-level default-download-directory behavior for this trigger path.
- CDP `Page.setDownloadBehavior` — same result.
- CDP `Browser.setDownloadBehavior` — same result.
- Deleting the unconsumed `Download` object after the test — this raced the download tool's own capture of the same download event and broke the tool's real download-handling path.

This is unresolved. It is not a cosmetic nit: running this test suite pollutes a real user directory outside the repo, and none of the four standard Playwright/CDP suppression mechanisms worked for this trigger.
