# Browser Agent V2 — Revised Architecture Proposal

**Status:** Proposed

**Date:** 2026-08-13

**Scope:** Accuracy, generality, consistency, and speed for public-information
evidence collection

**Primary decision:** Let the model make judgment calls, but stop asking it to
be the workflow engine, database, file formatter, and quality-control system.
Ordinary TypeScript should track state, validate outputs, schedule safe work,
and enforce the rules for completion.

## Table of contents

- [Executive summary](#executive-summary)
- [Goals](#goals)
- [Non-goals for the first iteration](#non-goals-for-the-first-iteration)
- [The proposal at a glance](#the-proposal-at-a-glance)
- [Terms used below](#terms-used-below)
- [Architecture](#architecture)
  1. [Define a small, validated output contract](#1-define-a-small-validated-output-contract)
  2. [Derive output status instead of maintaining task state](#2-derive-output-status-instead-of-maintaining-task-state)
  3. [Give the application an accurate view of the browser](#3-give-the-application-an-accurate-view-of-the-browser)
  4. [Use `browser_action` for normal browser interaction](#4-use-browser_action-for-normal-browser-interaction)
  5. [Make `execute_javascript` a normal page capability](#5-make-execute_javascript-a-normal-page-capability)
  6. [Inspect the right kind of content for the job](#6-inspect-the-right-kind-of-content-for-the-job)
  7. [Read public data directly when the webpage exposes it](#7-read-public-data-directly-when-the-webpage-exposes-it)
  8. [Store rows as data, then generate the output file](#8-store-rows-as-data-then-generate-the-output-file)
  9. [Link every important fact to its evidence](#9-link-every-important-fact-to-its-evidence)
  10. [Require the agent to prove it is finished](#10-require-the-agent-to-prove-it-is-finished)
  11. [Give the model a compact memory](#11-keep-the-audit-log-but-give-the-model-a-compact-memory)
  12. [Run only clearly independent work in parallel](#12-run-only-clearly-independent-work-in-parallel)
  13. [Bound every resource explicitly](#13-bound-every-resource-explicitly)
  14. [Use one shared model driver everywhere](#14-use-one-shared-model-driver-everywhere)
  15. [Give each model role a small, explicit tool set](#15-give-each-model-role-a-small-explicit-tool-set)
- [Revised core loop](#revised-core-loop)
- [Concrete example](#concrete-example)
- [Useful implementation patterns from Claude Code](#useful-implementation-patterns-from-claude-code)
- [Highest-leverage work to do first](#highest-leverage-work-to-do-first)
- [Implementation sequence](#implementation-sequence)
- [Success metrics](#success-metrics)
- [Expected outcome](#expected-outcome)

## Executive summary

The foundation is strong. Tools have strict input validation, browser sessions
are created cleanly, prompts are cached, files are traceable to their sources,
and every run has a clear output directory. Graders inspect the actual files
instead of trusting the model's written answer.

The main constraint is the agent loop. Today, one ever-growing conversation has
to remember browser state, plan the research, retain facts, build files, and
decide when the task is finished. Models are useful at judgment. They are less
reliable at repetitive bookkeeping and exact file construction.

The proposed design moves that bookkeeping into normal TypeScript components:

~~~text
Task
  → a model defines a small, validated output contract
  → worker starts browsing, usually in that same turn
  → derive output status from that contract and the files produced so far
  → use browser actions or page-scoped JavaScript
  → store tabular results in validated output tables linked to evidence
  → generate output files with regular code
  → run code-based completion checks
  → fresh verifier checks task, contract, outputs, and evidence
  → if needed, return precise corrections to the same worker conversation
~~~

The split is simple:

- The model understands the goal, chooses a research strategy, resolves
  ambiguity, and writes clear prose.
- The application tracks state, executes validated tools, formats files,
  checks objective requirements, schedules independent work, and decides
  whether completion can be accepted.

Model responses are treated as proposals. The application accepts a response
only when the network stream ended cleanly and the tool-call structure is
valid. Rejected responses are recorded for debugging but are not added to the
model's conversation. This prevents a partial response from leaving behind
unanswered or duplicated tool calls.

This proposal intentionally prioritizes capability and performance. Heavy
security hardening, signed evidence journals, strict origin policy, and
adversarial prompt-injection work are deferred. The existing no-shell boundary
should remain, along with inexpensive safeguards such as sending saved
credentials only to the exact site they belong to and limiting download sizes.

Page-scoped JavaScript in an authenticated tab can still access page-visible
session data and make network requests. V1 accepts that capability risk
explicitly. Dedicated, low-value test accounts and profiles are preferred, but
they are not assumed to exist for every authenticated lane. Each authenticated
session configuration must explicitly allow or deny JavaScript; allowing it for
a non-disposable account records an accepted exposure rather than claiming the
credential-store boundary solves it.

## Goals

1. Complete a substantially broader class of browser tasks.
2. Reduce model turns and end-to-end latency.
3. Generate exact output formats reliably with regular code.
4. Make omissions and incomplete work observable.
5. Support visual pages, PDFs, spreadsheets, popups, frames, and rich
   interactions.
6. Parallelize independent research where it produces real speedups.
7. Retain the current run-directory, source-tracking, and evaluation
   foundations.

## Non-goals for the first iteration

- Model-generated shell, Node.js, Python, filesystem, or other host-level code.
  There is no general-purpose host code runner; page-scoped JavaScript is
  intentionally supported.
- A swarm of unconstrained browser workers.
- A mandatory model-maintained task checklist or separate `TaskProgress`
  object; evaluate planning tools independently before adding them.
- Cryptographically signed evidence bundles.
- A complete enterprise security-policy engine.
- A robust JavaScript sandbox for authenticated pages. A configurable origin
  denylist can be added later, but a partial cookie or network shim must not be
  presented as isolation.
- A new browser engine.
- Task-specific selectors or hidden-eval tuning.

## The proposal at a glance

### Keep

- `BrowserSessionProvider` and Playwright.
- Zod-validated tool inputs.
- The rule that browser-changing tools run in sequence.
- Prompt caching and streaming.
- The split between published files (`artifacts/`) and private working files
  (`scratch/`).
- Manifest hashes and source URLs.
- The run-directory product boundary.
- The existing evaluation datasets, reference-data providers, and graders.

### Remove or defer

- `browser_batch`, after `browser_action` proves behavioral and observability
  parity in tests and evals.
- Restarting the worker every time the verifier asks for a correction.
- Free-form `INTENT.md` and `CONTRACT.md` planning files.
- Making a separate initializer or contract-writer call mandatory. Keep the
  existing initializer experiment available until the comparison described below
  shows whether it adds value beyond the contract and verifier themselves.
- Raw model-authored CSV.
- Full conversation replay as long-term memory.
- Prompt instructions encoding implementation workarounds such as the
  3,000-character write rule.
- Starting browser actions before the complete model response has been
  accepted. The small latency win is not worth the risk of executing an action
  twice after a stream retry.

### Replace

| Current mechanism | Replacement |
| --- | --- |
| inspect → model → click → model → inspect | Each browser action also reports what changed |
| Short-lived Playwright element references | Element references tied to a page, frame, and document |
| Checklist stored in a scratch file | Output status derived from the contract and current files |
| Raw CSV strings | An `OutputTable` rendered by a normal CSV library |
| Treating “no tool call” as completion | Explicit `submit_for_verification` protocol |
| Replaying the full conversation as memory | A short recent history plus compact structured state |
| One sequential research path | Limited parallel work for truly independent items |
| Full-page accessibility tree every time | Inspect only the type and area of content currently needed |
| Relying only on fixed browser tools | Choose between `browser_action` and `execute_javascript` for each step |
| Model-formatted contract and verdict prose | Schema-validated tool calls |
| Static `readOnly` scheduling | Input-aware page, file, and table access rules |

## Terms used below

- **Worker:** the main model conversation that browses and produces the result.
- **Initializer:** an optional one-call model that defines the first output
  contract before the worker starts.
- **Output contract:** validated data describing exactly what must exist at the
  end. It is not a research plan.
- **Code check:** an objective check such as exact columns, row count, file
  parsing, or evidence-link validity.
- **Verifier:** a fresh, read-only model session that reviews meaning, visual
  evidence, completeness, and agreement with the original request.
- **Research job:** a short, limited worker assigned one independent entity. It
  returns structured rows and evidence rather than editing shared outputs.

## Architecture

### 1. Define a small, validated output contract

Do not build a natural-language requirements parser. Do not ask a model to
format `INTENT.md` and `CONTRACT.md` and then parse headings from that prose.
The contract should arrive as a `set_output_contract` tool call, validated by
the same Zod schema the rest of the application uses.

> **Claude Code influence — schema-backed handoffs:** Claude Code's
> `SyntheticOutputTool` turns a caller-provided JSON schema into a required
> `StructuredOutput` tool, while `QueryEngine` caps retries for invalid output.
> `set_output_contract` and `report_verification` adapt that pattern for
> internal agent handoffs rather than final CLI output.

The default path lets the worker define the contract in its first response. It
may start browsing in that same response:

~~~text
tool_use: set_output_contract(...)
tool_use: browser_action(...)
~~~

The contract describes only what must exist at the end:

~~~ts
type OutputSpec =
  | {
      id: string;
      kind: 'table';
      filename: string;
      format: 'csv' | 'json' | 'markdown';
      columns: [OutputColumn, ...OutputColumn[]];
      rules: TableRule[];
    }
  | {
      id: string;
      kind: 'document';
      filename: string;
      format: 'markdown' | 'text' | 'pdf';
      requiredSections?: string[];
      evidenceRequirement?: 'none' | 'at_least_one' | 'per_required_section';
      evidencePresentation?: 'hidden' | 'footnotes';
    }
  | {
      id: string;
      kind: 'screenshots';
      count: { exact: number } | { minimum: number };
      filenamePattern?: string;
      mustShow?: string[];
    }
  | {
      id: string;
      kind: 'download';
      count: { exact: number } | { minimum: number };
      filenamePattern?: string;
      allowedMediaTypes?: string[];
      sourceUrlPattern?: string;
    };

interface OutputContract {
  outputs: [OutputSpec, ...OutputSpec[]];
  contentExpectations?: string[];
  assumptions?: string[];
}

type ContractRevisionBasis =
  | {
      kind: 'evidence_discovery';
      summary: string;
      evidenceIds: [string, ...string[]];
    }
  | { kind: 'assumption_correction'; summary: string }
  | { kind: 'user_clarification'; summary: string };

interface SetOutputContractInput {
  contract: OutputContract;
  revisionBasis?: ContractRevisionBasis;
}

interface OutputContractRevision {
  revision: number;
  basis?: ContractRevisionBasis;
  contract: OutputContract;
}
~~~

The fields have narrow meanings:

- `outputs` says which files or captures must exist and their exact structure.
- `contentExpectations` holds requirements that need judgment, such as
  “explain the most material control gaps and support them with evidence.”
- `assumptions` records only choices that materially affect the result.

A document's `evidenceRequirement` defaults to `at_least_one`. Use
`per_required_section` for evidence-heavy reports. `none` is valid only when
the requested document contains no source-backed factual claims; the verifier
still compares that choice with the original task. `evidencePresentation`
defaults to `hidden`; use `footnotes` when the user asks for visible citations.

The contract does not contain a research plan, browser steps, preferred sites,
or per-entity progress. Its first revision can contain requirements visible in
the task and clearly labeled assumptions. It must not invent facts that can
only be learned by browsing.

Code checks screenshot counts and filename patterns; `mustShow` is deliberately
semantic and is checked by an image-capable verifier against the actual image.
Download count and its filename, media-type, and source-URL constraints are
checked by code.

On the first turn, `set_output_contract` must be the first tool call. The
runtime validates and stores it before executing later calls from that response.

Failure behavior is explicit:

- If the contract is missing, no call in the response executes. Each receives
  an `output_contract_required` result.
- If the contract is invalid, the contract call receives specific validation
  errors. Later calls receive `blocked_by_invalid_contract`.
- The worker corrects the contract on its next turn.

Every tool use still receives exactly one result, which keeps the model
conversation valid.

Structural validation rejects:

- duplicate output IDs or paths;
- unsafe filenames;
- duplicate table columns;
- non-positive counts;
- conflicting table rules.

A download must also constrain at least one of filename, media type, or source
URL. An arbitrary download cannot satisfy the contract.

Store the accepted contract under `scratch/output-contract/` through
`writeArtifact`. Later changes are normal because browsing may reveal an exact
population, a field rule, or a mistaken assumption. Save every change as a
numbered revision instead of overwriting history. The first revision has no
`revisionBasis`; each later revision must explain what evidence, corrected
assumption, or user clarification caused the change.

Evidence-backed revisions and corrected assumptions are expected. A change is
a problem only when it weakens the original task, contradicts its cited
evidence, or has no reasonable basis. Only the user can relax an explicit
requirement from the original request. The verifier receives the latest
contract and its revision history so it can detect unsupported weakening of the
requirements.

The original task remains authoritative. The contract is an execution target,
not a replacement for the request, and the final verifier checks that the two
agree.

The `feat/judge-harness` experiment improved measured tasks, but it changed
several things at once: initializer, contract, verifier, screenshot review, and
correction attempts. We therefore do not yet know which part caused the gain.

Keep initializer authorship behind a configuration switch. Both modes must use
the same `set_output_contract` schema:

- **Worker-authored:** the worker defines the contract and can start browsing
  in the same response.
- **Initializer-authored:** a separate model sees the original task and is
  offered only `set_output_contract`. Force that tool choice. It cannot browse
  or produce free-form planning files.

The initializer's tool call either validates or returns a concrete schema
error for one bounded retry. Do not make this extra model call mandatory until
a controlled comparison shows that its accuracy gain justifies its latency and
cost.

The initializer is an alternate `ContractAuthor`, not a second contract format
or a permanent architectural layer. In both modes, the original task remains
authoritative and the final verifier remains independent.

### 2. Derive output status instead of maintaining task state

The application needs a compact way to tell the worker what remains, but it
does not need `TaskRequirements`, `TaskProgress`, `Goal`, `CollectionItem`, or
`CoverageSet` objects.

Build an output summary from the contract, current tables, published files, and
validation failures:

~~~ts
interface OutputSummary {
  outputId: string;
  state: 'missing' | 'in_progress' | 'valid' | 'invalid';
  paths: string[];
  failures: string[];
}

function summarizeOutputs(
  contract: OutputContract,
  outputs: PublishedOutput[],
  tables: OutputTable[],
  evidence: Evidence[],
): OutputSummary[];
~~~

This summary is computed for model context; it is not another persisted state
machine. For “collect the top 30 contributors,” the table's row-count,
uniqueness, required-value, and optional exact-value rules determine what is
missing.

### 3. Give the application an accurate view of the browser

The browser controller—not the model—should track tabs, embedded frames,
documents, observations, and element identity. A `documentId` changes only when
navigation, reload, or frame replacement creates a new document. An
`observationId` increments only when the runtime returns a new page snapshot.
`basedOnObservationId` selects the baseline for the returned diff. It does not
require the whole page to remain unchanged before an action can run.

~~~ts
interface ElementRef {
  id: string;
  pageId: string;
  frameId: string;
  documentId: string;

  backendNodeId?: number;
  role: string;
  name: string;
  /** A display hint only; never sufficient for a mutating fallback match. */
  ordinal?: number;
}

interface BrowserPage {
  pageId: string;
  documentId: string;
  observationId: number;
  url: string;
  title: string;
  active: boolean;
  frames: Array<{ frameId: string; documentId: string; url: string }>;
}
~~~

Before every action, revalidate its element reference in this order:

1. Use the browser's exact internal node ID if it is still connected to the
   expected document.
2. Otherwise try the stable locator saved when the element was observed, within
   that same document.
3. Otherwise match its role and visible name only when that pair is unique in
   the expected document. A saved ordinal may help explain a stale error, but
   must never retarget a mutating action after a list reorders.
4. If none of those works, report that the reference is stale and inspect the
   page again.

Unrelated DOM mutations and an old `observationId` do not invalidate every
element on the page. `stale` means the expected document was replaced or the
specific target can no longer be resolved uniquely. This keeps the useful
human description (“the Submit button”) while avoiding both wrong-row actions
and constant reinspection on live pages.

### 4. Use `browser_action` for normal browser interaction

`browser_action` performs one action or a short sequence of related actions,
such as filling two fields and submitting a form. It returns the updated page
instead of forcing the model to spend another turn asking what happened.

~~~ts
type BrowserAction =
  | { op: 'navigate'; url: string }
  | { op: 'click'; target: ElementRef }
  | { op: 'fill'; target: ElementRef; text: string }
  | { op: 'press'; target?: ElementRef; key: string }
  | { op: 'select'; target: ElementRef; values: string[] }
  | { op: 'check'; target: ElementRef; checked: boolean }
  | { op: 'hover'; target: ElementRef }
  | { op: 'drag'; source: ElementRef; target: ElementRef }
  | { op: 'upload'; target: ElementRef; runPath: string }
  | {
      op: 'scroll';
      direction: 'up' | 'down';
      amount: { unit: 'pixels' | 'viewport'; value: number };
    };

type SuccessCheck =
  | { type: 'url_matches'; pattern: string }
  | { type: 'element_exists'; role: string; name: string }
  | { type: 'text_present'; text: string }
  | { type: 'download_started' }
  | { type: 'popup_opened' };

interface PageChanges {
  basis: 'requested_observation' | 'full_snapshot';
  navigated: boolean;
  url?: { before: string; after: string };
  newlyVisible: ElementRef[];
  noLongerVisibleElementIds: string[];
  updatedText: Array<{ elementId?: string; text: string }>;
}

interface SettlePolicy {
  successCheckTimeoutMs?: number;
  quietWindowMs?: number;
  settleTimeoutMs?: number;
}

interface BrowserActionReceipt {
  index: number;
  op: BrowserAction['op'];
  status: 'completed' | 'failed' | 'stale';
  effectsCommitted: boolean;
  error?: string;
}

interface DownloadInfo {
  pageId: string;
  sourceUrl: string;
  suggestedFilename?: string;
  mediaType?: string;
  bytes?: number;
  artifactPath?: string;
}

interface BrowserDialog {
  dialogId: string;
  pageId: string;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultValue?: string;
}

type BrowserBlockReason =
  | 'login'
  | 'captcha'
  | 'rate_limit'
  | 'bot_challenge'
  | 'permission';

interface BrowserActionInput {
  pageId: string;
  documentId: string;
  basedOnObservationId: number;
  actions: [BrowserAction, ...BrowserAction[]];
  successChecks?: SuccessCheck[];
  settle?: SettlePolicy;
}

interface BrowserActionOutput {
  status: 'completed' | 'partial' | 'stale' | 'blocked' | 'failed_check' | 'failed';
  previousObservationId: number;
  actionReceipts: BrowserActionReceipt[];
  stoppedBeforeIndex?: number;
  stopReason?: 'navigation' | 'document_replaced' | 'popup' | 'dialog' | 'failure';
  settled: boolean;
  checks: Array<{ check: SuccessCheck; passed: boolean }>;
  currentPage: BrowserPage;
  changes: PageChanges;
  openedPages: BrowserPage[];
  dialogs: BrowserDialog[];
  downloads: DownloadInfo[];
  blockedReason?: BrowserBlockReason;
  retryAfterMs?: number;
  error?: string;
}
~~~

The output includes the landed URL and title, relevant content and controls that
changed, new pages, dialogs, downloads, and whether navigation occurred. Each
receipt says whether that action's effects committed. Earlier effects are never
rolled back. If a success check fails after a click or fill succeeds, the result
is `failed_check` with `effectsCommitted: true`, not a generic failure that
suggests the page is unchanged.

The Zod schema allows one to eight actions, all against one page and document.
The runtime revalidates every target immediately before use. Navigation,
document replacement, an unexpected popup, or a dialog stops the sequence.
Page switching uses a separate `switch_page` tool and cannot be mixed with
element actions. This gains the speed of batching without blindly continuing
and replaces the separate `browser_batch` tool.

An action that triggers navigation still completed. If it is the last action,
the whole sequence can be `completed`; otherwise the result is `partial`, names
the first unexecuted index, and returns the new document. Upload paths go
through `resolveRunPath` and can reference only files already inside the run
directory.

After the final committed action, wait for its explicit success checks or
expected navigation, then for a relevant-DOM quiet window. These waits have
separate limits: start with 10 seconds for a success check, a 250 ms quiet
window, and a 2 second settle timeout. Cap caller overrides at 30 seconds,
1 second, and 10 seconds respectively. A failed success check returns
`failed_check`; a settle timeout returns the best current snapshot with
`settled: false`. These are tunable provider defaults, not promises that the
whole network is idle. Do not rely on global `networkidle`, which never arrives
on many live applications, and never label a half-observed reaction as settled.

Classify recognizable login walls, CAPTCHAs, rate limits, and bot challenges as
`blocked` rather than generic action failures. Respect bounded `Retry-After`
delays; interactive runs may use `ask_user_question` for login or CAPTCHA
handoff, while unattended runs preserve the blocker and partial artifacts. The
caller chooses headed, headless, or authenticated session policy—never infer it
from a task name or task text.

`PageChanges` contains only the affected or previously observed regions and is
size-capped. Larger changes use the existing scratch offload mechanism rather
than serializing the entire page into every action result.
If the requested observation baseline has been evicted, return a bounded full
snapshot with `basis: 'full_snapshot'`; do not call the page stale merely
because a diff cache entry expired.

~~~text
Current: observe → click → observe → fill → click → observe
V2:      observe → browser_action → updated page
~~~

### 5. Make `execute_javascript` a normal page capability

Page-scoped JavaScript should not be reserved for emergencies. It is often the
fastest reliable way to inspect a page, extract repeated data, read embedded
application state, traverse shadow DOM, or work with virtualized lists and
unusual controls.

~~~ts
interface ExecuteJavaScriptInput {
  pageId: string;
  frameId: string;
  documentId: string;
  basedOnObservationId: number;
  code: string;
  timeoutMs?: number;
  successChecks?: SuccessCheck[];
  settle?: SettlePolicy;
  captureEvidence?: {
    label?: string;
    includeDomSnapshot?: boolean;
  };
}

interface ExecuteJavaScriptOutput {
  status: 'completed' | 'stale' | 'blocked' | 'failed_check' | 'failed';
  previousObservationId: number;
  result?: JsonValue;
  resultOffloadedTo?: string;
  evidence?: Evidence;
  pageChanged: boolean;
  settled: boolean;
  checks: Array<{ check: SuccessCheck; passed: boolean }>;
  currentPage: BrowserPage;
  changes: PageChanges;
  openedPages: BrowserPage[];
  dialogs: BrowserDialog[];
  downloads: DownloadInfo[];
  logs: string[];
  blockedReason?: BrowserBlockReason;
  error?: string;
}
~~~

Use the cheapest reliable mechanism for each step:

- `browser_action` for ordinary navigation and interactions where real browser
  events matter;
- `execute_javascript` for page inspection, bulk extraction, transformation,
  and complex interactions that are clearer in code.

JavaScript runs inside the selected webpage, never in Node.js or the host
filesystem. Each execution has a timeout and output-size limit, returns only
JSON-compatible values, and records its code and result in the transcript. The
application also captures page changes, navigation, popups, dialogs, downloads,
logs, and errors. A caller-supplied timeout is capped by the provider's finite
maximum.

`frameId` makes execution target one explicit document, including an embedded
frame. Results use the same per-result and combined-result caps as every other
tool: a large value is written through `writeArtifact` under
`scratch/tool-output/`, while the model receives a bounded preview and path.
When `captureEvidence` is set, save a manifest-hashed evidence artifact
containing the source URL, document identity, executed code, complete extracted
result, and—when requested—a supporting DOM snapshot. The returned evidence ID
can support every row produced by that bulk extraction.

The tool definition remains fixed and is generated in the same order every
time. Page-specific data belongs in the tool input, so adding this capability
does not make the cached prompt prefix vary between runs.

Because model-generated JavaScript can change the page even when it claims to
be read-only, the scheduler treats every call as a write to that page. Calls on
independent pages may still run concurrently.

A timer alone cannot stop synchronous JavaScript that freezes the browser's page
process. The browser provider must be able to terminate execution. If it cannot restore
the page to a known state, it closes that page, invalidates its element
references, and creates a replacement page. The result reports this recovery as
a failed execution rather than leaving the run hung.

Authenticated execution remains deliberately capable in V1. It is logged but
is not falsely described as sandboxed: page-scoped code can access page-visible
session state and make requests. The authenticated lane's configuration must
set JavaScript to `allow` or `deny`. When a task requires a non-disposable
account, `allow` is an explicit risk acceptance for that lane; the design does
not pretend the account is low value. A future hardened mode may deny specific
origins or run in a disposable context, but capability comes first in this
phase.

### 6. Inspect the right kind of content for the job

No single page representation works everywhere. Accessibility data is good for
buttons and forms, raw page text is good for quotations, table parsing is good
for rows and columns, and screenshots are necessary when layout or visual
meaning matters. The agent should ask for the smallest useful view.

~~~ts
interface ObserveRequest {
  pageId: string;
  target?: ElementRef | { text: string };
  need: Array<'interactive' | 'text' | 'table' | 'visual' | 'document'>;
}
~~~

Available inspection modes should include:

1. Compact accessibility snapshot for ordinary interaction.
2. Accessibility data for one relevant section instead of the whole page.
3. Structured HTML table extraction.
4. Exact page text linked back to its source element for quotations.
5. Cropped screenshot for visual ambiguity.
6. Full screenshot for evidence.
7. PDF text and layout extraction.
8. Spreadsheet parsing.
9. OCR for image-only documents.

When the task depends on layout, charts, images, or other visual information,
the model should actually receive the image. Saving a screenshot as evidence is
a separate operation: one helps the model reason, while the other creates a
durable output for the auditor.

### 7. Read public data directly when the webpage exposes it

Many “browser” tasks involve data that a webpage already loads from a JSON
endpoint, CSV export, PDF, or HTML table. Once the browser has discovered such
a public URL, the agent should be able to read it through an anonymous browser
context instead of clicking through hundreds of rows.

~~~ts
interface ReadResourceRequest {
  url: string;
  format: 'auto' | 'json' | 'html' | 'csv' | 'pdf' | 'binary';
  extract?: {
    jsonPath?: string;
    css?: string;
    table?: number;
  };
}

interface ReadResourceOutput {
  preview: JsonValue | string;
  parsedResultOffloadedTo?: string;
  evidence: Evidence;
}
~~~

Use this only after the agent has found or reasonably derived the relevant
public resource URL. The runtime accepts only an HTTP(S) URL whose site was
visited or whose exact URL appeared on an observed page. The reader sends no
profile cookies, authorization headers, or stored credentials. It may still use
a real browser network stack and ordinary browser headers for public sites that
reject lightweight HTTP clients.

Because this tool is explicitly for public resources, resolve and validate
every connection target and redirect. Reject credential-bearing URLs and
loopback, private, link-local, and reserved IPv4 or IPv6 destinations. A future
internal-source mode should be an explicit session policy, not an accidental
side effect of a webpage-provided URL.

Examples include:

- GitHub JSON endpoints;
- page-embedded JSON;
- CSV exports;
- accessible APIs;
- PDFs;
- HTML tables.

This can replace many slow pagination steps with one read. Every successful
call saves the bounded original response bytes as a `network_response` evidence
artifact and returns only a parsed preview or offload path to the model. The
tool writes evidence, so the scheduler treats it as a write even though the
network request itself only reads data.

The source named in the task and the page the worker deliberately opened decide
which data is authoritative. A resource endpoint is only a faster way to read
that source; it is not permission to silently switch datasets.

Before using endpoint data for final values, compare a small sample and its
ordering with the visible page. If they disagree, use the task-named source or
record the ambiguity and ask the user when it changes the answer. This keeps
results grounded in the requested source while retaining the speed of direct
reads when both views match.

`execute_javascript` operates on the live webpage. `read_resource` retrieves a
raw public resource such as a large JSON response, CSV, PDF, or binary file.
Keeping both avoids loading every resource into the document merely so
JavaScript can read it.

### 8. Store rows as data, then generate the output file

For structured output, the model should add rows to an `OutputTable`, not
hand-write CSV text. The corresponding table `OutputSpec` in the contract is
the only source of truth for its filename, format, columns, and rules.

~~~ts
type DateOutputFormat =
  | { kind: 'iso_date' }
  | { kind: 'iso_datetime' }
  | {
      kind: 'unicode_pattern';
      /** Unicode Technical Standard #35 tokens. */
      pattern: string;
      locale: string;
    };

type OutputColumn = {
  name: string;
  required: boolean;
} & (
  | { type: 'string' | 'integer' | 'number' | 'boolean' | 'url' }
  | { type: 'enum'; values: [string, ...string[]] }
  | {
      type: 'date' | 'datetime';
      format: DateOutputFormat;
      timezone?: string;
    }
);

interface OutputRow {
  rowId: string;
  values: Record<string, unknown>;
  evidenceIds: string[];
}

type TableCompletenessEvidence =
  | {
      method: 'authoritative_list' | 'pagination_exhausted' | 'ranked_view';
      evidenceIds: [string, ...string[]];
      note?: string;
    }
  | {
      method: 'explicit_assumption';
      note: string;
      evidenceIds?: string[];
    };

type TableRule =
  | { type: 'exact_row_count'; value: number }
  | { type: 'minimum_row_count'; value: number }
  | { type: 'unique'; columns: string[] }
  | {
      type: 'matches_expected_values';
      column: string;
      expected: string[];
      source:
        | { kind: 'original_task' }
        | { kind: 'evidence'; evidenceIds: string[] };
    };

interface OutputTable {
  outputId: string;
  version: number;
  rows: OutputRow[];
  completenessEvidence?: TableCompletenessEvidence;
}

interface UpsertOutputRowsInput {
  outputId: string;
  expectedVersion?: number;
  rows: [OutputRow, ...OutputRow[]];
}

interface DeleteOutputRowsInput {
  outputId: string;
  expectedVersion?: number;
  rowIds: [string, ...string[]];
}

interface SetTableCompletenessInput {
  outputId: string;
  expectedVersion?: number;
  evidence: TableCompletenessEvidence;
}
~~~

When rows are added, the application looks up the contract's `OutputSpec` by
`outputId` and rejects:

- missing required values;
- unexpected columns;
- values that do not match their URL, numeric, enum, date, datetime, format,
  or timezone contract;
- duplicates when disallowed;
- rows without required evidence;
- values that spreadsheet programs could accidentally execute as formulas.

Every factual row requires at least one valid evidence ID by default; this is
not an optional worker-selected rule. `upsert_output_rows` inserts or replaces
stable `rowId` values atomically, `delete_output_rows` removes mistakes without
rebuilding a table, and both advance `version`. `expectedVersion` provides
optional protection against overwriting a newer table update. The scheduler
still runs updates to one table in sequence.

Store dates and times internally in standard ISO form. If the user requires a
specific display format, the contract records the exact Unicode Technical
Standard #35 pattern, locale, and timezone. Timezones must be valid IANA names,
and the formatter version must be pinned so upgrades do not silently change the
output. A date copied exactly from a source can remain a string. This prevents
small formatting changes from breaking an otherwise correct result.

Any table with an exact or minimum count rule must also carry
`completenessEvidence`. This is a narrow proof attached to that output—not a
general `Dataset`, checklist, or coverage state machine. It records whether the
worker used an authoritative list, reached the end of pagination, captured a
ranked view, or had to make an explicit assumption. Missing completeness
evidence fails the code check. The verifier judges whether the cited proof
actually supports the claimed population.

The model does not need a separate “finalize table” tool. When it calls
`submit_for_verification`, application code validates the current rows against
the latest contract revision, renders the requested format, and writes the
actual requested-output artifact through `writeArtifact`. The verifier then
reads that exact file. Every row mutation advances `version`, which supports
safe one-at-a-time updates and output-summary caching; it is not another piece of
progress state for the model to maintain.

`matches_expected_values` handles cases that require proof that nothing was
missed. After discovering the complete contributor list, for example, the
worker can require the `Profile URL` column to match that list exactly.

Because those URLs were unknown before browsing, the new rule requires a
numbered contract revision and the evidence IDs that support the list. Values
stated directly by the user can cite the original task instead. Rules are never
attached silently.

This prevents malformed rows, avoids repeatedly reading and rewriting a growing
file, and uses far fewer model output tokens.

### 9. Link every important fact to its evidence

Each output row or factual statement should record which screenshot, webpage
text, JavaScript extraction, download, or network response supports it.

~~~ts
interface EvidenceBase {
  id: string;
  sourceUrl: string;
  capturedAt: string;
}

type Evidence = EvidenceBase &
  (
    | {
        kind: 'screenshot' | 'download' | 'network_response';
        artifactPath: string;
      }
    | {
        kind: 'web_text';
        artifactPath: string;
        quote?: string;
        locator?: ElementRef;
      }
    | {
        kind: 'web_text';
        quote: string;
        locator: ElementRef;
        artifactPath?: string;
      }
    | {
        kind: 'javascript_extraction';
        artifactPath: string;
        pageId: string;
        frameId: string;
        documentId: string;
      }
  );
~~~

`OutputRow.evidenceIds` is the table link; do not maintain a second evidence
index that can drift out of sync. Natural-language outputs use inline markers
such as `[evidence:E17]`. Completion code parses those markers, confirms every
ID exists, and passes the cited document spans and evidence to the verifier.
This avoids introducing a `Claim` store and claim-creation tool before the
product has demonstrated that it needs them.

Final prose uses `write_document({ outputId, content })`, which looks up the
contract rather than accepting another filename or format. Markdown and text
are written directly; PDF is rendered from the same content by application
code. `write_file` remains available for scratch work and supporting files, but
does not bypass contract-bound document rendering.

The evidence-marked source and the published document are separate artifacts.
`write_document` first saves the marked source under
`scratch/documents/<outputId>/` through `writeArtifact`. Completion code
validates its markers and evidence requirement, then deterministically renders
the requested output. With `evidencePresentation: 'hidden'`, internal markers
are removed from the published file. With `footnotes`, they become readable
source footnotes rather than raw evidence IDs. The clean requested output and
the marked scratch source are both manifest-hashed, and the verifier receives
both so it can check that the published wording came from the cited source.

An `Evidence` object is an index, not the evidence itself. Screenshots,
downloads, and saved network responses must point to a manifest-hashed artifact.
Web-text evidence must contain either a captured artifact or an exact quote and
locator. A JavaScript extraction points to the artifact containing its code,
complete result, source document identity, and optional DOM snapshot. This
keeps every reference reviewable from the run directory rather than relying on
the worker transcript.

The current manifest hashing is sufficient for the initial capability-focused
version. Stronger signing can be added later.

### 10. Require the agent to prove it is finished

The current loop treats any response with no tool call as completion. That can
also happen when the model reaches a token limit, refuses, or simply forgets to
continue. Replace this with the explicit `submit_for_verification` tool. The
name is deliberate: the worker requests verification; it does not decide that
the run is complete.

> **Claude Code influence — same-conversation correction:** Claude Code's
> `handleStopHooks` can block a proposed stop and append the reason to the
> current conversation. `submit_for_verification` uses the same control-loop
> shape, but adds browser-evidence checks and a separate verifier model.

Completion has two gates:

1. `CompletionCheck` uses ordinary code for facts with objective answers.
2. A fresh verifier model handles meaning, visual evidence, and ambiguous
   questions that code cannot settle.

The code gate checks table state and evidence, renders valid table outputs, and
then checks the actual published artifacts.

~~~ts
interface SubmitForVerificationInput {
  unresolvedLimitations?: string[];
}

type CompletionCheckResult =
  | { status: 'blocked'; failures: CompletionFailure[] }
  | { status: 'ready_for_review'; outputs: PublishedOutput[] };

async function runCompletionCheck(
  revision: OutputContractRevision,
  tables: OutputTable[],
  evidence: Evidence[],
): Promise<CompletionCheckResult> {
  const currentOutputs = publishedOutputs.all();
  const stateFailures = [
    ...validateTableRules(revision.contract, tables),
    ...validateTableCompleteness(revision.contract, tables, evidence),
    ...validateEvidenceReferences(tables, currentOutputs, evidence),
  ];

  if (stateFailures.length > 0) {
    return { status: 'blocked', failures: stateFailures };
  }

  await renderTableOutputs(revision, tables); // uses writeArtifact
  const outputs = publishedOutputs.all();
  const artifactFailures = validateExpectedOutputs(
    revision.contract,
    outputs,
    tables,
  );

  return artifactFailures.length > 0
    ? { status: 'blocked', failures: artifactFailures }
    : { status: 'ready_for_review', outputs };
}
~~~

The submission handler changes state, so it runs alone: earlier calls finish
before it starts, and no later call starts before it finishes. Rendering or
write failures become ordinary `CompletionCheck` failures; they never count as
completion.

`submit_for_verification` must be the only tool call in its response. The
provider stream must contain a terminal `message_delta`, a non-error stop
reason, and `message_stop`.

Do not require the stop-reason label to agree perfectly with the content. Some
providers have returned `end_turn` for a response that contains tool calls, or
`tool_use` for one that does not. The model API integration may allow both
labels. It must still reject `max_tokens`, refusal, context-window exhaustion,
and an absent stop reason. Tool-call content decides what executes;
`submit_for_verification` decides whether completion was requested.

None of the following can complete a run:

- a response with no tool call;
- a `max_tokens` stop;
- a provider refusal;
- a malformed tool block;
- a network stream that ends early.

Code-check and verifier failures return as the tool result for the same
submission call. The same worker conversation receives that result and
continues from its current browser and reasoning context.

Treat each model response as a proposal until its structure is accepted. If it
mixes submission with other calls or exceeds the per-turn call limit, record
the rejected attempt in the audit log but do not add it to model history. Retry
the same turn with a short explanation of the protocol error.

This is all-or-nothing response acceptance. It prevents partial responses from
creating unanswered tool calls. Once a response is accepted, every tool use
gets exactly one result, including validation and blocked-call errors.

Checks with objective answers run first:

- every contract output has an actual published artifact;
- every table artifact was rendered from the current rows and contract
  revision;
- exact columns;
- whether files can be parsed;
- row counts;
- uniqueness and exact matches against any discovered source list;
- completeness evidence for every count-ruled table;
- screenshot counts;
- unfinished placeholders such as `TODO` or missing values;
- row evidence and document citation linkage;
- each document's configured minimum or per-section evidence requirement.

After the code checks pass, open one verifier session with fresh context. A
small run may finish in one model call. A large run gets a limited set of
read-only tools so it can inspect outputs separately, read tables in chunks,
and view screenshots as images. It does not receive the entire run in one
unbounded prompt.

~~~ts
type VerificationFinding = {
  area: 'contract' | 'output' | 'evidence' | 'completeness';
  code: string;
  message: string;
  outputId?: string;
  evidenceIds?: string[];
};

type VerificationResult =
  | { status: 'verified'; findings: [] }
  | {
      status: 'needs_correction';
      findings: [VerificationFinding, ...VerificationFinding[]];
    };

type VerifierOutcome =
  | VerificationResult
  | { status: 'verifier_unavailable'; reason: string };

interface VerificationInput {
  originalTask: string;
  contract: OutputContract;
  contractHistory: OutputContractRevision[];
  outputs: PublishedOutputSummary[];
  tables: OutputTableSummary[];
  evidence: EvidenceSummary[];
  codeChecks: CompletionCheckResult;
  reportedLimitations: string[];
}
~~~

The verifier must return its decision through a schema-validated
`report_verification` tool. Do not parse `DONE`, `CONTINUE`, headings, or JSON
from ordinary model prose. The schema allows two results:

- `verified`, with no findings;
- `needs_correction`, with at least one specific finding.

A malformed response, token-limit stop, early stream ending, or verifier crash
never becomes `verified` by default. A structurally invalid verdict may receive
one bounded repair turn with the schema error returned explicitly. If that also
fails, the outcome is `verifier_unavailable`.

The verifier checks four relationships:

~~~text
Original task ↔ Output contract
Output contract ↔ Produced outputs
Original task ↔ Produced outputs
Factual rows and document citations ↔ Evidence
~~~

Checking the original task prevents an incorrect contract from validating its
own mistake. The verifier starts from small summaries and gets read-only tools
for published artifacts, marked document sources, evidence files, screenshots,
contract history, and code-check results. It does not receive arbitrary scratch
files, the worker transcript, a mutable browser, or write tools. Code has
already handled columns, counts, filenames, duplicates, and parseability.

Completeness is a named verifier decision, not an implication hidden inside
general alignment: for each count-ruled table, the verifier must decide whether
the cited enumeration method could reasonably establish the claimed
population. An explicit assumption is acceptable only when the source offers no
stronger proof and the limitation is visible in the output. It can explain an
incomplete run or a requested sample, but it is never sufficient to prove an
exact population or top-N boundary. Those require an authoritative list,
pagination exhaustion, or a captured ranked view that includes the boundary.

If verification fails, return its structured findings to the same worker. The
worker corrects the run and submits again; it is not restarted.

Use two counters because the failures have different costs. Allow up to five
submissions blocked before the verifier by a missing contract or failed code
check. Allow three submissions that actually reach the verifier: the first
review plus two semantic corrections. Both remain inside the whole-run turn,
tool, token, and time budgets.

`OutputSummary` should expose table-state, evidence-link, and completeness
failures before submission, so the worker normally fixes them without spending
a completion-check attempt. Rendering, file-write, and final artifact failures
can appear only during submission and are returned through the same result.
Repeated pre-verifier failures end the run as incomplete; they do not consume
the verifier's correction allowance.

`finalizeIncompleteRun()` tries to render every table's current rows through
`writeArtifact`, even when count or completeness checks fail. These files keep
the `requested_output` role and receive `completionStatus: 'partial'` in the
manifest. This requires adding that optional field to the manifest schema; it
must not be hidden in an unrelated metadata string. Rendering failures are
recorded, but the manifest, transcript, and metrics still close. This preserves
useful partial work without claiming that it satisfied the request.

Top-level run outcomes should say what actually happened:

~~~ts
type RunOutcome =
  | { status: 'verified' }
  | {
      status: 'incomplete';
      reason:
        | 'verification_attempts'
        | 'completion_check_failures'
        | 'verifier_unavailable'
        | 'budget_exceeded'
        | 'model_response_failed';
    }
  | { status: 'failed'; error: string }
  | { status: 'cancelled' };
~~~

`verified` is the only success state. `incomplete` preserves usable partial
work. `failed` means the runtime itself broke, and `cancelled` means the user or
caller stopped the run.

### 11. Keep the audit log, but give the model a compact memory

The full transcript remains the audit record. Do not replace the current
append-only, cache-friendly conversation with a wholly rebuilt prompt every
turn: measured deep runs already benefit heavily from moving prompt-cache
breakpoints. Keep the existing conversation for recent work, and add a small
state summary only when older detail must be removed.

Keep system tools and the original task as a stable cached prefix. Append recent
tool conversation normally. Add a compact state snapshot only when its source
data changes. When older conversation must be summarized, do it at an explicit
boundary that can become a new cached prefix.

> **Claude Code influence — cache-safe request construction:** Claude Code's
> `createCacheSafeParams` preserves the original prompt inputs, and
> `buildForkedMessages` uses byte-identical placeholder results across child
> requests. This proposal borrows that byte-stability discipline without
> copying the full parent conversation into every research job.

A contract revision affects requests from that revision forward. It does not
rewrite unrelated earlier turns.

That compact view should contain:

- the current contract revision;
- the derived output summary;
- current page states;
- recent actions and failures;
- normalized records of repeated failures, so an old failed strategy is
  not retried after its raw turn leaves the recent window.

~~~ts
interface AgentContext {
  contractRevision?: OutputContractRevision;
  outputs: OutputSummary[];
  pages: BrowserPage[];
  recentEvents: RunEvent[];
  repeatedFailures: Array<{
    actionKey: string;
    reason: string;
    count: number;
    lastTurn: number;
  }>;
}
~~~

There is no model-maintained notes tool or hidden retrieval subsystem in V1.
Record each event once in the audit log, and derive the compact state from the
current contract, tables, browser state, and evidence index. Gate rollout on
controlled comparisons of pass rate, wall time,
time to first token, cache reads and writes, and total cost per run—not raw
prompt length alone.

Tool-result shortening must also preserve cache stability:

- When a result is first shown to the model, freeze whether it is inline or
  offloaded for that conversation.
- If it is offloaded, persist the exact preview string the model saw. Do not
  regenerate it later from a new template.
- Replace a genuinely empty result with a short marker such as
  `(tool completed with no output)` so the model does not mistake an empty tail
  for the end of its turn.
- Compact only large, replaceable observations such as old page inspections.
  Never compact away the current contract, output tables, or evidence index.

These rules keep old request bytes stable and avoid silent prompt-cache misses.

### 12. Run only clearly independent work in parallel

Do not create a general swarm of browser agents. First divide the task into
well-defined items with clear inputs and outputs; then run items concurrently
only when they cannot interfere with one another.

Good candidates include:

- independent entity profiles;
- independent pull request pages;
- independent downloads;
- public resource fetches;
- PDF parsing and OCR;
- evidence validation.

This does not require a general task graph. Extend the current scheduler with a
small access description for each validated tool call:

~~~ts
interface ToolAccess {
  reads: string[];
  writes: string[];
}

interface ToolDef<Input> {
  getAccess(input: Input, ctx: ToolCtx): ToolAccess;
}
~~~

An access key names shared state, such as `page:research-2`,
`table:sororities`, or `manifest`. Two calls may overlap only when neither
writes something the other reads or writes. Invalid inputs and tools without an
access declaration run alone.

> **Claude Code influence — input-aware concurrency:** Claude Code's tool
> interface exposes `isConcurrencySafe(input)`. Its `runTools` implementation
> validates input before choosing parallel work and applies queued state changes
> in request order. `getAccess` extends that boolean decision into explicit
> page, file, manifest, and table reads and writes.

This is more accurate than one static `readOnly` flag. For example,
`execute_javascript` always writes its selected page because generated code may
change the DOM. It can still run beside work on another page.

`observe` does not change the webpage, but it does advance the controller's
observation ID and diff baseline. Treat it as a write to that page's observation
state: two observations of the same page run in order, while observations of
different pages may overlap. This serialization is deliberate; otherwise two
snapshots could both claim to be the next baseline.

Scheduling rules:

- Actions that change one page remain sequential.
- Independent pages may run concurrently.
- Independent public resources may fetch concurrently, but their evidence
  artifacts update the manifest in sequence.
- Output-table updates run one at a time, and published files still go through
  `writeArtifact`.
- Reject a response that exceeds `maxToolCallsPerTurn` before executing any of
  its calls. Every attempted call also counts toward the total run limit,
  regardless of how small its result is.
- Apply both per-result and combined-result size limits; offloading one large
  result must not let many small results overflow the next model request.
- A failed call gets its own error result without cancelling successful,
  independent calls.
- Results and application-state updates are committed in the model's original
  call order, even when the underlying work finishes in another order.

The combined-result limit applies to the final message the model will receive,
not just to each result in isolation. If needed, offload results that are below
their individual limit and return a path with no preview. The per-turn call cap
keeps the set of minimal path references itself small. Every tool call still
receives one result.

Parallelism is a speed optimization, not the planning model. The worker may
issue a few independent calls in one response. It should not maintain many
open-ended research conversations.

Repeated entity research is the one place where bounded worker jobs are worth
testing. Each job has its own browser session, cancellation signal, limits,
transcript, and result file:

> **Claude Code influence — isolated child work:** Claude Code's
> `registerAsyncAgent` gives child agents linked cancellation and their own
> transcript, while `runForkedAgent` creates an isolated tool context. A
> `ResearchJob` adds browser-specific limits and a typed rows-and-evidence
> result, and it forbids recursive workers and shared-output writes.

~~~ts
interface ResearchJobResult {
  jobId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  rows: OutputRow[];
  evidencePaths: string[];
  limitations: string[];
  usage: {
    turns: number;
    modelTokens: number;
    durationMs: number;
  };
}
~~~

Build one worker template containing the original task, output contract,
extraction rules, and tool definitions. Reuse those exact bytes for every job,
then append only the entity-specific instruction. This lets workers share the
cached prefix without inheriting the coordinator's entire conversation.

Each research worker:

- receives only the tools it needs;
- cannot start more workers;
- writes private status and result data under
  `scratch/research-jobs/<jobId>/` through `writeArtifact`;
- publishes evidence under a job-specific artifact path;
- returns typed rows and evidence, not a free-form transcript;
- cannot edit the shared output table, contract, spreadsheet, or final files.

The coordinator receives a small completion notice and reads the typed result.
It does not copy every child tool call into its own model context. Start with two
or three concurrent jobs and measure the gain before raising the limit.

Merge behavior is explicit and never last-write-wins. While results are staged,
identify each row as `<jobId>:<rowId>`. Group candidates by the contract's
uniqueness keys and validate cross-job rules before updating the shared table.
Non-conflicting rows can merge automatically. Conflicting values, duplicate
entities, or cross-job rule failures become structured merge failures for the
coordinator, which is the only role allowed to choose the final row or request
more research.

Parallel browser jobs default to public, isolated, headless sessions. Keep
authenticated or headed research at one concurrent job until load tests show
that the machine and target site remain reliable.

### 13. Bound every resource explicitly

Concurrency limits are not total-work limits. Every run needs independently
validated, finite budgets:

~~~ts
interface RunBudget {
  maxModelTurns: number;
  maxWallTimeMs: number;
  maxPromptTokensPerTurn: number;
  maxOutputTokensPerTurn: number;
  maxTotalModelTokens: number;
  maxConcurrentToolCalls: number;
  maxToolCallsPerTurn: number;
  maxToolCalls: number;
  maxModelResponseRepairs: number;
  maxConcurrentResearchJobs: number;
  maxResearchJobs: number;
  maxDownloadedBytes: number;
  maxPublishedBytes: number;
  maxCompletionCheckFailures: number;
  maxVerificationAttempts: number;
  maxVerifierModelCallsPerAttempt: number;
}
~~~

Require positive finite safe integers for time, token, turn, and call limits.
Byte limits may be zero to disable that capability; otherwise they follow the
same validation. Response-repair, research-job, completion-check-failure,
verification-attempt, and verifier-call limits must also be positive and
finite.

One run budget covers every role: optional initializer, worker, correction
turns, research workers, and verifier. Starting another worker or verification
attempt does not reset any whole-run limit. Retried and rejected model calls
also count whenever the provider reports usage. Metrics use the same boundary.

Enforce limits before or while work consumes them. Check a tool-call batch
before scheduling it, stop a streamed download at its byte limit, and stop
starting new research jobs when their shared allowance is exhausted.

### 14. Use one shared model driver everywhere

The CLI, eval runner, and TUI should not each implement their own version of the
model loop. Put provider streaming, cancellation, prompt caching, response
assembly, usage accounting, and terminal-state validation behind one driver:

~~~ts
interface ModelDriver {
  generateAttempt(
    request: ModelRequest,
    options: {
      signal: AbortSignal;
      onEvent?: (event: ModelLifecycleEvent) => void;
    },
  ): Promise<ModelAttempt>;
}

type ModelAttempt =
  | { status: 'accepted'; response: CompleteModelResponse }
  | {
      status: 'retryable';
      reason: 'stream_ended_early' | 'transport_error' | 'max_tokens';
    }
  | {
      status: 'rejected';
      reason: 'refusal' | 'context_window_exhausted' | 'malformed_response';
    };
~~~

> **Claude Code influence — retry cleanup:** Claude Code's query loop removes
> partial assistant messages and pending tool results before a fallback, and it
> can retry the same request with a larger output-token limit. This design
> borrows that cleanup and retry discipline. It deliberately does **not** borrow
> Claude Code's optional `StreamingToolExecutor`, because a browser action may
> change an external page and cannot be rolled back safely.

The TUI observes typed lifecycle events and cancels through `AbortSignal`; it
does not copy the production model client. The driver returns `accepted` only
after the provider's required terminal events and an allowed non-error stop
reason. The model API layer may tolerate a provider's `end_turn` versus
`tool_use` label mismatch; it never tolerates a missing or error stop reason.

An early network ending, temporary connection error, incomplete content block,
refusal, and token-limit stop are typed non-success outcomes. Plain text that
merely sounds reluctant is not classified by a text heuristic; without
`submit_for_verification`, it cannot complete the run anyway.

For `max_tokens`, the retry policy may repeat the same request content once with
a larger output allowance. Temporary connection failures repeat the exact
request. Neither path adds a partial answer to conversation history. Because
tools start only after a complete response is accepted, a retry cannot
duplicate a browser action.

Do not execute tools while their calls are still streaming. That optimization
makes retries unsafe after a page-changing action has started. The TUI may show
streaming text and tool names, but execution waits for an accepted response.

This shared driver prevents the TUI and eval runner from developing different
completion or retry behavior.

### 15. Give each model role a small, explicit tool set

The worker needs the following capabilities. Exact schemas still need
implementation specs, but no required operation should exist only as an
implication in prose.

| Tool | Purpose | Changes shared state? |
| --- | --- | --- |
| `set_output_contract` | Create or revise the output contract | Yes |
| `observe` | Return a targeted interactive, text, table, visual, or document view | Yes |
| `browser_action` | Navigate or perform a short action sequence with one receipt per action | Yes |
| `switch_page` | Select a tracked page without mixing page identity into an action sequence | Yes |
| `handle_dialog` | Accept or dismiss a tracked browser dialog with optional prompt text | Yes |
| `execute_javascript` | Inspect, extract, or interact inside one explicit page/frame document | Yes |
| `read_resource` | Read a discovered public resource anonymously and save its response as evidence | Yes |
| `capture_text` | Save exact page text plus locator and source as evidence | Yes |
| `screenshot` | Save a viewport, element, or full-page image as evidence or requested output | Yes |
| `download` | Save browser-captured bytes as evidence or requested output | Yes |
| `upsert_output_rows` | Insert or replace stable rows in one output table | Yes |
| `delete_output_rows` | Remove rows by stable ID | Yes |
| `set_table_completeness` | Attach the enumeration method and evidence to a table | Yes |
| `write_document` | Render a contract-bound Markdown, text, or PDF document with evidence markers | Yes |
| `read_file` / `grep` | Inspect run-directory state and artifacts | No |
| `write_file` | Write scratch state or supporting files through `writeArtifact` | Yes |
| `fill_credentials` | Fill credentials only for their configured origin | Yes |
| `ask_user_question` | Pause for ambiguity, login, CAPTCHA, or other human input | Yes |
| `submit_for_verification` | Render current tables and request independent review | Yes |

Other model roles receive smaller sets:

- The optional initializer gets only `set_output_contract`, with tool choice
  forced.
- The verifier gets read-only published-artifact, marked-document-source,
  evidence, and screenshot inspection plus `report_verification`. It receives
  no general scratch access, browser, or write tools.
- Research workers get only the browser, evidence, and extraction tools needed
  for their assigned entity. They cannot submit the run or start more workers.

There is no arbitrary sleep tool. Waiting is tied to an observable condition,
navigation, dialog, download, or the limited settle policy. All new tool
definitions are generated in the same order every time. During incremental
rollout, append rather than reorder existing definitions; after cutover, freeze
one V2 registration order so the prompt prefix stays byte-stable between runs.

## Revised core loop

The code below shows the control flow, not a required class structure. One
worker model chooses the next useful work. The application executes that work,
updates its records, and accepts completion only after validation succeeds.

~~~ts
async function runTask(task: string): Promise<RunOutcome> {
  const session = await browser.createSession();
  let completionCheckFailures = 0;
  let verificationAttempts = 0;

  while (!budget.expired()) {
    const contract = outputContracts.currentOrUndefined();
    const outputs = contract
      ? summarizeOutputs(
          contract,
          publishedOutputs.all(),
          outputTables.all(),
          evidenceStore.all(),
        )
      : [];

    const context = buildAgentContext({
      contractRevision: outputContracts.currentRevisionOrUndefined(),
      outputs,
      browser: session.state(),
    });

    // Nothing is added to model history until this attempt is accepted.
    const attempt = await modelDriver.generateAttempt(
      worker.buildRequest(context),
      { signal: runAbort.signal },
    );

    if (attempt.status !== 'accepted') {
      runEvents.recordRejectedModelAttempt(attempt);
      if (!prepareModelRetry(attempt, worker, budget)) {
        return finalizeIncompleteRun({ reason: 'model_response_failed' });
      }
      continue;
    }

    const checked = validateWorkerResponse(attempt.response, budget);
    if (!checked.ok) {
      runEvents.recordRejectedModelAttempt(checked);
      if (!budget.canRepairModelResponse()) {
        return finalizeIncompleteRun({ reason: 'model_response_failed' });
      }
      worker.retryCurrentTurn(checked.message);
      continue;
    }

    const { response, submission } = checked;
    worker.commitAssistantResponse(response);

    if (submission !== undefined) {
      if (contract === undefined) {
        completionCheckFailures += 1;
        const contractFailure = {
          status: 'blocked',
          failures: ['Set a valid output contract before submitting.'],
        } as const;
        runEvents.recordToolResult(submission.toolUseId, contractFailure);
        worker.addToolResult(submission.toolUseId, contractFailure);
        if (completionCheckFailures >= budget.maxCompletionCheckFailures) {
          return finalizeIncompleteRun({
            reason: 'completion_check_failures',
          });
        }
        continue;
      }

      const contractRevision = outputContracts.currentRevision();
      const codeChecks = await runCompletionCheck(
        contractRevision,
        outputTables.all(),
        evidenceStore.all(),
      );

      if (codeChecks.status === 'blocked') {
        completionCheckFailures += 1;
        runEvents.recordToolResult(submission.toolUseId, codeChecks);
        worker.addToolResult(submission.toolUseId, codeChecks);
        if (completionCheckFailures >= budget.maxCompletionCheckFailures) {
          return finalizeIncompleteRun({
            reason: 'completion_check_failures',
          });
        }
        continue;
      }

      verificationAttempts += 1;
      const verification = await verifier.review(
        {
          originalTask: task,
          contract,
          contractHistory: outputContracts.all(),
          outputs: summarizePublishedOutputs(codeChecks.outputs),
          tables: summarizeTables(outputTables.all()),
          evidence: summarizeEvidence(evidenceStore.all()),
          codeChecks,
          reportedLimitations: submission.input.unresolvedLimitations ?? [],
        },
        { signal: runAbort.signal, budget },
      );

      // Record one result, then append that same result to model history.
      runEvents.recordToolResult(submission.toolUseId, verification);
      worker.addToolResult(submission.toolUseId, verification);

      if (verification.status === 'verifier_unavailable') {
        return finalizeIncompleteRun({ reason: 'verifier_unavailable' });
      }

      if (verification.status === 'verified') {
        return finalizeRun();
      }

      if (verificationAttempts >= budget.maxVerificationAttempts) {
        return finalizeIncompleteRun({ reason: 'verification_attempts' });
      }
      continue;
    }

    const results = await scheduler.execute(response.toolCalls, {
      outputContracts,
      enforceContractOrdering: true,
    });
    runEvents.record(results);
    worker.addToolResults(results);
  }

  runEvents.recordBudgetExhausted(budget.reason());
  return finalizeIncompleteRun({ reason: 'budget_exceeded' });
}
~~~

`validateWorkerResponse` checks the whole response before committing it. It
requires at least one tool call, enforces the per-turn call limit, and requires
`submit_for_verification` to appear alone. Only then may tool execution start.

`enforceContractOrdering` implements the contract rule from Section 1. When no
contract exists, a valid leading `set_output_contract` call unlocks later calls
in that same response; a missing or invalid contract blocks them with an
explicit result. After a contract exists, the option still makes every revision
a scheduling barrier, so later calls never race ahead of validation.

`prepareModelRetry` chooses the recovery that matches the failure. A temporary
connection failure or early stream ending resends the same request content. A
token-limit retry uses the same content with a larger output allowance. A
context-window failure first removes replaceable old observations. A malformed
response gets one short protocol correction. A provider refusal is not blindly
retried. Every path is limited by the run budget and none adds the rejected
assistant response to model history. If safe context reduction is unavailable,
the run ends as `incomplete: model_response_failed`.

`retryCurrentTurn` is the narrower malformed-response path used after local
tool-call validation fails. It rebuilds the request with one short correction
at the end and does not replay the rejected assistant response.

The verifier is a separate, fresh-context model session. The worker is not. A
`needs_correction` result is appended to the same worker conversation as the
result of its submission call. This combines independent review with cheap,
well-oriented corrections.

`finalizeRun()` only closes the manifest, transcript, and metrics. Table files
have already been rendered by `CompletionCheck`; every other requested output
must already have been written through its normal artifact tool.

The important difference from the current loop is not “more agents.” It is a
clear ownership boundary. The model proposes; the application executes,
records, and verifies. This makes the model's mistakes visible and recoverable
instead of allowing them to silently become output.

## Concrete example

Suppose the request is: “Find the top 30 contributors to this repository. Save
`contributors.csv` with exactly the columns `Name`, `Profile URL`, and
`Commits`, and capture a screenshot of the leaderboard.”

V2 would handle it as follows:

1. In its first response, the worker calls `set_output_contract` with one table
   output and one screenshot output. It may navigate in the same response.
2. The model opens the repository and finds the contributor list. It can use
   `execute_javascript` with evidence capture to extract the visible list, or
   `read_resource` if the page exposes equivalent public JSON and a sample
   matches the visible ranking.
3. The contract defines a 30-row rule, exact columns, and unique profile URLs.
   If a complete contributor list becomes available, the worker can add an
   evidence-backed exact-value rule through an explicit contract revision.
4. Each `OutputTable` row stores the evidence supporting its values. The table
   also records `ranked_view` completeness evidence pointing to the captured
   leaderboard.
5. The screenshot tool saves the leaderboard as both requested output and
   evidence.
6. The worker calls `submit_for_verification` as its only tool call.
   `CompletionCheck` verifies exactly 30 unique rows and their completeness
   evidence, renders the CSV, then checks the actual file's three columns,
   profile URLs, required screenshot, and evidence links.
7. The verifier independently compares the original task, output contract,
   finished CSV, screenshot, and evidence before accepting the run.

If only 29 contributors were collected, the application returns one clear
failure—“expected 30 rows; found 29.” If an authoritative list is available, it
can name the missing profile URL. If the source genuinely exposes only 29, the
worker reports that limitation rather than weakening an explicit user request
for 30.

## Useful implementation patterns from Claude Code

The inline notes above mark where this proposal borrows from the local Claude
Code archive. These are the specific reference points:

- **Same-conversation correction:** `handleStopHooks` in
  `src/query/stopHooks.ts`.
- **Schema-backed handoffs:** `SyntheticOutputTool` in
  `src/tools/SyntheticOutputTool/SyntheticOutputTool.ts` and retry enforcement
  in `src/QueryEngine.ts`.
- **Retry cleanup:** the fallback and maximum-output-token recovery paths in
  `src/query.ts`.
- **Input-aware concurrency:** `Tool.isConcurrencySafe(input)` in `src/Tool.ts`
  and `runTools` in `src/services/tools/toolOrchestration.ts`.
- **Isolated child lifecycle:** `registerAsyncAgent` in
  `src/tasks/LocalAgentTask/LocalAgentTask.tsx` and `runForkedAgent` in
  `src/utils/forkedAgent.ts`.
- **Cache-safe child requests:** `createCacheSafeParams` in
  `src/utils/forkedAgent.ts` and `buildForkedMessages` in
  `src/tools/AgentTool/forkSubagent.ts`.

We should borrow those patterns, not the surrounding product complexity. In
particular, do not copy streaming tool execution, a general task dependency
system, full-conversation worker forks, or a very large prompt-only verifier.

## Highest-leverage work to do first

The full V2 design should not be implemented from top to bottom. The
`feat/judge-harness` experiment has already shown that an independent review
and correction loop can improve results. It also exposed control-flow problems
that are more urgent than richer browser abstractions. Tackle the following
group first, in this order.

### 1. Make completion trustworthy

This is the smallest high-severity fix. Stream assembly must require the
provider's terminal events, and the loop must reject token-limit stops,
refusals, malformed blocks, and network streams that end early. Until
`submit_for_verification` exists, a no-tool response may complete only after a
clean provider `message_stop` with a non-error stop reason.

Buffer each response until it passes those checks. A rejected response is
logged but not added to model history. For `max_tokens`, retry the same request
once with a larger output allowance. Do not start tool execution while the
response is still streaming.

Then add `submit_for_verification` as the only valid completion proposal. A
model response without that tool is either another working turn or an invalid
response; it is never proof that the task is finished.

### 2. Make the existing judge harness tell the truth

Do not scrap `feat/judge-harness`. Its measured gains justify keeping it as the
starting point, but its outcomes must be corrected before it can become the
production completion protocol:

- Judge `DONE` becomes `verified` only after a clean judge response.
- Judge `CONTINUE` at the correction limit becomes `incomplete`, not
  `completed`.
- A verifier crash preserves the worker's artifacts but marks the run
  `incomplete: verifier_unavailable`.
- One whole-run budget covers the initializer, every worker correction, and
  every verifier call. Starting a new worker cycle must not silently reset the
  turn or context budget.
- Metrics include initializer and verifier tokens and latency, not only worker
  time.
- Replace free-form `DONE` and `CONTINUE:` parsing with the validated
  `report_verification` tool. An invalid verifier response fails closed as
  `verifier_unavailable`.

Keep the harness's useful evidence boundary and screenshot review. Explicitly
make the verifier check all four relationships from Section 10, especially
original task ↔ contract; otherwise an initializer omission can validate its
own mistake.

### 3. Use one typed contract in both initializer modes

Replace free-form `INTENT.md` and `CONTRACT.md` as the executable protocol with
the structured `OutputContract` from Section 1. The original task already
contains the user's intent, so a model-authored intent paraphrase is not another
source of truth.

Support two interchangeable policies:

~~~ts
type ContractAuthor = 'worker' | 'initializer';
~~~

Both policies must produce the same validated schema and feed the same worker,
code checks, and verifier. Compare at least these four configurations:

1. Worker without a verifier.
2. Worker-authored contract plus verifier.
3. Initializer-authored contract plus verifier.
4. Initializer-authored contract without a verifier.

Compare pass rate, first-cycle acceptance, correction rate, wall time, and
total model cost. This separates the value of deliberate contract authorship
from the value of independent review and extra worker attempts.

### 4. Put code in front of the verifier

Once the contract is typed, implement the smallest useful `CompletionCheck`:

- required requested outputs exist and are non-empty;
- manifest roles and hashes are valid;
- CSV and JSON outputs parse;
- table columns are exact and in order;
- row counts, required values, and uniqueness rules pass;
- requested screenshots and downloads exist;
- document evidence requirements and markers pass;
- obvious placeholders such as `TODO` are absent.

Only semantic questions and evidence quality should reach the verifier. This
should improve consistency while reducing judge turns and variance.

Use the separate limits from Section 10: five pre-verifier completion-check
failures and three verifier reviews by default. A malformed CSV or missing row
must not consume the worker's opportunity to correct a semantic verifier
finding.

When verification requests a correction, continue the same worker conversation
and return the structured findings as the result of
`submit_for_verification`. This is the default design because it preserves page
knowledge, cached conversation, and the worker's reasoning.

Keep the current fresh-worker behavior only as a comparison during evaluation.
It spends time relearning the run and can create duplicate deliverables.

### 5. Add page-scoped JavaScript before a larger browser rewrite

Add the bounded `execute_javascript` capability from Section 5 before rebuilding
the entire browser state model. Bulk DOM extraction and embedded application
data can remove many model decisions immediately, particularly on repeated
roster, profile, and table pages.

The first useful version predates the full page/frame identity model, so it uses
a deliberately smaller input:

~~~ts
interface EarlyExecuteJavaScriptInput {
  target: 'selected_top_document';
  code: string;
  timeoutMs?: number;
  captureEvidence?: boolean;
}
~~~

The runtime locks the currently selected page, attaches its URL and internal
document token to the result, and returns JSON only. It also enforces execution
and output limits, logs the code, and can persist extraction evidence. Once
Phase 1 adds stable page, frame, document, and observation identities, replace
this narrow schema with the full Section 5 schema; do not make all identity
fields optional in one ambiguous tool.

In the same change, add a way to stop a script that freezes the page and replace
that page if it cannot recover. Do not prioritize another large batching schema
until this capability is measured; the existing `browser_batch` experiment had
no model adoption.

### 6. Store rows as data before adding research subagents

Implement the narrow `OutputTable` path next: upsert and delete rows, validate
them against the contract, attach evidence IDs, and render the final CSV with
ordinary code. This fixes a current output weakness and creates the merge
boundary needed for safe parallel research.

Only after that boundary exists should the runtime start several repeated
research jobs at once.

The MIT sororities task is a strong first evaluation because its six public-site
investigations are independent while its CSV and Google Sheet are shared.
Use a small coordinator-and-worker flow:

~~~text
coordinator defines one output contract
  → 2–3 concurrent research workers, one sorority per job
  → each returns validated row candidates plus evidence in its own job path
  → application merges and checks all affiliations and class cohorts
  → one coordinator writes the CSV and Google Sheet
  → verifier reviews the merged outputs and evidence
~~~

Research workers must not edit the shared table, Google Sheet, contract, or
final requested outputs. They return typed rows and evidence only. Start with
two or three concurrent public browser sessions rather than six, and keep the
authenticated Sheet under the coordinator's sole control.

Every job gets its own cancellation signal, limits, transcript, and result file
under `scratch/research-jobs/`. All jobs reuse the exact same prompt and tool
prefix; only the sorority-specific instruction changes at the end. The
parent reads the small typed result rather than replaying the child's entire
conversation.

This internal job record is not a model-maintained `Dataset`, `CollectionItem`,
or task-progress state machine.

### Defer for now

Do not put compact-memory redesign, a general dependency graph, a large
autonomous-agent swarm, or the complete multi-page browser identity model ahead
of this group. They may be valuable, but the steps above are smaller, have
clearer failure signals, and directly address problems already observed in the
current loop and judge experiment.

## Implementation sequence

The phases below describe the remaining V2 destination and dependencies. For
the immediate implementation order, the high-leverage group above takes
precedence. Each phase remains useful by itself; the team does not need to build
the entire architecture before measuring an improvement.

### Phase 0 — make the control loop trustworthy

- Replace the TUI's separate model loop with the shared, cancellable
  `ModelDriver`.
- Make stream assembly reject missing terminal events, incomplete blocks,
  token-limit stops, and refusals as completion.
- Buffer each model response until the whole response is accepted. Record
  rejected attempts without adding them to the model conversation.
- Retry one `max_tokens` response as the same request with a larger output
  allowance. Do not execute tools while their calls are still streaming.
- Add finite per-turn and whole-run token, tool-call, byte, time, and repair
  budgets. Enforce them before or during the operation that consumes them.
- Make the current judge harness report truthful `verified`, `incomplete`, and
  `verifier_unavailable` outcomes.
- Replace judge text parsing with the schema-validated `report_verification`
  tool. Include initializer and verifier work in the same run budget and
  metrics.
- Return judge corrections to the same worker conversation. Keep fresh worker
  cycles only as an evaluation comparison.
- Until `submit_for_verification` lands in Phase 2, require a clean provider
  stop before accepting the existing no-tool completion signal.

Primary metric: zero false-successful completions under forced truncation,
cancellation, refusal, and budget-exhaustion tests.

### Phase 1 — reduce browser turns

- Add `BrowserPage`, document IDs, observation IDs, frame tracking, and popup
  tracking.
- Define bounded settle behavior and observation IDs as diff baselines, not
  page-wide stale locks.
- Add conservative per-element revalidation and `browser_action` sequences
  capped at eight same-document actions, with one receipt per attempted action
  and explicit partial-commit behavior.
- Add page-scoped `execute_javascript` with page locking, timeouts, bounded
  output, execution termination, page recovery, explicit frame targeting, and
  persisted extraction evidence.
- Require every authenticated session policy to allow or deny JavaScript
  explicitly; record non-disposable-account exposure when it is allowed.
- Remove `browser_batch` only after the replacement preserves its current
  partial-commit diagnostics and improves measured outcomes.
- Cache observed element descriptions instead of regenerating outlines.
- Add keyboard, select, check, hover, drag, and run-confined upload operations;
  separate tools handle page switching and dialogs.
- Classify login, CAPTCHA, rate-limit, and bot-challenge blockers and preserve
  partial artifacts when unattended recovery is impossible.

Primary metrics: model calls per successful page operation, wrong-target rate,
false-stale rate, partial-batch recovery rate, and unsettled-result rate. Phase
1 does not graduate on turn reduction alone.

### Phase 2 — eliminate output failures

- Add the validated `set_output_contract` tool and store numbered contract
  revisions and their evidence/assumption basis under
  `scratch/output-contract/` through `writeArtifact`.
- Make both worker and optional initializer produce that same tool call. The
  initializer receives no prose-output path or separate `INTENT.md` format.
- Add versioned `OutputTable` row state whose columns and rules come from the
  contract output ID.
- Add row upsert/delete, exact type/format validation, `TableRule` validation,
  and mandatory completeness evidence for count-ruled tables.
- Add persisted JavaScript-extraction and exact-text evidence; use inline
  evidence markers for prose instead of an undefined claim store.
- Add contract-bound Markdown, text, and PDF document rendering. Preserve the
  marked source in scratch, publish a clean or footnoted render, hash both, and
  enforce the document's evidence requirement.
- Add the exclusive `submit_for_verification` protocol and reject no-tool,
  truncated, refused, or malformed completion attempts. Its handler renders
  current table artifacts through `writeArtifact` before verification.
- Connect that submission to the existing fresh verifier, which returns a
  structured verdict. A correction becomes the submission tool result in the
  same worker conversation.
- Bound pre-verifier code-check failures separately from submissions that reach
  the verifier, and try to render partial table artifacts when a run ends
  incomplete.
- Derive output paths and whether files are deliverables or supporting evidence
  from the output contract.
- Add derived `OutputSummary` and code-based `CompletionCheck`.

Primary metric: malformed structured-output rate, targeting zero.

### Phase 3 — broaden observation

- Add targeted page-structure and text extraction.
- Add table extraction.
- Add anonymous `read_resource` with response evidence and UI/resource
  reconciliation rules; reject public-resource requests that resolve or
  redirect to private, loopback, link-local, or reserved addresses.
- Let the model inspect screenshots.
- Add PDF and spreadsheet parsing.
- Add element screenshots and optical character recognition (OCR) for
  image-only content.

Primary metric: task completion rate for each content type—ordinary webpages,
visual pages, PDFs, spreadsheets, and image-only documents.

### Phase 4 — compact memory and parallel work

- Add the current contract and derived `OutputSummary` to `AgentContext`; do not
  introduce a separate goal, collection-item, or coverage state machine.
- Preserve the stable cached prefix and append-only recent history; add state
  snapshots only on change and compact only at cache-friendly boundaries.
- Derive normalized repeated-failure records from run events; do not add a
  model-maintained notes tool or an unspecified retrieval subsystem.
- Run a limited number of independent page and public-data jobs concurrently.
- Replace static read-only scheduling with input-aware page, file, manifest,
  origin, and output-table access keys. Commit results in original call order.
- Give each research job its own cancellation signal, limits, transcript, and
  typed result under `scratch/research-jobs/`. Restrict its tools and prohibit
  recursive workers.
- Namespace staged row IDs, validate cross-job uniqueness before shared writes,
  and return conflicts to the coordinator instead of choosing a last writer.
- Keep headed or authenticated research jobs serial until explicit load tests
  show that higher concurrency is reliable.
- Reuse exactly the same worker prompt and tool prefix, appending only the
  entity-specific instruction. Return typed rows and evidence rather than the
  child conversation.
- Compare the compact-context design with the current moving-breakpoint implementation
  on pass rate, cost, wall time, time to first token, and cache reads/writes.

Primary metrics: median and slow-case model turns, latency, page data sent to
the model, and repeated inspections that revealed nothing new.

### Phase 5 — strengthen verification and add reusable site knowledge

- Extend the fresh verifier to check task-to-contract, contract-to-output,
  task-to-output, completeness proof, and fact-to-evidence alignment after code
  checks pass.
- Keep its artifact tools read-only, split large outputs into chunks, and let
  it view screenshots directly. The worker receives at most two correction
  opportunities by default.
- Add data-only, site-specific interaction recipes. Each recipe should name the
  site it applies to, define how success is checked, and expire so stale site
  behavior is not trusted forever.
- Expand long-horizon and adversarial evals.

Primary metric: factual or interpretive error rate among outputs that already
pass all structural checks.

## Success metrics

The architecture should be evaluated against:

- task pass rate and consistency across repeated attempts;
- median and 95th-percentile end-to-end latency;
- model calls per successful page operation;
- total browser observations;
- redundant observation rate;
- stale-element retries and false-stale rate;
- wrong-target actions, partial batches, and unsettled action results;
- JavaScript termination and page-recovery rate;
- largest model input during a run;
- total output, cache-read, cache-write, and uncached-input tokens;
- output validation failures;
- table rendering or artifact-validation failures at submission;
- pre-verifier completion-check failures per run;
- partial tables successfully preserved on incomplete runs;
- count-ruled tables rejected for missing or weak completeness evidence;
- documents rejected for missing configured evidence coverage;
- contract defects found by the verifier;
- evidence-backed contract revisions versus unsupported constraint relaxations;
- verifier correction rate and added latency;
- required table values found versus missing;
- cross-job row conflicts requiring coordinator review;
- UI/resource reconciliation disagreements;
- unsupported-interaction failures;
- evidence coverage per factual row or document citation.

The primary performance target should be fewer model decisions. Prompt caching
can make repeated context cheaper, but it does not remove the latency or failure
opportunity of an unnecessary decision.

## Expected outcome

This architecture improves:

- **Accuracy:** code validates output requirements, table rules, and evidence
  links.
- **Generality:** the agent can inspect text, structure, images, PDFs, and
  spreadsheets, and can combine normal browser actions with page-scoped
  JavaScript.
- **Consistency:** explicit browser state and completion criteria.
- **Speed:** fewer model turns, smaller inspections, direct data reads, and
  limited parallel work.

The key shift is straightforward: let the model handle judgment, and turn
everything else into explicit, testable application behavior.
