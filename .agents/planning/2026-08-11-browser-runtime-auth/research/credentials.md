# Credential storage/brokering options for the browser-runtime agent

Research date: 2026-08-12. Context: TypeScript/Node agent driving a browser, runs locally on macOS today, may move to a hosted (Linux, headless) deployment later.

**Hard constraint:** the LLM must never process raw credentials through its context window — not in prompts, not in tool results. The design is `fillCredentials(siteId)`: the model requests a fill by name, and a mechanism outside the model fetches the secret from a vault and types it into the browser fields. This document evaluates which vault/broker backs that mechanism. Everything below assumes the secret's only journey is `vault → broker memory → page.fill()` — the tool result returns only `{ filled: true }`.

Prior art for exactly this pattern: Stagehand's `act()` supports `variables` — you template `%password%` in the instruction and pass the real value in a separate object that is "not shared with LLM providers" ([Stagehand act() docs](https://docs.stagehand.dev/v3/references/act)). The 1Password × Browserbase "Secure Agentic Autofill" launch (Oct 2025) productized the same idea (see §6).

---

## 1. macOS Keychain via the `security` CLI

The login keychain is the OS-native secret store; `security(1)` is its CLI ([ss64 reference](https://ss64.com/mac/security.html)).

### Usage sketch

```bash
# One-time store (interactive; -U updates if it exists)
security add-generic-password -U \
  -s "evidence-agent" -a "portal.example.com" \
  -w 'the-password'          # NB: -w on argv is visible in `ps` / shell history

# Fetch at fill time: -w prints only the password to stdout
security find-generic-password -w -s "evidence-agent" -a "portal.example.com"
```

```ts
// Node — child process, secret captured directly into broker memory
import { execFile } from "node:child_process";
import { promisify } from "node:util";

async function fetchSecret(account: string): Promise<string> {
  const { stdout } = await promisify(execFile)("/usr/bin/security", [
    "find-generic-password", "-w", "-s", "evidence-agent", "-a", account,
  ]);
  return stdout.trimEnd(); // hand straight to page.fill(); never log, never return to the model
}
```

Alternatively use a native binding instead of shelling out: [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) (Rust `keyring-rs` wrapper, the maintained successor to the deprecated `keytar`; also works on Linux/Windows via each OS's store — [migration discussions in MSAL](https://github.com/AzureAD/microsoft-authentication-library-for-js/issues/7170) and [Azure SDK](https://github.com/Azure/azure-sdk-for-js/issues/29288)).

### Prompting behavior and ACLs

- Each keychain item carries an ACL of trusted apps. On first read by an untrusted binary, macOS shows an **Allow / Always Allow** GUI dialog. "Always Allow" adds the caller to the item's ACL (silent thereafter); "Allow" re-prompts every time ([Scripting OS X](https://scriptingosx.com/2021/04/get-password-from-keychain-in-shell-scripts/)).
- `add-generic-password -T /usr/bin/security` pre-trusts the `security` binary — but then *any* script that shells out to `security` can read the item silently. Trusting your specific node binary path is tighter but breaks on Node upgrades ([Scripting OS X](https://scriptingosx.com/2021/04/get-password-from-keychain-in-shell-scripts/), [tamakiii gist](https://gist.github.com/tamakiii/9c3eadc493597ed819b9ff96cbcf61d4)).
- **Non-interactive contexts (SSH, launchd without a GUI session, CI):** item ACLs require user interaction to satisfy, so reads fail with `errSecInteractionNotAllowed` even if the keychain is unlocked — `security unlock-keychain` does not fix it because the restriction is per-item ACL, not the keychain lock ([Apple dev forums: headless unlock](https://developer.apple.com/forums/thread/690665), [SSH keychain access](https://developer.apple.com/forums/thread/717135), [KodeLab write-up](https://thekodelab.com/en/posts/macos-ssh-keychain-unlock/)). Workarounds (auto-login, "Always Allow" everything) each weaken the security story.

### Assessment

- Unattended fetch: only after "Always Allow"/`-T` pre-trust, and only inside a GUI login session. Attended fetch: excellent (native dialog, optionally Touch ID-gated).
- Out of env/argv/logs: reads are clean (stdout of a child process); *writes* via `-w <value>` leak into argv — do the initial store by hand or via stdin prompt.
- Portability: none — macOS only. (`@napi-rs/keyring` abstracts to libsecret/Windows stores, but a headless Linux box usually has no unlocked desktop keyring either.)
- Friction: zero install, already there. Cost: free.

---

## 2. 1Password CLI (`op`)

### Usage sketch

```bash
# Secret reference syntax: op://<vault>/<item>/[section/]<field>
op read "op://EvidenceAgent/portal.example.com/password"

# TOTP too (useful for 2FA fills):
op read "op://EvidenceAgent/portal.example.com/one-time password?attribute=otp"
```

```ts
// Node — same child-process capture as above
const { stdout } = await promisify(execFile)("op", [
  "read", `op://EvidenceAgent/${siteId}/password`,
]);
// There is also an official JS SDK (github.com/1Password/onepassword-sdk-js)
// that authenticates with a service account token — no `op` binary needed.
```

Secret references resolve at runtime; templates containing only `op://` URIs are safe to commit. `op run` injects resolved values as env vars into a subprocess and conceals them in that subprocess's output (`<concealed by 1Password>`); `op inject` renders template files ([secret references docs](https://www.1password.dev/cli/secret-references/)). For this project, prefer `op read` captured into broker memory over `op run` — the constraint is to keep secrets *out* of process env.

### Two auth modes, matching the two deployment phases

1. **Desktop-app integration (human present, macOS today).** Settings → Developer → "Integrate with 1Password CLI"; `op` then authenticates through the desktop app, gated by Touch ID / Apple Watch. Each CLI access can require a biometric approval — a strong human-in-the-loop property ([app integration docs](https://www.1password.dev/cli/app-integration), [Touch ID support](https://support.1password.com/touch-id-mac/)). `OP_BIOMETRIC_UNLOCK_ENABLED` toggles the behavior.
2. **Service accounts (headless, hosted later).** Token-based, "isn't associated with an individual", designed for CI/servers: set `OP_SERVICE_ACCOUNT_TOKEN` and every `op` command works with no human ([service accounts docs](https://www.1password.dev/service-accounts/), [setup walkthrough](https://zatoima.github.io/en/1password-cli-service-account-setup/)). Scope each service account to specific vaults (least privilege); up to 100 per account. Bootstrap problem: the token itself is a secret that must live somewhere (env var / platform secret store on the host).

### Rate limits and cost

Service-account rate limits by plan ([rate limits page](https://www.1password.dev/service-accounts/rate-limits)):

| Plan | Hourly (per token) | Daily (whole account) |
|---|---|---|
| Individual / Family | 1,000 reads, 100 writes | 1,000 |
| Teams | 1,000 reads, 100 writes | 5,000 |
| Business | 10,000 reads, 1,000 writes | 50,000 |

Even the Individual daily cap (1,000) is far beyond a dev agent's fill volume; cache-per-run makes it a non-issue. Pricing as of 2026: Individual $4.99/mo, Family $7.99/mo (raised ~March 2026, [alternativeto news](https://alternativeto.net/news/2026/2/1password-to-raise-subscription-prices-for-individual-and-family-plans-by-up-to-33-)); Teams Starter ~$19.95/mo, Business per-seat ([cybernews pricing overview](https://cybernews.com/best-password-managers/1password-review/1password-pricing/), [costbench](https://costbench.com/software/password-management/1password/)). Service accounts and CLI are included in the plans, no separate developer fee at these tiers.

### Assessment

- Unattended fetch: yes (service account). Attended fetch: yes, best-in-class (biometric per access).
- Out of env/argv/logs: `op read` to stdout is clean; the reference string (`op://…`) is safe to log and is exactly the kind of opaque handle `fillCredentials(siteId)` wants to map to.
- Portability: excellent — same `op read` call works on macOS with biometrics and on headless Linux with a token; only the auth mode changes.
- Friction: install `op` + desktop app toggle, ~10 minutes if you already use 1Password. Cost: subscription (see above).

---

## 3. Encrypted local file (`age` / `sops`)

### Usage sketch (age directly)

```bash
age-keygen -o ~/.config/agent/age.key          # prints the public "age1..." recipient
age -e -r age1xyz... -o creds.json.age creds.json && rm creds.json
age -d -i ~/.config/agent/age.key creds.json.age   # decrypt to stdout
# Passphrase mode instead of a key file (scrypt-derived key, prompts a human):
age -e -p -o creds.json.age creds.json
```

### Usage sketch (sops + age)

```bash
# .sops.yaml: creation_rules: [{path_regex: creds\.json$, age: "age1xyz..."}]
sops -e -i creds.json      # encrypts values, keys stay plaintext (diffable)
sops -d creds.json         # decrypt to stdout (SOPS_AGE_KEY_FILE points at the identity)
sops exec-file creds.json 'cat {}'   # decrypted content never persisted to disk
```

```ts
const { stdout } = await promisify(execFile)("sops", ["-d", CREDS_PATH], {
  env: { ...process.env, SOPS_AGE_KEY_FILE: AGE_KEY_PATH },
});
const creds = JSON.parse(stdout); // broker holds the map in memory for the run
```

sops encrypts only values (keys/structure stay readable for review), uses a DEK/KEK model, and supports multiple recipients — e.g. your laptop key *and* a future server key can both decrypt the same file ([sops repo](https://github.com/getsops/sops), [getsops.io](https://getsops.io/), [SOPS+age walkthrough](https://devops.datenkollektiv.de/using-sops-with-age-and-git-like-a-pro.html), [comparison post](https://www.jonashietala.se/blog/2026/05/31/sops_age_and_sealed_secrets/)).

### The master-key question — this option's whole tradeoff

The ciphertext is only as protected as wherever the age identity lives:

1. **Plaintext key file on disk** (`chmod 600`): fully unattended, but security reduces to file permissions — an attacker who can read the key file can also read the encrypted file. You've mostly gained "safe to commit/back up the ciphertext" and at-rest encryption, not much local-attacker resistance over option 4.
2. **Passphrase-derived key** (`age -p`): no key material on disk, but a human must type the passphrase — fine for "unlock once at agent startup, hold decrypted map in broker memory", incompatible with unattended restarts.
3. **Hybrid:** store the age key (or passphrase) in the macOS Keychain / 1Password — inherits that option's prompting model; the encrypted file becomes portable ciphertext.
4. **Hosted later:** sops natively supports cloud KMS (AWS/GCP/Azure) as the KEK, which is the clean migration path — same file, swap the key service ([sops repo](https://github.com/getsops/sops)).

### Assessment

- Unattended: yes with a disk key (weak) or KMS (hosted). Attended: yes with passphrase.
- Out of env/argv/logs: decrypt-to-stdout is clean; never write the decrypted file to disk (`exec-file`/pipe only).
- Portability: excellent — age/sops are single static binaries on Linux; KMS option for cloud.
- Friction: low-moderate (two small tools, a `.sops.yaml`, key management discipline). Cost: free.

---

## 4. Plain env/dotenv file outside the repo (baseline)

### Usage sketch

```ts
// ~/.config/evidence-agent/credentials.json  (chmod 600, outside any repo)
// { "portal.example.com": { "username": "...", "password": "..." } }
import { readFile } from "node:fs/promises";
const creds = JSON.parse(
  await readFile(`${process.env.HOME}/.config/evidence-agent/credentials.json`, "utf8"),
);
```

Deliberately **not** `dotenv` into `process.env`: env vars leak into every child process, crash reports, and diagnostic dumps, and `.env` files are exactly what AI coding tools (Claude Code, Cursor, Copilot) read automatically ([Keyway on dotenv alternatives](https://keyway.sh/articles/dotenv-alternatives), [dotenv security docs](https://www.dotenv.org/docs/security)). A JSON file with a non-obvious name, read directly by the broker module, avoids both failure modes while staying just as simple.

### Why it's weak, why it might be fine for now

- Plaintext at rest: any process running as your user can read it; one stray backup, sync folder, or commit away from exposure ([Keyway](https://keyway.sh/articles/dotenv-alternatives)).
- No prompting, no audit, no revocation story.
- But: for a single-dev, dev-phase tool on FileVault-encrypted disk, with the file outside the repo and out of `process.env`, the marginal risk over option 3-with-disk-key is small — the broker boundary (option 5) matters more than the storage format at this stage.
- Middle step if wanted: [dotenvx](https://dotenvx.com/) encrypts `.env` values (public-key crypto, decrypts just-in-time from a `.env.keys` private key) — same master-key tradeoffs as §3, less tooling generality. There's even a pattern combining dotenvx with the OS keychain for the private key ([dev.to write-up](https://dev.to/ustun/a-small-hardening-trick-for-envlocal-dotenvx-os-keychain-2533)).

### Assessment

- Unattended and attended: yes (no prompting at all — that's the weakness).
- Out of env/argv/logs: yes, *if* read as a file into module scope; no, if loaded via classic dotenv.
- Portability: trivial. Friction: none. Cost: free.

---

## 5. Custom broker process / module boundary

This is an **architecture pattern, not a storage backend** — it wraps any of §1–4 and is what actually enforces the hard constraint. Auth0's framing is apt: "want agents that don't spill secrets? don't give them secrets" ([Auth0 blog](https://auth0.com/blog/want-ai-agents-that-don-t-spill-secrets-don-t-give-them-secrets/)).

### Usage sketch (in-process module boundary)

```ts
// broker.ts — the ONLY module that ever touches secret values
import type { Page } from "playwright";

const backend = makeBackend(); // keychain | op | sops | file (§1–4)

export async function fillCredentials(page: Page, siteId: string) {
  const { username, password } = await backend.get(siteId); // stays in this scope
  await page.locator('input[type="email"], input[name*=user]').first().fill(username);
  await page.locator('input[type="password"]').first().fill(password);
  return { filled: true }; // <-- the ONLY thing that crosses back to the tool result
}
```

The tool handler the model sees takes `siteId`, calls the broker, and returns the boolean. The secret exists as a string in broker scope for milliseconds and is never serialized toward the model.

### In-process module vs. separate daemon

- **Module boundary (start here):** zero infra; the guarantee is enforced by code review of one file plus a redaction check on tool results. Sufficient while the agent and browser run in one trusted process.
- **Separate daemon (unix socket / localhost):** the broker holds secrets in a different OS process, so a compromised or over-curious agent process (or a rogue MCP tool sharing it) can't read them from memory; the daemon can also centralize per-fill human approval and audit logging. This is essentially a self-hosted version of what 1Password's agentic autofill does. Worth it only when untrusted code shares the agent process or at hosted deployment time.

### Leak channels the broker must also close (backend-independent)

- **Tool results / logs:** return booleans only; add a log-redaction pass for any value fetched from the backend.
- **Post-fill DOM snapshots:** after `fill()`, the value sits in the input's `value` property. If the agent takes an accessibility/DOM snapshot or extract before submitting, the username (and in non-`type=password` fields, the password) can flow into context. Mitigate by having `fillCredentials` fill *and submit* atomically, or by stripping input values from snapshots.
- **Screenshots:** password fields render masked, but username/email fields don't; TOTP fields don't.
- **Node memory hygiene:** JS strings are immutable and GC-managed — you can't zeroize them. Minimize lifetime and scope; the separate-daemon variant is the real answer if this matters.

### Assessment

Inherits fetch/portability/cost properties from whichever backend it wraps; the pattern itself costs a day of work in-process, more as a daemon. It is the non-negotiable piece regardless of the vault choice.

---

## 6. Cloud browser platforms (Browserbase et al.)

Relevant because a hosted deployment may run the browser on one of these anyway, and their credential features could replace §1–5 entirely for the hosted phase.

- **Browserbase × 1Password "Secure Agentic Autofill"** (launched Oct 8 2025, early access): the 1Password browser extension inside the Browserbase session fills credentials + TOTP on behalf of the agent; every fill requires real-time human approval via 1Password mobile/desktop by default; credentials "are not shared with the LLM or exposed in Browserbase logs"; transport is an encrypted Noise-framework channel between device and extension ([1Password press release](https://1password.com/press/2025/oct/browserbase-ai-security-partnership), [1Password blog](https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents), [Browserbase blog](https://www.browserbase.com/blog/1password-agentic-autofill), [marketplace listing](https://marketplace.1password.com/integration/browserbase), [SiliconANGLE](https://siliconangle.com/2025/10/08/1password-tackles-ai-credential-risks-new-agentic-autofill-integration-browserbase/)). As of the announcements it's surfaced through Browserbase/Director; the always-approve default means it's human-in-the-loop, not unattended.
- **Browserbase Contexts:** persist the user-data-directory (cookies incl. session cookies, auth tokens) across sessions — log in once (possibly with a human), then reuse the authenticated state instead of re-filling credentials every run ([contexts docs](https://docs.browserbase.com/features/contexts), [changelog](https://www.browserbase.com/changelog/new-and-improved-contexts-api)). Orthogonal and complementary: fewer fills means fewer chances to leak. Locally, Playwright `storageState` gives the same effect for free.
- **Stagehand `act()` variables:** if the stack already uses Stagehand, `act("type %password% ...", { variables: { password } })` keeps values out of the LLM but still requires *your code* to hold the plaintext — i.e., it's a fill mechanism, not a vault; it composes with §1–5 ([act() docs](https://docs.stagehand.dev/v3/references/act)).
- **Steel.dev Credentials API** (beta, free during beta): org-level encrypted credential store (envelope encryption, AES-256-GCM + org KMS keys); sessions started with a `credentials` field auto-detect login forms and inject within ~2s; fields blurred by default so vision models can't read them; hidden from agents/LLMs ([Steel docs](https://docs.steel.dev/overview/credentials-api/overview)). Closest thing to a fully unattended managed version of this design, but ties you to Steel's browser infra.

---

## Comparison

| Criterion | 1. macOS Keychain | 2. 1Password CLI | 3. age/sops file | 4. Plain file/dotenv | 5. Broker pattern | 6. Browserbase+1P / Steel |
|---|---|---|---|---|---|---|
| Unattended fetch (no human) | Partial — needs pre-trust *and* GUI login session; fails over SSH/headless | Yes (service account token) | Yes (disk key or KMS); no (passphrase mode) | Yes | Inherits backend | Steel: yes. 1P autofill: no (human approval per fill by default) |
| Attended fetch (human present) | Yes — native Allow dialog / Touch ID | Yes — biometric per access via desktop app | Yes — passphrase unlock | Yes (no gate at all) | Inherits backend; can add own approval step | Yes — 1P approval on phone/desktop |
| Secrets out of env/argv/logs by default | Read: yes. Write via `-w` argv: no | Yes (`op read` stdout; references safe to log) | Yes (decrypt to stdout/pipe) | Yes if file-read into module; no if dotenv→env | Its whole purpose; also closes DOM/screenshot channels | Yes — designed for it |
| Hosted Linux/headless portability | None | Excellent (same commands, token auth) | Excellent (static binaries; KMS for KEK) | Trivial | Portable by construction | Native — but platform lock-in |
| macOS setup friction today | None (built in) | Low (~10 min if already a 1P user) | Low-moderate (2 tools + key discipline) | None | ~1 day in-process; more as daemon | Account + early-access/beta onboarding |
| Cost | Free | Individual $4.99/mo → Business per-seat; SA included; rate limits by tier | Free | Free | Dev time | Browserbase session pricing; Steel creds free in beta; 1P sub |

---

## Observations (no recommendation)

- **The broker (§5) is orthogonal and mandatory.** Every backend funnels through the same `fillCredentials(siteId)` module; the vault choice changes `backend.get()`, nothing else. That also means the choice is cheaply reversible — worth designing the backend as a ~three-method interface from day one.
- **The two deployment phases pull in opposite directions.** Keychain is the lowest-friction *attended* option today and a hard dead-end for hosted headless (per-item ACLs demand a GUI session). 1Password is the only researched option that spans both phases with the same call site: biometric-gated locally, service-account token hosted.
- **age/sops mostly relocates the problem.** With the key on the same disk it's marginally stronger than option 4; its genuine wins are safe-to-commit ciphertext, multi-recipient (laptop + server), and a native KMS path for hosting.
- **Option 4 is defensible for the dev phase** precisely because the broker does the heavy lifting — but only in the "JSON file read into module scope" form, never via dotenv into `process.env`, and never inside the repo.
- **Post-fill leak channels matter as much as the vault.** DOM snapshots and screenshots after `fill()` can re-expose what the vault protected; fill-and-submit atomicity belongs in the broker regardless of backend.
- **Session persistence reduces the problem's surface.** Playwright `storageState` locally / Browserbase Contexts hosted mean credentials get filled rarely (login expiry) rather than every run — worth pairing with any vault.
- **The market validated this exact design in late 2025.** 1Password×Browserbase and Steel's Credentials API are productized versions of `fillCredentials()`; if the hosted phase lands on Browserbase, the 1Password integration (human-approval-per-fill) or Steel (unattended) could replace the self-built hosted path, at the price of platform coupling.

## Sources

- macOS Keychain: [ss64 security(1)](https://ss64.com/mac/security.html) · [Scripting OS X](https://scriptingosx.com/2021/04/get-password-from-keychain-in-shell-scripts/) · [tamakiii gist](https://gist.github.com/tamakiii/9c3eadc493597ed819b9ff96cbcf61d4) · [Apple forums: headless unlock](https://developer.apple.com/forums/thread/690665) · [Apple forums: SSH access](https://developer.apple.com/forums/thread/717135) · [KodeLab SSH keychain fix](https://thekodelab.com/en/posts/macos-ssh-keychain-unlock/) · [@napi-rs/keyring](https://github.com/Brooooooklyn/keyring-node)
- 1Password: [secret references](https://www.1password.dev/cli/secret-references/) · [service accounts](https://www.1password.dev/service-accounts/) · [rate limits](https://www.1password.dev/service-accounts/rate-limits) · [app integration](https://www.1password.dev/cli/app-integration) · [Touch ID](https://support.1password.com/touch-id-mac/) · [SA setup walkthrough](https://zatoima.github.io/en/1password-cli-service-account-setup/) · [2026 price increase](https://alternativeto.net/news/2026/2/1password-to-raise-subscription-prices-for-individual-and-family-plans-by-up-to-33-) · [cybernews pricing](https://cybernews.com/best-password-managers/1password-review/1password-pricing/) · [costbench](https://costbench.com/software/password-management/1password/)
- age/sops: [getsops/sops](https://github.com/getsops/sops) · [getsops.io](https://getsops.io/) · [SOPS+age guide](https://devops.datenkollektiv.de/using-sops-with-age-and-git-like-a-pro.html) · [Hietala: SOPS+age vs Sealed Secrets (2026)](https://www.jonashietala.se/blog/2026/05/31/sops_age_and_sealed_secrets/)
- dotenv/dotenvx: [Keyway dotenv alternatives](https://keyway.sh/articles/dotenv-alternatives) · [dotenv security](https://www.dotenv.org/docs/security) · [dotenvx](https://dotenvx.com/) · [dotenvx + keychain trick](https://dev.to/ustun/a-small-hardening-trick-for-envlocal-dotenvx-os-keychain-2533)
- Broker pattern & agents: [Auth0: don't give agents secrets](https://auth0.com/blog/want-ai-agents-that-don-t-spill-secrets-don-t-give-them-secrets/) · [Stagehand act() variables](https://docs.stagehand.dev/v3/references/act)
- Cloud platforms: [1Password×Browserbase press](https://1password.com/press/2025/oct/browserbase-ai-security-partnership) · [1Password blog](https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents) · [Browserbase blog](https://www.browserbase.com/blog/1password-agentic-autofill) · [1P marketplace listing](https://marketplace.1password.com/integration/browserbase) · [SiliconANGLE](https://siliconangle.com/2025/10/08/1password-tackles-ai-credential-risks-new-agentic-autofill-integration-browserbase/) · [Browserbase Contexts](https://docs.browserbase.com/features/contexts) · [Contexts changelog](https://www.browserbase.com/changelog/new-and-improved-contexts-api) · [Steel Credentials API](https://docs.steel.dev/overview/credentials-api/overview)
