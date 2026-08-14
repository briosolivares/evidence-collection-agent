# Follow-ups from the 2026-08-14 code-review pass on `feat/judge-harness`

A code-review pass over this branch's uncommitted diff fixed a batch of bugs
and flagged two findings as architecture-level rather than safe surgical
patches. Both were investigated properly rather than taken on faith. One
turned out to have a real, scoped, safe fix and is now fixed (with tests).
The other was confirmed to genuinely need an architecture decision this pass
should not make unilaterally, and is recorded here instead of attempted as a
half-measure.

This file is separate from `docs/open-followups-2026-08-14.md` (a different,
already-fully-resolved batch found while validating `3091a81` earlier the
same day) so that file's "all three resolved" title stays accurate.

---

## 1. `accessesConflict` used exact-string key matching against `file:` keys that are sometimes directories — FIXED

**Severity: real correctness bug (unsafe parallelism), not the efficiency
concern it was first framed as.** The framing to check was: does directory-
scoped-vs-exact-key mismatch cause unnecessary serialization, or unsafe
concurrency? It is the latter.

`grep`'s `getAccess` (`src/tools/grep/grep.ts:49-52`) declares:

```ts
getAccess: (input) => ({
  reads: [accessKey.file(input.path ?? '.')],
  writes: [],
}),
```

`input.path` is frequently a **directory** — it defaults to `.`, the whole
run directory, and grep's own doc comment says it searches "every file under
`path`". Every other file-touching tool (`write_file`, `edit_file`,
`download`, `read_file`, `screenshot`, `inspect_document`) declares
`accessKey.file(...)` for a single concrete file path.

The scheduler's `accessesConflict` (`src/tools/registry.ts`, previously)
compared these keys with plain `Set`-based exact-string equality. A grep of
`.` (key `file:.`) and a concurrent `write_file` to `artifacts/report.csv`
(keys `file:artifacts/report.csv`, `manifest`) share no exact string, so
`accessesConflict` reported **no conflict**, and `groupConcurrentCalls`
(`src/loop/scheduler.ts`) let them run in the same concurrent group. That is
an actual race: a `grep` enumerating and reading files under the run
directory while a concurrent write is landing a new or modified file inside
that same tree, with no ordering guarantee between them — exactly the
"a read hoisted ahead of the write it was meant to observe" hazard
`groupConcurrentCalls`'s own doc comment says must never happen.

This was not a theoretical gap the author of the write tools missed —
`download.ts`'s `getAccess` comment (`src/tools/download/download.ts:77-83`)
explicitly reasons about it: *"a concurrent read_file/grep/inspect_document
on that exact path is serialized behind this call."* That reasoning is
correct for a `grep` scoped to the exact same file, and silently wrong for a
`grep` scoped to a directory containing that file — the case the comment
doesn't consider, and the exact-match check couldn't have caught either way.

### What was done

`src/tools/registry.ts`: `accessesConflict` is now path-containment-aware for
`file:` keys specifically. Added:

- `normalizeFileKeyPath` — normalizes a `file:` key's path portion
  (`path.normalize`), collapsing the whole-run-dir sentinel (`.`) to `''`.
- `filePathsOverlap` — two file paths overlap iff they're equal, or one is a
  path-segment-bounded ancestor of the other (or one is `''`, the run-dir
  root, which contains everything). Segment-bounded so `file:artifacts` does
  not wrongly overlap `file:artifacts-old/x.csv` — a shared string prefix
  that is not a path-containment relationship.
- `keysOverlap` — dispatches to `filePathsOverlap` when both keys start with
  `file:`; every other key namespace (`page:`, `origin:`, `table:`, …) keeps
  exact-match semantics, since those are opaque atoms with no hierarchy.
- `accessesConflict` itself is now pairwise over each side's `reads`/`writes`
  (was `Set`-based) since containment can't be expressed as a hash lookup.
  Each side carries only a handful of concrete keys per call, so this stays
  cheap.

This tightens safety without over-serializing: two `grep`s of different,
non-overlapping directories still don't conflict (covered by a new test),
and two reads of the same or overlapping directories still never conflict
with each other (read/read is unconditionally safe) — only a *write* nested
inside (or containing) a directory-scoped read/write now correctly
conflicts.

**Tests added:**
- `src/tools/registry.test.ts` — a new `describe('accessesConflict', …)`
  block: non-file keys stay exact-match; a directory read key conflicts with
  a nested write key (both key orderings); a directory key that only shares
  a string prefix (not a path segment) does not falsely conflict; sibling
  directories/files don't conflict; `./foo` and `foo/` normalize to the same
  key as `foo`; read/read never conflicts even for overlapping directory
  keys.
