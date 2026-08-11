# Evidence Collection Agent — Checkpoint 1

## Problem Definition

### Problem

In audit and compliance engagements, auditors often must collect their own evidence directly from a client’s systems. They may receive read-only access to tools such as Workday, GitHub, NetSuite, Jira/Linear, etc. Evidence collection is frequently manual: auditors open links, take screenshots, record fields into spreadsheets, and download supporting artifacts.

### Need

A way to automate the evidence collection process.

---

## Solution

A general browser agent that can perform these evidence collection workflows reliably. This agent needs to work across many systems with consistent outputs suitable for audit documentation. It should take in a user message stating the task and output anything from screenshots, CSVs, natural language, or a mix of the above.

### Functional Requirements

What the system must do:

- Take in a user message stating the task
- Collect evidence from many systems
- Output a CSV, screenshot, and/or natural language

### Constraints

What the system must be:

- **Accurate** — quantify this somehow
- **Generalizable** — can do a wide variety of tasks that involve using the browser, reading context/source, and creating artifacts
- **Scalable** — can process thousands of samples / a large number of tasks at once
- **Consistent** — consistency between samples
- **Fast** — acceptable speed

---

## Initial Design

Starting with a minimal Claude Code–style agent loop.

### Core Product Loop

```
task →
  1. Assemble context needed for this turn
  2. Ask model and stream output
  3. Tool calls?
       yes → execute tools → append results → loop
       no  → return final result
```

### Components

#### Context

Assembled each turn from:

- System prompt
- Task / conversation messages
- Available tool definitions

#### Main Loop

1. When the user inputs a message, enter the loop.
2. Maintain a mutable `State` object as the loop’s memory. Each pass destructures `State`; parts of the loop that decide to repeat write back to `State`:

   ```
   State {
     messages: Message[],
     turnCount: number,
   }
   ```

3. Send the assembled conversation to the model (messages, system prompt, tools, etc.).
   - The agent loop does not call the model directly. Wrap I/O dependencies in a small `deps` bundle; the loop uses `deps.callModel` whenever it needs the client. `deps` can be replaced with dummies for testing.
   - Include a function to query the model with streaming.
4. As the model response streams in, watch for tool requests (`tool_use` blocks).
   - If the model asks to run a tool, the turn isn’t over.
   - If it asked for none, the turn is finished.
5. No tools requested means the model is done. The loop returns completed and the turn ends.
   - If `!needsFollowUp` → run token budget check and return completed.
6. If tools are requested, the loop runs them and collects each result as a new message to feed to the model.
   - Each result is converted into a `tool_result` user message and pushed onto the tool-results list.
7. Tool results are added, the turn counter is incremented, and the loop starts over.

#### Initial Guardrails

- Tool-result size cap
- Max iterations
- Tool input validation

#### Tool Registry

**Tool interface**

- Input schema (machine-readable description of expected arguments)
- Function that does the work
- `maxResultSizeChars`
- A way to convert tool output into a standard format the model can read

If a tool result exceeds its size limit, save the full output on disk and hand the model a short preview plus a path to the full result.

**Tool access**

1. Have a function that returns all the tools the model should have access to.
2. Run tools.

**Per-tool checklist**

1. Confirm the tool exists
2. Validate the input
3. Do the work
4. Normalize the output
5. Enforce the result size limit
6. Return the tool result

**Initial list of tools**

Borrow Claude Code tools when possible:

- `read_file`
- `write_file`
- `grep`
- `bash`

Browser tools:

- `navigate`
- `inspect page`
- `click`
- `type`
- `screenshot`
- `download`

#### Tracing

Use Braintrust.

Track:

- Input tokens
- Output tokens
- Tool result size
- Turn count
- Tools used and model output
- Latency

#### Evaluation Harness

**Experiment unit**

Each experiment records:

- Task
- Trial
- Output + trace + score

**Assertions**

Decompose each task into a set of assertions:

- Some assertions (file exists, number of rows, exact values) can be checked automatically
- Others (whether a screenshot shows the right thing) are harder and can be verified manually

**Metrics**

| Metric | Definition |
|--------|------------|
| Task completion | `0` or `1` |
| Accuracy | How many assertions are correct |
| Latency | Time to complete |

**Layout**

```
evals/
  hacker_news/
    task.json          # { task description/query, starting url }
    oracle/            # Independent way of determining the correct result
    grader/            # Assertions comparing agent output to oracle
```

---

## Ideas for Later

> Ignore for now — deferred design directions.

- Durable external state
- Fresh contexts
- intializer / worker / judge pattern
- Subagents
- Parallel workers
- Sandboxing & rehydration
- Horizontal workers to process many tasks at once
- Strong oracle if accuracy is a top priority, objectively verifiable signal to hill-climb against
- Agents probably shouldn’t share the same tools, code access, and filesystem access
- Planner agent owns task assignment
- Disjoint write scopes
- Evaluator/judge agent should not run commands or explore the filesystem; it should check completion against surfaced evidence
- Multi-agent coordination?

### Tech Candidates

| Area | Candidate | Role |
|------|-----------|------|
| Browser | Browserbase, Browser Use? | Interacting with the browser |
| Orchestration | Temporal? | Durable orchestration / parallel work |

### Evals

See `@evidence-collection-project-evals.csv`.
