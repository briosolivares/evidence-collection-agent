# Browserbase Browser Runtime and Provider Plan

**Date:** 2026-08-14  
**Status:** Provider implemented. The old §6 secondary-client design was
superseded by v3's protected command bridge; the live smoke test and Google/X
acceptance run have not been executed. See [Implementation status](#implementation-status).
**Scope:** Sherlock TUI, interactive REPL, CLI evals, TUI evals, login/preflight commands, and browser-backed demos

## Goal

Add Browserbase as the production browser runtime so normal application and eval use no longer launches local Google Chrome or creates temporary local Chrome profiles. Preserve `BrowserController` as the browser-tool boundary, keep local Chrome as an explicit fallback and hermetic-test runtime, and support authenticated Google Sheets and X runs through Browserbase Contexts and Live View.

## Agreed decisions

- Use Browserbase for every production entry point.
- Keep local Chrome as an explicit fallback and for network-free browser tests.
- Read the existing API key from `BROWSERBASE_API_KEY`.
- Create a Browserbase Context because none exists yet.
- Persist Google Sheets and X authentication in that Context.
- Enable Browserbase session recording.
- Preserve ordinary `bash` workspace execution.
- Do not pass Browserbase's remote connection URL to model-generated code.
  Browser programs use a parent-owned, target-pinned command session instead.
- Do not run an eval re-baseline without separate user direction.

## Architectural fit

The repository already has the intended acquisition seam:

- `BrowserSessionProvider` creates a browser session without exposing where it is hosted.
- `PlaywrightBrowserController` implements the browser operations used by the tools.
- `runTask`, the worker loop, and browser tools depend on `BrowserController`, not on local Chrome launch details.

The Browserbase provider can therefore create a remote session, connect through Playwright's `chromium.connectOverCDP`, obtain the default `BrowserContext`, and return the existing controller. The tool registry, worker protocol, prompt prefix, output contracts, and artifact provenance model should not change.

Official references:

- [Browserbase Playwright quickstart](https://docs.browserbase.com/welcome/quickstarts/playwright)
- [Browserbase Contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)
- [Session Live View](https://docs.browserbase.com/platform/browser/observability/session-live-view)
- [Downloads](https://docs.browserbase.com/platform/browser/files/downloads)
- [Session lifecycle](https://docs.browserbase.com/platform/browser/getting-started/manage-browser-session)

## Configuration

Document and support:

```dotenv
SHERLOCK_BROWSER_PROVIDER=browserbase
BROWSERBASE_API_KEY=...
BROWSERBASE_CONTEXT_ID=... # created and saved by the login command
```

Provider selection must be explicit so merely possessing an API key cannot silently start billable remote sessions. Browserbase should be selected in the user's environment, while `SHERLOCK_BROWSER_PROVIDER=local` remains the fallback.

Recording is enabled in the Browserbase session-create configuration. Session timeout, region, proxy, and concurrency settings should have typed internal options; expose additional environment variables only where an operational need is demonstrated.

## Implementation sequence

### 1. Browserbase provider and remote lifecycle

- Add and pin `@browserbasehq/sdk`; continue using the existing `playwright` dependency.
- Add `src/browser/browserbaseBrowserSessionProvider.ts`.
- Validate `BROWSERBASE_API_KEY` before creating a session and report a provider-specific startup error without printing the key.
- Create a recorded Browserbase session and connect immediately through its CDP connection URL.
- Use Browserbase's default context and prepare its existing blank page consistently with local sessions.
- Refactor `PlaywrightBrowserController` to accept an injected session closer:
  - local sessions close their persistent `BrowserContext`;
  - Browserbase sessions close/disconnect the connected Playwright `Browser` and release any keep-alive session explicitly.
- Clean up a Browserbase session if creation succeeds but CDP connection or controller initialization fails.
- Add a provider-owned heartbeat at less than Browserbase's ten-minute CDP inactivity limit, and stop it during close.
- Keep session ID, Live View URL, and recording/inspector URL available to application runtimes without exposing the connection URL to the model, transcript, tools, or shell environment.
- Classify Browserbase disconnects as browser death so the existing TUI relaunch path starts a new session from the persisted Context.

### 2. Shared provider composition

- Add one environment-to-provider factory rather than duplicating selection logic in entry points.
- Wire it into:
  - `src/tui/main.tsx`;
  - `src/cli/repl.ts`;
  - `evals/runners/cli.ts`;
  - `src/tui/bridge/evalRuntime.ts`;
  - the login/preflight flow;
  - browser-backed demos.
- Replace Chrome-specific startup messages with provider-neutral messages while retaining actionable local-Chrome fallback errors.
- Surface Browserbase session and Live View links in the TUI/CLI for observation and human takeover.
- Add REPL recovery after a remote session dies or times out, matching the TUI's existing next-run relaunch behavior.

### 3. Provider-neutral eval runtime

- Refactor `evals/runners/browserRuntime.ts` so its core policy owns browser leases rather than local-profile directories.
- Browserbase normal lane:
  - create one fresh, context-free session per trial;
  - close it after the trial;
  - preserve current bounded concurrency.
- Browserbase authenticated/headed lane:
  - use the configured persistent Context;
  - serialize trials;
  - avoid simultaneous sessions against the same Context;
  - reuse one live session where practical, matching the current headed-lane policy.
- Retain temporary-profile allocation, cleanup, and stale-profile reaping only inside the local provider adapter.
- Add bounded retry/backoff for Browserbase HTTP 429s and transient session/CDP failures, honoring `Retry-After` when present.
- Do not infer browser policy from task names or task text; continue honoring `task.json`'s `headed` and `requiresLogin` fields.

### 4. Browserbase Context and login workflow

Make `npm run login` provider-aware:

1. Load the same `.env` resolution used by the selected application runtime.
2. When `BROWSERBASE_CONTEXT_ID` is absent, call the Contexts API to create one.
3. Save only the returned Context ID to the active `.env` through a narrow, permission-preserving configuration update.
4. Start a recorded Browserbase session with that Context and `persist: true`.
5. Fetch and display/open its Live View URL.
6. Let the operator sign into Google Sheets and X manually; credentials are never typed by the agent.
7. After confirmation, close the session so Browserbase persists the Context.
8. Wait for Context synchronization, start a second session using the same Context, and run the existing behavioral login probes.
9. Exit successfully only when every requested login verifies.

Refactor the eval login preflight to probe the selected provider and the exact Context that authenticated trials will use. Update failure text to direct Browserbase users to the same `npm run login` command.

Google or X may still reject a cloud-browser login because Context persistence does not guarantee that the target accepts Browserbase's IP or fingerprint. Treat this as a POC acceptance check. Keep proxy/region configuration optional until the behavior is measured against the user's plan and accounts.

### 5. Browserbase download adapter

Browserbase stores browser downloads remotely, so the local `Download.createReadStream()` path cannot be assumed to work.

- Configure `Browser.setDownloadBehavior` through CDP with:

```json
{
  "behavior": "allow",
  "downloadPath": "downloads",
  "eventsEnabled": true
}
```

- Introduce a download-reader strategy beneath `PlaywrightBrowserController`:
  - local reader: retain the existing Playwright stream implementation;
  - Browserbase reader: correlate the download event with the session's Downloads API, poll with a finite deadline, retrieve the bytes, and return the existing `BrowserDownloadResult` shape.
- Verify Browserbase's checksum against the retrieved bytes before returning them.
- Continue routing the returned bytes through the existing download tool and `writeArtifact`; Browserbase is not the evidence system of record.
- Track retrieved remote download IDs and delete them during successful session cleanup after the local artifact has been written.
- Preserve current direct-navigation response capture where it already returns bytes without a browser download.

### 6. Protected browser-program bridge (v3 resolution)

Ordinary `bash` remains browser-free and runs only in
`scratch/workspace/`. The retired design would have given a second Playwright
client a loopback relay; v3 instead gives the bounded `browser_execute` child a
parent-owned helper. The controller opens one target-pinned CDP command session
and sends/receives bounded messages over protected IPC. The Browserbase
connection URL and API key never enter the child environment, tool result,
transcript, artifact, or error.

This is the same provider-neutral boundary used by local Chrome. Closing the
command session detaches only that target session; the provider owner still
controls and explicitly releases the Browserbase session.

### 7. Secret handling and observability

- Add `BROWSERBASE_API_KEY` to `BASH_SECRET_ENV_DENYLIST` in `src/cli/localExecution.ts`.
- Treat Browserbase CDP and Live View URLs as sensitive operational data:
  - Live View may be shown only to the local user interface;
  - CDP connection URLs must never appear in logs, model-visible tool results, transcripts, run artifacts, or thrown error messages.
- Record safe correlation fields such as provider and Browserbase session ID in runtime diagnostics without making the vendor ID the run's primary identity.
- Keep the run directory, manifest hashes, and requested-output roles authoritative; Browserbase recordings complement rather than replace local provenance.
- Ensure every normal shutdown and partial-failure path ends the billable remote session.

### 8. Tests and verification

Keep `npm test` hermetic and network-free. Add:

- provider unit tests with injected/fake Browserbase SDK and CDP connectors;
- controller close-hook and idempotent-cleanup tests;
- session-creation partial-failure cleanup tests;
- provider configuration and missing-key tests;
- eval policy tests for fresh normal sessions and serialized authenticated Context use;
- retry/rate-limit tests with finite clocks;
- Context provisioning and `.env` update tests that never use a real key;
- login verification tests across the close/persist/reopen boundary;
- download polling, correlation, checksum, timeout, and cleanup tests;
- secret-redaction tests proving the API key and CDP URL never reach the worker shell or model-visible results;
- target-pinned command-session and child-environment redaction tests.

Add a separately invoked live smoke test using `.env`, never part of `npm test`, covering:

1. session creation and recording;
2. new tab, navigation, observation, actions, and page lifecycle;
3. screenshot capture;
4. upload from a confined run path;
5. PDF rendering;
6. direct-response and browser-event downloads;
7. clean shutdown with no active Browserbase session left behind;
8. Context persistence in a synthetic login fixture;
9. a manual Google Sheets and X login verification run.

Run the regular test suite and typecheck after each implementation slice. Do not run the real eval suite or establish a new baseline without explicit user direction.

## Acceptance criteria

- Sherlock, the REPL, CLI evals, TUI evals, login/preflight, and browser-backed demos all select Browserbase when configured.
- No production Browserbase run launches local Chrome or creates a Chrome profile directory.
- A login command creates and saves a Browserbase Context when none exists.
- Google Sheets and X logins survive closing one Browserbase session and opening another with the same Context.
- Authenticated eval preflight checks the same Context used by the authenticated lane.
- Normal eval trials receive isolated Browserbase sessions; authenticated trials remain serialized.
- Every Browserbase session is recorded and exposes a user-facing inspector/Live View link without exposing its CDP URL.
- Navigation, observation, actions, screenshots, uploads, PDFs, and downloads preserve the existing controller/tool result contracts.
- Downloaded bytes are copied into the local provenance boundary and checksum-verified.
- Every session is closed or explicitly released on success, failure, cancellation, and partial initialization.
- `BROWSERBASE_API_KEY` and CDP connection URLs never appear in worker environments, transcripts, model-visible results, or artifacts.
- Ordinary `bash` workspace commands remain functional and browser-free;
  `browser_execute` uses the protected parent command bridge without receiving
  remote credentials.
- Local Chrome remains available through explicit provider configuration, and the normal test suite remains hermetic.

## Remaining operational input

Confirm the user's Browserbase plan before changing concurrency or `keepAlive`
defaults. The plan tier affects concurrent-session limits and session lifetime;
it does not block the provider, recording, Context creation, Live View login,
or ordinary Browserbase sessions.

---

## Implementation status

Written after the fact. This section is the honest record of what the code does, not a restatement of intent.

### What was built

| Plan section | Where it landed |
| --- | --- |
| §1 provider and remote lifecycle | `src/browser/browserbaseBrowserSessionProvider.ts`; injected session closer, download reader, and upload encoder on `PlaywrightBrowserController` (now an options object, `PlaywrightBrowserControllerOptions`) |
| §2 shared composition | `src/browser/provider.ts`, wired into `src/tui/main.tsx`, `src/cli/repl.ts`, `evals/runners/cli.ts`, `src/tui/bridge/evalRuntime.ts` (via the eval runtime), the login flow, and `demos/10–12` |
| §3 provider-neutral eval runtime | `evals/runners/browserRuntime.ts`, split into a provider-independent lane policy plus `createLocalEvalBrowserAdapter` / `createBrowserbaseEvalBrowserAdapter` behind an `EvalBrowserAdapter` seam |
| §4 Context and login workflow | `src/cli/browserbaseLogin.ts`, `src/cli/envFile.ts`, provider-aware `src/cli/login.ts`, provider-neutral `src/cli/loginCheck.ts`, provider-aware `evals/runners/loginPreflight.ts` |
| §5 download adapter | `src/browser/downloadReader.ts`, `src/browser/browserbaseDownloads.ts` |
| §6 browser-program execution | Superseded by v3: `browser_execute` uses target-pinned controller command sessions and protected IPC; `bash` remains browser-free. |
| §7 secrets and observability | `BROWSERBASE_API_KEY` added to `BASH_SECRET_ENV_DENYLIST`; `BrowserSessionDiagnostics` carries session id / Live View / recording URL and structurally cannot carry a connection URL |
| §8 tests | ~160 new hermetic tests across the provider, retry, downloads, composition, controller hooks, env-file, login, and both eval lanes; plus `npm run smoke:browserbase` (`scripts/browserbaseSmoke.ts`), which is never part of `npm test` |

### Deviations from the plan, and why

- **Uploads needed a fix the plan did not anticipate.** Playwright's `setInputFiles` decides whether to send a path or bytes from whether its own *driver* is remote. Under `connectOverCDP` the driver is local and only the browser is remote, so Playwright would hand a container a path from this filesystem. `src/browser/uploadEncoder.ts` adds a per-provider encoder; the remote one sends bytes. Confinement is unchanged — `resolveRunPath` still runs first.
- **Downloads use the per-file Downloads API, not the SDK.** `sessions.downloads.list` in the pinned SDK is the older whole-session-archive endpoint. `GET /v1/downloads?sessionId=` and `GET /v1/downloads/{id}` return one file each *with a SHA-256 checksum*, which is what makes verification possible, so those are called with plain injectable `fetch`.
- **A missing checksum is treated as a failure.** The plan said verify; it did not say what to do when Browserbase reports no checksum. Returning unverified bytes under a promise of verification is the worse outcome, so it throws. If a live run shows the field is sometimes legitimately absent, this is the first thing to revisit.
- **Remote download ids are tracked but not deleted.** `retrievedIds()` records them, but the API surface exposes no delete for a single download, so there is nothing to call. The plan's "delete during cleanup" step is unimplementable as written rather than skipped.
- **`REQUEST_RELEASE` is issued on every close, not only with `keepAlive`.** It is the only step that makes "no session outlives its run" true independently of how the disconnect went and of the plan tier. It is tolerant of failure, since an already-completed session rejects it.
- **`keepAlive` is off by default.** It needs a Hobby-or-above plan and lets a session bill past the run that owned it. It is a typed option, not an environment variable, pending the plan-tier answer.
- **The authenticated eval lane does NOT persist to the Context** (`persist: false`). It reads the operator's logins and cannot write over them, so a trial that gets signed out degrades that trial instead of destroying the Context every later batch depends on. This is deliberately *better* than the local persistent profile's behavior, not a copy of it.
- **Interactive runtimes use the Context when one exists and start signed out when it does not** (`context: 'optional'`); the authenticated eval lane and the login preflight *require* it (`context: 'required'`). A hard requirement everywhere would lock a user out of browsing public pages before they had ever run `npm run login`.
- **`npm run login -- --manual` has no remote analogue** and says so. Live View is already a human in a real browser tab, so the automation objection `--manual` exists to work around does not arise.
- **Browser-death classification gained disconnect phrases** (`has been disconnected`, `Connection closed`) so a timed-out remote session routes into the existing relaunch path. Bare transport errors (`socket hang up`, `ECONNRESET`) are deliberately still *not* browser death — they come from page networks and the model API far more often, and an existing test pins that.
- **The REPL gained recovery** it never had, because a local Chrome rarely dies mid-session and a remote one has timeouts and inactivity limits.
- **No environment variables beyond the three documented ones.** Timeout, region, proxies, and `keepAlive` are typed internal options only, per the plan's instruction to expose more only on demonstrated need.

### Not verified

- `npm run smoke:browserbase` has **not been run**. Everything about the remote provider is currently pinned only by fakes: whether a remote Chrome honors `Browser.setDownloadBehavior` as configured, whether the Downloads API correlates as assumed, whether a byte-encoded upload arrives, and whether a Context persists a cookie across a session boundary are all open until it runs.
- The **Google Sheets and X acceptance run** has not been attempted. Whether those services accept a Browserbase IP and fingerprint is the POC's real open question, and no proxy or region configuration has been chosen because nothing has been measured yet.
- **No eval re-baseline was run**, per the agreed decision.
