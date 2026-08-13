# Browser Agent V2 — Revised Architecture Proposal

**Status:** Proposed

**Date:** 2026-08-13

**Scope:** Accuracy, generality, consistency, and speed for public-information
evidence collection

**Primary decision:** Stop making one long model conversation manage the whole
task. Let the model choose what to do, while ordinary TypeScript tracks the
work, operates the browser, validates data, and decides whether the task is
actually complete.

## Executive summary

The foundation is strong. Tools have strict input validation, browser sessions
are created cleanly, prompts are cached, files are traceable to their sources,
and every run has a clear output directory. Graders inspect the actual files
instead of trusting the model's written answer.

The main constraint is the agent loop. Today, one ever-growing conversation has
to carry five different responsibilities: remember browser state, plan the
research, retain facts, build output files, and decide when the task is done.
This forces the model to behave like a workflow engine, database, CSV writer,
and quality-control system at the same time. Models are useful at judgment;
they are much less reliable at bookkeeping.

The proposed design moves that bookkeeping into normal TypeScript components:

~~~text
Task
  → worker defines a narrow output contract and starts work in the same turn
  → derive output status from that contract and the files produced so far
  → use browser actions or page-scoped JavaScript
  → store tabular results in validated output tables linked to evidence
  → generate output files with regular code
  → run mechanical completion checks
  → fresh-context verifier checks task, contract, outputs, and evidence
~~~

The split is simple: the model handles work that requires judgment—understanding
the goal, choosing a research strategy, resolving ambiguity, and writing clear
prose. The application handles work that regular code does better—tracking
state, operating the browser safely, formatting files, checking completeness,
scheduling independent work, and enforcing the rules for completion.

This proposal intentionally prioritizes capability and performance. Heavy
security hardening, signed evidence journals, strict origin policy, and
adversarial prompt-injection work are deferred. The existing no-shell boundary
should remain, along with inexpensive safeguards such as sending saved
credentials only to the exact site they belong to and limiting download sizes.

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
- Cryptographically signed evidence bundles.
- A complete enterprise security-policy engine.
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

- `browser_batch`.
- Restarting the worker every time the verifier asks for a correction.
- Free-form `INTENT.md` and `CONTRACT.md` planning files.
- A separate initializer or contract-writer model call before the worker starts.
- Raw model-authored CSV.
- Full conversation replay as long-term memory.
- Prompt instructions encoding implementation workarounds such as the
  3,000-character write rule.

### Replace

| Current mechanism | Replacement |
| --- | --- |
| inspect → model → click → model → inspect | Each browser action also reports what changed |
| Short-lived Playwright element references | Element references tied to a page, frame, and page version |
| Checklist stored in a scratch file | Output status derived from the contract and current files |
| Raw CSV strings | An `OutputTable` rendered by a normal CSV library |
| Treating “no tool call” as completion | An explicit finish request checked by code |
| Replaying the full conversation as memory | A short recent history plus compact structured state |
| One sequential research path | Limited parallel work for truly independent items |
| Full-page accessibility tree every time | Inspect only the type and area of content currently needed |
| Relying only on fixed browser tools | Choose between `browser_action` and `execute_javascript` for each step |

## Architecture

### 1. Define the output contract in the first worker response

Do not build a natural-language requirements parser and do not add a separate
contract-writer model call. The worker already has to interpret the task. In its
first response, it calls `set_output_contract` and may also issue its first
browser calls:

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
      columns: OutputColumn[];
      rules: TableRule[];
    }
  | {
      id: string;
      kind: 'document';
      filename: string;
      format: 'markdown' | 'text' | 'pdf';
      requiredSections?: string[];
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
      filename?: string;
      allowedMediaTypes?: string[];
    };

interface OutputContract {
  outputs: OutputSpec[];
  contentExpectations?: string[];
  assumptions?: string[];
}
~~~

`contentExpectations` holds semantic expectations such as “explain the most
material control gaps and support them with evidence.” `assumptions` contains
only choices that materially affect the result. Both are optional. The contract
contains no research plan, browser steps, source list, goal hierarchy, or
per-entity state.

