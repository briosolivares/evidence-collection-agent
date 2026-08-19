import { ATTACHED_CHROME_ENDPOINT_ENV_VAR } from '../../browser/browserEnvironment.js';

/**
 * Environment variables the worker's local code-execution children must not
 * inherit. Prefix entries end in `_` and deny the whole family.
 *
 * This is reproducibility and blast-radius hygiene, not isolation: commands
 * still run with the application's OS-user authority and can read anything
 * that user can read if they deliberately look for it.
 */
export const BASH_SECRET_ENV_DENYLIST: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'LANGFUSE_',
  'GITHUB_TOKEN',
  'BROWSERBASE_API_KEY',
  ATTACHED_CHROME_ENDPOINT_ENV_VAR,
];
