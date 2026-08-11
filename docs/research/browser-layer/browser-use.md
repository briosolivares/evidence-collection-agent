# Browser Use as the browser layer

**Assessment (10 August 2026).** Browser Use is a compelling *agentic browser layer*, not a complete evidence system. Its open-source Python package supplies a model-driven loop, browser state, actions and extensibility; Browser Use Cloud adds hosted Chromium, profiles, proxies, stealth, recordings and a run API. It can accelerate the proposed Claude Code-style loop, but the evidence-collection agent should retain ownership of task policy, tool-result caps, artifact storage, provenance, validation and audit logs. Recommended disposition: prototype behind an adapter, with deterministic Playwright actions for high-value steps and Browser Use for exploratory/generalized navigation.

## What it is and architectural boundary

The MIT-licensed repository describes an agent that opens pages, clicks, types, fills forms and extracts structured data ([repository README](https://github.com/browser-use/browser-use#what-can-browser-use-do)). The Python library accepts a task, an LLM and a `Browser`/`BrowserSession`; it can use Browser Use-hosted models or provider integrations including Anthropic, OpenAI and Google ([README quickstart](https://github.com/browser-use/browser-use#python-library-the-easiest-way-to-automate-the-web)). This is one layer above Playwright/CDP: the framework observes a page and asks a model to select actions, while Playwright/CDP actually drives Chromium. It overlaps substantially with our proposed loop (context → model → tool calls → results), so embedding it wholesale would duplicate orchestration and make iteration/budgets less transparent. An adapter can instead expose Browser Use as a bounded worker or use its browser session/action primitives inside our loop.

The project also offers a CLI intended for existing agents (Claude Code/Codex/Cursor) and a hosted V4 `runs` API ([CLI/library guidance](https://github.com/browser-use/browser-use#should-i-use-the-cli-vs-the-python-library), [Cloud API example](https://github.com/browser-use/browser-use#open-source-vs-cloud)). Custom actions are first-class: a `Tools` registry decorates Python functions with descriptions and passes them to the agent ([custom tools](https://github.com/browser-use/browser-use#can-i-use-custom-tools-with-the-agent)). This maps well to `write_file`, evidence hashing, CSV normalization and approval gates, but our outer loop must enforce allowed domains and read-only policy rather than trusting model intent.

## Browser, sessions and authentication

Open source can launch/manage local Chromium and connect to an existing browser by CDP; the documented Playwright integration shares one Chrome instance, allowing deterministic Playwright actions and Browser Use actions in the same run ([Playwright integration](https://docs.browser-use.com/open-source/examples/templates/playwright-integration)). Cloud browser sessions return both a live viewing URL and CDP URL, support custom dimensions, recording and up to four hours per session ([create browser](https://docs.browser-use.com/cloud/api-v3/browsers/create-browser-session)). Cloud profiles persist cookies, local storage and login state across browsers; documentation recommends one profile per end user ([profiles](https://docs.browser-use.com/cloud/guides/authentication)). Local profile synchronization is available in the CLI/docs, but auditors still need a controlled, per-client credential handoff and explicit secret lifecycle.

Cloud documents residential proxies, country selection and custom proxies; its browser page claims hardened Chromium, stealth and anti-fingerprinting enabled by default ([direct CDP browser](https://docs.browser-use.com/cloud/browser/playwright-puppeteer-selenium)). The README says Cloud provides proxy rotation and CAPTCHA handling ([production guidance](https://github.com/browser-use/browser-use#how-do-i-solve-captchas)). These are useful for public sites, but CAPTCHA bypass may conflict with client policies and is not a guarantee of access. For Workday/NetSuite/Jira, SSO, MFA and device-bound authentication remain POC risks; plan a human-assisted login or a customer-managed browser/CDP mode. Never put passwords in prompts or persisted task histories.

## Artifacts, structured results and provenance

The framework supports screenshots, downloads, PDFs and custom output examples in its open-source examples/docs ([examples index](https://docs.browser-use.com/open-source/examples)). Structured extraction can be requested with a Pydantic output schema (the repository’s agent configuration exposes `output_model_schema`; see [repository agent guidance](https://github.com/browser-use/browser-use/blob/main/AGENTS.md)). This is a good fit for a typed evidence record, but schema validity is not evidence correctness. Browser Use does not, by itself, establish an auditor-grade chain of custody: URL, timestamp, actor/profile, page title, selector/DOM context, screenshot hash, downloaded-file hash, network identity and model/tool trace should be captured by our wrapper. Store raw files outside model context and return bounded previews/immutable artifact IDs, matching the design doc’s result-size cap.

## Scale, latency and operations

The open-source README warns that Chrome is memory-heavy and parallel agents are difficult to manage; it recommends Cloud for scalable infrastructure, memory management and parallel execution ([production guidance](https://github.com/browser-use/browser-use#how-do-i-go-into-production)). Cloud’s V3 browser API documents 429s for concurrent-session limits and a four-hour maximum per session ([API limits](https://docs.browser-use.com/cloud/api-v3/browsers/create-browser-session)). Thus “thousands of samples” requires a queue, per-tenant quotas, retries, browser recycling and artifact backpressure outside Browser Use. Model-driven observation/action loops add variable latency and token cost; deterministic Playwright for repeated selectors should reduce both. Benchmark claims in the README (including 87.4% on an external leaderboard) are vendor/project claims, not an audit accuracy guarantee ([benchmark statement](https://github.com/browser-use/browser-use#open-source-vs-cloud)). Measure task success, evidence completeness, false-positive rate, p50/p95 latency and cost on our eval CSV.

The library exposes run history and the Cloud API returns run/session IDs, live URL, CDP URL, recording URL and cost fields ([session response](https://docs.browser-use.com/cloud/api-v3/browsers/create-browser-session)). These enable debugging, but production observability should correlate every Browser Use event with our task/sample/evidence IDs and retain redacted model/tool traces. Test browser crashes, stale profiles, downloads, navigation timeouts and partial completion as explicit states.

## Security, compliance and economics

OSS is free under MIT, but the operator pays for LLM APIs, Chromium/Playwright compute, proxy bandwidth, storage and engineering ([MIT/FAQ](https://github.com/browser-use/browser-use#can-i-use-this-for-free)). Cloud V3 browser sessions are documented at **$0.02/hour**, billed by the minute with unused time refunded; concurrent limits and proxy charges may vary by plan ([pricing in API reference](https://docs.browser-use.com/cloud/api-v3/browsers/create-browser-session)). Treat website data, screenshots, cookies and downloads as sensitive client evidence. Browser Use’s privacy policy says personal information is retained as necessary for service, legitimate business, dispute, safety/security and legal purposes ([privacy policy](https://browser-use.com/privacy)); that is not a stated zero-retention guarantee. The pricing page advertises “Zero Data Retention,” but obtain the contractual scope, region, subprocessors, deletion SLA, encryption, access controls, audit reports and whether prompts/screenshots/recordings train models before sending client data ([pricing](https://browser-use.com/pricing)). Prefer self-hosted OSS or a customer-controlled browser for regulated evidence until these answers are documented. Cloud API keys must be secret-managed; profiles must be tenant-isolated and destroyed on client offboarding.

## Fit against the design requirements

| Requirement | Fit | Judgment |
|---|---|---|
| User task message | Strong | Native task-to-agent API/CLI. Keep our intake and policy layer. |
| Many systems | Promising | General browser + CDP; validate SSO/MFA, file exports and app-specific quirks. |
| CSV/screenshots/natural language | Strong with wrapper | Examples and schemas exist; provenance and final packaging are ours. |
| Accurate | Unknown | Run per-system gold-set evals; vendor benchmark is directional only. |
| Generalizable | Strong | Vision/DOM agent and custom tools cover varied workflows, with model variance. |
| Scalable/thousands | Conditional | Cloud helps, but quotas, cost, queueing and memory isolation need architecture. |
| Consistent | Conditional | Use fixed schemas, deterministic actions, replay and evaluator checks. |
| Fast | Conditional | Hosted optimized models may help, but measure p95 end-to-end latency. |
| Design loop/guardrails/tracing | Partial | It supplies an overlapping loop; our adapter must own caps, validation, retries, trace and artifact limits. |

## Risks and unknowns

Key risks are model hallucination or premature completion, DOM changes, bot defenses, MFA/CAPTCHA, cross-tenant profile leakage, sensitive data in Cloud traces/recordings, undocumented retention/regions, Cloud quota/price changes, and Python/API churn. Browser Use’s very rapid repository activity is a maturity advantage but also an integration risk; pin versions and maintain a compatibility adapter. Confirm whether Cloud recordings include downloads and credentials, exact retention by plan, SOC 2/ISO reports, DPA/subprocessors, regional hosting, private networking, SLA, rate limits, cancellation behavior and support response. Confirm whether “CAPTCHA solving” is avoidance, third-party solving, or human escalation.

## Concrete POC and acceptance tests

Build an adapter with `start_session`, `navigate`, `inspect`, `click/type`, `scroll`, `screenshot`, `download`, `structured_extract`, `stop`; emit append-only event records and SHA-256 hashes. Run three representative systems (GitHub, Jira/Linear, and one SSO-heavy finance/HR sandbox) using synthetic read-only data. Compare Browser Use-only, Playwright-only and hybrid flows.

Acceptance tests: (1) ≥95% successful completion on a 20-case deterministic gold set, with zero unauthorized writes; (2) every output has task/sample IDs, source URL, UTC timestamp, profile/tenant ID, artifact hash and trace pointer; (3) schema-valid CSV/JSON in 100% of successful cases; (4) screenshot and downloaded artifact hashes reproduce after retrieval; (5) max iterations, tool-result caps, domain allowlist and timeout are enforced; (6) expired/stale auth yields a typed `AUTH_REQUIRED` state without leaking secrets; (7) 100 parallel synthetic sessions meet agreed p95 latency and no cross-tenant artifacts; (8) replay/evaluator catches intentionally corrupted or wrong-page evidence; (9) deletion removes profiles, recordings and artifacts within the contractual/tested SLA; and (10) cost per sample is measured for OSS/self-hosted and Cloud, including LLM/proxy/storage.

## Alternatives to compare

Compare direct Playwright (maximum determinism and provenance, more engineering), Browserbase (hosted browser infrastructure), Browserless (CDP/Playwright hosting), Stagehand (LLM primitives over Playwright), Microsoft Playwright MCP (agent-facing browser tools), and a custom Claude Code-style loop over CDP. For the evidence product, the likely best architecture is Browser Use for discovery/generalization plus Playwright assertions and a first-party evidence ledger for repeatability.

## Sources (accessed 2026-08-10)

| Title | Publisher | URL |
|---|---|---|
| Browser Use repository/README | Browser Use / GitHub | https://github.com/browser-use/browser-use |
| Create Browser Session API | Browser Use Docs | https://docs.browser-use.com/cloud/api-v3/browsers/create-browser-session |
| Profiles/authentication | Browser Use Docs | https://docs.browser-use.com/cloud/guides/authentication |
| Playwright integration | Browser Use Docs | https://docs.browser-use.com/open-source/examples/templates/playwright-integration |
| Playwright/Puppeteer/Selenium Cloud browser | Browser Use Docs | https://docs.browser-use.com/cloud/browser/playwright-puppeteer-selenium |
| Privacy policy | Browser Use | https://browser-use.com/privacy |
| Pricing | Browser Use | https://browser-use.com/pricing |
| Agent configuration guidance | Browser Use / GitHub | https://github.com/browser-use/browser-use/blob/main/AGENTS.md |
