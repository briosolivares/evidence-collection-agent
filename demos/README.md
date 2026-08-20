# Demos

Seven retained scripts show stable public or reusable layers. They are manual
walkthroughs, not tests; the automated suite never invokes them.

```bash
npx tsx demos/03-manifest.ts
npx tsx --env-file=.env demos/12-run-task.ts "your task here"
```

| Demo | Shows | Needs |
| --- | --- | --- |
| `01-run-id` | Run-id generation | — |
| `02-run-dir` | Run directory, confined paths, transcript | — |
| `03-manifest` | Atomic artifact manifest and hashing | — |
| `04-registry` | Generic tool validation/execution pipeline | — |
| `05-offload` | Bounded model-visible tool results | — |
| `10-controller` | Browser controller over explicit managed local Chrome or Browserbase | Chrome/provider config |
| `12-run-task` | Complete initializer → worker → checks → verifier stack | Chrome/provider config, API key, **spends tokens** |

Use `npm test` for hermetic behavior coverage. It exercises the tools,
coordinator, crash/resume boundaries, public composition, TUI bridge, and local
Chrome against the loopback fixture server without model tokens or oracle
network calls.
