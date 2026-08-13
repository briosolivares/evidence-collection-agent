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
  → extract the concrete requirements
  → derive what is done and what is missing
  → use browser actions or page-scoped JavaScript
  → store tabular results in validated output tables linked to evidence
  → generate output files with regular code
  → check every objective requirement
  → use a model judge only for subjective questions
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
- Starting a fresh model session every time a judge asks for a correction.
- Free-form `INTENT.md` and `CONTRACT.md` planning files.
- Calling an initializer and judge for every task, even when they add no value.
- Raw model-authored CSV.
- Full conversation replay as long-term memory.
- Prompt instructions encoding implementation workarounds such as the
  3,000-character write rule.

### Replace

| Current mechanism | Replacement |
| --- | --- |
| inspect → model → click → model → inspect | Each browser action also reports what changed |
| Short-lived Playwright element references | Element references tied to a page, frame, and page version |
| Checklist stored in a scratch file | Progress derived from requirements and validated outputs |
| Raw CSV strings | An `OutputTable` rendered by a normal CSV library |
| Treating “no tool call” as completion | An explicit finish request checked by code |
| Replaying the full conversation as memory | A short recent history plus compact structured state |
| One sequential research path | Limited parallel work for truly independent items |
| Full-page accessibility tree every time | Inspect only the type and area of content currently needed |
| Relying only on fixed browser tools | Choose between `browser_action` and `execute_javascript` for each step |

## Architecture

### 1. Turn the request into concrete requirements

For a complex task, translate the user's request into a small, validated data
structure before doing the work. This is not a second source of truth; it is a
machine-checkable summary of requirements such as filenames, CSV columns, and
the number of entities to collect. A simple task should skip this extra model
call.

~~~ts
type RequestedOutput =
  | {
      id: string;
      kind: 'csv';
      filename: string;
      columns: string[];
      expectedRows?: { exact: number } | { minimum: number };
    }
  | {
      id: string;
      kind: 'markdown';
      filename: string;
      requiredSections?: string[];
    }
  | {
      id: string;
      kind: 'screenshots';
      count?: number;
      namingPattern?: string;
    }
  | {
      id: string;
      kind: 'download';
      filename?: string;
      mediaTypes?: string[];
    };

interface TaskRequirements {
  objective: string;
  outputs: RequestedOutput[];
  freshness?: string;
  unresolvedQuestions: string[];
}
~~~

The original request remains authoritative. This structure may clarify what the
user explicitly asked for, but it must not invent new requirements. Important
ambiguities stay in `unresolvedQuestions` until they can be resolved.

Regular parsing code should handle obvious requirements without calling a
model:

- explicitly named CSV columns;
- requested filenames;
- requested screenshot counts;
- exact entity counts;
- explicitly required formats.

Use a model only when understanding the requirements actually requires
language judgment. For example, “summarize the key control failures” requires
interpretation; “write a CSV with columns Name and URL” does not.

### 2. Derive progress instead of maintaining another state machine

The application still needs to tell the model what is complete and what remains,
but it does not need `Goal`, `CollectionItem`, or `CoverageSet` objects to do so.
Those objects duplicate information already present in the requirements,
outputs, evidence, and validation results.

Create `TaskProgress` as a computed view:

~~~ts
interface CheckFailure {
  requirementId: string;
  message: string;
  relatedOutputIds?: string[];
}

interface TaskProgress {
  completedRequirementIds: string[];
  remainingRequirementIds: string[];
  failures: CheckFailure[];
}

function getTaskProgress(
  requirements: TaskRequirements,
  outputs: PublishedOutput[],
  tables: OutputTable[],
  evidence: Evidence[],
): TaskProgress;
~~~

For “collect the top 30 contributors,” completeness comes from the output
table's rules: exactly 30 rows, unique profile URLs, required values, and—when a
complete source list was discovered—an exact match against that list. There is
no second per-contributor status record to keep synchronized.

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

