# Scratch/Artifacts Split + Manifest Roles — Implementation Plan

**Date:** 2026-08-12
**Motivating failure:** `openclaw_contributors` trial 2 in the 2026-08-12 medium eval batch (`docs/reports/2026-08-12-medium-evals.md`): the agent's correct deliverable was shadowed in grading by an intermediate scrape CSV, because the grader's `findArtifactByExtension` tie-break (alphabetical-first over all manifest CSVs) had no way to know which file was the answer.
**Direction (user ruling):** do not punish intermediate scratch work — it is useful on long tasks. Instead make "which files are the answer" structural.

## The contract

Every run directory gains two agent-writable subdirectories:

```
run/
├── scratch/        # private agent working state; never graded or shown
├── artifacts/      # everything the agent publishes from the run
├── manifest.json
├── transcript.jsonl
└── metrics.json
```

The manifest is minimally extended: each entry for a file under `artifacts/` carries a `roles` field with one or both of:

- `requested_output` — the task explicitly asked for this file
- `evidence` — supporting/audit capture backing the outputs

An artifact may hold both roles (e.g. an explicitly requested screenshot that is also audit evidence) — no file duplication needed.

**Core invariant:** scratch is private, artifacts are published, `requested_output`/`evidence` are semantic roles, and an artifact may have both. External users of the agent need not know about the internal directories — the roles field is the product-facing model.

Unchanged invariants: every write (scratch included) still flows through `writeArtifact` and is hashed into the manifest — provenance stays total and tamper-evident; graders still read only the run directory; `sourceUrl` still originates only from the evidence tools (screenshot/download), so `write_file` cannot fabricate provenance-bearing evidence regardless of roles.

## Decisions (defaults confirmed by user 2026-08-12 — "let's go with defaults for now")

Q&A record: user confirmed screenshots/downloads default to `evidence` with the model free to add `requested_output` (typically both roles for explicitly requested captures); `write_file` defaults to `requested_output` under `artifacts/`. No-defaults (forced explicit roles) was considered and deferred.

