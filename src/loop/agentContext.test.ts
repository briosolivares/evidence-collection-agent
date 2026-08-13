import { describe, expect, it } from 'vitest';

import {
  buildAgentContext,
  contextHash,
  MAX_RECENT_EVENTS,
  normalizeRepeatedFailures,
  serializeAgentContext,
  type RunEvent,
} from './agentContext.js';

function event(seq: number, kind: string, summary: string, failed = false): RunEvent {
  return { seq, kind, summary, ...(failed ? { failed: true } : {}) };
}

describe('buildAgentContext', () => {
  it('derives an empty-but-valid context with no inputs', () => {
    const context = buildAgentContext({});
    expect(context).toEqual({
      contractRevision: 0,
      pages: [],
      evidenceIds: [],
      recentEvents: [],
      repeatedFailures: [],
    });
    expect(serializeAgentContext(context)).toContain('Contract: none yet');
  });

  it('bounds the recent-event window to the newest events', () => {
    const events = Array.from({ length: MAX_RECENT_EVENTS + 8 }, (_, index) =>
      event(index + 1, 'navigate', `step ${index + 1}`),
    );
    const context = buildAgentContext({ events });
    expect(context.recentEvents).toHaveLength(MAX_RECENT_EVENTS);
    // The newest survive, the oldest drop.
    expect(context.recentEvents.at(-1)?.seq).toBe(MAX_RECENT_EVENTS + 8);
    expect(context.recentEvents[0]?.seq).toBe(9);
  });

  it('sorts events by sequence regardless of input order', () => {
    const context = buildAgentContext({
      events: [event(3, 'a', 'third'), event(1, 'a', 'first'), event(2, 'a', 'second')],
    });
    expect(context.recentEvents.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe('normalizeRepeatedFailures', () => {
  it('keeps a repeated failure visible after its raw events aged out', () => {
    // The failures happen early; the window would drop them entirely.
    const events: RunEvent[] = [
      event(1, 'read_resource', 'read_resource on https://api.example.com: 403', true),
      event(2, 'read_resource', 'read_resource on https://api.example.com: 403', true),
      ...Array.from({ length: MAX_RECENT_EVENTS + 5 }, (_, index) =>
        event(index + 3, 'navigate', `step ${index}`),
      ),
    ];
    const context = buildAgentContext({ events });

    // Aged out of the recent window...
    expect(context.recentEvents.some((e) => e.kind === 'read_resource')).toBe(false);
    // ...but still reported as a repeated failure.
    expect(context.repeatedFailures).toHaveLength(1);
    expect(context.repeatedFailures[0]).toMatchObject({
      action: 'read_resource',
      resource: 'https://api.example.com',
      count: 2,
      unresolved: true,
    });
    expect(serializeAgentContext(context)).toContain('do not retry these unchanged');
  });

  it('ignores a one-off failure — the raw conversation still has it', () => {
    expect(
      normalizeRepeatedFailures([event(1, 'click', 'click on #submit: not found', true)]),
    ).toEqual([]);
  });

  it('marks a failure resolved once the same action later succeeds', () => {
    const failures = normalizeRepeatedFailures([
      event(1, 'navigate', 'navigate on https://e.com: timeout', true),
      event(2, 'navigate', 'navigate on https://e.com: timeout', true),
      event(3, 'navigate', 'navigate on https://e.com'),
    ]);
    expect(failures[0]?.unresolved).toBe(false);
    // A resolved failure is not shown as a warning.
    const context = buildAgentContext({
      events: [
        event(1, 'navigate', 'navigate on https://e.com: timeout', true),
        event(2, 'navigate', 'navigate on https://e.com: timeout', true),
        event(3, 'navigate', 'navigate on https://e.com'),
      ],
    });
    expect(serializeAgentContext(context)).not.toContain('do not retry');
  });

  it('keeps a failure unresolved when the success came BEFORE the last failure', () => {
    const failures = normalizeRepeatedFailures([
      event(1, 'navigate', 'navigate on https://e.com: timeout', true),
      event(2, 'navigate', 'navigate on https://e.com'),
      event(3, 'navigate', 'navigate on https://e.com: timeout', true),
      event(4, 'navigate', 'navigate on https://e.com: timeout', true),
    ]);
    expect(failures[0]).toMatchObject({ count: 3, unresolved: true });
  });

  it('separates different resources and different reasons', () => {
    const failures = normalizeRepeatedFailures([
      event(1, 'read', 'read on https://a.com: 403', true),
      event(2, 'read', 'read on https://a.com: 403', true),
      event(3, 'read', 'read on https://b.com: 500', true),
      event(4, 'read', 'read on https://b.com: 500', true),
    ]);
    expect(failures).toHaveLength(2);
    expect(new Set(failures.map((f) => f.resource))).toEqual(
      new Set(['https://a.com', 'https://b.com']),
    );
  });

  it('orders the stubbornest failure first', () => {
    const failures = normalizeRepeatedFailures([
      event(1, 'x', 'x on a: r', true),
      event(2, 'x', 'x on a: r', true),
      event(3, 'y', 'y on b: r', true),
      event(4, 'y', 'y on b: r', true),
      event(5, 'y', 'y on b: r', true),
    ]);
    expect(failures[0]?.action).toBe('y');
    expect(failures[0]?.count).toBe(3);
  });
});

describe('contextHash', () => {
  it('is stable for identical state, so an unchanged run appends nothing new', () => {
    const inputs = {
      pages: [{ pageId: 'p1', url: 'https://e.com', selected: true }],
      evidenceIds: ['E1'],
      events: [event(1, 'navigate', 'navigate on https://e.com')],
    };
    expect(contextHash(buildAgentContext(inputs))).toBe(contextHash(buildAgentContext(inputs)));
  });

  it('changes when any rendered fact changes', () => {
    const base = contextHash(buildAgentContext({ evidenceIds: ['E1'] }));
    expect(contextHash(buildAgentContext({ evidenceIds: ['E1', 'E2'] }))).not.toBe(base);
    expect(
      contextHash(
        buildAgentContext({ evidenceIds: ['E1'], pages: [{ pageId: 'p1', url: 'https://e.com' }] }),
      ),
    ).not.toBe(base);
  });
});

describe('serializeAgentContext', () => {
  it('renders contract, outputs, pages, evidence, and activity deterministically', () => {
    const context = buildAgentContext({
      contractRevision: {
        revision: 2,
        contract: { outputs: [{ id: 'roster' }] } as never,
      },
      outputs: {
        tables: [
          {
            outputId: 'roster',
            filename: 'roster.csv',
            format: 'csv',
            rowCount: 3,
            ruleFailures: [],
            completenessRequired: true,
            completenessProvided: false,
            danglingEvidenceIds: [],
          },
        ],
        others: [],
        readyForSubmission: false,
        blockers: ['roster: needs completeness evidence'],
      },
      pages: [{ pageId: 'p1', url: 'https://e.com', title: 'Home', selected: true }],
      evidenceIds: ['E1', 'E2'],
      events: [event(1, 'navigate', 'navigate on https://e.com')],
    });

    const text = serializeAgentContext(context);
    expect(text).toContain('Contract: revision 2');
    expect(text).toContain('roster → roster.csv: 3 rows (completeness evidence MISSING)');
    expect(text).toContain('p1: https://e.com — Home (selected)');
    expect(text).toContain('## Evidence (2)');
    expect(text).toContain('[1] navigate');
    // Byte-identical on a second render.
    expect(serializeAgentContext(context)).toBe(text);
  });
});
