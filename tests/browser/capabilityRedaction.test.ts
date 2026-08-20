import { describe, expect, it } from 'vitest';

import {
  redactBrowserCapabilities,
  safeBrowserErrorMessage,
} from '../../src/browser/capabilityRedaction.js';

describe('browser capability redaction', () => {
  it('redacts websocket, devtools, Browserbase, and discovery capabilities', () => {
    const redacted = redactBrowserCapabilities(
      'ws=wss://private.example/session?token=ws-secret\n' +
        'devtools=http://127.0.0.1:9222/devtools/browser/devtools-secret\n' +
        'provider=https://api.browserbase.com/v1/sessions/provider-secret\n' +
        'discovery=http://127.0.0.1:9222/json/version?token=discovery-secret',
    );

    expect(redacted).toBe(
      'ws=[REDACTED_WEBSOCKET_URL]\n' +
        'devtools=[REDACTED_CDP_URL]\n' +
        'provider=[REDACTED_CDP_URL]\n' +
        'discovery=[REDACTED_CDP_URL]',
    );
  });

  it('preserves all text that does not carry a browser capability', () => {
    const text = 'request failed with status 503; see https://example.com/help?q=browser';

    expect(redactBrowserCapabilities(text)).toBe(text);
  });

  it('extracts an Error message without losing surrounding diagnostics', () => {
    expect(
      safeBrowserErrorMessage(
        new Error(
          'attach failed at (http://localhost:9222/json/version?token=secret) retry denied',
        ),
      ),
    ).toBe('attach failed at ([REDACTED_CDP_URL]) retry denied');
  });

  it('stringifies and redacts a non-Error thrown value', () => {
    expect(safeBrowserErrorMessage('failed at wss://private.example/control')).toBe(
      'failed at [REDACTED_WEBSOCKET_URL]',
    );
  });
});
