import { describe, expect, it } from 'vitest';

import {
  BROWSER_TEST_TIMEOUT_MS,
  setupBrowserToolSuite,
} from '../../../tests/helpers/browserToolSuite.js';
import { toEarlyJavaScriptRequest } from '../../browser/browserJavaScript.js';
import {
  createBrowserStateStore,
  DEFAULT_MAX_CACHED_OBSERVATIONS_PER_PAGE,
  diffObservations,
  MAX_CHANGE_ENTRIES,
  type BrowserObservation,
  type ElementRef,
} from '../../browser/browserState.js';
import { executeToolCall } from '../pipeline.js';
import { createRegistry } from '../registry.js';
import { observeTool } from './observe.js';

const STORED_ELEMENT = {
  id: 'el-1',
  pageId: 'page-1',
  frameId: 'frame-1',
  documentId: 'doc-1',
  role: 'button',
  name: 'Submit',
};

describe('browser state store', () => {
  it('rejects non-positive or non-finite cache limits', () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createBrowserStateStore({ maxCachedObservationsPerPage: invalid }),
      ).toThrow(TypeError);
    }
  });

  it('evicts old baselines without ever reusing observation numbers', () => {
    const store = createBrowserStateStore({ maxCachedObservationsPerPage: 2 });
    const pageId = store.createPageId();
    const snapshot = { documentId: 'doc-1', url: 'https://example.test/', elements: [STORED_ELEMENT] };

    expect(store.recordObservation(pageId, snapshot)).toBe(1);
    expect(store.recordObservation(pageId, snapshot)).toBe(2);
    expect(store.recordObservation(pageId, snapshot)).toBe(3);

    // The oldest baseline is gone; recent ones and the counter survive.
    expect(store.getObservation(pageId, 1)).toBeUndefined();
    expect(store.getObservation(pageId, 2)?.observationId).toBe(2);
    expect(store.getObservation(pageId, 3)?.elements).toEqual([STORED_ELEMENT]);
    expect(store.latestObservationId(pageId)).toBe(3);

    store.forgetPage(pageId);
    expect(store.getObservation(pageId, 3)).toBeUndefined();
    expect(store.latestObservationId(pageId)).toBe(0);
  });
});

/** `count` refs in one document, ids `el-1..el-count`. */
function elementsFor(documentId: string, count: number): ElementRef[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `el-${index + 1}`,
    pageId: 'page-1',
    frameId: 'frame-1',
    documentId,
    role: 'button',
    name: `Row ${index + 1}`,
  }));
}

describe('observation diffs', () => {
  const url = 'https://example.test/';

  it('reports nothing but a full-snapshot basis when no baseline exists', () => {
    // The evicted/never-requested baseline path: the views carry the whole
    // picture, so every diff array must stay empty rather than imply "gone".
    expect(
      diffObservations(undefined, {
        documentId: 'doc-1',
        url,
        elements: elementsFor('doc-1', 3),
      }),
    ).toEqual({
      basis: 'full_snapshot',
      navigated: false,
      newlyVisible: [],
      noLongerVisibleElementIds: [],
      updatedText: [],
    });
  });

  it('matches same-document elements by id, reporting adds, drops, and renames', () => {
    const [kept, renamed, dropped] = elementsFor('doc-1', 3);
    const added: ElementRef = { ...kept, id: 'el-9', name: 'Added later' };
    const baseline = {
      observationId: 1,
      documentId: 'doc-1',
      url,
      elements: [kept, renamed, dropped],
    };

    const changes = diffObservations(baseline, {
      documentId: 'doc-1',
      url,
      elements: [
        // Reordered on purpose: identity is by id, never by position.
        added,
        { ...renamed, name: 'Row two (updated)' },
        kept,
      ],
    });

    expect(changes.basis).toBe('requested_observation');
    expect(changes.navigated).toBe(false);
    expect(changes.url).toBeUndefined();
    expect(changes.newlyVisible.map((element) => element.id)).toEqual(['el-9']);
    expect(changes.noLongerVisibleElementIds).toEqual([dropped.id]);
    expect(changes.updatedText).toEqual([
      { elementId: renamed.id, text: 'Row two (updated)' },
    ]);
  });

  it('treats a replaced document as navigation with bounded element turnover', () => {
    const oversized = MAX_CHANGE_ENTRIES + 25;
    const changes = diffObservations(
      {
        observationId: 4,
        documentId: 'doc-1',
        url,
        elements: elementsFor('doc-1', oversized),
      },
      {
        documentId: 'doc-2',
        url: 'https://example.test/next',
        elements: elementsFor('doc-2', oversized),
      },
    );

    expect(changes.navigated).toBe(true);
    expect(changes.url).toEqual({ before: url, after: 'https://example.test/next' });
    // Full turnover (no id survives a document replacement), but every array
    // stays bounded so one huge page cannot balloon the diff.
    expect(changes.newlyVisible).toHaveLength(MAX_CHANGE_ENTRIES);
    expect(changes.noLongerVisibleElementIds).toHaveLength(MAX_CHANGE_ENTRIES);
    expect(changes.updatedText).toEqual([]);
  });
});

