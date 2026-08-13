import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type {
  AssistantContentBlock,
  CallModel,
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../loop/messages.js';
import { makeCallModel, type ProgressEvent } from '../model/callModel.js';
import { ARTIFACTS_DIR, MANIFEST_FILENAME } from '../run/artifacts.js';
import { grepTool } from '../tools/grep/grep.js';
import { executeToolCall, type ToolCallResult } from '../tools/pipeline.js';
import { readFileTool } from '../tools/readFile/readFile.js';
import { createRegistry, toApiToolDefs, type ToolCtx, type ToolDef, type ToolRegistry } from '../tools/registry.js';
import { CONTRACT_FILENAME, INTENT_FILENAME } from './initializer.js';

// The judge is the harness's third role (see
// .agents/planning/2026-08-12-research-quality-harness/judge-design.md): a
// fresh-context verifier that checks a worker's proposed completion against
// INTENT.md + CONTRACT.md (initializer-owned) and the run's published
// evidence, then returns DONE or CONTINUE + a short reason. It never
// re-collects evidence and never browses — its only tools are read_file and
// grep, scoped to the run directory — and it never rewrites the contract.
//
// This module is a much smaller sibling of runAgentLoop (agentLoop.ts): a
// bounded mini-loop with the same content-decides-completion policy (no
// tool_use blocks ends the run) and the same tool-execution seam
// (executeToolCall, the pipeline's per-call entry point), but with none of
// the loop's transcript/metrics bookkeeping, elision, or budget guards —
// the judge's turn cap (JUDGE_MAX_TURNS) is the only guard it needs, and its
// verdict is returned to the harness, never written to the run directory
// (see judge-design.md's "Loop" section: "the harness records each judge
// verdict + reason in run metadata for diagnostics" — that recording is the
// harness's job, not this module's).

/** Model the judge runs on. Haiku tier: verifying a contract against
 * already-collected evidence is a bounded reading-comprehension task, not
 * one that benefits from Sonnet's extra capability — see judge-design.md's
 * role table. */
export const JUDGE_MODEL = 'claude-haiku-4-5-20251001';

/** Maximum number of model calls in one judge run. Bounds the mini-loop
 * outright: verifying a contract needs at most a handful of targeted reads,
 * never an open-ended investigation (that would blur into re-collecting
 * evidence, which is out of scope for this role). Hitting the cap without a
 * parseable final response is treated as CONTINUE (see runJudge) — never as
 * a silent DONE. */
export const JUDGE_MAX_TURNS = 8;

/**
 * Dedicated system prompt for the judge's mini-loop. Deliberately generic
 * protocol only: per the design's eval-integrity guardrail (judge-design.md,
 * "Eval integrity" — nobody inside a run sees oracles or graders), nothing
 * here may name a specific task, website, dataset, or grading method. The
 * same prompt runs unchanged across every task, hidden or not.
 */
export const JUDGE_SYSTEM_PROMPT = `You are a fresh-context verifier for one evidence-collection run. You were not present for the work and have no memory of it: everything you know about this run comes from the task text, INTENT.md, and CONTRACT.md, plus the manifest and artifact listing, all given to you in the opening message.

Your only job is to check whether the contract in CONTRACT.md is fully satisfied by what was actually produced. Go through every criterion in the contract and check it individually against the real artifacts: read the deliverable files named in CONTRACT.md and INTENT.md with read_file, and use grep when you need to confirm a pattern, a count, or the presence or absence of something across files. Verify structure — the exact fields, columns, or sections the contract requires — and field-level rules — formats, enum-like values, required non-emptiness — by inspecting the actual file content, never by assuming it was done correctly. Verify that every factual claim in the deliverables is backed by evidence surfaced somewhere in the run directory; a claim with no supporting evidence has not been proven, no matter how plausible it sounds.

Be skeptical. An unproven claim fails the criterion it belongs to, even if it looks correct on its face. A criterion is satisfied only when you can point to the specific evidence that proves it; when you cannot, treat it as unsatisfied. Do not give the benefit of the doubt, and do not fill gaps with outside knowledge.

You have exactly two tools, both read-only and both scoped to this run's directory: read_file and grep. You have no browser and cannot take new evidence, re-collect anything that should already be in the run directory, or edit any file. You must not rewrite, loosen, reinterpret, or add to the contract — apply it exactly as written. If the contract is genuinely ambiguous on a specific point, judge conservatively: prefer CONTINUE with a concrete question over guessing what was intended.

Work turn by turn: call only the reads and searches you need to check the contract's criteria, then stop calling tools once you have enough evidence to decide. Do not pad the run with speculative exploration beyond what the contract requires you to verify.

Your final response must contain no tool calls, and its text must be exactly one of two things, and nothing else:
- DONE — every criterion in the contract is satisfied and you have verified each one against actual evidence in the run directory.
- CONTINUE: <short, concrete reason> — naming exactly what is unsatisfied or unproven and what must be fixed, specific enough that someone with no memory of this conversation could act on it directly.

Never output anything else as your final response, and never invent or defer to any task-specific grading system, external oracle, or answer key — none exists for you to consult. Judge only from CONTRACT.md, INTENT.md, and the evidence in this run directory.`;

/** The judge's tool registry: read_file and grep only, in that order — no
 * browser, no write tools, nothing state-changing. Built once at module
 * load and shared between `runJudge` (executing the model's tool_use
 * blocks) and `makeJudgeCallModel` (deriving the matching apiToolDefs), so
 * the two can never drift apart. */
const JUDGE_TOOL_REGISTRY: ToolRegistry = createRegistry([
  readFileTool as ToolDef,
  grepTool as ToolDef,
]);

/** The judge's verdict on one worker cycle's proposed completion. `reason`
 * is always a string: empty for `done` (nothing to report), and non-empty
 * for `continue` (see runJudge's parseVerdict for exactly how it is
 * derived, including the generic fallback used when the judge's response
 * could not be parsed at all). */
export interface JudgeVerdict {
  verdict: 'done' | 'continue';
  reason: string;
}

/** The fallback reason used whenever the judge's final response cannot be
 * parsed into a verdict, or the mini-loop hits JUDGE_MAX_TURNS without ever
 * producing one. Fixed and exported-in-spirit only via this constant (not
 * itself part of the public API) so both failure paths in `runJudge` stay
 * byte-identical. */
const UNPARSEABLE_REASON = 'judge did not reach a parseable verdict';

/**
 * Run the judge to a verdict on one worker cycle's proposed completion.
 *
 * Reads `INTENT.md` and `CONTRACT.md` from the run-dir root (throwing if
 * either is missing — see below), assembles an opening user message from
 * the task text, both documents, the manifest, and a recursive artifacts/
 * listing, then runs a bounded mini-loop: call the model; if its response
 * contains tool_use blocks, execute each through the standard pipeline
 * (`executeToolCall`) against the judge's read-only registry (read_file and
 * grep only — a call naming any other tool gets the pipeline's structured
 * `unknown_tool` error, same as an unregistered tool anywhere else in this
 * codebase) and feed the results back as one tool_result message; otherwise
 * parse its text as the final verdict. At most JUDGE_MAX_TURNS model calls
 * are made.
 *
 * This function performs no run-directory writes of its own: it does not
 * append to transcript.jsonl and does not write metrics.json (those belong
 * to the worker's `runAgentLoop`) — it only reads, and returns its verdict
 * for the harness to record.
 *
 * @param args.taskText - the original task text, unmodified by any worker
 *   cycle's contract or feedback framing
 * @param args.runDir - absolute path to the run directory; must already
 *   contain `INTENT.md`, `CONTRACT.md`, and an initialized manifest (see
 *   run/artifacts.ts's initManifest)
 * @param args.callModel - the judge's bound model call (see
 *   makeJudgeCallModel for the production binding); a scripted fake drops
 *   in unchanged for tests, matching every other CallModel consumer in this
 *   codebase
 * @returns the parsed verdict (see JudgeVerdict) — `{verdict: 'done'}` only
 *   when the model's final response's first non-empty line is exactly
 *   "DONE" (case-insensitive); `{verdict: 'continue', reason}` for a
 *   parseable "CONTINUE: <reason>" response (the reason is the rest of that
 *   line plus any further lines, trimmed), and also — the fail-safe default
 *   — for any response that parses as neither, and for hitting
 *   JUDGE_MAX_TURNS while the model is still requesting tools. The judge
 *   never fails toward a false DONE.
 * @throws if `INTENT.md` or `CONTRACT.md` is missing from `runDir` — a run
 *   reaching the judge without both documents is a harness bug, not a
 *   worker-fixable condition, and must fail loudly rather than silently
 *   proceed judge-less or invent a verdict from nothing
 */
export async function runJudge(args: {
  taskText: string;
  runDir: string;
  callModel: CallModel;
}): Promise<JudgeVerdict> {
  const { taskText, runDir, callModel } = args;

  const intent = readRequiredRunDirFile(runDir, INTENT_FILENAME);
  const contract = readRequiredRunDirFile(runDir, CONTRACT_FILENAME);
  const manifestRaw = readFileSync(join(runDir, MANIFEST_FILENAME), 'utf8');
  const artifactListing = listArtifactFiles(runDir);

  const messages: Message[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: buildOpeningMessage({ taskText, intent, contract, manifestRaw, artifactListing }) },
      ],
    },
  ];
  const toolCtx: ToolCtx = { runDir };

  for (let turn = 1; turn <= JUDGE_MAX_TURNS; turn += 1) {
    const response = await callModel(messages);
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    );
    if (toolUses.length === 0) {
      return parseVerdict(extractText(response.content));
    }

    // The cap bounds model calls, not tool executions: on the last allowed
    // turn there is no further call to feed results into, so stop here
    // rather than executing tools whose results would never be seen.
    if (turn === JUDGE_MAX_TURNS) break;

    const resultBlocks = await executeJudgeToolUses(toolUses, toolCtx);
    messages.push({ role: 'user', content: resultBlocks });
  }

  return { verdict: 'continue', reason: UNPARSEABLE_REASON };
}

