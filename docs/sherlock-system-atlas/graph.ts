export type NodeKind = 'concept' | 'implementation';

export type NodeTone =
  | 'surface'
  | 'orchestration'
  | 'model'
  | 'capability'
  | 'browser'
  | 'store'
  | 'verification'
  | 'outcome'
  | 'evaluation'
  | 'observability';

export interface NodeAnswers {
  what: string;
  inputs: readonly string[];
  outputs: readonly string[];
  creator: string;
  consumers: readonly string[];
  enforcement: readonly string[];
  authority: string;
  why: string;
  code: readonly string[];
}

export interface NodeNarrative {
  opening: string;
  mechanics: readonly string[];
  handoff: string;
  boundary: string;
}

export interface SemanticNode {
  id: string;
  parentId?: string;
  kind: NodeKind;
  tone: NodeTone;
  code: string;
  title: string;
  kicker: string;
  summary: string;
  answers: NodeAnswers;
  narrative: NodeNarrative;
}

export interface SemanticEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  explanation: string;
  kind: 'flow' | 'feedback' | 'read' | 'control' | 'implementation';
  routeIds?: readonly string[];
}

export interface LearningRoute {
  id: string;
  number: string;
  title: string;
  summary: string;
  promise: string;
  nodeIds: readonly string[];
}

type SemanticNodeInput = Omit<SemanticNode, 'kind' | 'parentId' | 'narrative'> & {
  narrative?: NodeNarrative;
};

