# Idea Honing: Browser Runtime/Auth

Q&A log for requirements clarification. One question at a time; answers recorded
as decided.

## Q1: Which runtime candidates are on the list, exactly?

The candidate list looks dictated, so confirming names before researching:

- "Our browser-based" — does this mean (a) our existing browser-based setup
  (the local Chrome + persistent profile already in the repo), or (b)
  **Browserbase**, the cloud browser platform?
- "EGOLite Browser" — which product is this? (Not a name I recognize — could it
  be a transcription of something else?)
- "Playwright with auth support" — taken as Playwright with persistent
  context / storageState reuse.

**Answer:**

- **Browserbase** (the cloud browser platform).
- **EGO Lite** — https://lite.ego.app
- **Current Playwright setup, extended with auth support** (persistent
  context / storageState reuse on the existing local setup).

## Q2: What execution environment is this runtime choice for?

Is the runtime being chosen for (a) the current setup — agent runs locally on a
user's machine via the TUI, browser can open on their screen — or (b) a
future/hosted deployment where the agent runs server-side and the human isn't
at the machine the browser runs on? This drives everything about the handoff
mechanic (hand over the local window vs. share a live-view URL) and how login
state persists (local profile dir vs. cloud context).

**Answer:** **(a) local is the immediate target, (b) hosted is the eventual
design constraint.** The user queries the agent locally on their machine, but
the browser doesn't necessarily have to run there.

Refinement (user follow-up): the goal of this design phase is to **push the
browser agent's capabilities and discover its real failure modes in the current
local setup**. Scalability to thousands of samples remains an eventual
requirement, but do **not** assume that implies a hosted browser fleet, and do
not optimize around unobserved infrastructure bottlenecks yet. The constraint
is narrower: avoid unnecessarily coupling the core agent architecture to
local-only assumptions, so the option to move execution remote later stays
open.

Codebase note: the seam already exists — `BrowserSessionProvider.createSession()`
in `src/browser/sessionProvider.ts`, currently implemented only by the local
Playwright controller (`playwrightBrowserController.ts`).

## Q3: What's the credential model — is the agent ever allowed to type credentials itself?

When a login flow starts, does the agent have credentials it may fill on its
own (secrets store, env, config), or is anything secret always the human's
job? Middle ground offered: agent fills stored credentials for known sites,
MFA/unknown sites go to the human.

**Answer:** **The agent must never process raw credentials or passwords through
its context window.** Credentials live in an isolated credentials vault (or a
credentials broker) and are fetched securely only when needed. Implication: the
fill happens outside the model — a mechanism (e.g., a fill tool addressed by
site/account identifier) injects the secret directly into the browser, and the
model orchestrates without ever seeing secret values.

## Q4: Which login flows and sites are in scope for this phase?

Since the goal is to push the agent and find real failure modes: which
concrete targets are we designing against? E.g., plain username/password
sites, Google SSO ("Sign in with Google"), enterprise IdPs (Okta/Entra), and
which MFA types (TOTP codes, push approval, SMS/email codes, passkeys)? And
whose accounts — the user's real accounts, or dedicated test accounts?

**Answer:** **For now: plain username/password login, plus persisting the
authenticated browser identity across tasks.** SSO and MFA are not the current
implementation target.

Whose accounts (answered later, while research ran): **dedicated test accounts
created on the target sites** — not the user's real accounts. Blast radius of
an agent-driven login mistake is contained; the vault stores test-account
credentials.

## Q5: Where's the design boundary for SSO / MFA / human handoff?

"For now plain login" can mean two things for the design doc:

- (a) The design covers the full flow from the rough idea — detect login wall,
  attempt plain login, *recognize* SSO/MFA and fall back to human handoff +
  resume — but only plain login gets agent-automated now (handoff is the
  catch-all for everything else), or
- (b) This phase's design is strictly plain login + identity persistence, and
  SSO/MFA/handoff are out of scope entirely, left as named extension points.

**Answer:** **(a) — the design covers the full flow; human handoff is the
catch-all** for anything the agent can't automate (SSO, MFA, unknown flows).
Only plain login is agent-automated in this phase.

## Q6: What should human handoff look like concretely in the local setup?

The browser runs locally today. When the agent decides "human needed", what's
the experience? Straw proposal: the browser runs headed (visible window); the
TUI announces what's needed and why (e.g., "MFA challenge on site X — complete
it in the browser window"); the human acts directly in the same browser
window; then signals completion in the TUI (e.g., presses a key / types
`done`), and the agent verifies login state before resuming the task. Is that
the shape you want, or something else (e.g., agent auto-detects completion by
watching the page instead of an explicit human signal)?