/** Config for the production judge CallModel: only what the caller may
 * reasonably want to override (see makeJudgeCallModel). */
export interface JudgeCallModelConfig {
  /** max_tokens for each judge response; defaults to 2048 — ample for a
   * handful of targeted tool calls plus a short final verdict. */
  maxOutputTokens?: number;
  /** Optional live-progress callback, forwarded to makeCallModel unchanged
   * (see ProgressEvent) — lets interactive surfaces show the judge's turns
   * the same way they show worker turns. */
  onProgress?: (event: ProgressEvent) => void;
}

/**
 * Build the production judge CallModel.
 *
 * @param config - see JudgeCallModelConfig
 * @returns a CallModel bound to JUDGE_MODEL and JUDGE_SYSTEM_PROMPT via
 *   makeCallModel, with apiToolDefs derived from the same JUDGE_TOOL_REGISTRY
 *   `runJudge` executes calls against (toApiToolDefs over read_file and grep
 *   only) — the model is never offered a tool `runJudge` would reject
 */
export function makeJudgeCallModel(config: JudgeCallModelConfig = {}): CallModel {
  return makeCallModel({
    model: JUDGE_MODEL,
    system: JUDGE_SYSTEM_PROMPT,
    apiToolDefs: toApiToolDefs(JUDGE_TOOL_REGISTRY),
    maxOutputTokens: config.maxOutputTokens ?? 2048,
    onProgress: config.onProgress,
  });
}

