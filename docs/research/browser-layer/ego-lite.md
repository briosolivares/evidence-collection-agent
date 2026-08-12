# Ego Lite browser-layer research

Research date: 2026-08-10  
Candidate: **ego (lite)** by Citro Labs (`egolite.app`; repository name `ego-lite`)

## Executive assessment

**Bottom line:** Ego Lite is a promising **local, interactive browser for a human-supervised prototype**, especially when the task must reuse a real auditor's existing SSO, 2FA, cookies, extensions, and logged-in state. It is not currently a credible sole production browser layer for this design's requirement to process thousands of tasks. The documented product is a headed macOS Chromium application; it cannot run headlessly in CI today, and public materials do not expose a server orchestration API, Linux deployment, fleet controls, tenant isolation, or a quantified concurrency limit.

Its most interesting design idea is not merely “use the user's browser.” Ego Lite exposes a Chromium-integrated semantic snapshot and a Node.js helper runtime, lets an agent compose multiple browser operations in one JavaScript invocation, and isolates concurrent work into **Spaces**. That could reduce model round trips and make authenticated workflows easier. Those advantages should be tested independently rather than accepting vendor benchmarks.

**Recommendation:** put Ego Lite in a small **interactive-prototype track**, not the initial scalable backend shortlist. Use it to test whether (a) kernel-level semantic snapshots materially improve accuracy on difficult enterprise UIs and (b) importing a real profile materially raises authenticated-task completion. Pair those results with a remotely managed, headless candidate for the production path.

## What it is—and is not

Ego Lite is a custom Chromium desktop browser plus an `ego-browser` connection layer. The browser owns tabs, task spaces, CDP transport, snapshots, and events; the open Node helper package wraps those primitives in Playwright-style facades and is invoked by an agent through `ego-browser nodejs` ([helper runtime README](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/README.md)).

It is **not** an autonomous agent framework or durable orchestrator. It does not replace the design doc's model loop, mutable state, token budget, tool-result cap, tracing, evaluator, queue, or artifact store. It is also not a Browserbase-like public managed browser API. The clean integration boundary would be a controller behind the browser tools:

```text
custom agent loop
  -> validated navigate / inspect / click / type / scroll / screenshot / download tools
  -> EgoLiteBrowserController
  -> ego-browser local Node helper runtime
  -> local Ego Lite Chromium + selected Space
```

The official skill instead encourages the model to generate multi-step JavaScript and execute it through a shell heredoc ([agent-facing skill contract](https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/SKILL.md)). That is convenient for a Claude Code-style prototype, but a production implementation should not expose unrestricted shell or arbitrary raw CDP by default. It should translate validated tool inputs into a narrow allowlisted controller and log each consequential browser action.

## Architecture and capabilities

### Browser/runtime interface

