import { describe, expect, it } from 'vitest';

import {
  capPageChanges,
  classifyBlockedState,
  DEFAULT_SETTLE_POLICY,
  MAX_ACTION_CHANGE_ENTRIES,
  MAX_CHANGE_TEXT_CHARS,
  MAX_RETRY_AFTER_MS,
  MAX_SETTLE_POLICY,
  resolveSettlePolicy,
  type BlockSignals,
} from './browserActions.js';
import type { ElementRef, PageChanges } from './browserState.js';

/** A page that shows nothing worth blocking on. */
const CLEAR_PAGE: BlockSignals = {
  url: 'https://example.test/orders/42',
  text: 'Order 42\nStatus: shipped\nDownload invoice',
  hasPasswordField: false,
  frameUrls: ['https://example.test/orders/42'],
};

describe('settle policy resolution', () => {
  it('defaults the three waits independently', () => {
    expect(resolveSettlePolicy()).toEqual(DEFAULT_SETTLE_POLICY);
    expect(resolveSettlePolicy({ quietWindowMs: 100 })).toEqual({
      ...DEFAULT_SETTLE_POLICY,
      quietWindowMs: 100,
    });
  });

  it('caps every caller override at the provider maximum', () => {
    expect(
      resolveSettlePolicy({
        successCheckTimeoutMs: 600_000,
        quietWindowMs: 60_000,
        settleTimeoutMs: 600_000,
      }),
    ).toEqual(MAX_SETTLE_POLICY);
  });

  it('falls back to the default for a nonsense wait rather than failing the call', () => {
    // A bad hint must not sink a sequence that would otherwise work.
    for (const invalid of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveSettlePolicy({ settleTimeoutMs: invalid }).settleTimeoutMs).toBe(
        DEFAULT_SETTLE_POLICY.settleTimeoutMs,
      );
    }
    // Fractional milliseconds are floored, never rounded up past the cap.
    expect(resolveSettlePolicy({ quietWindowMs: 10.9 }).quietWindowMs).toBe(10);
  });
});

describe('blocked-state classification', () => {
  it('leaves an ordinary page unclassified', () => {
    expect(classifyBlockedState(CLEAR_PAGE)).toBeUndefined();
  });

  it('recognizes a rate limit from the status and echoes a bounded Retry-After', () => {
    expect(
      classifyBlockedState({
        ...CLEAR_PAGE,
        status: 429,
        retryAfterHeader: '30',
      }),
    ).toEqual({ reason: 'rate_limit', retryAfterMs: 30_000 });
  });

  it('drops a Retry-After it cannot act on', () => {
    for (const header of ['', 'soon', '-5', String(MAX_RETRY_AFTER_MS / 1_000 + 1)]) {
      expect(
        classifyBlockedState({ ...CLEAR_PAGE, status: 429, retryAfterHeader: header }),
      ).toEqual({ reason: 'rate_limit' });
    }
  });

  it('prefers a challenge over the login form wrapped around it', () => {
    expect(
      classifyBlockedState({
        ...CLEAR_PAGE,
        text: 'Sign in to continue',
        hasPasswordField: true,
        frameUrls: [CLEAR_PAGE.url, 'https://www.google.com/recaptcha/api2/anchor'],
      }),
    ).toEqual({ reason: 'captcha' });
    expect(
      classifyBlockedState({
        ...CLEAR_PAGE,
        text: 'Checking your browser before you continue',
      }),
    ).toEqual({ reason: 'bot_challenge' });
  });

  it('recognizes login and permission walls, including status-only ones', () => {
    expect(
      classifyBlockedState({
        ...CLEAR_PAGE,
        url: 'https://example.test/login',
        text: 'Log in to Example',
        hasPasswordField: true,
      }),
    ).toEqual({ reason: 'login' });
    expect(
      classifyBlockedState({ ...CLEAR_PAGE, text: 'Access denied' }),
    ).toEqual({ reason: 'permission' });
    expect(classifyBlockedState({ ...CLEAR_PAGE, status: 401 })).toEqual({
      reason: 'login',
    });
    expect(classifyBlockedState({ ...CLEAR_PAGE, status: 403 })).toEqual({
      reason: 'permission',
    });
  });

  it('does not call a page blocked just because it mentions a password field', () => {
    // No password input, no login URL: "password" in prose is not a wall.
    expect(
      classifyBlockedState({
        ...CLEAR_PAGE,
        text: 'Your password was changed successfully.',
      }),
    ).toBeUndefined();
  });
});

describe('page-change capping', () => {
  function refs(count: number): ElementRef[] {
    return Array.from({ length: count }, (_unused, index) => ({
      id: `el-${index + 1}`,
      pageId: 'page-1',
      frameId: 'frame-1',
      documentId: 'doc-1',
      role: 'button',
      name: `Row ${index + 1}`,
    }));
  }

  it('passes a small diff through untouched', () => {
    const changes: PageChanges = {
      basis: 'requested_observation',
      navigated: false,
      newlyVisible: refs(2),
      noLongerVisibleElementIds: ['el-9'],
      updatedText: [{ elementId: 'el-3', text: 'Saved' }],
    };
    expect(capPageChanges(changes)).toEqual({ changes, truncated: false });
  });

  it('bounds every array and every changed text, and says that it did', () => {
    const oversized = MAX_ACTION_CHANGE_ENTRIES + 10;
    const capped = capPageChanges({
      basis: 'requested_observation',
      navigated: true,
      url: { before: 'https://example.test/a', after: 'https://example.test/b' },
      newlyVisible: refs(oversized),
      noLongerVisibleElementIds: refs(oversized).map((ref) => ref.id),
      updatedText: [{ elementId: 'el-1', text: 'x'.repeat(MAX_CHANGE_TEXT_CHARS + 50) }],
    });

    expect(capped.truncated).toBe(true);
    expect(capped.changes.newlyVisible).toHaveLength(MAX_ACTION_CHANGE_ENTRIES);
    expect(capped.changes.noLongerVisibleElementIds).toHaveLength(
      MAX_ACTION_CHANGE_ENTRIES,
    );
    expect(capped.changes.updatedText[0]?.text).toHaveLength(MAX_CHANGE_TEXT_CHARS);
    // Navigation facts survive the cap: they are what makes refs stale.
    expect(capped.changes.navigated).toBe(true);
    expect(capped.changes.url?.after).toBe('https://example.test/b');
  });
});
