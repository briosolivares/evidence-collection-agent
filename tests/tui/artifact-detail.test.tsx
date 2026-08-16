// The provenance detail card's rendering contract: every field of the
// manifest entry (full sha256, never truncated), local capture time,
// graceful absent-field handling, and zero overflow on narrow terminals
// (each row is one nested <Text> paragraph, so long values wrap instead
// of spilling).

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { ArtifactDetail } from '../../src/tui/components/ArtifactDetail.js';
import type { PublishedArtifact } from '../../src/tui/store/state.js';
import { renderAt, tick } from './helpers.js';

const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const CAPTURED_AT = '2026-08-12T10:00:00.000Z';

const DETAIL_HINT = 'space preview · o open · r reveal · esc back';

function artifact(
  overrides: {
    entry?: Partial<PublishedArtifact['entry']>;
    sizeBytes?: number | undefined;
  } = {},
): PublishedArtifact {
  return {
    entry: {
      filename: 'artifacts/filings-page.png',
      sha256: SHA,
      sourceUrl: 'https://sec.gov/cgi-bin/browse-edgar?action=getcompany',
      roles: ['requested_output', 'evidence'],
      capturedAt: CAPTURED_AT,
      ...overrides.entry,
    },
    // `sizeBytes: undefined` must survive as undefined (a failed stat),
    // so the default applies only when the key is absent entirely.
    sizeBytes: 'sizeBytes' in overrides ? overrides.sizeBytes : 2_048,
  };
}

describe('ArtifactDetail', () => {
  it('renders the full provenance: filename, roles, source, local time, sha256, size, hints', async () => {
    const { lastFrame, unmount } = render(<ArtifactDetail artifact={artifact()} />);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('◆ artifacts/filings-page.png');
    // Both roles show — an artifact may hold requested_output and evidence.
    expect(frame).toContain('requested output · evidence');
    expect(frame).toContain('source: https://sec.gov/cgi-bin/browse-edgar?action=getcompany');
    // capturedAt is ISO UTC in the manifest; the card shows local time.
    expect(frame).toContain(`captured: ${new Date(CAPTURED_AT).toLocaleString()}`);
    // The full 64-hex sha256, untruncated (it fits on one 100-column line).
    expect(frame).toContain(`sha256: ${SHA}`);
    expect(frame).toContain('2.0 KB on disk');
    expect(frame).toContain(DETAIL_HINT);
    unmount();
  });

  it('omits the source line when a published entry has no sourceUrl', async () => {
    const { lastFrame, unmount } = render(
      <ArtifactDetail
        artifact={artifact({
          entry: {
            filename: 'artifacts/top5.csv',
            roles: ['requested_output'],
            sourceUrl: undefined,
          },
        })}
      />,
    );
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('◆ artifacts/top5.csv');
    expect(frame).toContain('requested output');
    expect(frame).not.toContain('evidence');
    expect(frame).not.toContain('source:');
    unmount();
  });

  it('shows ? for an unknown size (the publish-time stat failed)', async () => {
    const { lastFrame, unmount } = render(
      <ArtifactDetail artifact={artifact({ sizeBytes: undefined })} />,
    );
    await tick();
    expect(lastFrame()).toContain('? on disk');
    unmount();
  });

  it('renders with zero overflow at 44 columns, sha256 wrapped whole', async () => {
    const { lastFrame, unmount } = renderAt(44, <ArtifactDetail artifact={artifact()} />);
    await tick();
    const frame = lastFrame();
    for (const line of frame.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(44);
    }
    // The hash hard-wraps across lines but survives in full — rejoin the
    // frame to confirm no character was truncated.
    const rejoined = frame
      .split('\n')
      .map((line) => line.trim())
      .join('');
    expect(rejoined).toContain(SHA);
    unmount();
  });
});
