/**
 * Local code execution setup.
 *
 * Owns the `bash` tool's secret-env denylist and the preflight check
 * {@link prepareLocalExecution} runs (via
 * @link runTask and @link resumeTask) before the first model call, so a host
 * that cannot run local commands fails immediately instead of after the
 * worker has already planned around a tool that was never going to run.
 * Split out because both `runTask` and `resumeTask` need this exact
 * preflight, and the denylist it enforces belongs beside the check that
 * proves the shell it applies to actually exists.
 */
import { accessSync, constants as fsConstants, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { ATTACHED_CHROME_ENDPOINT_ENV_VAR } from '../browser/browserEnvironment.js';
import { SCRATCH_DIR } from '../run/artifacts.js';

/**
 * Environment variables the `bash` child must never inherit — THE one place a
 * new harness credential has to be added.
 *
 * Every name here was found by enumerating what this codebase actually reads
 * from `process.env`, not by guessing at a general list of scary-looking
 * names. Prefix entries end with `_` and strip a whole family.
 *
 * Be clear about what this does and does not buy. It is reproducibility and
 * blast-radius hygiene: a generated script cannot casually read the model key
 * out of its own environment and spend it, or exfiltrate tracing credentials
 * because it happened to run `env`. It is NOT a security boundary. Commands
 * run as the same operating-system user as this process, so anything that user
 * can read — including the credentials file this list deliberately hides the
 * PATH to — is still reachable by a command that goes looking. Treat the
 * denylist as removing an easy accident, never as containing a determined one.
 */
export const BASH_SECRET_ENV_DENYLIST: readonly string[] = [
  // Model provider credentials.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  // Tracing credentials (LANGFUSE_PUBLIC_KEY / _SECRET_KEY / _BASE_URL).
  'LANGFUSE_',
  // A token present in developer shells that no generated script needs.
  'GITHUB_TOKEN',
  // A full remote-browser session-control credential. A generated script never
  // needs it: the browser is reached through the controller, not from the
  // workspace.
  'BROWSERBASE_API_KEY',
  // The optional attached-local endpoint is equally a browser-control
  // capability. Only provider composition may consume it.
  ATTACHED_CHROME_ENDPOINT_ENV_VAR,
];

/** The shell `bash` invokes. Fixed rather than configurable until a concrete
 * environment needs otherwise. */
const BASH_SHELL_PATH = '/bin/bash';

/**
 * Fail before the first model call if local execution cannot work.
 *
 * Both checks are cheap and both are things the worker would otherwise
 * discover mid-run, having already spent tokens planning around a tool that
 * was never going to run. `scratch/workspace` is created owner-only; an
 * existing directory is validated rather than silently re-permissioned, since
 * quietly widening a mode nobody asked us to change is worse than reporting it.
 */
export function prepareLocalExecution(runDir: string): void {
  try {
    accessSync(BASH_SHELL_PATH, fsConstants.X_OK);
  } catch {
    throw new Error(
      `local code execution requires an executable ${BASH_SHELL_PATH}, which this ` +
        'host does not provide',
    );
  }
  const workspace = join(runDir, SCRATCH_DIR, 'workspace');
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
}
