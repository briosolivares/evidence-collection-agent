# Sherlock

Sherlock is a browser agent for collecting audit evidence. Give it a task in
plain English and it uses Chrome to research, capture evidence, and publish
requested outputs with provenance.

## Install and run

You need:

- Node.js 22 or newer
- an Anthropic API key or auth token
- Google Chrome for the default local provider, or a Browserbase account and
  API key for the remote provider

```bash
npm install -g github:briosolivares/evidence-collection-agent
sherlock
```

On first launch, Sherlock asks for an Anthropic API key when no supported
credential is already configured and can save it to `~/.sherlock/.env` for
future sessions.

## Configuration

For an installed copy, put Sherlock's configuration in
`~/.sherlock/.env`, one `KEY=value` entry per line. The first-launch prompt
creates this file when you choose to save the Anthropic key. To create or edit
it yourself:

```bash
mkdir -p ~/.sherlock
touch ~/.sherlock/.env
chmod 600 ~/.sherlock/.env
```

At minimum, add one supported Anthropic credential:

```dotenv
# ~/.sherlock/.env
ANTHROPIC_API_KEY=...
# or ANTHROPIC_AUTH_TOKEN=...
```

Runtime credentials and browser-provider variables documented below can go in
this same file. Sherlock also accepts variables exported by the shell. To use a
different file for one launch, pass
`sherlock --env-file /path/to/sherlock.env`.

Installed Sherlock checks `./.env` before `~/.sherlock/.env` when no explicit
file is given. A development checkout uses the repository-root `.env`.

`SHERLOCK_HOME` and `SHERLOCK_RUNS_DIR` are the exceptions: export them in the
shell before launching Sherlock because they determine where Sherlock looks
before it loads an environment file. Setting `SHERLOCK_HOME` this way moves the
installed config file to `$SHERLOCK_HOME/.env`.

By default, the interactive TUI attaches to your current local Chrome session
so existing logins are available. If Chrome remote debugging is not enabled,
Sherlock opens `chrome://inspect/#remote-debugging` and waits for you to enable
“Allow remote debugging for this browser instance” and approve the connection.
Sherlock preserves tabs that existed before the run and closes only task-owned
pages when the run ends.

To see the interface without starting a browser or using model tokens:

```bash
sherlock --demo
```

## Browser providers

Local Chrome is the default. Browserbase is available only when selected
explicitly; merely setting a Browserbase API key never starts a billable remote
session. To use it, add these entries to `~/.sherlock/.env` (or the explicit
environment file you selected):

```dotenv
SHERLOCK_BROWSER_PROVIDER=browserbase
BROWSERBASE_API_KEY=...
BROWSERBASE_CONTEXT_ID=... # optional persistent authenticated context
```

Without `BROWSERBASE_CONTEXT_ID`, interactive Browserbase sessions can still
browse public pages but start signed out. From a development checkout,
`npm run login` creates and saves a Context when necessary and opens Live View
for manual sign-in.

Set `SHERLOCK_BROWSER_PROVIDER=local` or leave it unset to use local Chrome.

## Try a task

Type a request at the prompt, for example:

```text
Create a CSV of the top 5 Hacker News stories with exactly these columns: title, URL, points.
```

Useful commands inside Sherlock:

- `/help` — show available commands
- `/runs` — browse previous runs
- `/artifacts` — browse the latest outputs and evidence
- `/evals` — run development eval tasks (checkout only)
- `/exit` — quit

Press Esc to cancel the current task and Ctrl+C to quit.

## Where results go

Installed Sherlock stores its state under `~/.sherlock/`:

```text
~/.sherlock/
  chrome-profile/   managed login/eval profile
  runs/             task outputs, evidence, and provenance
  .env              saved credentials and provider configuration
```

Development checkouts instead keep `.env`, `chrome-profile/`, and `runs/` at
the repository root. Each run is self-contained:

```text
runs/<run-id>/
  artifacts/        published requested outputs and evidence
  scratch/          private intermediate work
  harness/          private contract, checkpoint, and recovery state
  manifest.json     artifact roles, hashes, provenance, and lifecycle times
  transcript.jsonl  durable execution events
  metrics.json      run status, usage, and timing
```

Only files published under `artifacts/` are deliverables. Scratch files remain
private run state.

This repository includes a shared historical snapshot under `runs/` and
`evals/experiments/` for reviewing prior outputs and eval results. New local
records remain ignored unless they are explicitly staged for another snapshot.

Common overrides:

- `sherlock --runs-dir <path>` — use another results directory
- `sherlock --env-file <path>` — load a specific environment file
- `sherlock --verbose` — print environment and browser-provider diagnostics
- `SHERLOCK_HOME=<path>` — move Sherlock's data home (shell environment)
- `SHERLOCK_RUNS_DIR=<path>` — move only the runs directory (shell environment)
- `SHERLOCK_CHROME_PATH=<path>` — use a specific Chrome/Chromium binary
- `SHERLOCK_CHROME_CDP_ENDPOINT=<loopback-url>` — attach through an explicit
  loopback Chrome debugging endpoint

## Development

From a git checkout:

```bash
npm install
npm run sherlock
```

Sherlock reads `.env` from the repository root. For the default local provider,
configure either:

```dotenv
ANTHROPIC_API_KEY=...
# or ANTHROPIC_AUTH_TOKEN=...
```

Run the hermetic checks with:

```bash
npm test
npm run typecheck
```

There is no build step; TypeScript runs through `tsx`. The test suite is
network-free but requires local Chrome.

Evals are development-only and are not included in the installed package. In a
checkout, use `/evals` in the TUI or run:

```bash
npm run evals -- --tasks hacker_news --k 1
```

Authenticated eval setup and verification are provider-aware:

```bash
npm run login
npm run login -- --check
npm run login -- --manual # local Chrome only
```

For contributor navigation and binding repository rules, read
[`AGENTS.md`](AGENTS.md) and [`.agents/summary/index.md`](.agents/summary/index.md).
Current rationale and progress live in the
[Sherlock v3 design](docs/browser-agent-v3/sherlock-v3-design-doc.md) and
[implementation plan](docs/browser-agent-v3/implementation-plan.md). The
checkpoint-1 planning tree is historical context only.
