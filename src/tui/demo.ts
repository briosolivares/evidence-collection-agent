// `sherlock --demo`: a canned fake investigation played through the real
// store/reducer/render pipeline with realistic pacing — the full "agent is
// working" experience at zero API cost. The event stamps are logical (the
// completion line reads 42s · 18.7k tokens) while playback is compressed.

import type { StoreAction } from './store/reducer.js';

/** One scripted step: wait, then dispatch. */
export interface DemoStep {
  delayMs: number;
  action: StoreAction;
}

const DEMO_TASK = "Find Acme Corp's Series B investors and save them to a CSV";
const DEMO_RUN_DIR = 'runs/2026-08-11_10-15-02_find-acme-corp-series-b_demo';

/** Split prose into word-ish chunks so it streams like a live model. */
function deltas(turnDelay: number, text: string): DemoStep[] {
  const chunks = text.match(/\S+\s*/g) ?? [];
  return chunks.map((chunk, index) => ({
    delayMs: index === 0 ? turnDelay : 45,
    action: { type: 'text_delta', text: chunk },
  }));
}

/**
 * Build the demo script. Logical run duration is 42s and settled usage
 * sums to 18 700 tokens (input + output), so the completion line reads
 * `✓ Brewed in 42s · 18.7k tokens` exactly.
 *
 * @param baseAt - epoch ms used for the run's logical start; pass
 *   Date.now() for live playback (elapsed time then ticks from now) or a
 *   fixed value in tests
 */
