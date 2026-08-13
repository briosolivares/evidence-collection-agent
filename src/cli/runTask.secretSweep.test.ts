import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FileCredentialStore } from '../auth/credentialStore.js';
import type { BrowserController } from '../browser/controller.js';
import { LocalChromeBrowserSessionProvider } from '../browser/playwrightBrowserController.js';
import type { CallModel, Message, ModelResponse } from '../loop/messages.js';
import {
  startFixtureServer,
  type FixtureServer,
} from '../../tests/fixtures/server.js';
import { refFor } from '../../tests/helpers/outline.js';
import { runTask } from './runTask.js';

const TEST_TIMEOUT_MS = 30_000;

// Deliberately high-entropy so a grep hit can only be a real leak.
const PASSWORD = 'sweep-canary-p4ssw0rd-71c9e2';
const USERNAME = 'sweep-user';

/** The latest tool_result content in the conversation — what the "model"
 * saw last, used to react with real refs from the live outline. */
function lastToolResultText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    for (const block of message.content) {
      if (block.type === 'tool_result') return block.content;
    }
    break;
  }
  throw new Error('No tool_result found in the conversation.');
}

function toolUse(id: string, name: string, input: unknown): ModelResponse {
  return {
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

/**
 * Permanent enforcement of R6 (the model never processes raw credentials):
 * a scripted run performs a real two-step login through fill_credentials,
 * then every recorded artifact of the run — transcript, manifest, metrics,
 * offloaded results — is swept for the password. One hit fails the build.
 */
describe('secret-leak sweep', () => {
  let browser: BrowserController;
  let fixtureServer: FixtureServer;
  let tempRoot: string;

  beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    tempRoot = await mkdtemp(join(tmpdir(), 'secret-sweep-'));
    const provider = new LocalChromeBrowserSessionProvider({
      profileDir: join(tempRoot, 'chrome-profile'),
      headless: true,
    });
    browser = await provider.createSession();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
    await fixtureServer?.close();
    if (tempRoot !== undefined) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it(
    'leaves no trace of the password anywhere in the run directory',
    async () => {
      const credentialsFile = join(tempRoot, 'credentials.json');
      await writeFile(
        credentialsFile,
        JSON.stringify({
          '127.0.0.1': { username: USERNAME, password: PASSWORD },
        }),
        { mode: 0o600 },
      );

      // A reactive fake model: it walks the real login flow, pulling live
      // refs out of each inspection result exactly as the production model
      // would.
      let turn = 0;
      const callModel: CallModel = async (messages) => {
        turn += 1;
        switch (turn) {
          case 1:
            return toolUse('nav-1', 'navigate', {
              url: fixtureServer.url('/login.html'),
            });
          case 2:
            return toolUse('inspect-1', 'inspect_page', {});
          case 3: {
            const outline = lastToolResultText(messages);
            return toolUse('fill-1', 'fill_credentials', {
              fields: [
                { ref: refFor(outline, 'textbox "Username"'), value: 'username' },
              ],
            });
          }
          case 4:
            return toolUse('inspect-2', 'inspect_page', {});
          case 5: {
            const outline = lastToolResultText(messages);
            return toolUse('click-1', 'click', {
              ref: refFor(outline, 'button "Next"'),
            });
          }
          case 6:
            return toolUse('inspect-3', 'inspect_page', {});
          case 7: {
            const outline = lastToolResultText(messages);
            return toolUse('fill-2', 'fill_credentials', {
              fields: [
                { ref: refFor(outline, 'textbox "Password"'), value: 'password' },
              ],
              submit_ref: refFor(outline, 'button "Log in"'),
            });
          }
          case 8:
            return toolUse('inspect-4', 'inspect_page', {});
          default:
            return {
              content: [{ type: 'text', text: 'Logged into the fixture.' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 2 },
            };
        }
      };

      const result = await runTask('Log into the local fixture site.', {
        browser,
        runsBaseDir: join(tempRoot, 'runs'),
        callModel,
        credentials: new FileCredentialStore(credentialsFile),
        maxTurns: 12,
        maxContextTokens: 100_000,
      });

      // Guard the guard: the login genuinely happened before we sweep.
      expect(result.status).toBe('completed');
      expect(fixtureServer.lastLogin()).toEqual({
        username: USERNAME,
        password: PASSWORD,
      });

      const entries = await readdir(result.runDir, {
        recursive: true,
        withFileTypes: true,
      });
      const files = entries.filter((entry) => entry.isFile());
      expect(files.length).toBeGreaterThan(0);
      for (const entry of files) {
        const path = join(entry.parentPath, entry.name);
        const contents = await readFile(path, 'utf8');
        expect(contents, `password leaked into ${path}`).not.toContain(PASSWORD);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