| # | Decision | Default | Rationale |
|---|---|---|---|
| D1 | Where may each producer write? | `write_file` → `artifacts/` or `scratch/` only; `screenshot`/`download` → `artifacts/` only; pipeline offload (`capResult`) → `scratch/tool-output/` | Evidence tools always publish (their outputs exist to be shown); offloaded tool output is private working state |
| D2 | Paths outside the two roots | Structured steering error (pipeline's existing error-recovery pattern), write nothing | One wasted turn worst case; model reads the error and corrects, as with stale refs |
| D3 | `roles` on `write_file` | Optional `roles` input; default `["requested_output"]` for `artifacts/` writes; rejected on `scratch/` writes | Most `write_file` publishes ARE the requested outputs; explicit only when adding `evidence` |
| D4 | `roles` on `screenshot`/`download` | Optional `roles` input; default `["evidence"]`; agent passes `["requested_output","evidence"]` when the capture is explicitly requested | Matches the both-roles example driving the design |
| D5 | `roles` on `scratch/` entries | Field absent | Scratch has no semantic role; presence of `roles` ⇔ published |
| D6 | Grader selection among multiple `requested_output` matches | Keep deterministic alphabetical-first tie-break, unchanged | Two same-type files both marked `requested_output` is now a real agent error, not ambiguity; determinism preserved |
| D7 | Old run directories | Not regradable after this change (no `artifacts/` prefix, no roles); `regrade.ts` untouched | Regrade exists for same-era crash recovery; validation is a fresh run anyway |
| D8 | `initManifest` | Also creates `scratch/` and `artifacts/` eagerly | The directories exist before the loop starts, matching the manifest-before-loop ordering guarantee |

## Implementation steps (one commit each)

### Step 1 — Manifest schema + write-path validation (`src/run/artifacts.ts`)

- Add `export type ArtifactRole = 'requested_output' | 'evidence'` and `ManifestEntry.roles?: ArtifactRole[]`.
- Extend `ArtifactMeta` with `roles?: ArtifactRole[]`.
- `writeArtifact` enforces the partition: rel paths must start with `artifacts/` or `scratch/`; `artifacts/**` entries must carry non-empty `roles`; `scratch/**` entries must carry none. Throws (writing nothing) otherwise — same fail-fast posture as the existing escape guard.
- `initManifest` creates both subdirectories (D8).
- Tests: `src/cli/runTask.test.ts` fixtures and `artifacts` unit tests updated; new cases for role validation and path partition.

### Step 2 — Producers (`src/tools/`)

- `writeFile/writeFile.ts`: add optional `roles` input (zod enum array, described for the model); route defaults per D3; description rewritten to teach the publish contract ("publish final requested outputs into artifacts/, keep working data in scratch/").
- `screenshot/screenshot.ts`, `download/download.ts`: require the `artifacts/` prefix (extend `shared/evidence.ts`'s `assertEvidencePath` — it already guards reserved metadata names); add optional `roles` input defaulting to `["evidence"]` (D4).
- `capResult.ts`: offload target `tool-output/…` → `scratch/tool-output/…` (D1); no roles.
- Tests per tool: prefix rejection message content (steering quality), role defaults, offload location.

### Step 3 — System prompt (`src/cli/systemPrompt.ts`)

Rewrite the product-boundary paragraph and add the workspace contract, per the user's four teaching points: use `scratch/` for intermediate work; publish final requested outputs into `artifacts/`; preserve supporting audit evidence as published artifacts; assign the correct artifact roles (both roles when a capture is explicitly requested). Keep the prompt static — no per-run values — so the cached prefix changes once at deploy and is byte-stable thereafter. Update `systemPrompt.test.ts`.

### Step 4 — Grading layer (`evals/grading/` + all 12 dataset graders)

- `manifestVerification.ts`: add `requestedOutputs(manifest): ManifestEntry[]` (role filter). Rescope `findArtifactByExtension` / `findArtifactBySha256` over requested outputs, and add `findRequestedOutputByName(manifest, basename)` matching on basename so graders stop hardcoding paths. `verifyManifestHashes` stays whole-run (scratch included — tamper evidence is total).
- Update every grader's selection (three current styles):
  - `findArtifactByExtension` users: `hacker_news`, `elon_tweets`, `openclaw_contributors`, `openclaw_merged_prs`, `yc_w24_outreach`
  - `findArtifactBySha256` user: `edgar`
  - direct `manifest.artifacts.find/some/flatMap` by filename/extension: `airbnb_lake_tahoe`, `company_freshness`, `mit_sororities`, `wikipedia_reference`, `openclaw_pr`, `edgar` (screenshot), `openclaw_merged_prs` (screenshots), `stub`
  All selections filter on `requested_output` (user ruling). Screenshot assertions keep their `sourceUrl` checks unchanged.
- **Regression test** (`openclaw_contributors/grader/grader.test.ts`): reproduce trial 2's exact layout — `scratch/contributors_raw.csv` (header `rank,github_handle,commits`, 32 rows, no roles) alongside `artifacts/top_30_contributors.csv` (exact schema, 30 rows, `requested_output`) — assert all content assertions pass, i.e. the scratch file is invisible to grading. Companion case: the raw CSV alone (as `requested_output`) still fails the schema assertion.
- Update each grader's existing tests for the `artifacts/` prefix and roles in fixtures (the stub task is the TUI harness seam — keep its fake-agent writes consistent).

### Step 5 — Documentation

- `AGENTS.md` + `.agents/summary/data_models.md` (run-directory contract), `architecture.md` (invariants list), `workflows.md` §5 if the persistence description shifts. `README.md` only if it shows a run layout.
- Do NOT touch `.agents/planning/evidence-collection-agent-checkpoint-1/design/detailed-design.md` — it has uncommitted modifications from a concurrent session.

### Step 6 — Validation + report

1. `npm run typecheck` && `npm test`.
2. Smoke: `hacker_news` k=1 (fastest full path: prompt → tools → grader).
3. The bug's context: `openclaw_contributors,openclaw_merged_prs` k=3.
4. Watch specifically for the new miss mode: a deliverable written into `scratch/` or an unprefixed path (count steering-error occurrences in transcripts; expect ≤1 per run early in the run).
5. Report as `docs/reports/2026-08-12-scratch-artifacts-rerun.md` comparing against `2026-08-12-medium-evals.md`.

## Risks / watch-fors

- **Concurrent main movement:** five commits landed on main during the planning session (new eval datasets covering all CSV rows — now 12 graders, not 6). Sync/rebase immediately before starting; re-inventory graders at that point.
- **New failure mode traded for the old one:** the agent can now publish to the wrong place. Mitigations: D2 steering errors + prompt teaching; measured explicitly in Step 6.4.
- **Prompt-prefix change:** system prompt + tool descriptions change the cached prefix once; within-run byte-stability (the actual invariant) is unaffected.
- **Historical comparability:** pre-change runs can't be regraded by post-change graders (D7); reports must compare at the task-outcome level, not by re-running old dirs.

## Out of scope (noted for later)

- Surfacing roles in the REPL/TUI product surface (e.g. run summary showing published artifacts grouped by role, hiding scratch) — the roles field enables this; nothing here blocks it.
- A `delete`/retract tool for published artifacts.
- Browser-batch worktree (`codex/browser-batch-design`) alignment — it has its own tool surface; reconcile at merge time.