On the first turn, `set_output_contract` must be the first tool call. The runtime
validates and stores it before executing later calls from the same response. If
the contract is invalid, later calls do not run. This adds no extra model round
trip.

Structural validation rejects duplicate output IDs or paths, unsafe filenames,
duplicate table columns, non-positive counts, and conflicting table rules. The
accepted contract is written through `writeArtifact` under
`scratch/output-contract/`. If the worker explicitly changes the contract, save
a new numbered revision instead of silently overwriting the previous one. The
final verifier sees the latest contract and the revision history, so the worker
cannot hide a mistake by moving the goalposts.

The original task remains authoritative. The contract is an execution target,
not a replacement for the request, and the final verifier checks that the two
agree.

Do not add a dedicated contract-writer call unless evals show that first-turn
contract defects are common enough to justify the added latency.

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

The browser controller—not the model—should track tabs, embedded frames, page
changes, and element identity. Navigation, frame changes, and DOM mutations that
can invalidate an observed element increment `pageVersion`. An element
reference is valid only for the page version where it was observed.

~~~ts
interface ElementRef {
  id: string;
  pageId: string;
  frameId: string;
  pageVersion: number;

  backendNodeId?: number;
  role: string;
  name: string;
  ordinal?: number;
}

interface BrowserPage {
  pageId: string;
  pageVersion: number;
  url: string;
  title: string;
  active: boolean;
  frames: Array<{ frameId: string; url: string }>;
}
~~~

When the agent tries to use an element reference, resolve it in this order:

1. Use the browser's exact internal node ID if the page and frame have not
   changed.
2. Otherwise try the stable locator saved when the element was observed.
3. Otherwise match its role, visible name, and position—but only if there is
   exactly one safe match.
4. If none of those works, report that the reference is stale and inspect the
   page again.

This keeps the useful human description (“the Submit button”) without assuming
that a short-lived accessibility reference will remain valid after the page
changes.

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
  | { op: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { op: 'activate_page'; pageId: string };

type SuccessCheck =
  | { type: 'url_matches'; pattern: string }
  | { type: 'element_exists'; role: string; name: string }
  | { type: 'text_present'; text: string }
  | { type: 'download_started' }
  | { type: 'popup_opened' };

interface PageChanges {
  navigated: boolean;
  url?: { before: string; after: string };
  newlyVisible: ElementRef[];
  noLongerVisibleElementIds: string[];
  updatedText: Array<{ elementId?: string; text: string }>;
}

interface BrowserActionInput {
  pageId: string;
  pageVersion: number;
  actions: [BrowserAction, ...BrowserAction[]];
  successChecks?: SuccessCheck[];
}

interface BrowserActionOutput {
  status: 'completed' | 'stale' | 'blocked' | 'failed';
  previousPageVersion: number;
  currentPage: BrowserPage;
  changes: PageChanges;
  openedPages: BrowserPage[];
  downloads: DownloadInfo[];
  error?: string;
}
~~~

The output should include the landed URL and title, relevant content and
controls that changed, new pages, dialogs, downloads, and whether navigation
occurred. `PageChanges` means the useful difference between the page before and
after the action.

If an action changes the page and makes a later target stale, or if an
unexpected popup or dialog appears, the application stops the sequence. This
gains the speed of batching without blindly continuing. It replaces the
separate `browser_batch` tool.

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
  pageVersion: number;
  code: string;
  timeoutMs?: number;
  successChecks?: SuccessCheck[];
}