/**
 * Execute one turn's tool_use blocks through the standard pipeline and
 * convert the results to tool_result blocks, in request order. Every block
 * in `toolUses` is a request the model made this turn; both allowed tools
 * (read_file, grep) are read-only, and a call naming anything else is
 * rejected by `executeToolCall` itself (JUDGE_TOOL_REGISTRY's unknown_tool
 * error, listing the tools that do exist) — so running them concurrently
 * carries none of the ordering risk `scheduleToolCalls` guards against for
 * the worker's mixed read/write registry (see loop/scheduler.ts); `Promise.all`
 * already preserves result order by index, which is all that is needed here.
 */
async function executeJudgeToolUses(
  toolUses: readonly ToolUseBlock[],
  ctx: ToolCtx,
): Promise<ToolResultBlock[]> {
  const results = await Promise.all(
    toolUses.map((block) =>
      executeToolCall(JUDGE_TOOL_REGISTRY, { id: block.id, name: block.name, input: block.input }, ctx),
    ),
  );
  return results.map(toResultBlock);
}

/** Convert one pipeline result into the API-shaped tool_result block the
 * model reads next turn; is_error appears only on failures. Deliberately
 * duplicated from agentLoop.ts's private toResultBlock (not exported there,
 * and this module has no other reason to import from the loop) — same
 * one-line contract, kept in sync by inspection since neither side is
 * expected to change. */
function toResultBlock(result: ToolCallResult): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: result.toolCallId,
    content: result.content,
    ...(result.isError ? { is_error: true } : {}),
  };
}

/** A response's prose: its text blocks joined with newlines ("" if none).
 * Deliberately duplicated from agentLoop.ts's private extractText (not
 * exported there, and this module has no other reason to import from the
 * loop) — same one-line contract, kept in sync by inspection since neither
 * side is expected to change; initializer.ts carries the same duplicate for
 * the same reason. */