export function createDemoScript(baseAt: number): DemoStep[] {
  return [
    { delayMs: 400, action: { type: 'submit_task', text: DEMO_TASK } },
    { delayMs: 200, action: { type: 'run_started', task: DEMO_TASK, at: baseAt } },

    // Turn 1 — orient, then open the coverage.
    { delayMs: 300, action: { type: 'turn_start', turn: 1 } },
    ...deltas(
      500,
      "I'll start with recent funding coverage, then confirm the names against the primary filing.",
    ),
    { delayMs: 400, action: { type: 'tool_pending', name: 'browser_execute' } },
    { delayMs: 300, action: { type: 'turn_end', usage: { input: 1200, output: 180 } } },
    {
      delayMs: 200,
      action: {
        type: 'tool_exec_start',
        id: 1,
        name: 'browser_execute',
        input: {
          code: "await browser.goto('https://techcrunch.com/2026/05/14/acme-series-b'); return await browser.pageInfo();",
        },
      },
    },
    { delayMs: 1400, action: { type: 'tool_exec_end', id: 1, ok: true, result: 'Loaded techcrunch.com — Acme Corp raises $85M Series B' } },

    // Turn 2 — read the article, capture the coverage as evidence.
    { delayMs: 300, action: { type: 'turn_start', turn: 2 } },
    ...deltas(
      400,
      'The coverage is up. Reading the page for investor names and capturing the article as evidence.',
    ),
    { delayMs: 350, action: { type: 'tool_pending', name: 'browser_execute' } },
    { delayMs: 100, action: { type: 'tool_pending', name: 'publish_artifact' } },
    { delayMs: 250, action: { type: 'turn_end', usage: { input: 3400, output: 240 } } },
    {
      delayMs: 200,
      action: {
        type: 'tool_exec_start',
        id: 2,
        name: 'browser_execute',
        input: { code: "return await browser.accessibility({ filter: 'investor' });" },
      },
    },
    { delayMs: 1200, action: { type: 'tool_exec_end', id: 2, ok: true, result: 'outline: article — "Acme Corp raises $85M Series B led by Meridian Growth"' } },
    {
      delayMs: 150,
      action: {
        type: 'tool_exec_start',
        id: 3,
        name: 'publish_artifact',
        input: {
          kind: 'screenshot',
          artifact_path: 'artifacts/series-b-coverage.png',
          roles: ['evidence'],
        },
      },
    },
    // Publishes precede their execution's tool_exec_end (the tracing-seam
    // contract), carrying the manifest entry verbatim — sourceUrl included.
    {
      delayMs: 700,
      action: {
        type: 'artifact_published',
        entry: {
          filename: 'artifacts/series-b-coverage.png',
          sha256: '4c8a1d2e9f30b6a75d4e3c2b1a09f8e7d6c5b4a3928170f6e5d4c3b2a1908f7e',
          sourceUrl: 'https://techcrunch.com/2026/05/14/acme-series-b',
          roles: ['evidence'],
          capturedAt: '2026-08-11T10:15:12.000Z',
        },
        sizeBytes: 84_512,
        toolExecId: 3,
      },
    },
    { delayMs: 150, action: { type: 'tool_exec_end', id: 3, ok: true, result: 'Captured series-b-coverage.png (viewport)' } },

    // Turn 3 — follow to the filing; one flaky click for texture.
    { delayMs: 300, action: { type: 'turn_start', turn: 3 } },
    ...deltas(
      400,
      'The article names three investors — Meridian Growth, Halcyon Partners, and Northgate Capital. The filing should confirm the amounts.',
    ),
    { delayMs: 350, action: { type: 'tool_pending', name: 'browser_execute' } },
    { delayMs: 100, action: { type: 'tool_pending', name: 'browser_execute' } },
    { delayMs: 250, action: { type: 'turn_end', usage: { input: 4200, output: 260 } } },
    {
      delayMs: 200,
      action: {
        type: 'tool_exec_start',
        id: 4,
        name: 'browser_execute',
        input: {
          code: "await browser.goto('https://www.sec.gov/cgi-bin/browse-edgar?company=acme'); return await browser.pageInfo();",
        },
      },
    },
    { delayMs: 1300, action: { type: 'tool_exec_end', id: 4, ok: true, result: 'Loaded sec.gov EDGAR company search' } },
    {
      delayMs: 150,
      action: {
        type: 'tool_exec_start',
        id: 5,
        name: 'browser_execute',
        input: { code: "await browser.click('e42'); return await browser.pageInfo();" },
      },
    },
    {
      delayMs: 900,
      action: {
        type: 'tool_exec_end',
        id: 5,
        ok: false,
        error: 'ref e42 not found after navigation',
      },
    },

    // Turn 4 — recover, capture the filing, save the deliverable.
    { delayMs: 300, action: { type: 'turn_start', turn: 4 } },
    ...deltas(
      400,
      'The link moved after the page settled — re-inspecting, then capturing the filing and saving the confirmed list as evidence.',
    ),
    { delayMs: 350, action: { type: 'tool_pending', name: 'browser_execute' } },
    { delayMs: 100, action: { type: 'tool_pending', name: 'publish_artifact' } },
    { delayMs: 100, action: { type: 'tool_pending', name: 'publish_artifact' } },
    { delayMs: 250, action: { type: 'turn_end', usage: { input: 4300, output: 420 } } },
    {
      delayMs: 200,
      action: {
        type: 'tool_exec_start',
        id: 6,
        name: 'browser_execute',
        input: { code: "return await browser.accessibility({ filter: 'offering' });" },
      },
    },
    { delayMs: 1000, action: { type: 'tool_exec_end', id: 6, ok: true, result: 'outline: Form D — Acme Corp, total offering $85,000,000' } },
    {
      delayMs: 150,
      action: {
        type: 'tool_exec_start',
        id: 7,
        name: 'publish_artifact',
        input: {
          kind: 'screenshot',
          artifact_path: 'artifacts/form-d-filing.png',
          roles: ['evidence'],
        },
      },
    },
    {
      delayMs: 650,
      action: {
        type: 'artifact_published',
        entry: {
          filename: 'artifacts/form-d-filing.png',
          sha256: '7e5d4c3b2a1908f7e6d5c4b3a291807f6e5d4c3b2a19f8e7d6c5b4a392817065',
          sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1874523/primary_doc.xml',
          roles: ['evidence'],
          capturedAt: '2026-08-11T10:15:36.000Z',
        },
        sizeBytes: 61_240,
        toolExecId: 7,
      },
    },
    { delayMs: 150, action: { type: 'tool_exec_end', id: 7, ok: true, result: 'Captured form-d-filing.png (full page)' } },
    {
      delayMs: 150,
      action: {
        type: 'tool_exec_start',
        id: 8,
        name: 'publish_artifact',
        input: {
          kind: 'text',
          artifact_path: 'artifacts/investors.csv',
          roles: ['requested_output'],
        },
      },
    },
    // The manifest-derived publish is authoritative; the reducer does not
    // infer an artifact merely from the tool name.
    {
      delayMs: 550,
      action: {
        type: 'artifact_published',
        entry: {
          filename: 'artifacts/investors.csv',
          sha256: '9b2f6cd3a4e18f70b5c243d9a0e6f1785c3b2a4d6e8f9012a3b4c5d6e7f80915',
          roles: ['requested_output'],
          capturedAt: '2026-08-11T10:15:40.000Z',
        },
        sizeBytes: 182,
        toolExecId: 8,
      },
    },
    { delayMs: 150, action: { type: 'tool_exec_end', id: 8, ok: true, result: 'Created investors.csv (3 rows)' } },

    // Turn 5 — conclude.
    { delayMs: 300, action: { type: 'turn_start', turn: 5 } },
    ...deltas(
      500,
      "Acme's Series B was led by Meridian Growth with participation from Halcyon Partners and Northgate Capital; the three names and their filing references are saved in investors.csv.",
    ),
    { delayMs: 100, action: { type: 'tool_pending', name: 'finish' } },
    { delayMs: 300, action: { type: 'turn_end', usage: { input: 4100, output: 400 } } },
    {
      delayMs: 500,
      action: {
        type: 'run_finished',
        outcome: 'completed',
        // The completion panel's answer block — a real one-line answer
        // (the full prose is already in the transcript above).
        finalText:
          'Series B: $85M led by Meridian Growth, with Halcyon Partners and Northgate Capital — confirmed against the Form D and saved to investors.csv.',
        runDir: DEMO_RUN_DIR,
        at: baseAt + 42_000,
      },
    },
  ];
}

/**
 * Play a demo script into a dispatcher with its scripted pacing.
 *
 * @returns a cancel function; once called, no further steps dispatch
 */
export function playDemo(
  steps: readonly DemoStep[],
  dispatch: (action: StoreAction) => void,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = (index: number) => {
    if (cancelled || index >= steps.length) return;
    const step = steps[index]!;
    timer = setTimeout(() => {
      if (cancelled) return;
      dispatch(step.action);
      run(index + 1);
    }, step.delayMs);
  };
  run(0);

  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