- `src/loop/scheduler.test.ts` — two integration-level regression tests under
  `describe('access-aware scheduling', …)`: a directory-scoped read
  concurrent with a write nested inside it now serializes (peak concurrency
  1); a directory-scoped read concurrent with a write *outside* that
  directory still overlaps in time (peak concurrency 2), proving the fix
  doesn't over-serialize unrelated work.

Verified: `npx tsc --noEmit` clean; `npx vitest run src/tools/registry.test.ts
src/loop/scheduler.test.ts src/tools/grep/grep.test.ts` — 40/40 passing.
Changes are uncommitted on `feat/judge-harness`, confined to
`src/tools/registry.ts` (fix) and the two `*.test.ts` files (tests) — no
tool's declared `getAccess` needed to change.

---

## 2. "Abandon, don't cancel" timeouts let the scheduler treat a still-running call as settled — investigated, NOT fixed; real architecture gap

**Conclusion: the original code-review's judgment was right.** This needs a
cross-cutting design decision this pass should not make unilaterally.
Documented here in full rather than attempted as a partial patch, per the
explicit instruction to avoid a half-measure.

### The mechanism, confirmed

`withToolDeadline` (`src/tools/pipeline.ts:223-242`) and `withRendererDeadline`
(`src/browser/playwrightBrowserController.ts:2152-2184`) both race the real
work against a timer and, on timeout, stop waiting — the real work (`started`)
is never cancelled; its eventual rejection is swallowed
(`void started.catch(() => undefined)`), and both functions' own doc comments
say this explicitly ("there is no way to reach in and stop it").