describe('observe tool', () => {
  const suite = setupBrowserToolSuite('observe-tool');
  const registry = createRegistry([observeTool]);

  function call(name: string, input: unknown) {
    return executeToolCall(
      registry,
      { id: `call-${name}`, name, input },
      { runDir: suite.runDir(), browser: suite.controller() },
    );
  }

  /** Load a fixture page through the controller directly, not a tool call:
   * a plain page-setup step has no reason to touch the tool pipeline, and
   * (unlike browser_action, whose own finishSequence() always calls
   * session.observe() to build its returned diff) this never advances the
   * page's observation counter, exactly like the deleted `navigate` tool
   * never did. Several assertions below depend on the FIRST explicit
   * `observe` call landing on observationId 1; routing setup through
   * browser_action would burn that slot on the navigate step itself. */
  async function navigateTo(path: string): Promise<void> {
    await suite.controller().goto(suite.server().url(path));
  }

  async function observe(input: unknown): Promise<BrowserObservation> {
    const result = await call('observe', input);
    expect(result.isError).toBe(false);
    return JSON.parse(result.content) as BrowserObservation;
  }

  it(
    'returns the interactive view with stable identity by default',
    async () => {
      await navigateTo('/');

      const observation = await observe({});

      expect(observation.page.observationId).toBe(1);
      expect(observation.page.active).toBe(true);
      expect(observation.page.url).toBe(suite.server().url('/'));
      expect(observation.changes.basis).toBe('full_snapshot');
      expect(observation.views).toHaveLength(1);
      expect(observation.views[0]?.need).toBe('interactive');
      expect(observation.views[0]?.content).toContain('button "Announce ready"');

      const announce = observation.elements.find(
        (element) => element.role === 'button' && element.name === 'Announce ready',
      );
      expect(announce).toBeDefined();
      expect(announce?.pageId).toBe(observation.page.pageId);
      expect(announce?.documentId).toBe(observation.page.documentId);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'returns exact text alongside the outline when both needs are requested',
    async () => {
      await navigateTo('/');

      const observation = await observe({ need: ['interactive', 'text'] });

      expect(observation.views.map((view) => view.need)).toEqual([
        'interactive',
        'text',
      ]);
      expect(observation.views[1]?.content).toContain(
        'This deterministic page exercises semantic browser observations.',
      );
      expect(observation.views[1]?.truncated).toBe(false);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'diffs against a recent baseline and full-snapshots an evicted one',
    async () => {
      await navigateTo('/rows.html');
      const first = await observe({});

      // Mutate through the browser controller's own JavaScript evaluation —
      // the engine mechanism the now-deleted inspect_page/click tools wrapped
      // (click(ref) itself is gone with them) — rather than through observe
      // or browser_action. This is deliberate, not a convenience shortcut: it
      // proves observe's diff reflects the page's actual DOM state, not
      // merely state that observe/browser_action themselves recorded, AND it
      // never touches the observation cache. (browser_action would not work
      // as a substitute here even though it exposes a 'click' op: its own
      // finishSequence() calls session.observe() internally to build its
      // returned diff, which would silently consume a slot in the
      // eviction-cache accounting below.)
      await suite.controller().executeJavaScript!(
        toEarlyJavaScriptRequest("document.getElementById('mutate').click();", 5_000),
      );

      const second = await observe({
        basedOnObservationId: first.page.observationId,
      });
      expect(second.changes.basis).toBe('requested_observation');
      expect(second.changes.navigated).toBe(false);
      expect(
        second.changes.newlyVisible.some((element) => element.name === 'Added later'),
      ).toBe(true);

      // Age the first observation out of the diff cache.
      for (let i = 0; i < DEFAULT_MAX_CACHED_OBSERVATIONS_PER_PAGE; i += 1) {
        await observe({});
      }
      const evicted = await observe({
        basedOnObservationId: first.page.observationId,
      });
      expect(evicted.changes.basis).toBe('full_snapshot');
      expect(evicted.views[0]?.content).toContain('button "Reverse rows"');
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects malformed requests before touching the browser',
    async () => {
      await navigateTo('/');

      for (const input of [
        { basedOnObservationId: 0 },
        { basedOnObservationId: 1.5 },
        { need: [] },
        { need: ['visual'] },
        { pageId: '' },
        { unexpected: true },
      ]) {
        const result = await call('observe', input);
        expect(result).toMatchObject({ isError: true, errorKind: 'invalid_input' });
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