**Answer:** **Headed browser with an explicit done signal, delivered as a
chat-like interactive experience.** The agent pauses and *asks* the human in
the conversation; the human replies in natural language that they've done it
(no hardcoded "done" keyword — the agent interprets the reply). Reference
point: the local Claude Code archive, for how it implements asking a follow-up
question / this kind of interactive pause-and-resume experience.

Located: the archive is `/Users/briosolivares/Desktop/Code/claude-code/`, with
the relevant implementation in `src/tools/AskUserQuestionTool/` (and the
permission-request UI components around it). Prior research on this archive
already exists at `docs/research/claude-code-harness.md` in this repo.

## Q7: Which vault/broker should hold the credentials?

Q3 decided credentials never pass through the model. Something still has to
store them and hand them to the fill mechanism. Candidates: macOS Keychain
(`security` CLI), 1Password CLI (`op`), an encrypted local file, plain
`.env`-style file outside the repo, or a custom broker process. Do you have a
preference/existing tool, or should the research phase evaluate options?

**Answer:** **Research the options and decide.** Note from the user: some of
the browser runtime options might already help with credential handling —
unsure, so the runtime research should check for built-in credential/secret
features that could subsume or simplify the vault choice.

## Q8 (user → design): How does this generalize to sites with no existing account?

Discussion outcome:

1. **Detection generalizes**: login walls are recognized by the model from the
   page (outline/screenshot), not via site-specific selectors — works on
   never-seen sites.
2. **Vault lookup is the branch point**: credentials for the origin → fetch &
   fill plain login; vault miss → the agent knows it can't self-serve.
3. **Vault miss routes to the handoff catch-all**: agent pauses and asks the
   human to log in or create an account in the headed browser. Persistent
   identity makes this a one-time cost per site; afterwards the site behaves
   like a known site (valid session → free; expired → auto re-login if
   credentials were added to the vault).
4. **Future extension — agent-driven signup**: agent drives the signup form,
   but password creation is vault-side (e.g., `generateCredentials(siteId)`
   mints, stores, and fills — model never sees the secret). Email verification
   (needs inbox access) and CAPTCHAs are the realistic blockers; both degrade
   gracefully to handoff.

## Research-plan addition (user)

**Scalability is an explicit evaluation constraint** for the runtime
comparison — alongside the five auth capabilities, evaluate each candidate on
concurrency limits, cost at volume, and how it would scale to a large number
of sessions (per Q2: without coupling the core architecture to local-only
assumptions).

## Q9: Final scope directive (user-led, post-research)

The story for auth, as decided by the user:

**Minimal authentication with human handoff.**

- The agent may complete **plain username/password login** itself.
- Otherwise, **human handoff**: the human completes login manually in the
  browser, signals resume to the agent, and the agent **reinspects the page**
  and continues.
- **Simple credential automation** — the model must never process raw
  credentials.
- Immediate goal: **unblock the one task that requires auth — the Elon Musk
  one** (X/Twitter). The user will create a **test X account** for this.

**Handing back to the human — two ways, the model chooses (no classifier
routing between them):**

1. **Free text** — the model just uses free text for open-ended/narrative asks.
2. **`AskUserQuestion` tool** — works like any other tool.

**Permission seam (Claude Code–style) in the tool pipeline:**

- Runs **after zod validation and before execute**.
- A tool opts in via something like `requiresUserInteraction`.
- The pipeline calls `ToolCtx.requestPermission(request)` →
  `allow(updatedInput) | deny(feedback)`, and **blocks until it resolves**.
- The TUI (runSession) wires that callback so a mid-run dialog can resolve the
  promise. **Headless/evals omit it and interactive tools fail closed.**
- The gate stays general, but only `ask_user_question` is marked as requiring
  interaction for now. Its `execute` just returns the allowed answers as the
  tool result so the existing tool_use loop continues.

**System prompt:** barely pushes the tool — mainly "use it if authentication
is unsuccessful or there's ambiguity."

## Q10: Vault decision (resolves Q7)

**Gitignored JSON credentials file for now**, read at fill time in the
executor layer (module scope, never `process.env`). Requirement: the code must
stay **extensible for a more complete auth system later** — keep a general
credentials interface (e.g., `CredentialStore`) so the file backend can be
swapped (1Password CLI, broker service) without touching call sites.

Runtime assumption confirmed alongside: current local Playwright behind the
existing `BrowserSessionProvider` seam; no Browserbase this phase (documented
future second implementation); EGO Lite dropped (no external CDP endpoint,
immature docs, would need a from-scratch controller).

