# Demos

Fourteen numbered scripts that walk each subsystem **in build order** — run one to watch that layer work in isolation and read its output. They are manual demonstration scripts, **not tests**: nothing asserts, several hit live websites or spend real API tokens, and the automated suite never invokes them.

The automated end-to-end coverage lives elsewhere: `npm test` runs the hermetic vitest suites (per-tool suites in `src/tools/*/`, plus `src/cli/runTask.test.ts` for the full stack) against local Chrome and the loopback fixture server in `tests/fixtures/` — no network, no tokens.

```bash
npx tsx demos/07-loop-fake-model.ts        # full agent loop, scripted model, zero tokens
npx tsx --env-file=.env demos/14-run-task.ts "your task here"   # the real thing
```

| Demo | Shows | Needs |
| --- | --- | --- |
| `01-run-id` | Run-id generation | — |
| `02-run-dir` | Run directory + transcript | — |
| `03-manifest` | Artifact manifest + hashing | — |
| `04-registry` | Tool registry + validation pipeline | — |
| `05-offload` | Oversize tool-result offloading | — |
| `06-file-tools` | read_file / write_file / grep | — |
| `07-loop-fake-model` | Full agent loop with a scripted model | — |
| `08-scheduling` | Parallel-read tool scheduling | — |
| `09-real-agent` | Loop against the live model (file tools only) | API key, **spends tokens** |
| `10-controller` | Browser controller over local Chrome | Chrome |
| `11-observe` | navigate + inspect_page | Chrome |
| `12-act` | click / type / scroll | Chrome |
| `13-evidence` | screenshot + download | Chrome |
| `14-run-task` | The complete production stack on a live site | Chrome, API key, **spends tokens** |
