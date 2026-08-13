import { readFile, stat } from 'node:fs/promises';

/** One site's login credential. Only the fill executor may consume this. */
export interface Credential {
  username: string;
  password: string;
}

/**
 * Read-only access to stored credentials, keyed by hostname.
 * Implementations must never log, cache into env, or otherwise emit
 * secret material.
 */
export interface CredentialStore {
  /** Hostnames with stored credentials. Safe to surface to the model. */
  listHosts(): Promise<string[]>;
  /** The secret material for a hostname, or null when absent. */
  lookup(hostname: string): Promise<Credential | null>;
}

/**
 * `CredentialStore` over a gitignored JSON file (keys are hostnames, values
 * `{username, password, notes?}`; `notes` is ignored).
 *
 * The file is re-read on every call, into locals only — never `process.env`,
 * never module state — so secrets don't leak to child processes and edits
 * take effect mid-session. A missing file is an empty store (environments
 * without credentials degrade to human handoff); a malformed one throws a
 * model-readable error naming the path but never file contents.
 */
export class FileCredentialStore implements CredentialStore {
  readonly #filePath: string;
  #warnedPermissions = false;

  /** @param filePath - absolute path to the credentials JSON file */
  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async listHosts(): Promise<string[]> {
    return Object.keys(await this.#read());
  }

  async lookup(hostname: string): Promise<Credential | null> {
    const entries = await this.#read();
    const host = hostname.toLowerCase();

    const exact = entries[host];
    if (exact !== undefined) return exact;

    // Suffix matching on label boundaries: `mobile.x.com` matches an
    // `x.com` entry (but `notx.com` does not). Longest matching key wins.
    let best: { key: string; credential: Credential } | undefined;
    for (const [key, credential] of Object.entries(entries)) {
      if (!host.endsWith(`.${key}`)) continue;
      if (best === undefined || key.length > best.key.length) {
        best = { key, credential };
      }
    }
    return best?.credential ?? null;
  }

  async #read(): Promise<Record<string, Credential>> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, 'utf8');
    } catch (thrown) {
      if ((thrown as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw thrown;
    }

    await this.#warnOnLoosePermissions();

    // JSON.parse's own SyntaxError can quote file contents; replace it with
    // a path-only message so no error channel ever carries secret material.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Credentials file at ${this.#filePath} is not valid JSON. Fix or remove it.`,
      );
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `Credentials file at ${this.#filePath} must be a JSON object keyed by hostname.`,
      );
    }

    const entries: Record<string, Credential> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const entry = value as Record<string, unknown>;
      if (
        value === null ||
        typeof value !== 'object' ||
        typeof entry.username !== 'string' ||
        typeof entry.password !== 'string'
      ) {
        throw new Error(
          `Credentials file at ${this.#filePath} has an invalid entry for ` +
            `host "${key}": expected an object with string "username" and "password".`,
        );
      }
      entries[key.toLowerCase()] = {
        username: entry.username,
        password: entry.password,
      };
    }
    return entries;
  }

  /** Warn once, to stderr only (never the run transcript), when the file is
   * group- or world-readable. File permissions remain the user's job. */
  async #warnOnLoosePermissions(): Promise<void> {
    if (this.#warnedPermissions) return;
    this.#warnedPermissions = true;
    try {
      const fileStat = await stat(this.#filePath);
      if ((fileStat.mode & 0o077) !== 0) {
        console.error(
          `Warning: credentials file ${this.#filePath} is readable by other ` +
            `users. Run: chmod 600 ${this.#filePath}`,
        );
      }
    } catch {
      // Permission advice is best-effort; never block a lookup on it.
    }
  }
}