The scheduler's mutual-exclusion guarantee
(`src/loop/scheduler.ts`'s `groupConcurrentCalls`/`accessesConflict`) is built
on the assumption that once a call's promise settles, its effects are
complete — that's what makes it safe to start the next conflicting group. A
timed-out call breaks that assumption silently: `executeToolCall`
(`src/tools/pipeline.ts:148-185`) catches `ToolTimeoutError` and returns a
normal `ToolCallResult` (`errorKind: 'timeout'`); from the scheduler's
perspective this is an ordinary settled call like any other, its semaphore
slot is released (`scheduler.ts`'s `finally { slots.release(); }`), and the
next group — or an entirely new `scheduleToolCalls` call from a later model
turn — proceeds as if the resource were free. The real work can still be
running.

### Why this can't be closed with a narrow patch

1. **The abandoned promise's handle doesn't escape where it would need to.**
   `started` in `withToolDeadline` is a local variable inside that function's
   closure; nothing outside it can observe when the abandoned work eventually
   really finishes. Making the scheduler "keep a resource locked" requires a
   registry that can be told about `started` at the moment of abandonment —
   which means `withToolDeadline` needs to know the call's `ToolAccess` keys,
   which today only the scheduler computes (`validateToolCallsForScheduling`
   in `src/loop/scheduler.ts`), not `pipeline.ts`.

2. **That registry must survive past one `scheduleToolCalls` call.** The
   ctx handed to tools (`toolCtx` in `src/loop/workerSession.ts:669-676`) is
   rebuilt fresh on every turn from `deps`. For a "still busy" marker to
   protect a call in a *later* model turn (the realistic case — the model
   sees the timeout error and tries again, or tries something else touching
   the same page, one or more turns later), the registry has to be owned by
   something that outlives a single turn (`WorkerSession`, threaded through
   `WorkerSessionDeps`/`ToolCtx` as a new optional field) — a real, if small,
   change to a currently-persistent-per-run object's shape.

3. **A "locked/excluded" gate needs its own bound, and there's no obviously
   correct value.** Waiting unboundedly for the real (abandoned, uncancelled)
   promise to settle before allowing the *next* conflicting call to even
   start would silently reintroduce the exact failure `withToolDeadline` was
   built to prevent — `pipeline.ts`'s own comment describes a real incident
   ("a `browser_action` fill... stopped returning and the run sat dead for
   ten minutes") — just moved one call later and now hidden behind a "waiting
   to acquire the resource" state with no guard able to fire. So the gate
   itself needs a timeout, and if it elapses with the resource still marked
   busy, the new call must fail closed with a distinct, new error rather than
   (a) proceeding as if the resource were free (today's bug) or (b) hanging
   silently (a regression). That's a new `ToolErrorKind`, a bound value with
   no principled default, and a policy question with real trade-offs: does
   a second abandonment on the same key extend the busy window again (a
   pathological page could then lock a resource out indefinitely), and does
   this defeat the recovery path the timeout message itself already tells
   the model to take — *"observe the current state before acting again"*
   (`pipeline.ts:172-175`) — if the next `observe` on that same page is the
   very call now blocked by the gate?

4. **`withRendererDeadline` is invisible to whatever `pipeline.ts` learns.**
   It's used inside a tool's own `execute()` — `observe.ts`, `inspectPage.ts`,
   `scroll.ts`, and others call into `PlaywrightBrowserController` methods
   that use it internally (`ariaSnapshot`, `page.title()`,
   `page.evaluate(...)`, at minimum the ~10 call sites in
   `playwrightBrowserController.ts` at lines 440, 466, 545, 581, 595, 632,
   642, 839, 1279, 1793, 1846, 1865). Its 5s ceiling
   (`RENDERER_READ_TIMEOUT_MS`) is well under the outer 120s
   `DEFAULT_TOOL_TIMEOUT_MS`, so a stuck `ariaSnapshot()` typically resolves
   (via a fallback value or a plain rejection converted to `execution_error`)
   *inside* the tool's own `execute()`, and the whole tool call returns to
   `pipeline.ts` well within its own deadline. `withToolDeadline` never even
   sees a timeout in this — the abandonment already happened one layer down,
   invisible to any registry `pipeline.ts` alone could populate. Closing this
   half requires `PlaywrightBrowserController` to participate in the same
   registry directly, which means it needs to know the relevant access key
   (`accessKey.page(pageId)` / `accessKey.selectedPage()`) at each of those
   ~10 call sites — information the controller does not have today; its
   methods operate on `this.page`/`this.requirePage()` with no `accessKey`-
   shaped concept, and no reference to `ToolCtx` or the registry module at
   all.

5. **`click()`/`type()` have no deadline wrapper of their own at all**
   (`playwrightBrowserController.ts:446-462`) — their only exposure to this
   problem already runs through the outer 120s `withToolDeadline`. A fix
   confined to `withRendererDeadline` would leave them exactly as exposed as
   today; a fix confined to `withToolDeadline` would cover them but still
   leave the `observe`/`inspect_page`/`scroll` paths above uncovered. A
   correct fix has to span both layers to be honestly complete — fixing only
   one and calling the finding closed would be worse than leaving it
   documented, since it would look resolved without being resolved.

6. **`bash.ts`'s mitigation doesn't transfer.** `BASH_TOOL_TIMEOUT_MS`
   (`src/tools/bash/bash.ts:30-49`) works because bash has a *real*
   cancellation hook: its own inner timeout (inside `runForegroundCommand`)
   sends SIGTERM then SIGKILL to the actual child process group, and the
   tool declares a `timeoutMs` large enough that this always fires before
   the pipeline's outer, non-cancelling deadline could ever matter — the
   outer deadline becomes a dead-man's switch that (by the comment's own
   worst-case arithmetic) should never be the one to actually intervene.
   Playwright gives no equivalent hook — there is no way to forcibly stop an
   in-flight `page.evaluate()`, `ariaSnapshot()`, or `locator.click()` from
   outside Playwright's own process — so "just set a bigger `timeoutMs`"
   would not fix anything here: it would only delay when the model learns
   the call is stuck, while the real operation goes on running for exactly
   as long regardless. This asymmetry (bash can truly cancel; browser tools
   cannot) is the crux of why bash needed no equivalent of this fix and
   browser tools do.

### What a correct fix would require (for whoever picks this up)

At minimum, coordinated changes across:
- `src/tools/registry.ts` — a new busy-resource registry type keyed by
  `ToolAccess`-style keys, with a bounded `waitUntilFree`.
- `src/tools/pipeline.ts` — `withToolDeadline` (or `executeToolCall` around
  it) needs the call's derived `ToolAccess` to register abandonment, and
  must keep a handle on `started` so the registry can clear the key on real
  settlement.
- `src/loop/scheduler.ts` — every call start (not just intra-batch grouping)
  needs to consult the registry before proceeding, bounded, with a new
  fail-closed error kind when the bound elapses.
- `src/loop/workerSession.ts` — the registry needs to be owned by
  `WorkerSession`/threaded through `WorkerSessionDeps`, not rebuilt per-turn
  like `toolCtx` is today.
- `src/browser/playwrightBrowserController.ts` — its ~10
  `withRendererDeadline` call sites need to thread through and register
  against the relevant page's access key, which requires giving the
  controller a concept it doesn't have today.

Each of those needs a policy answer this pass has no authority to pick
unilaterally (the gate's bound; whether repeated abandonment compounds the
busy window; whether/how this interacts with resume, since the registry
would be in-memory and would not survive a crash — though the browser session
itself is also not expected to survive one). That combination — new
cross-cutting state, several non-obvious policy decisions, and changes
spanning two abstraction layers — is what makes this architecture-level. Left
open; not attempted as a partial patch.