The application then runs `CompletionCheck`: ordinary validation code that
checks the finish request against the original requirements, published outputs,
table rules, and evidence.

~~~ts
interface FinishRequest {
  outputIds: string[];
  claimIds: string[];
  unresolvedLimitations: string[];
}

async function runCompletionCheck(
  requirements: TaskRequirements,
  request: FinishRequest,
  outputs: PublishedOutput[],
  tables: OutputTable[],
  evidence: Evidence[],
): Promise<CompletionCheckResult> {
  const failures = [
    ...validateRequestedOutputs(requirements, outputs, tables),
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

Call a model judge only when the remaining question requires judgment, such as
whether a summary fairly represents its cited sources. Do not spend a model
call checking columns, counts, filenames, duplicates, or parseability.

Return judge feedback to the same working session so it keeps the task context.
Start a fresh session only when the measured context size requires it.

### 11. Keep the audit log, but give the model a compact memory

The full transcript should remain available as the audit record. It should not
be resent to the model on every turn. Instead, each turn should contain a
compact view of the current task and the information needed for the next
decision.

That compact view should contain:

- the original task;
- the structured requirements;
- a summary of completed and missing work;
- current page states;
- recent actions and failures;
- only the notes relevant to the current decision;
- outstanding work.

~~~ts
interface AgentContext {
  requirements: TaskRequirements;
  progress: TaskProgress;
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
  // Avoid a planning call when straightforward parsing is enough.
  const requirements = await extractRequirementsWhenNeeded(task);
  const session = await browser.createSession();

  while (!budget.expired()) {
    const progress = getTaskProgress(
      requirements,
      publishedOutputs.all(),
      outputTables.all(),
      evidenceStore.all(),
    );

    const context = buildAgentContext({
      task,
      requirements,
      progress,
      browser: session.state(),
    });

    // The model proposes tool calls; tools own all application-state changes.
    const nextStep = await worker.next(context);

    const results = await scheduler.execute(nextStep.toolCalls);
    runEvents.record(results);

    if (nextStep.finishRequest !== undefined) {
      // Objective requirements must pass before the run can finish.
      const verdict = await runCompletionCheck(
        requirements,
        nextStep.finishRequest,
        publishedOutputs.all(),
        outputTables.all(),
        evidenceStore.all(),
      );

      if (verdict.status === 'verified') {
        return publishRun({ tables: outputTables.all() });
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

1. Regular parsing code records the filename, exact columns, row count, and
   screenshot requirement.
2. The model opens the repository and finds the contributor list. It can use
   `execute_javascript` to extract the visible list or `read_resource` if the
   page exposes the same data as public JSON.
3. The application creates an `OutputTable` with a 30-row rule, exact columns,
   unique profile URLs, and an exact-value rule if a complete contributor list
   is available.
4. Each table row stores the evidence that supports its values. A CSV
   library—not the model—writes the final file.
5. The screenshot tool saves the leaderboard as both requested output and
   evidence.
6. `CompletionCheck` verifies exactly 30 unique rows, exactly three
   columns, valid profile URLs, the required screenshot, and evidence links.

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

- Add `OutputTable`, batch row insertion, and `TableRule` validation.
- Add strict CSV rendering.
- Derive output paths and whether files are deliverables or supporting evidence
  from the task requirements.
- Add code-based completion validation.

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

- Add derived `TaskProgress` to `AgentContext`; do not introduce a separate
  goal, collection-item, or coverage state machine.
- Record each new event once instead of storing repeated copies of prior model
  requests.
- Run a limited number of independent page and public-data jobs concurrently.
- Extend the scheduler with page, origin, and output-table resource keys; do not
  add a general dependency-graph system.
- Retrieve only relevant past information and summarize history when needed.

Primary metrics: median and slow-case model turns, latency, page data sent to
the model, and repeated inspections that revealed nothing new.

### Phase 5 — verify meaning and add reusable site knowledge

- Add a narrowly scoped judge that can review both text and images when code
  cannot answer the quality question.
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