function naturalList(values: readonly string[]): string {
  if (values.length === 0) return 'nothing';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

function defaultNarrative(node: SemanticNodeInput): NodeNarrative {
  return {
    opening: `${node.answers.what} ${node.answers.why}`,
    mechanics: [
      `${node.answers.creator} Once active, it works from ${naturalList(node.answers.inputs)} and produces ${naturalList(node.answers.outputs)}.`,
      node.answers.enforcement.join(' '),
    ],
    handoff: `Its result moves to ${naturalList(node.answers.consumers)}, carrying ${naturalList(node.answers.outputs)} into the next part of the system.`,
    boundary: node.answers.authority,
  };
}

const concept = (node: SemanticNodeInput): SemanticNode => ({
  ...node,
  narrative: node.narrative ?? defaultNarrative(node),
  kind: 'concept',
});

const implementation = (parentId: string, node: SemanticNodeInput): SemanticNode => ({
  ...node,
  parentId,
  narrative: node.narrative ?? defaultNarrative(node),
  kind: 'implementation',
});

export const concepts: readonly SemanticNode[] = [
  concept({
    id: 'entry',
    tone: 'surface',
    code: '01',
    title: 'Task entry',
    kicker: 'Public surface',
    summary: 'Turns a human or eval task into one call through the production seam.',
    answers: {
      what: 'The TUI and eval runner are adapters around the same public run API.',
      inputs: ['Task text', 'Browser authority', 'Optional human permission answers'],
      outputs: ['runTask call', 'Progress events', 'Terminal result presentation'],
      creator: 'A human starts the TUI; the eval CLI creates isolated trials.',
      consumers: ['Production composition', 'Human operator', 'Eval reporting'],
      enforcement: [
        'Each adapter chooses attached versus managed browser authority explicitly.',
        'Artifact presentation follows manifest changes, not assistant claims.',
      ],
      authority: 'May collect a task and present results; it cannot declare a run verified.',
      why: 'Many entry experiences can evolve without duplicating the agent runtime.',
      code: ['src/tui/main.tsx', 'evals/runners/cli.ts'],
    },
  }),
  concept({
    id: 'composition',
    tone: 'orchestration',
    code: '02',
    title: 'Production composition',
    kicker: 'One wiring root',
    summary: 'Creates the run directory, model roles, tools, tracing, and durable configuration.',
    answers: {
      what: 'The only production location where live dependencies become one executable Sherlock run.',
      inputs: ['Task text', 'BrowserController', 'Run configuration'],
      outputs: [
        'DurableRunConfiguration',
        'Three model drivers',
        'Nine-tool registry',
        'Run outcome',
      ],
      creator: 'Task-entry adapters call runTask.',
      consumers: ['Durable lifecycle', 'Tracing adapter', 'Public entry surfaces'],
      enforcement: [
        'Durable configuration is persisted before lifecycle execution.',
        'Worker prompt and API tool definitions remain byte-stable process-wide values.',
      ],
      authority:
        'Chooses dependencies and configuration; delegates all terminal truth to runAgent.',
      why: 'A single composition root prevents production, eval, and interactive behavior from drifting.',
      code: ['src/agent/runTask.ts'],
    },
  }),
  concept({
    id: 'lifecycle',
    tone: 'orchestration',
    code: '03',
    title: 'Durable lifecycle',
    kicker: 'Checkpointed state machine',
    summary: 'Coordinates initializer, worker, checks, verifier, recovery, and terminal cleanup.',
    answers: {
      what: 'runAgent is the crash-aware state machine spanning the complete life of one run.',
      inputs: [
        'Durable configuration',
        'Models',
        'Tool registry',
        'Optional browser and abort signal',
      ],
      outputs: ['Monotonic checkpoints', 'Terminal outcome', 'Finalized projections'],
      creator:
        'Production composition invokes runAgent; runAgent restores any checkpoint it finds.',
      consumers: ['Worker session', 'Run directory', 'Public composition'],
      enforcement: [
        'Effects are checkpointed before and after calls.',
        'Terminal state is absorbing and cleanup completes before the run lock is released.',
      ],
      authority: 'Owns phase transitions, budgets, recovery, and terminalization.',
      why: 'Evidence collection must remain truthful after cancellation, timeout, or process death.',
      code: ['src/agent/lifecycle.ts', 'src/agent/checkpoint.ts', 'src/agent/checkpoint.schema.ts'],
    },
  }),
  concept({
    id: 'contract',
    tone: 'model',
    code: '04',
    title: 'Contract initializer',
    kicker: 'Model 1 · fresh context',
    summary: 'Reads the task and emits the one immutable, schema-valid output contract.',
    narrative: {
      opening:
        "Before Sherlock opens a page, a short-lived Sonnet call turns the user's request into a typed description of the required end state. This is the contract initializer: it decides what must exist at the end, not how the research should be performed.",
      mechanics: [
        'The model receives the original task with one forced tool, set_output_contract. Its response must contain exactly that call. Sherlock intercepts the call instead of executing an external effect, validates its arguments, and permits one repair attempt if the first proposal is invalid.',
        'The accepted value is checked against a Zod union for tables, documents, screenshots, external actions, and downloads. Cross-field rules catch contradictions that a field-by-field schema cannot, then the lifecycle writes the same object to harness/output-contract.json so every later stage works from one durable definition of done.',
      ],
      handoff:
        'Once accepted, the original request and immutable contract travel together to the persistent worker. The same contract later reaches deterministic checks and the verifier, so a correction can change the work without silently changing the goal.',
      boundary:
        'The initializer can translate explicit requirements into typed filenames, columns, counts, evidence needs, and semantic expectations. It cannot browse, choose sources, invent requirements, or approve completion.',
    },
    answers: {
      what: 'A bounded Sonnet model role that translates the original task into the end state the run must produce before any browsing begins.',
      inputs: ['Original task text', 'Initializer system prompt', 'set_output_contract schema'],
      outputs: [
        'OutputContract.outputs: table, document, screenshots, external action, or download specs',
        'Judgment-shaped contentExpectations',
        'Durable harness/output-contract.json projection',
      ],
      creator: 'The contract initializer gets one initial attempt and at most one repair.',
      consumers: ['Worker', 'Deterministic checks', 'Fresh verifier'],
      enforcement: [
        'Only this role sees set_output_contract, forced as its sole tool call.',
        'Zod plus cross-field validation rejects malformed or contradictory contracts; the worker cannot revise an accepted contract.',
      ],
      authority: 'Defines machine-readable requirements; it does not research or judge success.',
      why: 'Exact filenames, columns, counts, evidence needs, and semantic expectations must survive every worker correction unchanged.',
      code: [
        'src/agent/initializer/initializer.ts',
        'src/agent/initializer/outputContract.schema.ts',
        'src/prompts/contract.md',
      ],
    },
  }),
  concept({
    id: 'worker',
    tone: 'model',
    code: '05',
    title: 'Persistent worker',
    kicker: 'Model 2 · persistent context',
    summary: 'Browses, writes, publishes, and repairs through one sequential conversation.',
    narrative: {
      opening:
        'The persistent worker is where the investigation actually happens. Unlike the initializer and verifier, it keeps one Sonnet conversation alive across research, tool results, failed checks, and verifier corrections, so it can repair its work without relearning the task from scratch.',
      mechanics: [
        'Each model turn is assembled and validated before any effect occurs. Valid tool calls then run in response order through the frozen nine-tool registry: the worker can operate the browser, inspect live viewport pixels, work in private scratch files, publish artifacts, ask the user, run bounded shell commands, and eventually request finish.',
        'Private work and public evidence stay separate throughout that loop. write_file and edit_file only change scratch space; publish_artifact is the deliberate crossing into the manifest. When the worker believes the contract is satisfied, finish must be the only tool call in its response. That pauses production and asks the rest of Sherlock to inspect the result—it does not declare success.',
      ],
      handoff:
        'The worker receives the task and immutable contract from the initializer. Its exclusive finish request hands the completion report and published run state to deterministic checks. Mechanical defects and verifier findings return to this same conversation as concrete repair instructions.',
      boundary:
        'The worker has the broadest operational authority in the system, but only through its tools. It can research and produce evidence; it cannot revise the contract, skip publication, or turn its own confidence into a verified outcome.',
    },
    answers: {
      what: 'The only stateful model role that performs research and produces requested artifacts; production defaults to Sonnet while preserving one useful conversation across corrections.',
      inputs: ['Task and contract', 'Tool results', 'Deterministic defects', 'Verifier findings'],
      outputs: ['Progress text', 'Sequential tool calls', 'Exclusive finish request'],
      creator: 'The durable lifecycle creates one WorkerSession after contract initialization.',
      consumers: ['Tool registry', 'Completion checks', 'TUI progress bridge'],
      enforcement: [
        'Model output is fully assembled and validated before effects.',
        'Tool calls execute in response order; finish must be the only call in its response.',
      ],
      authority: 'May research and request effects; cannot revise the contract or declare success.',
      why: 'Persistent useful context makes corrections efficient while sequential effects stay auditable.',
      code: [
        'src/agent/worker/worker.ts',
        'src/agent/worker/contextView.ts',
        'src/prompts/worker.md',
      ],
    },
  }),
  concept({
    id: 'tools',
    tone: 'capability',
    code: '06',
    title: 'Capability boundary',
    kicker: 'Nine frozen tools',
    summary: 'Turns validated model requests into bounded, permissioned, observable effects.',
    answers: {
      what: 'Exactly nine model-visible tools behind one registry and execution pipeline.',
      inputs: ['Validated worker tool calls', 'Tool context', 'Durable browser policy'],
      outputs: ['Bounded CapResult values', 'Checkpointable effects', 'Finish control flow'],
      creator: 'Production composition builds one run-scoped registry in frozen order.',
      consumers: ['Worker history', 'Browser runtime', 'Run directory', 'Human permission UI'],
      enforcement: [
        'One global busy-resource gate blocks every later call behind abandoned effects.',
        'Schema, permission, timeout, and result-size checks wrap execution.',
      ],
      authority:
        'Runs only capabilities exposed by registered tools; it is not a security sandbox.',
      why: 'A small stable surface concentrates safety and recovery rules around every effect.',
      code: ['src/tools/index.ts', 'src/tools/registry.ts', 'src/tools/pipeline.ts'],
    },
  }),
  concept({
    id: 'browser',
    tone: 'browser',
    code: '07',
    title: 'Browser runtime',
    kicker: 'Owned-page authority',
    summary:
      'Runs bounded browser programs against one exact page through a provider-neutral seam.',
    answers: {
      what: 'browser_execute, BrowserController, and providers form one target-pinned browser capability.',
      inputs: ['Finite JavaScript program', 'Run-owned page', 'Explicit provider selection'],
      outputs: ['DOM, AX, visual, network, file, and navigation results', 'Safe diagnostics'],
      creator:
        'The selected BrowserSessionProvider creates a controller; the tool creates child programs.',
      consumers: ['Persistent worker', 'Evidence publication', 'Terminal cleanup'],
      enforcement: [
        'Connection URLs and provider credentials never enter the child or model-visible data.',
        'Run markers constrain inventory and mutation to pages owned by the same run.',
      ],
      authority: 'May control run-owned pages; browser-global Browser.* commands are denied.',
      why: 'Programmability handles unfamiliar sites without a sprawling site-action tool surface.',
      code: [
        'src/tools/browserExecute/browserExecute.ts',
        'src/browser/controller.ts',
        'src/browser/provider.ts',
      ],
    },
  }),
  concept({
    id: 'publication',
    tone: 'store',
    code: '08',
    title: 'Publication boundary',
    kicker: 'Explicit artifact roles',
    summary: 'Promotes private bytes into hashed requested outputs or evidence.',
    answers: {
      what: 'publish_artifact is the sole worker-controlled transition from private work to public deliverable.',
      inputs: ['Inline text, workspace file, screenshot, or browser download', 'Semantic roles'],
      outputs: ['Artifact bytes', 'Hash and provenance', 'Atomic manifest entry'],
      creator: 'The worker calls publish_artifact after producing or collecting source bytes.',
      consumers: ['Deterministic checks', 'Fresh verifier', 'TUI', 'Black-box graders'],
      enforcement: [
        'At least requested_output or evidence must be nonempty.',
        'Artifact journals and atomic manifest writes survive interruption.',
      ],
      authority:
        'May publish named bytes with roles; private file tools cannot cross this boundary.',
      why: 'Published results must be intentional, attributable, and independently selectable.',
      code: [
        'src/tools/publishArtifact/publishArtifact.ts',
        'src/run/artifactWriteTransaction.ts',
        'src/run/artifacts.ts',
      ],
    },
  }),
  concept({
    id: 'run-store',
    tone: 'store',
    code: '09',
    title: 'Run directory',
    kicker: 'Product boundary',
    summary:
      'A self-contained, hashed record separating public evidence from private work and harness state.',
    answers: {
      what: 'One directory containing artifacts/, scratch/, harness/, manifest.json, transcript, and metrics.',
      inputs: ['Published artifacts', 'Private workspace writes', 'Checkpoints and projections'],
      outputs: [
        'Recoverable run state',
        'Manifest-selected deliverables',
        'Auditable execution record',
      ],
      creator: 'runTask creates the directory and initializes its manifest before model work.',
      consumers: ['Lifecycle recovery', 'Verifier', 'TUI', 'Eval graders'],
      enforcement: [
        'resolveRunPath confines model paths and denies harness and metadata targets.',
        'No-follow atomic writes, hashes, and workspace reconciliation reject symlinks and special files.',
      ],
      authority:
        'The manifest is authoritative for published roles; scratch and harness stay private.',
      why: 'The final filesystem state—not a conversational claim—is the product and grading boundary.',
      code: ['src/run/runDir.ts', 'src/run/artifacts.ts', 'src/run/syncScratchWorkspace.ts'],
    },
  }),
  concept({
    id: 'checks',
    tone: 'verification',
    code: '10',
    title: 'Deterministic finish checks',
    kicker: 'Code gate · no model',
    summary: 'Settles integrity, role, shape, count, media, and other code-decidable requirements.',
    narrative: {
      opening:
        "Deterministic finish checks form a code gate between the worker's finish request and the fresh verifier. No model runs here. Sherlock first settles everything that can be answered exactly from the immutable contract, manifest, and published bytes.",
      mechanics: [
        'The lifecycle waits for effects to become quiescent, then reads the manifest and artifacts with bounded, no-follow inspection. It can prove hashes, artifact roles, filenames, media validity, requested counts, and exact CSV, JSON, or Markdown shapes without asking another language model to guess.',
        'A failed check produces a concrete defect and returns control directly to the same worker session. A successful check produces settled facts and a verifier-ready view of the surfaced files. This keeps objective failures cheap, repeatable, and authoritative while reserving subjective questions for the next stage.',
      ],
      handoff:
        "If a mechanical requirement fails, the defect loops back to the persistent worker for repair. If every check passes, Sherlock gives the fresh verifier the settled facts, the worker's completion report, and only the manifest-selected requested outputs and evidence.",
      boundary:
        "This gate is authoritative about code-decidable facts, but deliberately narrow. It cannot decide whether prose is persuasive, research is semantically complete, or the evidence truly supports the user's request.",
    },
    answers: {
      what: 'A synchronous inspection gate triggered only by an exclusive finish tool response.',
      inputs: ['Immutable contract', 'Finish report', 'Manifest and published bytes'],
      outputs: ['Settled facts', 'Repairable defects', 'Verifier-ready evidence view'],
      creator: 'The lifecycle invokes runFinishChecks after the worker requests finish.',
      consumers: [
        'Same worker on failure',
        'Fresh verifier on success',
        'Terminal checkpoint integrity checks',
      ],
      enforcement: [
        'Manifest and artifacts are inspected with bounded no-follow reads.',
        'Exact CSV/JSON/Markdown shapes and hashes are checked in code.',
      ],
      authority:
        'Its mechanical failures are authoritative; it does not judge prose quality or inferred scope.',
      why: 'Facts a program can settle should not depend on model judgment.',
      code: [
        'src/agent/completion/finishChecks.ts',
        'src/agent/completion/artifactInspection.ts',
        'src/agent/completion/tableInspection.ts',
      ],
    },
  }),
  concept({
    id: 'verifier',
    tone: 'verification',
    code: '11',
    title: 'Fresh verifier',
    kicker: 'Model 3 · fresh context',
    summary: 'Reviews semantic completeness in a new read-only context and alone accepts success.',
    narrative: {
      opening:
        "The verifier is a fresh Haiku call with none of the worker's conversational momentum. It approaches the result as an independent reviewer, comparing the original task and immutable contract with the files Sherlock is actually prepared to expose as evidence or requested output.",
      mechanics: [
        'Its context contains the task, contract, untrusted completion report, settled deterministic facts, surfaced manifest entries, and correction history. Bounded read_file and grep tools let it inspect those published files more closely, but it cannot see scratch work, browse the web, or change anything.',
        'The verifier must finish with one typed judgment: verified, needs_correction with actionable findings, or incomplete with a credible reason. Invalid or unavailable judgments fail closed. Only verified becomes success; needs_correction reopens the existing worker conversation, while incomplete records an honest terminal limitation.',
      ],
      handoff:
        'A verified judgment moves to the truthful terminal outcome. A typed correction returns to the same persistent worker, preserving its useful context while giving it an outside account of what remains wrong. The contract itself never changes during that loop.',
      boundary:
        'The verifier alone may accept semantic success, but its authority is read-only and evidence-bound. It has no browser, no scratch access, no mutation tools, and no permission to reinterpret the request or weaken the contract.',
    },
    answers: {
      what: 'A fresh read-only Haiku model role that judges the request against the contract, code-settled facts, and published evidence.',
      inputs: [
        'Task and contract',
        'Finish report',
        'Manifest entries and files',
        'Correction history',
      ],
      outputs: ['verified', 'needs_correction with findings', 'incomplete with reason'],
      creator:
        'Production composition creates its driver; the lifecycle invokes a fresh call each cycle.',
      consumers: ['Persistent worker', 'Durable lifecycle', 'Terminal outcome'],
      enforcement: [
        'Verifier tools are bounded, read-only, and restricted to manifest.json plus published artifacts.',
        'Malformed or unavailable judgment fails closed.',
      ],
      authority:
        'Sole semantic success verdict; no browser, scratch access, mutation, or requirement revision.',
      why: 'A separate context catches omissions and unsupported claims the producing worker may miss.',
      code: [
        'src/agent/verifier/verifier.ts',
        'src/agent/verifier/tools.ts',
        'src/agent/verifier/verificationResult.schema.ts',
      ],
    },
  }),
  concept({
    id: 'outcome',
    tone: 'outcome',
    code: '12',
    title: 'Truthful outcome',
    kicker: 'Absorbing terminal state',
    summary: 'Exposes verified success or a precise incomplete/cancelled reason after cleanup.',
    answers: {
      what: 'The normalized durable result returned by the lifecycle to every public adapter.',
      inputs: [
        'Verifier acceptance or bounded failure',
        'Latest worker text',
        'Unresolved findings',
      ],
      outputs: [
        'Verified, incomplete, or cancelled result',
        'Final manifest/transcript/metrics/findings',
      ],
      creator:
        'Coordinator terminalization persists an absorbing checkpoint after integrity cleanup.',
      consumers: ['TUI', 'Eval runner', 'Recovery integrity checks'],
      enforcement: [
        'finish never maps directly to success.',
        'Unavailable verification, exhausted limits, uncertainty, and cancellation remain non-success.',
      ],
      authority:
        'The checkpoint is durable truth; adapters may present but not reinterpret the status.',
      why: 'Honest failure with preserved artifacts is more useful than a false success claim.',
      code: ['src/run/runOutcome.ts', 'src/agent/lifecycle.ts', 'src/agent/findingsReport.ts'],
    },
  }),
  concept({
    id: 'grading',
    tone: 'evaluation',
    code: '13',
    title: 'Black-box evaluation',
    kicker: 'External product test',
    summary:
      'Runs isolated trials and grades only manifest-selected deliverables against fresh oracle data.',
    answers: {
      what: 'The eval harness tests Sherlock at the same run-directory boundary a product consumer sees.',
      inputs: ['Task metadata', 'Fresh browser session', 'runDir and oracleData'],
      outputs: ['Per-assertion score', 'Trial report', 'Aggregate metrics'],
      creator: 'The eval CLI creates normal parallel or headed serial trial lanes.',
      consumers: ['Developers', 'CI grading', 'Experiment reports'],
      enforcement: [
        'headed and requiresLogin are explicit task metadata.',
        'Graders receive only runDir and oracleData and select requested_output manifest roles.',
      ],
      authority: 'May score the product boundary; it cannot inspect or steer worker internals.',
      why: 'Hidden and live tasks reward general mechanisms instead of transcript-oriented tuning.',
      code: [
        'evals/runners/runner.ts',
        'evals/runners/browserRuntime.ts',
        'evals/grading/manifestVerification.ts',
      ],
    },
  }),
  concept({
    id: 'observability',
    tone: 'observability',
    code: '14',
    title: 'Observability projections',
    kicker: 'Side channel',
    summary:
      'Projects progress, transcript, metrics, and Langfuse spans without becoming product truth.',
    answers: {
      what: 'Local durable projections plus an optional external tracing adapter around the same run.',
      inputs: [
        'Model attempts',
        'Tool calls',
        'Checkpoint and manifest changes',
        'Lifecycle timing',
      ],
      outputs: ['TUI progress', 'transcript.jsonl', 'metrics.json', 'Langfuse observations'],
      creator: 'Composition creates tracing; lifecycle and tool/model seams emit events.',
      consumers: ['Human operator', 'Debugging', 'Performance analysis'],
      enforcement: [
        'Provider capabilities and secrets are redacted from diagnostics and tracing.',
        'Tracing remains observational during recovery and projection repair.',
      ],
      authority: 'Can explain execution but cannot select deliverables or determine success.',
      why: 'Operators need visibility without confusing telemetry with evidence.',
      code: ['src/tracing/runTracing.ts', 'src/run/transcript.ts', 'src/tui/bridge/runtime.ts'],
    },
  }),
];

export const implementations: readonly SemanticNode[] = [
  implementation('entry', {
    id: 'entry-tui',
    tone: 'surface',
    code: '01.a',
    title: 'Ink TUI',
    kicker: 'Interactive adapter',
    summary:
      'Attaches to local Chrome, streams progress, answers questions, and presents artifacts.',
    answers: {
      what: 'The primary terminal interface started by npm run sherlock.',
      inputs: ['Human task', 'Attached-browser setup events', 'Progress and permission requests'],
      outputs: ['runTask call', 'Permission decisions', 'Manifest-derived artifact events'],
      creator: 'src/tui/main.tsx creates the application and bridge runtime.',
      consumers: ['Production composition', 'Human operator'],
      enforcement: [
        'Preserves pre-existing tabs.',
        'Diffs the manifest after tools to announce publication.',
      ],
      authority: 'Owns interaction, not run truth.',
      why: 'Makes long evidence work visible and interruptible.',
      code: ['src/tui/main.tsx', 'src/tui/bridge/runtime.ts'],
    },
  }),
  implementation('entry', {
    id: 'entry-cli',
    tone: 'surface',
    code: '01.b',
    title: 'Eval CLI',
    kicker: 'Managed adapters',
    summary: 'Uses explicit managed browsers for isolated evaluation trials.',
    answers: {
      what: 'The batch evaluation adapter over the public run seam.',
      inputs: ['Dataset metadata', 'Managed browser configuration'],
      outputs: ['runTask calls', 'Trial reports'],
      creator: 'The eval CLI parses arguments and creates provider sessions.',
      consumers: ['Production composition', 'Eval reporting'],
      enforcement: ['Never attach to ambient Chrome.', 'Eval lanes follow explicit metadata.'],
      authority: 'Owns session setup and reporting only.',
      why: 'Supports automation without a second agent runtime.',
      code: ['evals/runners/cli.ts'],
    },
  }),
  implementation('composition', {
    id: 'composition-fresh',
    tone: 'orchestration',
    code: '02.a',
    title: 'runTask',
    kicker: 'Fresh-run path',
    summary: 'Freezes configuration, creates the run directory, and initializes the manifest.',
    answers: {
      what: 'The public fresh-run function.',
      inputs: ['Task text', 'RunTaskConfig'],
      outputs: ['New runDir', 'Initialized manifest', 'RunTaskResult'],
      creator: 'A public adapter calls it.',
      consumers: ['executeRun', 'TUI and eval adapters'],
      enforcement: [
        'Validates browser JavaScript policy.',
        'Applies production defaults before persistence.',
      ],
      authority: 'Creates run identity and durable configuration.',
      why: 'All fresh runs begin with identical invariants.',
      code: ['src/agent/runTask.ts'],
    },
  }),
  implementation('composition', {
    id: 'composition-execute',
    tone: 'orchestration',
    code: '02.b',
    title: 'executeRun',
    kicker: 'Live wiring',
    summary: 'Builds traced model drivers and the exact run-scoped tool registry before runAgent.',
    answers: {
      what: 'The internal live-dependency assembly function.',
      inputs: ['runDir', 'Durable config', 'Live seams'],
      outputs: ['Initializer, worker, verifier drivers', 'Tool registry', 'Normalized outcome'],
      creator: 'runTask calls it.',
      consumers: ['runAgent', 'Tracing'],
      enforcement: [
        'Closes tracing in finally.',
        'Uses canonical cached worker prompt and tool definitions.',
      ],
      authority: 'Wires dependencies; it does not run phases itself.',
      why: 'Keeps production assembly inspectable in one function.',
      code: ['src/agent/runTask.ts'],
    },
  }),
  implementation('lifecycle', {
    id: 'lifecycle-coordinator',
    tone: 'orchestration',
    code: '03.a',
    title: 'CoordinatorState',
    kicker: 'Phase owner',
    summary: 'Advances initializer, working, checking, verifying, and terminal phases.',
    answers: {
      what: 'The in-memory state owner backed by a durable checkpoint store.',
      inputs: ['Restored checkpoint', 'Budget', 'Role results'],
      outputs: ['Next checkpoint revision', 'Corrections', 'Terminal outcome'],
      creator: 'runAgent creates it under the run lock.',
      consumers: ['Checkpoint store', 'Worker and verifier loops'],
      enforcement: [
        'Writes state only through checkpoint transitions.',
        'Terminalization is one-way.',
      ],
      authority: 'Owns lifecycle phase and correction routing.',
      why: 'One owner prevents contradictory phase transitions.',
      code: ['src/agent/lifecycle.ts'],
    },
  }),
  implementation('lifecycle', {
    id: 'lifecycle-recovery',
    tone: 'orchestration',
    code: '03.b',
    title: 'Checkpoint + recovery',
    kicker: 'Crash boundary',
    summary:
      'Locks the run, validates integrity, and reconciles uncertain effects before progress resumes.',
    answers: {
      what: 'Durable schema, store, recovery inspection, budget, and deadline machinery.',
      inputs: ['harness checkpoint', 'Run files', 'Current time and abort signal'],
      outputs: ['Validated restored state', 'Reconciled workspace', 'Deadline signal'],
      creator: 'runAgent opens these on every lifecycle invocation.',
      consumers: ['CoordinatorState', 'Terminal integrity repair'],
      enforcement: [
        'Monotonic revisions and exclusive lock.',
        'Never blindly replays an uncertain state-changing effect.',
      ],
      authority: 'May recover or refuse corrupted state.',
      why: 'A process crash must not duplicate effects or invent success.',
      code: ['src/agent/checkpoint.ts', 'src/run/runBudget.ts', 'src/run/runDeadline.ts'],
    },
  }),
  implementation('contract', {
    id: 'contract-model',
    tone: 'model',
    code: '04.a',
    title: 'Initializer model',
    kicker: 'Bounded author',
    summary: 'Calls a private schema tool exactly once per accepted contract attempt.',
    answers: {
      what: 'A dedicated Claude call with no browser or worker tools.',
      inputs: ['Task', 'Contract prompt', 'Prior validation error on repair'],
      outputs: ['set_output_contract input'],
      creator: 'Composition creates its ModelDriver.',
      consumers: ['Contract validation'],
      enforcement: [
        'Maximum two attempts.',
        'Accepted response must contain the one expected tool call.',
      ],
      authority: 'Authors proposed requirements only.',
      why: 'Requirement extraction should finish before research begins.',
      code: ['src/agent/initializer/initializer.ts', 'src/prompts/contract.md'],
    },
  }),
  implementation('contract', {
    id: 'contract-tool',
    tone: 'model',
    code: '04.b',
    title: 'set_output_contract',
    kicker: 'Initializer-only protocol',
    summary: 'Carries the proposed contract as one intercepted, non-executing tool call.',
    answers: {
      what: 'The initializer-private tool protocol used to return structured requirements instead of prose.',
      inputs: ['contract.outputs', 'Optional contract.contentExpectations'],
      outputs: ['One proposed OutputContract for mechanical and semantic validation'],
      creator: 'The initializer model must call it through forced tool choice.',
      consumers: ['validateInitialContractCall', 'OutputContract validation'],
      enforcement: [
        'Exactly one call and no other tool calls are accepted.',
        'Its execute function always throws because the initializer loop intercepts the call.',
      ],
      authority: 'Transports a proposal; it cannot execute effects or store an invalid contract.',
      why: 'A strict tool boundary makes the handoff typed, repairable, and independent of prose parsing.',
      code: ['src/agent/initializer/initializer.ts'],
    },
  }),
  implementation('contract', {
    id: 'contract-schema',
    tone: 'model',
    code: '04.c',
    title: 'OutputContract schema',
    kicker: 'Durable form',
    summary:
      'Validates output unions, exact shapes, and cross-field rules, then persists the contract.',
    answers: {
      what: 'The Zod discriminated unions for table, document, screenshot, external-action, and download outputs, plus semantic cross-field validation and the durable writer.',
      inputs: ['Proposed tool input from set_output_contract'],
      outputs: ['Typed contract', 'harness/output-contract.json'],
      creator: 'Initializer validation accepts and persists it.',
      consumers: ['Worker context', 'Finish checks', 'Verifier', 'Crash recovery'],
      enforcement: [
        'Dedicated schema validates exact durable shape.',
        'ensureOutputContractFile detects drift.',
      ],
      authority: 'Canonical machine representation of output requirements.',
      why: 'All later roles must see the same contract after restart.',
      code: [
        'src/agent/initializer/outputContract.schema.ts',
        'src/agent/initializer/contractFile.ts',
      ],
    },
  }),
  implementation('worker', {
    id: 'worker-session',
    tone: 'model',
    code: '05.a',
    title: 'createWorker',
    kicker: 'Sequential loop',
    summary: 'Maintains the useful conversation and executes accepted responses in order.',
    answers: {
      what: 'The stateful Worker returned by createWorker: one conversation, response validator, and sequential executor.',
      inputs: ['Task and contract guidance', 'ModelDriver', 'ToolRegistry'],
      outputs: ['Progress', 'Effects', 'FinishRequest or bounded stop'],
      creator: 'CoordinatorState calls createWorker after contract acceptance.',
      consumers: ['CoordinatorState', 'Tool pipeline'],
      enforcement: [
        'Rejects invalid streaming output before history or execution.',
        'No parallel dispatch.',
      ],
      authority: 'Controls the Worker conversation and response execution.',
      why: 'One Worker remembers evidence and corrections without permitting parallel effects.',
      code: ['src/agent/worker/worker.ts'],
    },
  }),
  implementation('worker', {
    id: 'worker-context',
    tone: 'model',
    code: '05.b',
    title: 'Context view',
    kicker: 'Model projection',
    summary: 'Builds bounded role messages without mutating the cached system prefix.',
    answers: {
      what: 'The dynamic task, contract, correction, and tool-result view sent in conversation messages.',
      inputs: ['Checkpoint history', 'Contract', 'Tool results and corrections'],
      outputs: ['Worker messages'],
      creator: 'WorkerSession rebuilds it as needed.',
      consumers: ['Worker ModelDriver'],
      enforcement: [
        'Oversized complete text is offloaded to scratch/tool-output.',
        'Static prefix stays byte-stable.',
      ],
      authority: 'Chooses context projection, not system policy.',
      why: 'Long runs need useful history within a request context ceiling.',
      code: ['src/agent/worker/contextView.ts', 'src/tools/capResult.ts'],
    },
  }),
  implementation('tools', {
    id: 'tools-registry',
    tone: 'capability',
    code: '06.a',
    title: 'Registry + API defs',
    kicker: 'Frozen surface',
    summary:
      'Assembles browser_execute, capture_screenshot, publish_artifact, read/write/edit_file, bash, ask_user, and finish.',
    answers: {
      what: 'The ordered ToolDef map and canonical model-facing JSON schemas.',
      inputs: ['JavaScript policy', 'Secret environment denylist'],
      outputs: ['ToolRegistry', 'WORKER_API_TOOL_DEFS'],
      creator: 'createWorkerToolRegistry builds one per run.',
      consumers: ['Worker ModelDriver', 'Execution pipeline'],
      enforcement: [
        'WORKER_TOOL_ORDER fixes names and order.',
        'Deep freezing prevents prefix mutation.',
      ],
      authority: 'Defines available capabilities, not permission outcomes.',
      why: 'Deterministic tools preserve prompt caching and reduce model ambiguity.',
      code: ['src/tools/index.ts', 'src/tools/registry.ts'],
    },
  }),
  implementation('tools', {
    id: 'tools-pipeline',
    tone: 'capability',
    code: '06.b',
    title: 'Execution pipeline',
    kicker: 'Effect gate',
    summary:
      'Wraps each tool with validation, permission, a global busy gate, timeout, recovery, and output bounds.',
    answers: {
      what: 'The common executor around every model-visible ToolDef.',
      inputs: ['Tool call', 'Tool context', 'BusyResourceRegistry'],
      outputs: ['CapResult', 'Effect records', 'Busy-resource state'],
      creator: 'Worker dispatches accepted calls through it.',
      consumers: ['Worker history', 'Lifecycle checkpoint'],
      enforcement: [
        'Timed-out resources remain busy until underlying work settles.',
        'The global busy gate blocks every later call and terminalization until effects settle.',
      ],
      authority: 'May run or reject a validated effect.',
      why: 'One enforcement path avoids tool-specific safety drift.',
      code: ['src/tools/pipeline.ts', 'src/tools/capResult.ts'],
    },
  }),
  implementation('browser', {
    id: 'browser-program',
    tone: 'browser',
    code: '07.a',
    title: 'browser_execute child',
    kicker: 'Bounded program',
    summary: 'Runs model-authored JavaScript in a fresh child through protected parent IPC.',
    answers: {
      what: 'A finite Node child and parent helper protocol pinned to one command session.',
      inputs: ['JavaScript source', 'Run workspace', 'Pinned target helper'],
      outputs: ['Serializable result', 'Downloads/screenshots/workspace changes'],
      creator: 'browser_execute launches one child per call.',
      consumers: ['Worker', 'Workspace sync', 'BrowserController'],
      enforcement: [
        'Foreground timeout and parent-death watchdog.',
        'No CDP URL, credential, package install, or background process.',
      ],
      authority: 'May invoke protected helpers for one owned page.',
      why: 'Fresh bounded programs offer flexibility without persistent child authority.',
      code: [
        'src/tools/browserExecute/runner.ts',
        'src/tools/browserExecute/child.mjs',
        'src/tools/browserExecute/coreHelpers.mjs',
      ],
    },
  }),
  implementation('browser', {
    id: 'browser-controller',
    tone: 'browser',
    code: '07.b',
    title: 'Controller + providers',
    kicker: 'Engine seam',
    summary: 'Owns pages and selects attached Chrome, managed Chrome, or explicit Browserbase.',
    answers: {
      what: 'BrowserController plus provider implementations and exact target command sessions.',
      inputs: ['Provider configuration', 'Run marker', 'Protected browser operations'],
      outputs: ['Prepared page', 'Pinned session', 'Verified downloads', 'Safe diagnostics'],
      creator: 'BrowserSessionProvider.createSession returns it.',
      consumers: ['browser_execute', 'Lifecycle cleanup'],
      enforcement: [
        'Only SHERLOCK_BROWSER_PROVIDER=browserbase selects remote.',
        'Cleanup closes only same-run marked pages.',
      ],
      authority: 'Owns its session and run pages, never ambient pages.',
      why: 'The worker contract stays identical across local and remote engines.',
      code: [
        'src/browser/controller.ts',
        'src/browser/provider.ts',
        'src/browser/playwrightBrowserController.ts',
      ],
    },
  }),
  implementation('publication', {
    id: 'publication-tool',
    tone: 'store',
    code: '08.a',
    title: 'publish_artifact',
    kicker: 'Model-facing boundary',
    summary: 'Validates roles and chooses inline, workspace, screenshot, or download bytes.',
    answers: {
      what: 'The sole publication ToolDef.',
      inputs: ['Publication input', 'Run context'],
      outputs: ['Published artifact result'],
      creator: 'The registry exposes it to the worker.',
      consumers: ['Artifact transaction', 'Worker'],
      enforcement: ['Requires a semantic role.', 'Confines and validates every source path.'],
      authority: 'May request publication only.',
      why: 'Explicit intent separates deliverables from temporary files.',
      code: ['src/tools/publishArtifact/publishArtifact.ts'],
    },
  }),
  implementation('publication', {
    id: 'publication-transaction',
    tone: 'store',
    code: '08.b',
    title: 'Artifact transaction',
    kicker: 'Crash-safe commit',
    summary:
      'Journals bytes, hashes them, atomically updates the manifest, and reconciles recovery.',
    answers: {
      what: 'The durable write protocol behind publication.',
      inputs: ['Validated bytes', 'Artifact metadata'],
      outputs: ['artifacts/file', 'Manifest entry', 'Cleared journal'],
      creator: 'publish_artifact starts the transaction.',
      consumers: ['Run directory', 'Recovery', 'Verifier and graders'],
      enforcement: [
        'No-follow targets and SHA-256 verification.',
        'Recovery completes or rolls forward known transaction state.',
      ],
      authority: 'Commits artifact bytes and manifest truth together.',
      why: 'A crash cannot leave a manifest pointing at partial or different bytes.',
      code: ['src/run/artifactWriteTransaction.ts', 'src/run/artifacts.ts'],
    },
  }),
  implementation('run-store', {
    id: 'run-store-public',
    tone: 'store',
    code: '09.a',
    title: 'artifacts + manifest',
    kicker: 'Public record',
    summary: 'Holds published bytes and their roles, hashes, provenance, and lifecycle metadata.',
    answers: {
      what: 'The public portion of a run directory.',
      inputs: ['Artifact transactions', 'Lifecycle times'],
      outputs: ['Manifest-selected outputs and evidence'],
      creator: 'runTask initializes it; publication and lifecycle update it.',
      consumers: ['TUI', 'Verifier', 'Graders'],
      enforcement: ['Atomic manifest writes.', 'Hash and role checks select trusted entries.'],
      authority: 'Defines which files are published.',
      why: 'Consumers need a stable selection protocol independent of filenames or prose.',
      code: ['src/run/artifacts.ts', 'src/run/atomicFile.ts'],
    },
  }),
  implementation('run-store', {
    id: 'run-store-private',
    tone: 'store',
    code: '09.b',
    title: 'scratch + harness',
    kicker: 'Private state',
    summary:
      'Keeps worker files separate from protected checkpoints, locks, contracts, and journals.',
    answers: {
      what: 'The private working and recovery portions of a run.',
      inputs: ['File tools', 'Bash/browser workspace effects', 'Lifecycle checkpoints'],
      outputs: ['Hashed workspace', 'Recoverable harness state'],
      creator: 'createRunDir creates the fixed directory shape.',
      consumers: ['Worker', 'Recovery lifecycle'],
      enforcement: [
        'Model paths cannot enter harness.',
        'Workspace sync rejects symlinks and special files.',
      ],
      authority: 'Worker may write scratch; only harness code may write harness.',
      why: 'Private iteration and protected control state need different trust boundaries.',
      code: ['src/run/runDir.ts', 'src/run/syncScratchWorkspace.ts', 'src/agent/checkpoint.ts'],
    },
  }),
  implementation('checks', {
    id: 'checks-finish',
    tone: 'verification',
    code: '10.a',
    title: 'finish protocol',
    kicker: 'Control request',
    summary: 'Intercepts the exclusive finish call and hands its report to lifecycle checks.',
    answers: {
      what: 'A model-facing control ToolDef whose call requests checking rather than success.',
      inputs: ['Summary and unresolved requirements'],
      outputs: ['FinishRequest control flow'],
      creator: 'Registry exposes finish; worker interception handles it.',
      consumers: ['Lifecycle', 'runFinishChecks'],
      enforcement: [
        'Must be the sole call in a worker response.',
        'Prose or zero tools never completes.',
      ],
      authority: 'Can request validation only.',
      why: 'Completion needs one explicit machine-detectable protocol.',
      code: ['src/tools/finish/finish.ts', 'src/agent/worker/worker.ts'],
    },
  }),
  implementation('checks', {
    id: 'checks-inspection',
    tone: 'verification',
    code: '10.b',
    title: 'Artifact inspection',
    kicker: 'Mechanical proof',
    summary: 'Reads manifest bytes and validates exact structures before model judgment.',
    answers: {
      what: 'runFinishChecks plus bounded CSV, JSON, Markdown, media, and hash inspection.',
      inputs: ['Contract', 'Finish request', 'Run directory'],
      outputs: ['FinishFacts', 'Structured defects'],
      creator: 'Lifecycle invokes it synchronously.',
      consumers: ['Worker correction', 'Verifier'],
      enforcement: [
        'No-follow bounded reads.',
        'Exact requested columns mean exact order with no extras.',
      ],
      authority: 'Settles code-decidable facts.',
      why: 'Deterministic defects are cheaper and more reliable to repair before verification.',
      code: ['src/agent/completion/finishChecks.ts', 'src/agent/completion/artifactInspection.ts'],
    },
  }),
  implementation('verifier', {
    id: 'verifier-model',
    tone: 'verification',
    code: '11.a',
    title: 'Verifier model',
    kicker: 'Fresh context',
    summary: 'Haiku re-derives semantic completeness without inheriting the worker conversation.',
    answers: {
      what: 'A dedicated read-only model role and strict result protocol.',
      inputs: ['Verifier prompt', 'Surfaced run evidence', 'Deterministic facts'],
      outputs: ['VerificationResult tool call'],
      creator: 'Composition creates its driver; lifecycle invokes each cycle.',
      consumers: ['Result schema', 'Lifecycle'],
      enforcement: [
        'Fresh message context per judgment.',
        'Exactly one schema-valid result is accepted.',
      ],
      authority: 'Proposes the sole semantic verdict.',
      why: 'Independence reduces producer self-confirmation.',
      code: ['src/agent/verifier/verifier.ts', 'src/prompts/verifier.md'],
    },
  }),
  implementation('verifier', {
    id: 'verifier-boundary',
    tone: 'verification',
    code: '11.b',
    title: 'Read-only boundary',
    kicker: 'Constrained evidence',
    summary: 'Allows bounded reads of manifest.json and published artifacts only.',
    answers: {
      what: 'Verifier inspection tools and the VerificationResult schema.',
      inputs: ['Manifest path', 'Published artifact path', 'Model result'],
      outputs: ['Bounded file content', 'Typed verdict'],
      creator: 'Verifier harness creates private tools per judgment.',
      consumers: ['Verifier model', 'Lifecycle'],
      enforcement: [
        'No browser, scratch, harness, or mutation.',
        'Schema failure becomes incomplete rather than success.',
      ],
      authority: 'May inspect published evidence and validate a verdict.',
      why: 'The judge should see what downstream consumers can actually receive.',
      code: ['src/agent/verifier/tools.ts', 'src/agent/verifier/verificationResult.schema.ts'],
    },
  }),
  implementation('outcome', {
    id: 'outcome-terminal',
    tone: 'outcome',
    code: '12.a',
    title: 'Terminal checkpoint',
    kicker: 'Durable truth',
    summary: 'Persists status, findings, final text, and phase as an absorbing checkpoint.',
    answers: {
      what: 'The terminal variant of the durable checkpoint schema.',
      inputs: ['Accepted verdict or failure reason', 'Coordinator state'],
      outputs: ['DurableTerminalOutcome'],
      creator: 'CoordinatorState.terminalize writes it.',
      consumers: ['Public result', 'Recovery integrity checks'],
      enforcement: [
        'Cannot transition back to active.',
        'A restored verified terminal checkpoint re-runs deterministic integrity checks.',
      ],
      authority: 'Canonical terminal status.',
      why: 'Restarting cannot accidentally rerun a finished job or rewrite its meaning.',
      code: ['src/agent/checkpoint.schema.ts', 'src/agent/lifecycle.ts'],
    },
  }),
  implementation('outcome', {
    id: 'outcome-projections',
    tone: 'outcome',
    code: '12.b',
    title: 'Cleanup + projections',
    kicker: 'Safe handoff',
    summary:
      'Drains busy effects, reconciles files, closes owned pages, and repairs public projections.',
    answers: {
      what: 'The terminal fixed-point cleanup and outcome normalization path.',
      inputs: ['Terminal checkpoint', 'Busy resources', 'Browser and run directory'],
      outputs: [
        'Closed owned pages',
        'Final manifest/transcript/metrics/findings',
        'RunTaskResult',
      ],
      creator: 'Lifecycle terminalization invokes it before lock release.',
      consumers: ['TUI and eval runner'],
      enforcement: [
        'Does not abandon still-running timed-out effects.',
        'Never closes ambient pages.',
      ],
      authority: 'Finalizes projections without changing the verdict.',
      why: 'A terminal result must describe quiescent, inspectable state.',
      code: ['src/agent/lifecycle.ts', 'src/agent/findingsReport.ts', 'src/run/runOutcome.ts'],
    },
  }),
  implementation('grading', {
    id: 'grading-runner',
    tone: 'evaluation',
    code: '13.a',
    title: 'Trial lanes',
    kicker: 'Isolated execution',
    summary: 'Runs normal headless trials in parallel and headed/authenticated work serially.',
    answers: {
      what: 'The eval runner and browser-runtime composition.',
      inputs: ['Task metadata', 'Concurrency', 'Provider configuration'],
      outputs: ['Isolated runDir per trial'],
      creator: 'Eval CLI loads tasks and creates lanes.',
      consumers: ['Oracle and grader phase'],
      enforcement: [
        'Normal lane browsers are isolated.',
        'Headed and login policies are explicit metadata.',
      ],
      authority: 'Schedules trials and browser sessions.',
      why: 'Trials must not contaminate each other or ambient user state.',
      code: ['evals/runners/runner.ts', 'evals/runners/browserRuntime.ts'],
    },
  }),
  implementation('grading', {
    id: 'grading-oracle',
    tone: 'evaluation',
    code: '13.b',
    title: 'Oracle + graders',
    kicker: 'Fresh scoring',
    summary: 'Loads expected external facts after the run and scores requested outputs only.',
    answers: {
      what: 'Task-specific oracle loaders and black-box assertion functions.',
      inputs: ['runDir', 'Fresh oracleData'],
      outputs: ['Assertions and score'],
      creator: 'Runner invokes them after the agent finishes.',
      consumers: ['Eval reports'],
      enforcement: [
        'No transcript or scratch access.',
        'Manifest requested_output roles choose deliverables.',
      ],
      authority: 'Scores correctness but cannot mutate the run.',
      why: 'Fresh expected data keeps live-web evaluations meaningful.',
      code: ['evals/grading/manifestVerification.ts', 'evals/oracles/fetchWithRetry.ts'],
    },
  }),
  implementation('observability', {
    id: 'observability-local',
    tone: 'observability',
    code: '14.a',
    title: 'Durable projections',
    kicker: 'Local diagnostics',
    summary: 'Records transcript and metrics as rebuildable views of lifecycle events.',
    answers: {
      what: 'Append-safe execution projections inside the run directory.',
      inputs: ['Model/tool/lifecycle events'],
      outputs: ['transcript.jsonl', 'metrics.json'],
      creator: 'Lifecycle and execution seams update them.',
      consumers: ['Debugging', 'Eval metrics', 'Terminal projection repair'],
      enforcement: [
        'Historical v3 event names remain stable.',
        'They never determine deliverable roles.',
      ],
      authority: 'Observational only.',
      why: 'Durable local evidence supports diagnosis without external services.',
      code: ['src/run/transcript.ts', 'src/agent/lifecycle.ts'],
    },
  }),
  implementation('observability', {
    id: 'observability-live',
    tone: 'observability',
    code: '14.b',
    title: 'Progress + tracing',
    kicker: 'Live side channel',
    summary: 'Streams safe progress to the TUI and optional role/tool observations to Langfuse.',
    answers: {
      what: 'The public progress bridge and RunTracing adapter.',
      inputs: ['Model attempt events', 'Tool calls', 'Run lifecycle'],
      outputs: ['TUI status', 'External traces when configured'],
      creator: 'Composition creates and wraps these seams.',
      consumers: ['Human operator', 'Performance analysis'],
      enforcement: [
        'Redacts capabilities and secret environment values.',
        'Tracing closes in finally.',
      ],
      authority: 'May observe timing and summaries only.',
      why: 'Long-running browser work needs understandable progress and attribution.',
      code: ['src/tracing/runTracing.ts', 'src/agent/runTask.ts'],
    },
  }),
];

export const edges: readonly SemanticEdge[] = [
  {
    id: 'entry-worker-core',
    source: 'entry',
    target: 'worker',
    label: 'starts research',
    explanation:
      'The core view folds composition, lifecycle, and contract initialization into this one honest summary edge.',
    kind: 'flow',
    routeIds: ['core'],
  },
  {
    id: 'worker-verifier-core',
    source: 'worker',
    target: 'verifier',
    label: 'submits evidence',
    explanation:
      'The core view folds tools, publication, the run directory, and deterministic finish checks into this one honest summary edge.',
    kind: 'flow',
    routeIds: ['core'],
  },
  {
    id: 'entry-composition',
    source: 'entry',
    target: 'composition',
    label: 'calls',
    explanation: 'Every public adapter enters through runTask.',
    kind: 'flow',
  },
  {
    id: 'composition-lifecycle',
    source: 'composition',
    target: 'lifecycle',
    label: 'assembles',
    explanation: 'The composition root injects all live dependencies into runAgent.',
    kind: 'flow',
  },
  {
    id: 'lifecycle-contract',
    source: 'lifecycle',
    target: 'contract',
    label: 'initializes',
    explanation: 'The lifecycle establishes the immutable contract before worker research.',
    kind: 'control',
  },
  {
    id: 'contract-worker',
    source: 'contract',
    target: 'worker',
    label: 'task + contract',
    explanation:
      'The worker opens with the original request and the exact accepted OutputContract as separate guidance.',
    kind: 'flow',
  },
  {
    id: 'lifecycle-worker',
    source: 'lifecycle',
    target: 'worker',
    label: 'coordinates',
    explanation:
      'The coordinator owns worker creation, checkpoint restoration, correction, and stop.',
    kind: 'control',
  },
  {
    id: 'worker-tools',
    source: 'worker',
    target: 'tools',
    label: 'requests effects',
    explanation: 'Validated worker responses call only the frozen capability surface.',
    kind: 'flow',
  },
  {
    id: 'tools-browser',
    source: 'tools',
    target: 'browser',
    label: 'executes',
    explanation: 'browser_execute crosses the capability gate into owned-page control.',
    kind: 'flow',
  },
  {
    id: 'tools-publication',
    source: 'tools',
    target: 'publication',
    label: 'publishes',
    explanation: 'publish_artifact is the sole model-visible public write.',
    kind: 'flow',
  },
  {
    id: 'publication-store',
    source: 'publication',
    target: 'run-store',
    label: 'commits',
    explanation: 'Artifact transactions atomically add bytes and manifest truth.',
    kind: 'flow',
  },
  {
    id: 'tools-store',
    source: 'tools',
    target: 'run-store',
    label: 'private writes',
    explanation: 'File, bash, and browser workspace effects remain private until publication.',
    kind: 'flow',
  },
  {
    id: 'lifecycle-store',
    source: 'lifecycle',
    target: 'run-store',
    label: 'checkpoints',
    explanation: 'Every phase and effect boundary is made durable under harness/.',
    kind: 'control',
  },
  {
    id: 'worker-checks',
    source: 'worker',
    target: 'checks',
    label: 'finish() alone',
    explanation:
      'The worker submits its summary and unresolved list through one exclusive finish call, which requests review rather than success.',
    kind: 'flow',
  },
  {
    id: 'checks-worker',
    source: 'checks',
    target: 'worker',
    label: 'repair defects',
    explanation: 'Mechanical failures return to the same persistent worker.',
    kind: 'feedback',
  },
  {
    id: 'checks-verifier',
    source: 'checks',
    target: 'verifier',
    label: 'facts + files',
    explanation:
      'Passing checks provide code-settled facts and the manifest-selected evidence view for semantic judgment.',
    kind: 'flow',
  },
  {
    id: 'store-verifier',
    source: 'run-store',
    target: 'verifier',
    label: 'published view',
    explanation: 'The verifier can read only manifest-selected published evidence.',
    kind: 'read',
  },
  {
    id: 'verifier-worker',
    source: 'verifier',
    target: 'worker',
    label: 'typed correction',
    explanation:
      'Research, artifact-repair, or report-repair findings return to the same persistent worker conversation.',
    kind: 'feedback',
  },
  {
    id: 'verifier-outcome',
    source: 'verifier',
    target: 'outcome',
    label: 'verified / incomplete',
    explanation: 'Verifier acceptance is the only success path.',
    kind: 'flow',
  },
  {
    id: 'lifecycle-outcome',
    source: 'lifecycle',
    target: 'outcome',
    label: 'terminalizes',
    explanation: 'The coordinator persists all success, incomplete, and cancelled terminal states.',
    kind: 'control',
  },
  {
    id: 'store-grading',
    source: 'run-store',
    target: 'grading',
    label: 'black-box input',
    explanation: 'Graders receive the finished directory, never worker internals.',
    kind: 'read',
  },
  {
    id: 'composition-observability',
    source: 'composition',
    target: 'observability',
    label: 'wraps',
    explanation: 'Composition wraps model and tool seams with optional tracing.',
    kind: 'flow',
  },
  {
    id: 'lifecycle-observability',
    source: 'lifecycle',
    target: 'observability',
    label: 'projects',
    explanation: 'Lifecycle events become progress, transcript, and metrics.',
    kind: 'flow',
  },
];

export const routes: readonly LearningRoute[] = [
  {
    id: 'handoff',
    number: '01',
    title: 'Three-model handoff',
    summary: 'Initializer → worker → verifier.',
    promise: 'Follow task text into a contract, evidence-producing work, checks, and judgment.',
    nodeIds: ['contract', 'worker', 'checks', 'verifier'],
  },
  {
    id: 'core',
    number: '02',
    title: 'Product boundary',
    summary: 'The smallest useful mental model.',
    promise: 'Follow a task from entry to independently verified outcome.',
    nodeIds: ['entry', 'worker', 'verifier', 'outcome'],
  },
  {
    id: 'research',
    number: '03',
    title: 'Browser research',
    summary: 'How one model controls a real browser.',
    promise: 'Trace capability checks, target ownership, and programmable browser execution.',
    nodeIds: ['worker', 'tools', 'browser', 'publication', 'run-store'],
  },
  {
    id: 'trust',
    number: '04',
    title: 'Evidence trust',
    summary: 'Why artifact claims are auditable.',
    promise: 'Trace publication, deterministic facts, semantic review, and grading.',
    nodeIds: ['worker', 'publication', 'run-store', 'checks', 'verifier', 'outcome', 'grading'],
  },
  {
    id: 'recovery',
    number: '05',
    title: 'Crash recovery',
    summary: 'What survives interruption.',
    promise: 'Trace configuration, checkpoint state, reconciliation, and terminal truth.',
    nodeIds: ['entry', 'composition', 'lifecycle', 'worker', 'tools', 'run-store', 'outcome'],
  },
  {
    id: 'authority',
    number: '06',
    title: 'Authority map',
    summary: 'Who is allowed to claim or mutate what.',
    promise: 'Walk from human authority through effects, evidence, and the sole success judge.',
    nodeIds: [
      'entry',
      'contract',
      'worker',
      'tools',
      'browser',
      'publication',
      'checks',
      'verifier',
      'outcome',
    ],
  },
  {
    id: 'full',
    number: '07',
    title: 'Whole system',
    summary: 'All conceptual boundaries at once.',
    promise: 'Survey every production and evaluation subsystem after learning the smaller routes.',
    nodeIds: concepts.map((node) => node.id),
  },
];

export const allNodes: readonly SemanticNode[] = [...concepts, ...implementations];
export const nodeById = new Map(allNodes.map((node) => [node.id, node]));

export function implementationNodes(parentId: string): readonly SemanticNode[] {
  return implementations.filter((node) => node.parentId === parentId);
}

export function validateGraphData(): void {
  const ids = new Set<string>();
  for (const node of allNodes) {
    if (ids.has(node.id)) throw new Error(`duplicate atlas node id: ${node.id}`);
    ids.add(node.id);
    const answers = node.answers;
    if (
      !answers.what ||
      !answers.creator ||
      !answers.authority ||
      !answers.why ||
      answers.inputs.length === 0 ||
      answers.outputs.length === 0 ||
      answers.consumers.length === 0 ||
      answers.enforcement.length === 0 ||
      answers.code.length === 0
    ) {
      throw new Error(`atlas node ${node.id} does not answer every semantic question`);
    }
    if (node.kind === 'concept' && implementationNodes(node.id).length < 2) {
      throw new Error(`concept ${node.id} has no implementation-level subgraph`);
    }
  }
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target))
      throw new Error(`atlas edge ${edge.id} has an unknown endpoint`);
  }
  for (const route of routes) {
    if (
      route.nodeIds.length === 0 ||
      route.nodeIds.some((id) => !concepts.some((node) => node.id === id))
    ) {
      throw new Error(`atlas route ${route.id} contains an unknown concept`);
    }
  }
}

validateGraphData();
