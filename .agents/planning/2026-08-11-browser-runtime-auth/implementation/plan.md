# Implementation Plan: Browser Auth with Human Handoff

Design: `../design/detailed-design.md`. Four steps, each ending in working,
demoable functionality. Test requirements live inside each step (TDD — write
them with, not after, the code).

## Checklist

- [ ] Step 1: Credential store + `fill_credentials` — agent logs into a plain login form
- [ ] Step 2: Permission gate + `ask_user_question` — fail-closed everywhere
- [ ] Step 3: TUI interactive channel — pause, ask, answer, resume
- [ ] Step 4: System prompt + X acceptance — the Elon Musk task unblocked

---

## Step 1: Credential store + `fill_credentials` — agent logs into a plain login form

**Objective:** The full secret path exists and is provably leak-free: a
gitignored JSON file, behind the `CredentialStore` interface, consumed by a
`fill_credentials` tool in the production registry.

**Guidance:**

- `src/auth/credentialStore.ts`: `Credential`, `CredentialStore`
  (`listHosts`, `lookup`), `FileCredentialStore` (fresh read per lookup,
  hostname exact-then-suffix matching with longest key winning, missing file
  = empty store, malformed file = path-only error). Add `.credentials.json`
  to `.gitignore` in the same commit.
- `src/tools/fillCredentials/`: schema per the design (`fields` of
  ref + `'username' | 'password'`, `submit_ref` required whenever a password
  field is present — zod refinement). Executor: hostname from
  `browser.currentUrl()` only; `lookup` miss throws the documented
  "no credentials stored" message; fill via `controller.type`, optional
  `controller.click(submit_ref)`; result is metadata only. `readOnly: false`.
- Wire-up: register in `createProductionRegistry`; grow `ToolCtx` with
  `credentials?`; `runTask` builds the default `FileCredentialStore`
  (`CREDENTIALS_FILE` env override) with a `RunTaskConfig.credentials` test
  seam; the loop places it on the ToolCtx it constructs.
- Test fixture: a local two-step login page (username → Next → password →
  submit, mimicking X) served in-test.

**Tests (this step's functionality):**

- Unit — store: matching rules, missing/malformed file, fresh-read
  semantics, no secret in any error message.
- Unit — tool: fake controller + store (right values to right refs; hostname
  never taken from input; password-without-submit rejected by schema; result
  secret-free).
- Integration — real Playwright vs. the fixture: two-step login completes;
  fixture receives the correct submitted values.
- **Secret-leak sweep** — scripted fake-model run performing the fill, then
  grep the entire run dir (transcript, manifest, offloads) for the password:
  must be absent. This test is permanent (guards R6 forever).

**Integration with previous work:** consumes the existing `BrowserController`
ref-based `type`/`click` path and the pipeline's throw→error contract; first
use of `ToolCtx`'s documented grow-in-place pattern.

**Demo:** with fixture credentials in `.credentials.json`, a CLI run against
the fixture page logs in — and `grep -r <password> runs/<run>/` comes back
empty.

---

## Step 2: Permission gate + `ask_user_question` — fail-closed everywhere

**Objective:** The general interaction seam exists in the pipeline, and the
one tool that uses it degrades gracefully in every environment that can't
answer.

**Guidance:**

- `src/tools/registry.ts`: `PermissionRequest`, `PermissionDecision`,
  `ToolDef.requiresUserInteraction?`, `ToolCtx.requestPermission?`; new
  `ToolErrorKind: 'permission_denied'`.
- `src/tools/pipeline.ts`: gate between validation and execute, exactly per
  the design (no callback → fail-closed error; deny → feedback as error
  content; allow → execute receives trusted `updatedInput`, not re-validated).
- `src/tools/askUserQuestion/`: schema (single question, ≤4 options,
  `multi_select`), `requiresUserInteraction: true`, `readOnly: false`;
  `execute` reads `answers` from the updated input and returns them as
  natural-language prose. Register in `createProductionRegistry`.

**Tests (this step's functionality):**

- Pipeline: interactive + no callback → `permission_denied`, execute never
  called; deny path; allow path delivers `updatedInput`; non-interactive
  tools bypass the gate (existing pipeline tests unchanged).
- Tool: prose result from answers; schema bounds.
- Regression: eval/headless registries need zero changes and their runs
  can't hang.

**Integration with previous work:** pure pipeline/registry extension; nothing
supplies `requestPermission` yet — fail-closed *is* this step's observable
behavior. (Second and final prompt-prefix change; steps 1+2 can land together
if cache churn matters.)

**Demo:** a headless run whose task provokes a question — the model calls
`ask_user_question`, receives the structured "this environment does not
support user interaction" error, and visibly routes around it in the
transcript.

---

## Step 3: TUI interactive channel — pause, ask, answer, resume

**Objective:** The first UI→run data path: a mid-run question renders as a
dialog in the TUI, the human answers in natural language, the run resumes
with the answer in context.

**Guidance:**

- Plumb `requestPermission?` down the existing DI chain:
  `TuiRuntimeDeps → RunSessionDeps → RunTaskConfig → loop deps → ToolCtx`
  (one optional field per layer; the loop's ToolCtx construction site gains
  one property).
- New `permission_request` UiEvent; App holds `{request, resolve}` in state
  (ToolUseConfirm shape), renders the question dialog above the composer,
  and re-targets composer input to it: option selection, free-text answer,
  submit → `allow({...input, answers})`, Esc → `deny` with the fixed
  dismissal feedback.
- Bridge races the pending promise against the run's abort signal: cancel
  during a pause resolves deny, the loop observes the abort at the next
  model call → `run_cancelled` exactly as today.

**Tests (this step's functionality):**

- Bridge: fake `runTaskFn` issuing an interactive call — event emitted,
  resolution round-trips, abort-during-pause ends `run_cancelled`.
- ink-testing-library: dialog render, option selection, free-text, Esc
  (30s timeouts per repo convention).
- One PTY-driven pass (per the repo's verification playbook): scripted
  human answers mid-run; frames captured and checked.

**Integration with previous work:** supplies what Step 2 left unwired; no
pipeline or tool changes. Eval/CLI paths untouched (still fail-closed).

**Demo:** in the TUI, a task that hits the fixture's login wall with no
stored credentials — the agent asks, the dialog pauses the run, you type
"done, logged in" after acting in the Chrome window, the agent reinspects
and finishes.

---

## Step 4: System prompt + X acceptance — the Elon Musk task unblocked

**Objective:** The model knows the auth playbook (lightly), and the real
task passes end-to-end with the test X account.

**Guidance:**

- Add the design's short **Authentication** section to
  `src/cli/systemPrompt.ts` (fill first, never `type` for credentials, ask
  on failure/ambiguity, reinspect after handoff). No detection heuristics,
  no site playbooks.
- Create the test X account; add it to `.credentials.json`.
- Run the Elon Musk task in the TUI. Exercise both fates: fresh profile
  (agent must log in, possibly hand off an X challenge) and warm profile
  (second run starts authenticated, auth never comes up).

**Tests (this step's functionality):**

- Prompt-inclusion unit test (section present; `type`-for-credentials
  prohibition worded as designed).
- The Step 1 secret-leak sweep re-run against a real X login run's artifacts.
- Manual acceptance checklist recorded in the run notes: wall recognized,
  two-step fill, challenge → handoff → resume (if X challenges), evidence
  collected, second-run persistence.

**Integration with previous work:** exercises every prior step in one flow —
store → fill (Step 1), ask fallback (Step 2), dialog pause/resume (Step 3).

**Demo:** the previously blocked task completes, and re-running it starts
already authenticated.
