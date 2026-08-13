# Browser Runtime Candidates for Authenticated Browsing

Research date: 2026-08-12. Scope: three candidate runtimes for the evidence-collection agent's
authenticated browsing needs, evaluated against criteria a–h (defined in the comparison table).
No recommendation is made here; observations only.

Existing seam this must slot behind:
`BrowserSessionProvider.createSession(): Promise<BrowserController>`
(`src/browser/sessionProvider.ts`), currently implemented by
`LocalChromeBrowserSessionProvider` in `src/browser/playwrightBrowserController.ts`, which calls
`chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: false })` against
`chrome-profile/` at the repo root and wraps the resulting `BrowserContext` in
`PlaywrightBrowserController`.

---

## 1. Browserbase (cloud browser platform)

Cloud-hosted Chromium sessions you drive with Playwright over CDP:

```ts
const session = await bb.sessions.create();
const browser = await chromium.connectOverCDP(session.connectUrl);
const context = browser.contexts()[0];
const page = context.pages()[0];
```

Source: [Playwright quickstart](https://docs.browserbase.com/quickstart/playwright).

### Contexts (persisted auth)

- A **Context** persists the Chromium user data directory between sessions. Create once
  (`bb.contexts.create({name})` returns an ID), then attach to any session with
  `browserSettings: { context: { id, persist: true } }`. With `persist: false` the session reads
  the context but doesn't write back.
- Persisted: cookies, localStorage, IndexedDB, session storage, service workers (and their
  caches), form autofill data, site permissions/HSTS. **Not** persisted: browser HTTP cache.
- Contexts persist indefinitely until explicitly deleted (deletion is irreversible). Website-side
  invalidation still applies (password changes, server-side logout, token revocation).
- Documented caveats: wait a few seconds after closing a session before reusing its context
  (sync); **avoid simultaneous sessions logging in on the same context**; keep consistent
  geolocation; one context per site/login combination is the recommended practice — a
  multi-site "one identity" context is possible but runs against their best-practice guidance.

Source: [Contexts docs](https://docs.browserbase.com/features/contexts).

```mermaid
sequenceDiagram
    participant Agent as Agent (local TS)
    participant BB as Browserbase API
    participant CB as Cloud Browser
    participant H as Human (Live View)

    Agent->>BB: contexts.create() → contextId (once)
    Agent->>BB: sessions.create({context:{id, persist:true}})
    BB->>CB: boot Chromium with context's user-data-dir
    Agent->>CB: chromium.connectOverCDP(connectUrl)
    Note over Agent,CB: task runs; hits login/MFA wall
    Agent->>BB: sessions.debug(id) → debuggerFullscreenUrl
    Agent->>H: show/open Live View URL
    H->>CB: click, type, complete login/MFA
    Note over Agent,CB: same CDP connection still live
    Agent->>CB: resume automation on same page
    Agent->>CB: browser.close() / session ends
    CB->>BB: user-data-dir written back to Context
    Note over BB: wait a few seconds before next session reuses the Context
```

### Live View / human handoff

- `bb.sessions.debug(session.id)` returns `debuggerFullscreenUrl` — a URL a human opens in any
  browser to see and **fully interact** with the live session (click, type, scroll, file upload,
  iframes). Explicitly positioned for human-in-the-loop, including "delegating credentials by
  giving end-user control" (the human types the password; the agent code never handles it).
- Embeddable as an iframe, interactive or read-only (`pointer-events: none`); per-tab URLs via a
  `pages` property; `navbar=false` styling; a `browserbase-disconnected` message event signals
  session end.
- Resume: the session and the agent's CDP connection stay alive during human control; the script
  just continues when the human is done. For a TUI, "handoff" = print/open the URL, then poll for
  a post-login condition.

Source: [Session Live View docs](https://docs.browserbase.com/features/session-live-view).

### Secrets / credential handling

- No native vault today. There is a documented **1Password integration** — an integration
  pattern using the 1Password SDK with a Service Account: credentials live in the vault, are
  fetched at runtime, and are injected by your own code (so your process does momentarily hold
  the plaintext). Docs note improved "native support" is coming (unverified timeline).
- The other documented pattern is Live View credential delegation (human types it).

Source: [1Password integration](https://docs.browserbase.com/integrations/1password/introduction).

### Stealth / bot-detection posture

- **Verified sessions**: purpose-built Chromium with real fingerprints recognized by bot-protection
  partners — **Scale plan only**. Auto CAPTCHA-solving for supported challenges. **Web Bot Auth**
  (Cloudflare Signed Agents, cryptographic agent identity) in beta, request access. Residential/
  datacenter proxies on paid plans.
- Whether Google login specifically succeeds from a Browserbase session is **unverified**; Google's
  "This browser or app may not be secure" wall targets automation signals generally (see candidate 3),
  and a datacenter-hosted browser adds IP-reputation risk that proxies only partially offset. The
  safest documented pattern is: human completes the login once via Live View into a persisted
  Context, and no automated code ever touches the login page.

Source: [Stealth/Agent Identity docs](https://docs.browserbase.com/features/stealth-mode).

### MFA

No built-in MFA solving is documented. Recognizing an MFA wall is the agent's job (page
inspection); handling it is the Live View handoff. A persisted Context reduces how often MFA is
triggered at all. TOTP could be automated in your own code, but that's not a Browserbase feature.

### Pricing / concurrency / limits (as of the current plans page, Aug 2026)

| Plan | Price | Concurrent browsers | Included browser hrs | Overage | Max session | Proxy GB | Retention | Sessions/min |
|---|---|---|---|---|---|---|---|---|
| Free | $0 | 3 | 1 | — | 15 min | 0 | 7 days | 5 |
| Developer | $20/mo | 25 | 100 | $0.12/hr | 6 hr | 1 ($12/GB over) | 7 days | 25 |
| Startup | $99/mo | 100 | 500 | $0.10/hr | 6 hr | 5 ($10/GB over) | 30 days | 50 |
| Scale | custom | 250+ | flexible | custom | 6+ hr | usage-based | 30+ days | 150+ |

- `keepAlive: true` (paid plans) lets you disconnect and reconnect to the same session; sessions
  otherwise end on disconnect. Hard cap of 6 hours per session on standard plans. Keep-alive
  sessions bill browser minutes until explicitly stopped.
- Rough cost intuition: at Startup overage rates, 1,000 task-hours/month ≈ $99 + 500×$0.10 = $149.

Sources: [Plans](https://docs.browserbase.com/account/billing/plans),
[Long-running sessions](https://docs.browserbase.com/guides/long-running-sessions).

### Fit with the `BrowserSessionProvider` seam

Very natural at the type level: a `BrowserbaseSessionProvider.createSession()` would create a
session (with a Context ID), `connectOverCDP`, take `browser.contexts()[0]`, and hand it to the
**existing** `PlaywrightBrowserController` unchanged — the controller only needs a
`BrowserContext`. Real integration caveats found in the current controller code:

- `download()` relies on Playwright download events/streams. On Browserbase you must call
  `Browser.setDownloadBehavior` over CDP with `downloadPath: "downloads"` (exactly), and files
  land in Browserbase cloud storage, retrieved afterward via their
  [Downloads API](https://docs.browserbase.com/features/downloads) (with retry for large files).
  Whether `download.createReadStream()` works transparently over their CDP is **unverified** —
  needs a spike; worst case the download path needs a Browserbase-specific branch.
- `fetch()` uses `context.request` (Playwright's `APIRequestContext`), which issues HTTP from the
  **local Node process**, not from the remote browser — cookies come from the remote context but
  egress IP/fingerprint would be the local machine's, not the Browserbase session's
  (moderately confident; verify in a spike).
- `prepareSessionPage` / single-tab discipline should carry over unchanged.

---

## 2. EGO Lite (`ego (lite)`, Citro Labs)

### What it is

A free, MIT-licensed, Chromium-based **desktop browser for macOS** (Apple Silicon + Intel;
Windows waitlist) built specifically so AI agents (Claude Code, Codex, Cursor, any shell-capable
agent) can drive a browser that shares the user's logged-in state — while the human keeps using
it. Made by Citro Labs. Repo: [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite)
(~9.6k stars, 245 commits, MIT, active Discord/Discussions). Site: [lite.ego.app](https://lite.ego.app);
docs: [lite.ego.app/document/](https://lite.ego.app/document/).

**Maturity: very new.** The visible releases page shows v1.2.0 → v1.2.3 all dated 2026-08-11
(release cadence of multiple versions per day); coverage is mostly 2026 launch-cycle press. Exact
first-release date unverified. Star count is strong but the docs are thin on operational detail
(no concurrency limits, no formal API reference beyond the skill/tool list, "experience
accumulation" marked coming-soon). Treat operational claims (e.g., "3.45x faster") as vendor
benchmarks.

### Auth / session model

- One-click import of an existing Chrome setup: cookies, login sessions, passwords, extensions,
  bookmarks. The user stays logged in; agents inherit that authenticated state. All data stays
  local (explicitly no upload).
- **Spaces**: isolated workspaces (described as isolated BrowserContexts inside the same Chromium
  process) so agents work in parallel without touching the human's tabs or mouse. One source
  describes a Space as having "its own cookies and storage," which superficially conflicts with
  the shared-login pitch — the exact cookie-sharing semantics between the main profile and Spaces
  are **not clearly documented; verify hands-on**.

### API / integration surface

- The **ego-browser skill** (`npx skills add citrolabs/ego-lite`) is the integration: the agent
  writes JavaScript snippets against a `globalThis.ego` runtime and dispatches them via heredoc —
  `ego-browser nodejs <<'EOF' ... EOF`. Tools: snapshot, fill, click, wait, navigate, capture,
  uploads/downloads, tabs, `taskSpaces.useOrCreate(...)`; element refs via `@eN` markers, CSS,
  XPath, ARIA. Snapshots are built into the custom Chromium engine (claimed ~200–400 tokens/page,
  handles cross-origin iframes/shadow DOM).
- "Raw CDP access" is mentioned as available **inside** the ego runtime; **no external CDP
  endpoint for `chromium.connectOverCDP` is documented** — Playwright compatibility is
  effectively absent/unverified. This is a CLI/skill-shaped product, not a Playwright target.

Sources: [repo](https://github.com/citrolabs/ego-lite),
[ego-browser package](https://github.com/citrolabs/ego-lite/tree/main/package/ego-browser),
[docs](https://lite.ego.app/document/), [releases](https://github.com/citrolabs/ego-lite/releases).

### Handoff / MFA / logins

This is EGO Lite's strongest axis: it *is* the user's local headed browser. Docs describe agents
pulling the human in "only when it needs you to log in, verify something, or check a result" —
the user clicks into the agent's Space, does the login/MFA/payment step, and the agent continues.
Login flows happen in a real daily-driver browser with the user present, so bot-detection risk on
the login itself is minimal (though it's a custom Chromium build — whether Google treats it as a
recognized browser is unverified).

### Scalability / secrets

- Local-only: concurrency = Spaces within one process on one Mac; no cloud fleet, no per-session
  pricing (it's free). Batch scale is bounded by the machine.
- Imports Chrome's password manager (stored locally), so autofill can cover many logins without a
  separate vault — but there is **no documented programmatic secrets API**.

### Fit with the `BrowserSessionProvider` seam

Poor-to-moderate, and the most work of the three. The seam's contract
(`createSession(): Promise<BrowserController>`) is engine-neutral, so an `EgoBrowserController`
is *conceivable* — but it would be a full reimplementation of the controller surface
(`outline`, `click`, `type`, `download`, `fetch`, aria-ref semantics...) by shelling out heredoc
scripts to `ego-browser`, mapping ego's `@eN` refs to the repo's `e\d+` aria-ref convention, and
reimplementing download/fetch byte capture. None of the existing Playwright controller is
reusable. Alternatively, if ego ever exposes an external CDP endpoint, Playwright could attach —
unverified and undocumented today.

---

## 3. Playwright on the current local setup

### Current state

`LocalChromeBrowserSessionProvider` launches real Chrome (`channel: 'chrome'`, headed by default)
via `launchPersistentContext` on a dedicated profile dir (`chrome-profile/`). This already gives
full user-data-dir persistence: cookies, localStorage, IndexedDB, service workers, HSTS,
extensions state — everything Chrome itself persists. Log in once (manually, in the headed
window), and every later `createSession()` reopens the same identity across all sites.

### Persistent context vs storageState

Two auth-persistence mechanisms ([playwright.dev/docs/auth](https://playwright.dev/docs/auth)):

| | Persistent context (current) | storageState save/restore |
|---|---|---|
| What persists | Entire user data dir | Cookies, localStorage, IndexedDB (per docs; the docs also mention WebAuthn state — treat that as needs-verification). **Not** sessionStorage (workaround: `addInitScript`). |
| Granularity | One dir = one identity | JSON file per identity/role; `test.use`-style multi-role |
| Concurrency | **One browser process per profile dir** — Chromium's ProcessSingleton lock forbids concurrent access; unclean shutdown can leave a stale `SingletonLock` blocking relaunch (and, per one report, corrupt profile databases) | N ephemeral contexts can each load the same JSON concurrently |
| Freshness | Live — always current | Snapshot — goes stale as tokens rotate |

A useful hybrid: keep `chrome-profile/` as the identity of record, and call
`context.storageState()` on it to stamp out ephemeral concurrent contexts sharing the login
(writes in those clones don't merge back; some sites bind sessions to IP/fingerprint and may
invalidate cloned sessions — site-dependent).

Multi-profile: nothing stops multiple profile dirs (`chrome-profile-a/`, `-b/`), each a separate
identity with its own singleton lock; auth does not follow between them automatically.

Sources: [Playwright auth docs](https://playwright.dev/docs/auth),
[playwright#19499 (SingletonLock)](https://github.com/microsoft/playwright/issues/19499),
[playwright#35466 (profile lock/corruption)](https://github.com/microsoft/playwright/issues/35466),
[claude-code#24144 (one instance per profile, Windows)](https://github.com/anthropics/claude-code/issues/24144).

### Login flows and bot-blocking

- Google is the canonical hazard: automated logins hit "This browser or app may not be secure,"
  and this can fire even in headed real Chrome when automation signals are present
  ([playwright#19420](https://github.com/microsoft/playwright/issues/19420),
  [playwright#31212](https://github.com/microsoft/playwright/issues/31212)).
- The consensus workaround is exactly what this setup already enables: **the human performs the
  login manually in the headed window once**, the profile keeps the session, and automated code
  never touches the Google login page
  ([Autonoma write-up](https://getautonoma.com/blog/how-to-test-google-oauth-login),
  [Adequatica on Medium](https://adequatica.medium.com/google-authentication-with-playwright-8233b207b71a)).
- Headed real-Chrome (`channel: 'chrome'`) is the most human-looking configuration Playwright
  offers; headless (even Chrome's new headless) is more detectable. Playwright's own docs don't
  address bot-detection evasion.

### MFA / handoff / resume

- Handoff is trivially natural: the browser is a headed window on the user's Mac. Agent pauses,
  TUI tells the user "complete the login in the Chrome window," user does password + MFA
  (push/TOTP; platform passkeys via Touch ID in a Playwright-launched Chrome are **unverified**),
  agent resumes on the same `Page`/`BrowserContext` — no reconnect, no URL plumbing.
- Recognizing MFA walls is agent logic (outline/screenshot inspection) in all three candidates.
- One repo-specific caveat: the controller enforces a single active task tab and assumes it owns
  the page; a human clicking around during handoff can change URL/DOM state under the agent, so a
  post-handoff resync (re-outline, re-verify URL) is advisable.

### Scalability / secrets / seam

- Scalability is the weak axis: one Mac, one browser per profile dir, no concurrent reuse of the
  authenticated profile (except the storageState-cloning hybrid above). Cost is $0; memory is
  roughly hundreds of MB per Chrome instance (unmeasured here).
- No secret handling: Chrome's password manager lives in the profile and can autofill in headed
  use, but Playwright has no API to query it; a programmatic vault remains a separate concern.
- Seam fit: it *is* the seam's current implementation. Zero work.

---

## Comparison table

| Criterion | Browserbase | EGO Lite | Local Playwright (current) |
|---|---|---|---|
| **a. Reusable authenticated identity** | Good: Contexts persist user-data-dir indefinitely; multi-site possible but best practice is one context per site/login; sync delay between sessions | Good on paper: inherits the user's real Chrome state, one-click import, always-fresh (it's the daily browser); Space↔profile cookie semantics under-documented | Good: full user-data-dir persistence in `chrome-profile/`, multi-site, always live; already working |
| **b. Normal login & SSO flows** | Automated logins face standard bot walls; CAPTCHA solving on paid, Verified sessions Scale-only, Web Bot Auth beta; datacenter IP risk (proxies mitigate); Google success unverified | Best posture: human does logins in a real local daily-driver browser; custom-Chromium recognition by Google unverified | Human-in-headed-window login works and is the documented best practice; *automated* Google login is blocked/fragile |
| **c. MFA handling** | No built-in; recognize via page inspection, resolve via Live View human takeover; persisted Context reduces recurrence | Human is co-located with the browser; designed to "pull you in" for verification steps | User completes MFA in the local headed window; passkey/Touch-ID support unverified |
| **d. Human handoff mechanism** | Live View URL (`sessions.debug` → `debuggerFullscreenUrl`), fully interactive, embeddable, per-tab; works for a remote/headless-host human too | Local: user clicks into the agent's Space in the ego window | Local headed Chrome window; TUI just prompts the user |
| **e. Resume after handoff** | Session + CDP connection stay live; script continues; poll for post-login state | Agent continues in the Space after user steps back | Same Page/context, no reconnect; should resync state post-handoff |
| **f. Scalability** | Strongest: 3/25/100/250+ concurrent by plan; $20–$99/mo + $0.10–0.12/hr overage; 6 hr session cap; keepAlive on paid; session-creation rate limits 5–150+/min | Weak for batches: one Mac, Spaces in one process, no fleet; free | Weakest for concurrency: one browser per profile dir (singleton lock); parallel = extra profiles or storageState clones; free |
| **g. Built-in credential/secret handling** | 1Password integration (SDK pattern, your code holds plaintext briefly; "native support coming" unverified); Live View credential delegation keeps secrets out of code entirely | Local Chrome password import + autofill; no programmatic secrets API documented | None; Chrome password manager not API-accessible; separate vault still needed |
| **h. Fit behind `BrowserSessionProvider`** | Very natural: `createSession` → sessions.create + `connectOverCDP` → reuse existing `PlaywrightBrowserController`; caveats: `download()` needs `Browser.setDownloadBehavior` + Downloads-API branch (unverified), `fetch()` egresses from local Node not the cloud browser (verify) | Poor today: no documented external CDP endpoint; would require a from-scratch `EgoBrowserController` shelling heredoc JS to the ego-browser CLI and re-mapping ref semantics | Perfect: it is the current implementation |

---

## Observations

- The three candidates barely overlap: Browserbase buys **scale and remote handoff URLs**,
  EGO Lite buys **the user's real logged-in browser with co-located human help**, and the current
  local setup already delivers the single-user auth story at zero cost. The decision is mostly
  about which axis (f vs b/c/d) matters more for evidence-collection workloads.
- Browserbase's Playwright-over-CDP model means the existing `PlaywrightBrowserController` is
  reusable nearly verbatim — the cheapest *second* provider to add — but the two non-page code
  paths in the controller (`download()`, `fetch()`) are exactly where remote CDP semantics
  diverge from local, and both need a spike before trusting the "drop-in" story.
- No candidate automates MFA or hardened logins; all three converge on the same pattern —
  a human completes login/MFA once, persistence machinery (Context / profile / imported state)
  carries it forward. The differentiator is only *how* the human gets into the loop (URL vs
  local window) and how durable the persistence is.
- Browserbase's "avoid simultaneous logins on one Context" guidance means its concurrency
  headline doesn't straightforwardly compose with a *single* shared identity: 100 concurrent
  sessions writing to one persisted Context is off the documented happy path (read-only
  `persist: false` fan-out over one logged-in Context looks like the sanctioned shape; unverified
  at scale).
- EGO Lite is genuinely interesting but young: launched in 2026, macOS-only, multiple releases
  per day, thin operational docs, and an agent interface (heredoc JS via a skill) that is
  orthogonal to Playwright. Integration cost is a full controller reimplementation unless/until
  it documents an external CDP endpoint.
- Local Playwright's hard ceiling is the ProcessSingleton lock: one live browser per profile dir,
  so "many sessions, one identity" requires the storageState-cloning hybrid, whose reliability is
  site-dependent (session-to-IP/fingerprint binding) and unverified for the target sites.

## Sources

**Browserbase**
- https://docs.browserbase.com/features/contexts
- https://docs.browserbase.com/features/session-live-view
- https://docs.browserbase.com/account/billing/plans
- https://docs.browserbase.com/quickstart/playwright
- https://docs.browserbase.com/guides/long-running-sessions
- https://docs.browserbase.com/features/stealth-mode
- https://docs.browserbase.com/features/downloads
- https://docs.browserbase.com/integrations/1password/introduction

**EGO Lite**
- https://lite.ego.app/
- https://lite.ego.app/document/
- https://github.com/citrolabs/ego-lite
- https://github.com/citrolabs/ego-lite/tree/main/package/ego-browser
- https://github.com/citrolabs/ego-lite/releases
- https://tessl.io/registry/skills/github/citrolabs/ego-lite/ego-browser/evals

**Playwright / local**
- https://playwright.dev/docs/auth
- https://github.com/microsoft/playwright/issues/19420
- https://github.com/microsoft/playwright/issues/31212
- https://github.com/microsoft/playwright/issues/19499
- https://github.com/microsoft/playwright/issues/35466
- https://github.com/anthropics/claude-code/issues/24144
- https://getautonoma.com/blog/how-to-test-google-oauth-login
- https://adequatica.medium.com/google-authentication-with-playwright-8233b207b71a
