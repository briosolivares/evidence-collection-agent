import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runForegroundCommand } from '../../src/tools/bash/runForegroundCommand.js';
import { runBrowserProgram } from '../../src/v3/browser/runner.js';

type Scenario = 'bash' | 'browser';

const [scenarioValue, workDir] = process.argv.slice(2);
if ((scenarioValue !== 'bash' && scenarioValue !== 'browser') || workDir === undefined) {
  throw new Error('process crash fixture requires a bash|browser scenario and work directory');
}
const scenario: Scenario = scenarioValue;

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  writeFileSync(join(workDir, 'fixture-error.txt'), message, 'utf8');
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (scenario === 'bash') {
    await runForegroundCommand({
      shellPath: '/bin/bash',
      command: [
        "trap '' TERM",
        '(sleep 0.3; printf survived > "$MARKER_PATH") &',
        'printf "%s" "$!" > "$DESCENDANT_PID_PATH"',
        'printf "%s" "$$" > "$TARGET_PID_PATH"',
        'while :; do :; done',
      ].join('\n'),
      cwd: workDir,
      env: {
        PATH: process.env.PATH,
        MARKER_PATH: join(workDir, 'delayed-marker.txt'),
        TARGET_PID_PATH: join(workDir, 'target.pid'),
        DESCENDANT_PID_PATH: join(workDir, 'descendant.pid'),
      },
      timeoutMs: 120_000,
      maxOutputBytes: 1_000_000,
    });
    return;
  }

  const markerPath = join(workDir, 'delayed-marker.txt');
  const targetPidPath = join(workDir, 'target.pid');
  const descendantPidPath = join(workDir, 'descendant.pid');
  const descendantCode = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(markerPath)}, 'survived'), 300);`,
    'setInterval(() => undefined, 60000);',
  ].join('\n');

  await runBrowserProgram({
    code: `
      const fs = await import('node:fs');
      const childProcess = await import('node:child_process');
      process.on('SIGTERM', () => {});
      fs.writeFileSync(${JSON.stringify(targetPidPath)}, String(process.pid));
      const descendant = childProcess.spawn(
        process.execPath,
        ['-e', ${JSON.stringify(descendantCode)}],
        { stdio: 'ignore' }
      );
      fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
      while (true) {}
    `,
    cwd: workDir,
    env: {},
    page: { pageId: 'crash-fixture-page', targetId: 'crash-fixture-target' },
    timeoutMs: 120_000,
    maxOutputBytes: 1_000_000,
    sendCdp: async () => ({}),
  });
}