function extractText(content: readonly AssistantContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Read one required file from the run-dir root.
 *
 * @param runDir - absolute path to the run directory
 * @param filename - a fixed, harness-known filename at the run-dir root
 *   (never model- or worker-supplied, so no path-escape confinement is
 *   needed here — contrast resolveRunPath, which guards untrusted relative
 *   paths from tool calls)
 * @returns the file's UTF-8 content
 * @throws with a message naming the missing file and the run directory if
 *   it does not exist; rethrows any other read failure unchanged
 */
function readRequiredRunDirFile(runDir: string, filename: string): string {
  try {
    return readFileSync(join(runDir, filename), 'utf8');
  } catch (thrown) {
    if ((thrown as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${filename} is missing from the run directory (${runDir}) — the harness must write ` +
          'INTENT.md and CONTRACT.md before the judge runs.',
      );
    }
    throw thrown;
  }
}

/**
 * Recursively list every file under `<runDir>/artifacts/`, depth-first in
 * lexicographic order (matching grep.ts's collectFiles — deterministic
 * listings make judge behavior reproducible run to run).
 *
 * @returns one line per file, `"<runDir-relative path> (<N> bytes)"`; an
 *   empty array if artifacts/ does not exist or is empty
 */
function listArtifactFiles(runDir: string): string[] {
  const artifactsDir = join(runDir, ARTIFACTS_DIR);
  if (!existsSync(artifactsDir)) return [];
  return collectFilesRecursive(artifactsDir).map((absPath) => {
    const relPath = relative(runDir, absPath);
    const { size } = statSync(absPath);
    return `${relPath} (${size} bytes)`;
  });
}

/** Depth-first, lexicographically-sorted absolute file paths under `absDir`
 * (directories themselves are not included). */
function collectFilesRecursive(absDir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(absDir).sort()) {
    const absPath = join(absDir, name);
    if (statSync(absPath).isDirectory()) {
      files.push(...collectFilesRecursive(absPath));
    } else {
      files.push(absPath);
    }
  }
  return files;
}

/**
 * Assemble the judge's opening (and only harness-authored) user message:
 * the task text, both governing documents, the manifest's raw content, and
 * the artifacts/ listing — everything judge-design.md's "Evidence diet"
 * promises the judge up front, so its tool calls can go straight to the
 * specific files it needs instead of discovering what exists.
 */
function buildOpeningMessage(params: {
  taskText: string;
  intent: string;
  contract: string;
  manifestRaw: string;
  artifactListing: readonly string[];
}): string {
  const artifactsSection =
    params.artifactListing.length > 0 ? params.artifactListing.join('\n') : '(no files published)';
  return [
    '# Task',
    params.taskText,
    '',
    `# Intent (${INTENT_FILENAME})`,
    params.intent,
    '',
    `# Contract (${CONTRACT_FILENAME})`,
    params.contract,
    '',
    `# Manifest (${MANIFEST_FILENAME})`,
    params.manifestRaw,
    '',
    `# Artifacts (${ARTIFACTS_DIR}/)`,
    artifactsSection,
  ].join('\n');
}

/**
 * Parse a judge response's final text into a verdict.
 *
 * @param finalText - the joined text of a no-tool-call response (see
 *   extractText)
 * @returns `{verdict: 'done', reason: ''}` iff the first non-empty line,
 *   trimmed and compared case-insensitively, is exactly "DONE";
 *   `{verdict: 'continue', reason}` iff that line matches
 *   /^continue\s*:?\s*(.*)$/i, with `reason` the matched remainder of that
 *   line plus every following line, joined and trimmed (falling back to a
 *   fixed placeholder if that is itself empty — a bare "CONTINUE" with no
 *   explanation is still parseable as a verdict, just not an actionable
 *   one); otherwise `{verdict: 'continue', reason: UNPARSEABLE_REASON}` —
 *   the fail-safe default for anything that is not exactly one of the two
 *   sanctioned forms, so a malformed or off-protocol response can never be
 *   read as a false DONE
 */
function parseVerdict(finalText: string): JudgeVerdict {
  const lines = finalText.split('\n');
  const firstNonEmptyIndex = lines.findIndex((line) => line.trim() !== '');
  if (firstNonEmptyIndex === -1) {
    return { verdict: 'continue', reason: UNPARSEABLE_REASON };
  }
  const firstLine = lines[firstNonEmptyIndex]!.trim();

  if (/^done$/i.test(firstLine)) {
    return { verdict: 'done', reason: '' };
  }

  const continueMatch = /^continue\s*:?\s*(.*)$/i.exec(firstLine);
  if (continueMatch !== null) {
    const trailingLines = lines.slice(firstNonEmptyIndex + 1);
    const reason = [continueMatch[1] ?? '', ...trailingLines].join('\n').trim();
    return {
      verdict: 'continue',
      reason: reason.length > 0 ? reason : 'judge returned CONTINUE with no reason',
    };
  }

  return { verdict: 'continue', reason: UNPARSEABLE_REASON };
}
