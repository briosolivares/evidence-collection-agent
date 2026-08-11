# User Vision Statement (verbatim, 2026-08-11)

I want this to be similar to the Claude Code TUI. The experience should feel like watching a capable agent actively investigate something in real time, not like looking at a conventional dashboard or a full-screen pane-based TUI.

## Core interaction model

Use a single vertically growing transcript.

The transcript should contain, in chronological order:

- the user's request
- agent status/activity
- browser actions
- searches
- pages visited
- evidence discovered
- extracted facts/quotes
- intermediate reasoning summaries where appropriate
- errors/retries
- the final synthesized result

Do not make every action a permanent panel. Actions should appear inline as compact blocks in the transcript and naturally scroll upward as the investigation continues.

The bottom of the interface should contain the persistent user input/composer.

The overall feeling should be:

user asks a question → agent begins investigating → activity streams into the terminal → evidence accumulates → agent finishes and leaves behind a readable investigation transcript.

## Active-agent status line

While the agent is working, show a compact animated status line inspired by Claude Code.

For example:

```
✻ Foraging…
```

Under or alongside it, show live operational metadata:

```
↳ 12.4k tokens · 18s
```

The elapsed time should update continuously while the agent is running.

The token count should increase as the investigation progresses. Prefer a compact representation such as:

```
847 tokens
3.2k tokens
18.7k tokens
```

Do not make these metrics visually dominant. They should feel like subtle instrumentation attached to the current agent status.

## Whimsical working words

Instead of always displaying generic text such as Thinking… or Loading…, cycle through playful verbs while the agent works.

These words are ambient personality, not precise state descriptions. They do not need to correspond exactly to what the agent is doing at that instant.

Use words that fit an investigator / researcher / evidence-gathering agent while retaining the playful Claude Code feel.

Examples:

- Foraging…
- Brewing…
- Sifting…
- Rummaging…
- Ferreting…
- Digging…
- Scouring…
- Tracing…
- Poking around…
- Connecting dots…
- Following leads…
- Chasing citations…
- Dusting for clues…
- Reading the fine print…
- Peeking under rocks…
- Untangling threads…
- Consulting the archives…
- Cross-examining the web…
- Separating signal from noise…

Cycle the phrase periodically during longer operations so that a 30-second investigation might naturally show several different phrases.

Avoid changing it so rapidly that it becomes distracting. The effect should feel subtle and charming.

The status phrase should be visually ephemeral: when the agent moves on, the transcript should primarily preserve the meaningful actions and evidence, not dozens of old loading phrases.

## Browser/tool activity

Render browser actions inline in a compact, readable way.

For example:

```
● Searching "Acme Corp Series B investors"
● Opening techcrunch.com/...
● Reading SEC filing
● Following source → acme.com/about
● Found 3 relevant passages
```

Avoid dumping raw browser/tool JSON into the normal UI.

Tool activity should communicate what the agent is doing at the semantic level, while detailed debugging information can remain behind a verbose/debug mode.

Evidence findings can receive slightly stronger visual treatment than ordinary browsing actions.

For example:

```
◆ Evidence found
```

followed by the relevant claim/source.

This should make it possible to visually skim the completed transcript and distinguish:

navigation → investigation → evidence → conclusion

## Completed state

When the agent finishes, replace the animated working state with a persistent completion line.

Use the same personality as Claude Code's completion treatment.

For this product, I like "Brewed" as the default completion verb.

For example:

```
✻ Brewed for 42s · 18.7k tokens
```

or:

```
✓ Brewed in 42s · 18.7k tokens
```

The completion line should remain in the transcript.

For longer durations, format naturally:

```
✓ Brewed in 1m 24s · 31.2k tokens
```

This line represents the entire investigation, not merely the final LLM generation.

Architect the wording so Brewed is configurable rather than hard-coded; we may eventually choose another branded completion word.

## Motion and polish

Keep animation restrained.

Good:

- spinner/glyph subtly animates
- elapsed time increments
- whimsical status phrase occasionally changes
- new agent actions append smoothly
- status line updates in place

Avoid:

- excessive terminal redraws
- flashing
- large progress bars
- fake percentage-complete indicators
- constant layout shifts
- animations that compete with the evidence itself

The UI should feel alive while remaining extremely readable.

## Design philosophy

Prioritize the feeling of an agent visibly doing intellectual work.

A user should be able to glance at the terminal and immediately understand:

- Is the agent still working?
- What is it doing right now?
- How long has it been working?
- Roughly how much model work has occurred?
- What sources has it investigated?
- What evidence has it actually found?
- When did the investigation finish?