interface ExecuteJavaScriptOutput {
  status: 'completed' | 'stale' | 'blocked' | 'failed';
  previousPageVersion: number;
  result?: JsonValue;
  pageChanged: boolean;
  currentPage: BrowserPage;
  changes: PageChanges;
  openedPages: BrowserPage[];
  downloads: DownloadInfo[];
  logs: string[];
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
logs, and errors.

The tool definition remains static and deterministic. Page-specific data belongs
in the tool input, so adding this capability does not make the cached prompt
prefix vary between runs.

Because model-generated JavaScript can change the page even when it claims to
be read-only, every call acquires that page's state-changing lock. Calls on
independent pages may still run concurrently.

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
  depth?: number;
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
a public URL, the agent should be able to read it through the same browser
session instead of clicking through hundreds of rows.

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
~~~

Use this only after the agent has found or reasonably derived the relevant
public resource URL, such as:

- GitHub JSON endpoints;
- page-embedded JSON;
- CSV exports;
- accessible APIs;
- PDFs;
- HTML tables.

This can replace many slow pagination steps with one read. Keep the source URL
and, when useful for audit evidence, the original response bytes.

`execute_javascript` operates on the live webpage. `read_resource` retrieves a
raw public resource such as a large JSON response, CSV, PDF, or binary file.
Keeping both avoids loading every resource into the document merely so
JavaScript can read it.

### 8. Store rows as data, then generate the output file

For structured output, the model should add rows to an `OutputTable`, not
hand-write CSV text. The table is the answer before file formatting; its
`TableRule` values describe what must be true before that answer can be
published.

~~~ts
interface OutputColumn {
  name: string;
  required: boolean;
  type: 'string' | 'integer' | 'url' | 'date';
}

interface OutputRow {
  values: Record<string, unknown>;
  evidenceIds: string[];
}

type TableRule =
  | { type: 'exact_row_count'; value: number }
  | { type: 'minimum_row_count'; value: number }
  | { type: 'unique'; columns: string[] }
  | {
      type: 'matches_expected_values';
      column: string;
      expected: string[];
      sourceEvidenceIds: string[];
    };

interface OutputTable {
  id: string;
  filename: string;
  format: 'csv' | 'json' | 'markdown';
  columns: OutputColumn[];
  rows: OutputRow[];
  rules: TableRule[];
}
~~~

When rows are added, the application rejects:

- missing columns;
- extra columns;
- invalid URLs or integers;
- duplicates when disallowed;
- malformed dates;
- rows without required evidence;
- values that spreadsheet programs could accidentally execute as formulas.

Before publishing, regular code evaluates every `TableRule` and generates a
standards-compliant CSV in one pass. The same rows can also produce JSON,
Markdown tables, or other formats without asking the model to rewrite the data.

`matches_expected_values` handles the cases that actually require proof of
completeness. For example, after discovering the complete contributor list, it
can require the table's `Profile URL` column to match that list exactly. This is
a validation rule, not a separate collection-item or coverage state machine.

This prevents malformed rows, avoids repeatedly reading and rewriting a growing
file, and uses far fewer model output tokens.

### 9. Link every important fact to its evidence

Each output row or factual statement should record which screenshot, webpage
text, download, or network response supports it.

~~~ts
interface Evidence {
  id: string;
  kind: 'screenshot' | 'web_text' | 'download' | 'network_response';
  sourceUrl: string;
  capturedAt: string;
  artifactPath?: string;
  quote?: string;
  locator?: ElementRef;
}

interface Claim {
  id: string;
  text: string;
  evidenceIds: string[];
}
~~~

These links make review and debugging much easier. An auditor can move from a
claim to its source, and the agent can recollect one weak fact without repeating
the entire task.

The current manifest hashing is sufficient for the initial capability-focused
version. Stronger signing can be added later.

### 10. Require the agent to prove it is finished

The current loop treats any response with no tool call as completion. That can
also happen when the model reaches a token limit, refuses, or simply forgets to
continue. Instead, the model must explicitly ask to finish and identify the
deliverables and claims it believes are complete.

The application first runs `CompletionCheck`: ordinary validation code that
checks the finish request against the output contract, published outputs, table
rules, and evidence.

~~~ts
interface FinishRequest {
  outputIds: string[];
  claimIds: string[];
  unresolvedLimitations: string[];
}

async function runCompletionCheck(
  contract: OutputContract,
  request: FinishRequest,
  outputs: PublishedOutput[],
  tables: OutputTable[],
  evidence: Evidence[],
): Promise<CompletionCheckResult> {
  const failures = [
    ...validateExpectedOutputs(contract, outputs, tables),
    ...validateTableRules(tables),
    ...validateEvidenceLinks(request, tables, evidence),
  ];

  if (failures.length > 0) {
    return { status: 'continue', failures };
  }

  return { status: 'verified' };
}
~~~

Checks with objective answers run first:

- the model response ended normally rather than at a token limit, refusal, or
  truncated stream;
- required artifacts exist;
- exact columns;
- whether files can be parsed;
- row counts;
- uniqueness and exact matches against any discovered source list;
- screenshot counts;
- unfinished placeholders such as `TODO` or missing values;
- evidence linkage.

A transport EOF without the provider's normal message-stop event is an error,
not a successful finish.

After mechanical checks pass, run one verifier call with fresh context:

~~~ts
interface VerificationResult {
  status: 'accepted' | 'needs_correction';
  contractProblems: string[];
  outputProblems: string[];
  evidenceProblems: string[];
}

interface VerificationInput {
  originalTask: string;
  contract: OutputContract;
  contractHistory: OutputContract[];
  outputs: PublishedOutput[];
  tables: OutputTable[];
  evidence: Evidence[];
}
~~~

The verifier checks four relationships:

~~~text
Original task ↔ Output contract
Output contract ↔ Produced outputs
Original task ↔ Produced outputs
Claims and rows ↔ Evidence
~~~

Checking the original task prevents an incorrect contract from validating its
own mistake. The verifier receives the run outputs and evidence, not the
worker's full conversation, so it forms an independent view. Code handles
columns, counts, filenames, duplicates, and parseability before this call.

If verification fails, return the specific contract, output, and evidence
problems to the same worker. The worker corrects the run and requests
verification again; it is not restarted from scratch. Verification-repair
cycles must have their own small limit. If they remain unresolved, publish an
incomplete run rather than accepting it.

### 11. Keep the audit log, but give the model a compact memory

The full transcript should remain available as the audit record. It should not
be resent to the model on every turn. Instead, each turn should contain a
compact view of the current task and the information needed for the next
decision.

That compact view should contain:

- the original task;
- the output contract;
- the derived output summary;
- current page states;
- recent actions and failures;
- only the notes relevant to the current decision;
- outstanding work.

~~~ts
interface AgentContext {
  contract?: OutputContract;
  outputs: OutputSummary[];
  pages: BrowserPage[];
  recentEvents: RunEvent[];
  relevantNotes: string[];
}
~~~

Record each event once. Do not copy the entire previous model request into the
transcript again on every turn. Summarize or restart a session only when context
size is actually becoming a problem.

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

This does not require a `WorkNode`, `ScheduledTask`, or general dependency-graph
primitive. The existing scheduler can group ordinary tool calls by the resource
they use—for example, page ID, public origin, or output table—and apply the
rules below.

Scheduling rules:

- Actions that change one page remain sequential.
- Independent pages may run concurrently.
- Public data reads can use more concurrency than browser pages.
- Output-table updates are serialized, and published files still go through
  `writeArtifact`.
- A failed call is returned immediately, while successful independent results
  remain usable.

## Revised core loop

The code below shows the control flow, not a required class structure. One
worker model chooses the next useful work. The application executes that work,
updates its records, and accepts completion only after validation succeeds.

~~~ts
async function runTask(task: string): Promise<VerifiedRun> {
  const session = await browser.createSession();
  let contract: OutputContract | undefined;

  while (!budget.expired()) {
    const outputs = contract
      ? summarizeOutputs(
          contract,
          publishedOutputs.all(),
          outputTables.all(),
          evidenceStore.all(),
        )
      : [];

    const context = buildAgentContext({
      task,
      contract,
      outputs,
      browser: session.state(),
    });

    // The model proposes tool calls; tools own all application-state changes.
    const nextStep = await worker.next(context);

    const results = await scheduler.execute(nextStep.toolCalls, {
      requireOutputContract: contract === undefined,
    });
    runEvents.record(results);
    contract = outputContracts.current();

    if (nextStep.finishRequest !== undefined) {
      if (contract === undefined) {
        worker.addFeedback(['Set a valid output contract before finishing.']);
        continue;
      }

      // Mechanical contract checks must pass before semantic verification.
      const verdict = await runCompletionCheck(
        contract,
        nextStep.finishRequest,
        publishedOutputs.all(),
        outputTables.all(),
        evidenceStore.all(),
      );

      if (verdict.status === 'verified') {
        const verification = await verifier.verify({
          originalTask: task,
          contract,
          contractHistory: outputContracts.all(),
          outputs: publishedOutputs.all(),
          tables: outputTables.all(),
          evidence: evidenceStore.all(),
        });

        if (verification.status === 'accepted') {
          return publishRun({ tables: outputTables.all() });
        }

        worker.addFeedback([
          ...verification.contractProblems,
          ...verification.outputProblems,
          ...verification.evidenceProblems,
        ]);
        continue;
      }

      worker.addFeedback(verdict.failures);
    }
  }

  return publishIncompleteRun();
}
~~~

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
   `execute_javascript` to extract the visible list or `read_resource` if the
   page exposes the same data as public JSON.
3. The contract creates an `OutputTable` with a 30-row rule, exact columns,
   unique profile URLs, and an exact-value rule if a complete contributor list
   becomes available.
4. Each table row stores the evidence that supports its values. A CSV
   library—not the model—writes the final file.
5. The screenshot tool saves the leaderboard as both requested output and
   evidence.
6. `CompletionCheck` verifies exactly 30 unique rows, exactly three
   columns, valid profile URLs, the required screenshot, and evidence links.
7. The verifier independently compares the original task, output contract,
   finished CSV, screenshot, and evidence before accepting the run.

If only 29 contributors were collected, the application would return one clear
failure—“expected 30 rows; found 29.” If an authoritative list is available, it
can name the missing profile URL instead of asking the model to reread the
entire conversation and discover the omission itself.

## Implementation sequence

The phases below are ordered by expected value. Each phase is useful by itself;
the team does not need to build the entire architecture before measuring an
improvement.

### Phase 1 — reduce browser turns

- Add `BrowserPage`, page IDs, version numbers, frame tracking, and popup
  tracking.
- Add `browser_action` and make every action report the relevant page changes.
- Add page-scoped `execute_javascript` with page locking, timeouts, bounded
  output, and before/after page state.
- Remove `browser_batch`.
- Cache observed element descriptions instead of regenerating outlines.
- Add keyboard, select, and page-switch operations.

Primary metric: model calls per successful page operation. A lower number means
less latency and cost without relying on a faster model.

### Phase 2 — eliminate output failures

- Add the validated `set_output_contract` tool and store numbered contract
  revisions under `scratch/output-contract/` through `writeArtifact`.
- Add `OutputTable`, batch row insertion, and `TableRule` validation.
- Add strict CSV rendering.
- Derive output paths and whether files are deliverables or supporting evidence
  from the output contract.
- Add derived `OutputSummary` and code-based `CompletionCheck`.

Primary metric: malformed structured-output rate, targeting zero.

### Phase 3 — broaden observation

- Add targeted page-structure and text extraction.
- Add table extraction.
- Let the model inspect screenshots.
- Add PDF and spreadsheet parsing.
- Add element screenshots and optical character recognition (OCR) for
  image-only content.

Primary metric: task completion rate for each content type—ordinary webpages,
visual pages, PDFs, spreadsheets, and image-only documents.

### Phase 4 — compact memory and parallel work

- Add the current contract and derived `OutputSummary` to `AgentContext`; do not
  introduce a separate goal, collection-item, or coverage state machine.
- Record each new event once instead of storing repeated copies of prior model
  requests.
- Run a limited number of independent page and public-data jobs concurrently.
- Extend the scheduler with page, origin, and output-table resource keys; do not
  add a general dependency-graph system.
- Retrieve only relevant past information and summarize history when needed.

Primary metrics: median and slow-case model turns, latency, page data sent to
the model, and repeated inspections that revealed nothing new.

### Phase 5 — add independent verification and reusable site knowledge

- Add the fresh-context verifier. It checks task-to-contract,
  contract-to-output, task-to-output, and claim-to-evidence alignment after
  mechanical checks pass.
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
- largest model input during a run;
- total output and cached-input tokens;
- output validation failures;
- contract defects found by the verifier;
- verifier correction rate and added latency;
- required table values found versus missing;
- unsupported-interaction failures;
- evidence coverage per claim or row.

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
