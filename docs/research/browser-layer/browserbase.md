# Browserbase as the browser layer

**Assessment (accessed 2026-08-10).** Browserbase is a strong POC candidate for this project’s remote-browser substrate: it exposes isolated Chromium sessions over CDP, works with Playwright/Puppeteer/Selenium, and supplies first-class downloads, screenshots, live control, recordings, logs, proxies, and CAPTCHA/identity features. It is infrastructure, not the evidence agent: our loop, model, tool registry, validation, artifact naming, and audit policy remain ours. The largest production questions are sensitive-data governance, durable authenticated contexts, actual throughput at “thousands of samples,” and whether target portals tolerate third-party cloud browsers.

## What it is and architectural boundary

Browserbase describes itself as a platform for browser agents: browsers, Search/Fetch APIs, Functions, identity, and (optionally) model access under one API key ([overview](https://docs.browserbase.com/welcome/what-is-browserbase)). The browser primitive is a managed, isolated headless-browser session. A typical adapter calls `POST /v1/sessions` (or the SDK), receives `id` and `connectUrl`, then connects with `chromium.connectOverCDP()`. This fits the design doc’s `navigate`, inspect, click, type, screenshot, download, and write-file tools, while leaving the existing Claude-style loop unchanged. Stagehand is Browserbase’s separate AI/browser-automation framework; it is optional and should not replace our orchestration because it would couple planning and execution to a vendor framework. Any HTTP-capable language can use the API; official SDKs and repositories include Node/Python and Stagehand implementations ([official GitHub organization](https://github.com/browserbase)).

The deployment boundary is cloud-first. Browserbase runs the browser; our worker runs the model/tool loop and should persist normalized evidence and provenance in our own storage. Browserbase advertises private-cloud/VPC options and regions, but on-prem is not a standard self-serve deployment (pricing FAQ, [pricing](https://www.browserbase.com/pricing)); validate contractually before promising client-network isolation.

## Browser control, auth, and hostile sites

CDP compatibility means minimal migration from local Playwright. Browserbase documents Playwright, Puppeteer, Selenium, and Stagehand compatibility ([Playwright cloud](https://www.browserbase.com/use-case/playwright-cloud)). Sessions can use managed residential or datacenter proxies, custom proxies, routing rules, and country/state/city geolocation ([proxies](https://docs.browserbase.com/platform/identity/proxies)). CAPTCHA solving is available on paid plans and may take up to 30 seconds; `solveCaptchas` can be disabled. “Verified” sessions use Browserbase’s purpose-built Chromium fingerprints and are Scale-only; this is a documented partnership/allowlisting approach, not a guarantee against every anti-bot system ([identity](https://docs.browserbase.com/platform/identity/overview)). Treat stealth/CAPTCHA as a reliability aid subject to each client’s authorization and target-site terms, never as a bypass promise.

Authentication supports cookie reuse and persistent browser identity, OAuth/2FA flows, 1Password integration, and handing the user a Live View for interactive MFA ([authentication](https://docs.browserbase.com/platform/identity/authentication)). The exact lifecycle, encryption, export/deletion semantics, and cross-session context behavior need a POC and contract review. Store client credentials in our secret manager; do not put passwords in prompts, recordings, logs, or model-visible tool results. A human-in-the-loop Live View is useful for first login and exceptional MFA, but adds latency and operational state.

## Evidence artifacts and observability

Playwright screenshots can be captured normally and returned to our artifact store. Downloads are synchronized to Browserbase cloud storage and retrieved through the Downloads API; Playwright/Puppeteer require CDP `Browser.setDownloadBehavior` with `behavior: allow` and download path exactly `downloads` ([downloads](https://docs.browserbase.com/platform/browser/files/downloads)). The API can list/filter/retrieve/delete downloads. Uploads use `setInputFiles` for local worker files or the Session Uploads API for larger files ([uploads](https://docs.browserbase.com/platform/browser/files/uploads)). Therefore our adapter must hash downloaded bytes, record source URL/session ID/timestamps, virus-scan where required, and copy artifacts promptly to controlled storage rather than treating Browserbase as the system of record.

Every session is recorded as video by default; the Dashboard Session Inspector supports playback, up to ten tab streams, live view, console/network logs, and metadata. Logs are available via API as CDP events ([observability](https://docs.browserbase.com/platform/browser/observability/observability), [recording](https://docs.browserbase.com/platform/browser/observability/session-recording)). Video is the most faithful replay; the older rrweb DOM API is being deprecated. Set `recordSession:false` for sensitive runs; this also disables replay, while Live View remains available. For audit reproducibility, retain our own structured action/evidence manifest and a selected screenshot, because vendor recording retention and availability can change.

## Scale, latency, and cost

Documented concurrency/session-creation limits are Free 3/5 per minute, Developer 25/25, Startup 100/50, and Scale 250+/150+; hitting either returns HTTP 429, and each browser has a one-minute minimum runtime ([concurrency](https://docs.browserbase.com/optimizations/concurrency/overview)). Limits are organization-level and allocated across projects. This is adequate for pilot parallelism but not evidence for “thousands at once”: production would require queueing, backoff, multiple projects or negotiated Scale capacity, and measurement of cold-start, navigation, CAPTCHA, download, and teardown latency. “Thousands of concurrent sessions” is marketing language; the public hard limits are materially lower.

As of 2026-08-10, public pricing is Free $0 (3 concurrency, 1 browser hour, 7-day retention); Developer $20/month (25 concurrency, 100 included browser hours, then $0.12/hour, 1 GB proxies then $12/GB, 7-day retention shown in the plan card); Startup $99/month (100 concurrency, 500 hours, then $0.10/hour, 5 GB proxies then $10/GB, 30-day retention); Scale custom (250+ concurrency, 30+ days). The pricing page’s comparison table currently says Developer/Startup 30-day retention while plan cards say 7/30; this inconsistency must be resolved with sales before budgeting. CAPTCHA, stealth level, Search/Fetch, and Model Gateway entitlements vary by plan ([pricing](https://www.browserbase.com/pricing)). Browser hours, proxy GB, session minimums, retries, and human MFA make per-sample cost workload-dependent.

## Security, compliance, and maturity

Browserbase documents one-browser-per-VM isolation, strict subnets/firewalls, no shared GPU access, SOC 2 Type II, HIPAA, penetration testing, configurable US/EU/Asia regions, and an API option for zero retention by disabling logs/recording ([enterprise security](https://docs.browserbase.com/account/enterprise/security)). These are vendor assertions; obtain the SOC report, DPA/BAA, subprocessors, breach terms, encryption/key-management details, deletion SLA, and exact residency guarantees. “Configurable region” does not automatically mean all metadata, support access, backups, or proxy traffic remain in-region.

The public GitHub organization shows active SDK and Stagehand repositories (Python SDK updated May 2026; Stagehand is widely used), suggesting a maintained product ([GitHub](https://github.com/browserbase)). Still, API/recording changes (rrweb deprecation is a concrete example) create adapter risk. Pin SDK versions, use API contract tests, and monitor changelog/status; do not expose vendor session IDs as the sole audit identifier.

## Fit against the design requirements

* **User task input:** indirect fit; our model loop supplies this.
* **Many systems/generalizable:** strong browser/CDP and proxy coverage, but each portal’s selectors, downloads, MFA, and bot policy remain workflow-specific.
* **CSV/screenshots/natural language:** strong primitives; CSV/NL generation and evidence schema remain ours.
* **Accurate/consistent:** recordings, network logs, deterministic Playwright actions, and hashes help prove execution; Browserbase cannot establish semantic correctness. Add schema validation, source assertions, retries, and evaluator tests.
* **Scalable/fast:** elastic cloud capacity and parallel sessions help, but public limits, one-minute billing, cold starts, and CAPTCHA latency require queueing and benchmarks.
* **Initial guardrails/tracing:** session IDs, logs, recordings, and API rate headers complement our result caps, iteration limits, and token/tool tracing; redact before model ingestion.

## Risks and unknowns

Vendor outage or API change; portal blocks or changes UI; third-party proxy/CAPTCHA legal and policy exposure; credentials or PII in recordings/logs/download storage; ambiguous residency/retention; inability to run inside a client VPC; hidden concurrency/throughput ceilings; downloads that are eventually consistent; and semantic hallucination by the agent. Unknowns to resolve: context persistence and cookie isolation, session timeout/keep-alive limits, exact browser versions, network allowlisting/private connectivity, retention by plan and region, deletion proof, support/SLA, and whether client Workday/NetSuite tenants permit Browserbase IPs.

## Recommended POC and acceptance tests

Build a thin `BrowserbaseBrowser` adapter behind the existing tool interface. Use a non-production tenant and synthetic records. For each run, emit `{task_id, session_id, region, URL, action log, artifact SHA-256, source timestamp}` and copy artifacts to local/S3-compatible controlled storage.

1. Login/context: complete cookie-based login, expire/reuse context, perform MFA through Live View, and verify no secret appears in model transcript or recording.
2. Evidence: navigate a dynamic portal, inspect/click/type, capture viewport/full-page screenshots, download CSV/PDF, hash and reopen each artifact, and verify filename/content match.
3. Reliability: run 100 identical samples; require ≥99% tool completion, identical normalized outputs, and zero cross-session data leakage. Record p50/p95 cold-start, first navigation, CAPTCHA, download, and total latency.
4. Scale: run 25 concurrent sessions, then a controlled 100-session test; verify queue/backoff on 429, no dropped artifacts, and measured cost/hour.
5. Security: test `recordSession:false`, deletion, region selection, proxy allowlisting, log redaction, and artifact malware scanning; obtain written retention/residency/compliance answers.

A gate for production should require ≥99.5% artifact integrity, zero credential leakage, reproducible evidence manifests, documented deletion, and an agreed SLA. Accuracy of extracted business facts needs a separate labeled eval; Browserbase only supplies browser execution evidence.

## Alternatives worth comparing

Benchmark self-hosted Playwright on isolated workers (maximum control/residency, materially more operations), Browserless (similar CDP cloud-browser model), Apify (actor/scraping ecosystem), and AWS-hosted Playwright/Chrome (network and IAM control). For orchestration compare Temporal separately; for browser-agent layers compare Stagehand, Browser Use, and Playwright plus our own tools. The decisive comparison dimensions are authenticated-context handling, client-VPC/private networking, regional data controls, artifact APIs, observability export, concurrency price, and portal success rate—not model-agent feature count.

## Sources

| Title | Publisher | Accessed | URL |
|---|---|---:|---|
| What is Browserbase? | Browserbase Docs | 2026-08-10 | [docs](https://docs.browserbase.com/welcome/what-is-browserbase) |
| Pricing | Browserbase | 2026-08-10 | [pricing](https://www.browserbase.com/pricing) |
| Concurrency management | Browserbase Docs | 2026-08-10 | [docs](https://docs.browserbase.com/optimizations/concurrency/overview) |
| Downloads / Uploads | Browserbase Docs | 2026-08-10 | [downloads](https://docs.browserbase.com/platform/browser/files/downloads), [uploads](https://docs.browserbase.com/platform/browser/files/uploads) |
| Observability / Session recording | Browserbase Docs | 2026-08-10 | [observability](https://docs.browserbase.com/platform/browser/observability/observability), [recording](https://docs.browserbase.com/platform/browser/observability/session-recording) |
| Proxies / Agent identity / Authentication | Browserbase Docs | 2026-08-10 | [proxies](https://docs.browserbase.com/platform/identity/proxies), [identity](https://docs.browserbase.com/platform/identity/overview), [auth](https://docs.browserbase.com/platform/identity/authentication) |
| Enterprise security | Browserbase Docs | 2026-08-10 | [security](https://docs.browserbase.com/account/enterprise/security) |
| Official repositories | Browserbase GitHub | 2026-08-10 | [GitHub](https://github.com/browserbase) |