- **Browser:** custom Chromium, currently a headed macOS app. Windows and Linux are described as roadmap items ([repository quick start](https://github.com/citrolabs/ego-lite#quick-start)).
- **Control surface:** a CLI-accessible Node.js runtime with helpers for task spaces, navigation, semantic snapshots, screenshots, pointer/keyboard input, file upload, waits, browser/server fetch, JavaScript evaluation, and raw CDP ([skill helper inventory](https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/SKILL.md#common-helpers)).
- **Playwright compatibility:** the helper package exposes *Playwright-style* `page`, `page.locator`, `browser`, `taskSpaces`, `site`, `fetch`, and `cdp` facades; it is not documented as a drop-in Playwright browser endpoint. Existing Playwright code should be assumed incompatible until tested ([runtime README](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/README.md)).
- **Observation:** `snapshotText()` emits a semantic page view with action references and stable locators. The vendor says its snapshot is implemented inside Chromium and can reach cross-origin iframes and shadow DOM ([product page](https://www.egolite.app/)). This is a vendor claim, not an independently validated result.
- **Visual and low-level fallbacks:** the official workflow recommends semantic refs for ordinary DOMs, screenshots plus coordinate/keyboard actions for canvas or virtualized editors, and direct JavaScript/CDP for compact extraction or unsupported browser features ([workflow guidance](https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/SKILL.md#recommended-workflow)).

### Sessions, authentication, and isolation

During onboarding, Ego Lite can import Chrome tabs, bookmarks, saved passwords, extensions, cookies, sessions, and profiles. Agent Spaces inherit the current user's login state while keeping separate tabs ([quick-start docs](https://www.egolite.app/document/en/docs/quick-start)). A Space can be handed to the user for login, CAPTCHA, verification, or another manual step and later returned to the agent; ownership rules are explicit in the open skill contract.

This directly addresses Workday, GitHub, NetSuite, Jira/Linear, SSO, and 2FA friction in the design doc. It does **not** provide strong tenant or identity isolation: the vendor describes Spaces as sharing the user's login state, and says parallel tabs can appear to a site as one signed-in user ([testing FAQ](https://www.egolite.app/solutions/browser-testing)). Separate auditor identities, client engagements, or conflicting single-session applications would need separate OS/browser profiles or machines. A public issue requesting Space-level profiles reinforces that this is not a documented present capability ([issue #176](https://github.com/citrolabs/ego-lite/issues/176)).

There is no documented proxy fleet, geographic routing, CAPTCHA-solving service, or fingerprint configuration. The anti-bot proposition is instead “use a real, headed, already-established user session.” That may reduce challenges for legitimate read-only audit work, but it is not a general anti-detection system and must not be treated as one.

### Evidence artifacts

The helper surface includes `captureScreenshot`, console/network event draining, uploads, raw CDP, and a download facade built around browser download events ([skill contract](https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/SKILL.md), [runtime source layout](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/README.md#source-layout)). This is enough to prototype screenshots and downloaded files. CSV and natural-language generation remain responsibilities of the outer agent's `write file` tool.

What is missing from public documentation is more important for audit evidence: immutable artifact IDs, page URL and timestamp embedded in a manifest, screenshot hashes, download checksums, browser/version provenance, WARC/HAR retention, trace export, policy-controlled storage, and chain-of-custody guarantees. A user-reported open screenshot timeout also makes repeated artifact validation necessary rather than assuming screenshot capture is reliable ([issue #183](https://github.com/citrolabs/ego-lite/issues/183)).

### Parallelism, scaling, and latency

Ego Lite can run tasks in parallel Spaces without taking over the user's tabs. The free plan says parallelism is “limited only by your machine,” while the business plan offers custom volume and deployment terms but publishes no architecture, API, concurrency quota, SLA, or reference deployment ([enterprise/pricing page](https://www.egolite.app/enterprise)).

The website reports a 3.45x result—81.8 seconds versus 282.9 seconds—for one X scraping task against Vercel agent-browser, and illustrates fewer tool calls by batching operations ([vendor comparison](https://www.egolite.app/compare/ego-lite-vs-agent-browser)). Treat this as directional only: it is vendor-run, one showcased task, and not a reproducible cross-site benchmark with confidence intervals. More fundamentally, eliminating model round trips can improve speed but also removes opportunities to inspect unexpected intermediate state. The controller should batch deterministic operations and retain observation checkpoints before irreversible actions.

For this project, the production blocker is explicit: Ego Lite says it **cannot run headless in CI today** and positions itself as an interactive inner-loop browser on a Mac ([testing boundary](https://www.egolite.app/solutions/browser-testing#where-ego-lite-fits-and-where-it-doesnt)). A single user's Mac and shared profile cannot meet “thousands of samples” with controlled isolation and repeatable provisioning. Open issues requesting resource budgets for concurrent Spaces and reporting background rendering pauses are useful warning signals, though they are user reports rather than confirmed product limitations ([issue #174](https://github.com/citrolabs/ego-lite/issues/174), [issue #168](https://github.com/citrolabs/ego-lite/issues/168)).

## Observability and debugging

Positive signals:

- Headed execution is visible; a human can watch, interrupt, or take over a Space.
- The runtime exposes page info, console/network events, screenshots, raw CDP, and a debug-click mode.
- The model can log only selected outputs, reducing context size, while the outer loop can record tool input/output and latency.

Gaps:

- No public managed session dashboard, video recording, fleet view, historical trace viewer, OpenTelemetry export, or retention contract was found.
- No documented correlation ID or event schema maps a high-level agent decision to its browser effects and final artifact.
- User takeover is a local interaction protocol, not a documented queue/SLA workflow for distributed audit teams.

The prototype should therefore add its own append-only event log with `task_id`, `turn`, `space_id`, URL before/after, normalized action, result, timing, screenshot/download hash, and model decision reference.

## Security, privacy, licensing, and maturity

The individual plan says there is no account or email, the user brings their model key, and browser data stays local ([enterprise/pricing page](https://www.egolite.app/enterprise)). The repository likewise says browsing data stays on-device. This is favorable for client evidence, but it does not by itself establish enterprise suitability.

Important diligence items:

1. **Sensitive-session blast radius.** The agent receives a browser containing saved passwords, cookies, authenticated client systems, browser fetch, page JavaScript, raw CDP, and file upload. A prompt-injected page or over-broad agent command could read or act across reachable sessions. Use a dedicated auditor profile with least-privilege accounts, domain allowlists, read-only action policy, and a confirmation gate for any mutation.
2. **Privacy scope is ambiguous.** The broad Citro privacy policy covers multiple EGOBOT applications, extensions, and cloud services and describes collection of URLs, content, interactions, task logs, and screenshots in some services ([privacy policy](https://www.egolite.app/privacy)). That does not prove Ego Lite's local individual mode sends those fields, but it is broader than the product-page statement that Lite does not upload browsing data. Obtain written product-specific data-flow, telemetry, retention, subprocessors, and DPA answers before using real client evidence.
3. **Partial open source.** The repository content and Node helper are MIT-licensed, but the README explicitly says the downloadable Ego Lite browser is separate ([license statement](https://github.com/citrolabs/ego-lite#license)). The browser binary's source, build reproducibility, update channel, enterprise license, and Chromium security-patch cadence need review.
4. **Full-access installation.** Official setup recommends allowing the agent full access because it must launch a local app outside the sandbox, and onboarding can migrate credentials and write skills into agent directories ([quick-start docs](https://www.egolite.app/document/en/docs/quick-start)). That permission model is too broad for a production worker without additional containment.

The project is young: GitHub records creation in April 2026, while activity and a beta release were present on the research date ([GitHub repository metadata](https://api.github.com/repos/citrolabs/ego-lite), [releases](https://github.com/citrolabs/ego-lite/releases)). Rapid development and substantial early adoption are positive maturity signals; a short operating history, beta release state, open reliability reports, and lack of public enterprise assurance materials are counter-signals. No public SOC 2 report, ISO 27001 certificate, penetration-test summary, DPA, data-residency control, or vulnerability disclosure policy was found during this review.

## Fit against the design requirements

| Requirement | Fit | Assessment |
|---|---|---|
| User-message-driven general browser work | Strong for prototype | Any shell-capable agent can drive the runtime; semantic, visual, JS, and CDP paths cover diverse interfaces. |
| Many authenticated systems | Strong locally | Real profile import and human handoff are unusually useful for SSO/2FA. Cross-client/profile isolation is weak. |
| Screenshot output | Partial–strong | Native helper exists; reliability and provenance must be measured and wrapped. |
| CSV / natural-language output | Neutral | Outer agent/write-file responsibility, not a browser feature. |
| Accurate | Promising, unproven | Kernel snapshot and headed verification could help; no independent cross-site accuracy evaluation was found. |
| Generalizable | Moderate–strong | DOM, screenshot, coordinate, JS, CDP, uploads, and downloads are broad; Chromium/macOS only. |
| Scalable to thousands | Poor today | Local headed Mac, machine-bounded Spaces, no public fleet API or headless CI. |
| Consistent | Moderate–poor | Established profile helps auth consistency; shared live state, extensions, machine state, and interactive execution reduce reproducibility. |
| Fast | Promising, unproven | Multi-action batching is architecturally sound; published benchmark is too narrow to decide. |
| Tool registry and guardrails | Partial | Broad helper runtime can sit behind tools, but official shell/JS/CDP interface is wider than the proposed validated registry. |
| Tracing | Partial | Useful events and CDP exist; durable normalized traces and audit artifact manifests must be built. |

## Proposed proof of concept

Run this only with dedicated test accounts and a dedicated browser profile—not an employee's everyday client sessions.

1. Build a narrow `EgoLiteBrowserController` for `navigate`, `inspect`, `click`, `type`, `scroll`, `screenshot`, and `download`. Disable arbitrary server fetch, page JS, raw CDP, uploads, and cross-domain navigation by default.
2. Define an evidence manifest containing task ID, system, account alias, source URL, capture time, browser/runtime version, action trace, screenshot/download path, SHA-256, and extraction output.
3. Assemble at least 40 representative tasks across GitHub, Jira/Linear, Workday-like HR, NetSuite-like finance, tables/pagination, downloads, cross-origin iframes, shadow DOM, SSO, expired sessions, and an adversarial prompt-injection page. Include read-only and mutation-attempt negatives.
4. Run each task five times from a controlled starting state, and compare with the same outer loop on the leading managed/headless backend. Record task success, field-level precision/recall, artifact correctness, forbidden-action rate, human interventions, model/browser latency, tool calls, tokens, and peak memory.
5. Stress Spaces at 1, 2, 4, 8, and 16 concurrent tasks; verify no tab, task, artifact, or identity crosses another run and that foreground/background rendering yields identical data.

Suggested acceptance gates for continued investigation:

- 100% prevention of forbidden writes and cross-task/cross-profile leakage.
- At least 95% exact task completion and 99% field-level accuracy on the controlled corpus, with every reported value traceable to a captured page/artifact.
- 100% valid screenshot/download hashes and manifests; no silent artifact failure.
- At least 30% lower median end-to-end latency or model-token use than the baseline without a statistically meaningful accuracy loss.
- Successful recovery from session expiry, user handoff, native dialog, download, and renderer restart.

If Ego Lite clears the accuracy/authentication gates but fails scale, retain it as a **human-supervised exception path** for difficult authenticated evidence collection, not as the default worker runtime.

## Sources

All sources accessed 2026-08-10. Product capability and benchmark pages are first-party vendor claims unless otherwise noted.

| Source | Publisher | URL |
|---|---|---|
| Product page and FAQ | Citro Labs | https://www.egolite.app/ |
| Quick start | Citro Labs | https://www.egolite.app/document/en/docs/quick-start |
| Browser testing: capabilities and explicit boundaries | Citro Labs | https://www.egolite.app/solutions/browser-testing |
| Enterprise and pricing | Citro Labs | https://www.egolite.app/enterprise |
| Privacy policy | Citro Labs | https://www.egolite.app/privacy |
| Ego Lite vs agent-browser benchmark | Citro Labs | https://www.egolite.app/compare/ego-lite-vs-agent-browser |
| Repository README, activity, license, issues | Citro Labs / GitHub | https://github.com/citrolabs/ego-lite |
| Agent-facing helper contract | Citro Labs / GitHub | https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/SKILL.md |
| Node helper runtime architecture | Citro Labs / GitHub | https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/README.md |
| Repository metadata API | GitHub | https://api.github.com/repos/citrolabs/ego-lite |
| Release history | Citro Labs / GitHub | https://github.com/citrolabs/ego-lite/releases |
| Open issue #168: background rendering report | Community report / GitHub | https://github.com/citrolabs/ego-lite/issues/168 |
| Open issue #174: resource budgets request | Community report / GitHub | https://github.com/citrolabs/ego-lite/issues/174 |
| Open issue #176: Space-level profiles request | Community report / GitHub | https://github.com/citrolabs/ego-lite/issues/176 |
| Open issue #183: screenshot timeout report | Community report / GitHub | https://github.com/citrolabs/ego-lite/issues/183 |
