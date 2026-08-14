# Sherlock

Sherlock is a browser agent for collecting audit evidence. Give it a task in
plain English and it uses Chrome to research, capture evidence, and save the
results with provenance.

## Install and run

You need:

- Node.js 22 or newer
- Google Chrome
- An Anthropic API key

```bash
npm install -g github:briosolivares/evidence-collection-agent
sherlock
```

On first launch, Sherlock asks for your API key and can save it for future
sessions. It opens a visible Chrome window, so you can watch it work and sign in
to sites when needed.

To see the interface without using an API key or model tokens:

```bash
sherlock --demo
```

## Try a task

Type a request at the prompt, for example:

```text
Create a CSV of the top 5 Hacker News stories with title, URL, and points.
```

Useful commands inside Sherlock:

- `/help` — show commands
- `/runs` — browse previous runs
- `/artifacts` — browse the latest outputs and evidence
- `/exit` — quit

Press Esc to cancel the current task and Ctrl+C to quit.

## Where results go

Installed Sherlock stores its state under `~/.sherlock/`:

```text
~/.sherlock/
  chrome-profile/   saved browser sessions and logins
  runs/             task outputs, evidence, and provenance
  .env              saved API key
```

Each run contains published artifacts, a SHA-256 manifest, a transcript, and
run metrics.

Common overrides:

- `sherlock --runs-dir <path>` — use another results directory
- `sherlock --env-file <path>` — load a specific environment file
- `SHERLOCK_HOME=<path>` — move all Sherlock state
- `SHERLOCK_CHROME_PATH=<path>` — use a specific Chrome/Chromium binary

## Development

From a git checkout:

```bash
npm install
npm run sherlock
```

Sherlock reads `.env` from the repository root. The only required value is:

```text
ANTHROPIC_API_KEY=...
```

Run the checks with:

```bash
npm test
npm run typecheck
```

Evals are development-only and are not included in the installed package. In a
checkout, use `/evals` in the TUI or run:

```bash
npm run evals -- --tasks hacker_news --k 1
```

For architecture and contributor details, start with
[`.agents/summary/index.md`](.agents/summary/index.md). Design rationale lives in
[the detailed design](.agents/planning/evidence-collection-agent-checkpoint-1/design/detailed-design.md).
