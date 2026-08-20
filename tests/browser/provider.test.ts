import { describe, expect, it } from 'vitest';

import {
  ATTACHED_CHROME_ENDPOINT_ENV_VAR,
  AttachedChromeSetupBrowserSessionProvider,
} from '../../src/browser/attachedChromeSetup.js';
import { BrowserbaseBrowserSessionProvider } from '../../src/browser/browserbaseBrowserSessionProvider.js';
import { LocalChromeBrowserSessionProvider } from '../../src/browser/playwrightBrowserController.js';
import {
  BROWSER_PROVIDER_ENV_VAR,
  BROWSERBASE_CONTEXT_ENV_VAR,
  browserbaseContextId,
  createBrowserSessionProvider,
  describeBrowserProvider,
  formatBrowserStartupError,
  requireBrowserbaseContextId,
  resolveBrowserProviderKind,
} from '../../src/browser/provider.js';

/**
 * All tests pass explicit `env` objects — never `process.env` — so nothing
 * here depends on, or mutates, this process's real environment.
 */

const PROFILE_DIR = '/tmp/sherlock-test-profile';

describe('resolveBrowserProviderKind', () => {
  it('defaults to local when unset', () => {
    expect(resolveBrowserProviderKind({})).toBe('local');
  });

  it('defaults to local when the variable is empty', () => {
    expect(resolveBrowserProviderKind({ [BROWSER_PROVIDER_ENV_VAR]: '' })).toBe('local');
  });

  // One value per branch, chosen to exercise the shared trim+lowercase normalization.
  it('treats " LOCAL " as local', () => {
    expect(resolveBrowserProviderKind({ [BROWSER_PROVIDER_ENV_VAR]: ' LOCAL ' })).toBe('local');
  });

  it('treats "BrowserBase" as browserbase', () => {
    expect(resolveBrowserProviderKind({ [BROWSER_PROVIDER_ENV_VAR]: 'BrowserBase' })).toBe(
      'browserbase',
    );
  });

  it('throws on an unknown value, naming the value and both valid options', () => {
    // A silent fallback to local Chrome for a typo like "browsebase" would run
    // a whole batch on the wrong runtime with nothing to show for it until
    // someone notices the batch never used Browserbase at all.
    expect(() => resolveBrowserProviderKind({ [BROWSER_PROVIDER_ENV_VAR]: 'browsebase' })).toThrow(
      /browsebase/,
    );
    expect(() => resolveBrowserProviderKind({ [BROWSER_PROVIDER_ENV_VAR]: 'browsebase' })).toThrow(
      /browserbase/,
    );
    expect(() => resolveBrowserProviderKind({ [BROWSER_PROVIDER_ENV_VAR]: 'browsebase' })).toThrow(
      /local/,
    );
  });
});

describe('browserbaseContextId', () => {
  it('is undefined when unset', () => {
    expect(browserbaseContextId({})).toBeUndefined();
  });

  it('is undefined when blank', () => {
    expect(browserbaseContextId({ [BROWSERBASE_CONTEXT_ENV_VAR]: '   ' })).toBeUndefined();
  });

  it('returns the trimmed value when set', () => {
    expect(browserbaseContextId({ [BROWSERBASE_CONTEXT_ENV_VAR]: '  ctx-123  ' })).toBe('ctx-123');
  });
});

describe('requireBrowserbaseContextId', () => {
  it('throws naming `npm run login` when unset', () => {
    expect(() => requireBrowserbaseContextId({})).toThrow(/npm run login/);
  });

  it('returns the context id when set', () => {
    expect(requireBrowserbaseContextId({ [BROWSERBASE_CONTEXT_ENV_VAR]: 'ctx-123' })).toBe(
      'ctx-123',
    );
  });
});

