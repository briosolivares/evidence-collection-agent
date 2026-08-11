# Lab notebook

Casual notes from reviewing runs and thinking about fixes or improvements. These are working ideas, not final design decisions unless explicitly noted.

## 2026-08-10 — Checkpoint 1 baseline review

### Output contracts and schemas

The general instruction to avoid adding unrequested structure is probably helpful. However, task queries currently provide only natural-language output requirements, not formal output schemas.

A better long-term improvement may be a separate initializer or planner agent that turns the task into an explicit output contract before execution. That contract could define the deliverables, exact schemas, evidence requirements, and completion checks. It should distinguish requirements stated by the user from assumptions inferred by the planner so it does not silently invent constraints.

Decision on 2026-08-11: implement the short-term exact-output instruction now. Keep the initializer/planner idea as a longer-term improvement; do not implement it in this round.

### Browser-native downloads

The download tool should be able to obtain files through Chrome's actual network path. Sharing browser cookies with a separate HTTP client is not equivalent, and hardened sites may reject the separate client even while the document loads normally in Chrome.

The likely direction is to make browser-native downloading the default for accuracy: capture an in-page fetch, navigation response, or browser download event and save the exact bytes. The tool also needs a way to handle viewer-wrapper links by downloading a validated raw URL or saving the raw document after the agent navigates to it.

Fetching without Chrome may be faster, so it can remain as a secondary optimization if responses are validated carefully. Accuracy is the highest priority, so the faster path should not be trusted when it may save a block or challenge page instead of the requested document.

Implemented on 2026-08-11: `download` now accepts either an inspected ref or a verified direct HTTP(S) URL. It captures exact bytes from a temporary Chrome navigation response or a browser download event, including JavaScript-triggered downloads. The separate request client remains available but is no longer the download tool's primary path.

### Turn budget

Increase the production turn budget from 12 to 24 so deeper tasks have room to recover from errors. Keep the existing 250k cumulative token ceiling as the cost guard. This change is approved and implemented; re-baseline is still pending.

### Starting URLs and task anchoring

When a starting URL is provided, the agent should begin from that page and treat it as task context. The runtime already loads `startUrl` before the first model turn, but the system prompt does not explain that the initial page was deliberately selected.

A possible system-prompt improvement is to require the agent to inspect a nonblank initial page before navigating elsewhere and prefer interpretations consistent with it unless the task or observed evidence provides a concrete reason to leave. This would make the starting URL a strong anchor without treating it as infallible.

Implemented on 2026-08-11 in the system prompt.
