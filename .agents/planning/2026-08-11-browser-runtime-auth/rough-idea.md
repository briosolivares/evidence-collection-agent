# Rough Idea

Design a new part of the evidence-collection-agent system: **browser runtime/auth**.

## As described by the user

We want to choose a browser runtime that lets the agent:

1. Reuse an authenticated browser identity across tasks.
2. Complete a normal login flow and SSO flows through the browser.
3. Handle or recognize MFA challenges.
4. Temporarily hand the browser session to a human if needed.
5. Resume execution afterwards.

### The flow in practice

Given a task that requires authentication:

- Check: do we already have a valid login state?
  - **Yes** → use the persistent login.
  - **No** → follow the login flow (regular login, SSO, or MFA).
    - If the agent can handle it, it continues.
    - If not, it hands off to a human; the human does what's needed, and the
      agent resumes afterwards.

### Candidate runtimes to look into

- "Our browser-based" (name to be confirmed — possibly the existing browser-based
  setup, or Browserbase)
- "EGOLite Browser" (name to be confirmed)
- Playwright with auth support

## Process note

We are following a PDD-like process, but not strictly. The user is taking more
of a lead and will prompt as we go, rather than the skill driving every step.