describe('createBrowserSessionProvider', () => {
  it('builds a managed LocalChromeBrowserSessionProvider only when requested', () => {
    const provider = createBrowserSessionProvider({
      env: {},
      localMode: 'managed',
      profileDir: PROFILE_DIR,
    });
    expect(provider).toBeInstanceOf(LocalChromeBrowserSessionProvider);
  });

  it('builds the attached setup provider for interactive local mode', () => {
    const provider = createBrowserSessionProvider({
      env: { [ATTACHED_CHROME_ENDPOINT_ENV_VAR]: 'http://127.0.0.1:9222' },
      localMode: 'attached',
      profileDir: PROFILE_DIR,
      onAttachedSetupState: () => undefined,
    });
    expect(provider).toBeInstanceOf(AttachedChromeSetupBrowserSessionProvider);
  });

  it('requires a visible setup callback for attached local mode', () => {
    expect(() =>
      createBrowserSessionProvider({
        env: {},
        localMode: 'attached',
        profileDir: PROFILE_DIR,
      }),
    ).toThrow(/onAttachedSetupState/);
  });

  it('fails closed for an unknown local mode before selecting a provider', () => {
    expect(() =>
      createBrowserSessionProvider({
        env: {},
        localMode: 'ambient' as never,
        profileDir: PROFILE_DIR,
      }),
    ).toThrow(/localMode/);
  });

  it('builds a BrowserbaseBrowserSessionProvider when explicitly selected with a key', () => {
    // Constructing the real class here does build a real Browserbase SDK
    // client, but reading its constructor (node_modules/@browserbasehq/sdk)
    // shows it only stores config and builds resource sub-objects — no
    // network call and no ambient env read once apiKey is passed explicitly,
    // which it is here. So this stays hermetic.
    const provider = createBrowserSessionProvider({
      env: { [BROWSER_PROVIDER_ENV_VAR]: 'browserbase', BROWSERBASE_API_KEY: 'sk-test' },
      localMode: 'managed',
      profileDir: PROFILE_DIR,
    });
    expect(provider).toBeInstanceOf(BrowserbaseBrowserSessionProvider);
  });

  it('does not apply attached-local setup requirements to Browserbase', () => {
    const provider = createBrowserSessionProvider({
      env: { [BROWSER_PROVIDER_ENV_VAR]: 'browserbase', BROWSERBASE_API_KEY: 'sk-test' },
      localMode: 'attached',
      profileDir: PROFILE_DIR,
    });
    expect(provider).toBeInstanceOf(BrowserbaseBrowserSessionProvider);
  });

  it('throws before constructing anything when browserbase is selected with no key', () => {
    expect(() =>
      createBrowserSessionProvider({
        env: { [BROWSER_PROVIDER_ENV_VAR]: 'browserbase' },
        localMode: 'managed',
        profileDir: PROFILE_DIR,
      }),
    ).toThrow(/BROWSERBASE_API_KEY/);
  });

  it("throws when context: 'required' and no BROWSERBASE_CONTEXT_ID is set", () => {
    expect(() =>
      createBrowserSessionProvider({
        env: { [BROWSER_PROVIDER_ENV_VAR]: 'browserbase', BROWSERBASE_API_KEY: 'sk-test' },
        localMode: 'managed',
        profileDir: PROFILE_DIR,
        context: 'required',
      }),
    ).toThrow(/npm run login/);
  });

  it("succeeds when context: 'optional' and no context id is set", () => {
    const provider = createBrowserSessionProvider({
      env: { [BROWSER_PROVIDER_ENV_VAR]: 'browserbase', BROWSERBASE_API_KEY: 'sk-test' },
      localMode: 'managed',
      profileDir: PROFILE_DIR,
      context: 'optional',
    });
    expect(provider).toBeInstanceOf(BrowserbaseBrowserSessionProvider);
  });
});

describe('describeBrowserProvider', () => {
  it('names the profile dir for managed local mode', () => {
    expect(
      describeBrowserProvider({
        env: {},
        localMode: 'managed',
        profileDir: PROFILE_DIR,
      }),
    ).toContain(PROFILE_DIR);
  });

  it('describes attached local mode without naming the managed profile', () => {
    const description = describeBrowserProvider({
      env: {},
      localMode: 'attached',
      profileDir: PROFILE_DIR,
    });
    expect(description).toContain('attached');
    expect(description).not.toContain(PROFILE_DIR);
  });

  it('names the context id for browserbase when set', () => {
    const description = describeBrowserProvider({
      env: { [BROWSER_PROVIDER_ENV_VAR]: 'browserbase', [BROWSERBASE_CONTEXT_ENV_VAR]: 'ctx-123' },
      localMode: 'managed',
      profileDir: PROFILE_DIR,
    });
    expect(description).toContain('ctx-123');
  });

  it('says no context is configured for browserbase when unset', () => {
    const description = describeBrowserProvider({
      env: { [BROWSER_PROVIDER_ENV_VAR]: 'browserbase' },
      localMode: 'managed',
      profileDir: PROFILE_DIR,
    });
    expect(description).toMatch(/no .*context.* configured/i);
  });
});

describe('formatBrowserStartupError', () => {
  it('gives the exact Chrome permission path for attached mode', () => {
    const formatted = formatBrowserStartupError('local', 'setup did not complete', 'attached');
    expect(formatted).toContain('chrome://inspect/#remote-debugging');
    expect(formatted).toContain('Allow remote debugging for this browser instance');
  });

  it('includes Chrome-install guidance for a not-found-shaped local message', () => {
    const formatted = formatBrowserStartupError(
      'local',
      "Executable doesn't exist at /no/chrome",
      'managed',
    );
    expect(formatted).toMatch(/install/i);
    expect(formatted).toContain("Executable doesn't exist at /no/chrome");
  });

  it('omits install guidance for a local message that is not not-found-shaped', () => {
    const formatted = formatBrowserStartupError('local', 'Chrome crashed unexpectedly', 'managed');
    expect(formatted).not.toMatch(/chrome\.com|playwright install/i);
    expect(formatted).toContain('Chrome crashed unexpectedly');
  });

  it('always ends with the underlying message, local branch', () => {
    const formatted = formatBrowserStartupError(
      'local',
      'some underlying failure detail',
      'managed',
    );
    expect(formatted.endsWith('some underlying failure detail')).toBe(true);
  });

  it('mentions BROWSERBASE_API_KEY and the local fallback, never Chrome install, browserbase branch', () => {
    const formatted = formatBrowserStartupError('browserbase', 'session limit reached', 'managed');
    expect(formatted).toContain('BROWSERBASE_API_KEY');
    expect(formatted).toMatch(/local/);
    expect(formatted).not.toMatch(/install/i);
    expect(formatted.endsWith('session limit reached')).toBe(true);
  });
});
