# Most Recent Pull Request on openclaw/openclaw

**PR #122882: "fix(gateway): preserve explicit zero-byte artifact downloads"**

- **URL:** https://github.com/openclaw/openclaw/pull/122882
- **Author:** SunnyShu0925 (Contributor)
- **Opened:** Aug 13, 2026
- **Status at time of review:** Open, 1 commit, +50/−12 lines across 3 files
- **Labels:** `gateway`, `size: S`
- **Linked issue:** Fixes #122802 ("Artifacts: valid zero-byte files are reported as unsupported")

## What it does

This PR fixes a bug in the Gateway's artifact-handling code where a file with
intentionally empty (zero-byte) content — e.g. an empty base64 string or an
empty `data:` URL — was incorrectly treated as "unsupported" and could not be
downloaded, even though it's a legitimate, valid artifact.

**Root cause:** An earlier fix (commit `bb7150de94c`, "reject malformed
artifact base64") added truthiness checks to reject malformed base64 input,
but this also unintentionally rejected explicitly *empty* (but validly
present) content, since an empty string is falsy in JavaScript/TypeScript.

**The fix:** Replace truthiness checks with presence checks (only `undefined`
is treated as "missing data") in the Gateway's artifact projection logic.
Specifically:
- `src/gateway/server-methods/artifacts-base64.ts`: `readArtifactBase64Payload`
  no longer rejects an empty payload, so it correctly returns
  `{ data: "", sizeBytes: 0 }`.
- `src/gateway/server-methods/artifacts.ts`: byte fields (`data`/`content`/
  `source.data`) are now read using presence semantics (`!== undefined`)
  rather than truthiness, and `isArtifactBlock` now recognizes explicit empty
  string data as valid.
- `src/gateway/server-methods/artifacts.test.ts`: adds test coverage for
  direct empty data, empty base64 data URLs, empty content, and empty source
  data.

**Impact:** Agents/tools that produce an intentionally empty file or
transcript artifact (e.g., an empty export or 0-byte placeholder) can now
list, inspect, and download it via `artifacts.list`/`artifacts.get`/
`artifacts.download` with `mode: "bytes"`, `sizeBytes: 0`, and `data: ""`.
Previously, download always failed with `artifact_download_unsupported`.
Absent or genuinely malformed base64 input is still correctly rejected as
unsupported — only the previously-mishandled "explicitly empty" case is
fixed. No configuration changes are required, and URL-mode artifacts, MIME
handling, protocol schema, SDK, and UI are untouched.

## Evidence
- Full-page screenshot of the PR saved as `pr-122882-screenshot.png` in this
  artifacts folder.
