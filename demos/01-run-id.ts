// Demo for T1: print a few freshly generated run ids.
// Run with: npx tsx demos/01-run-id.ts

import { generateRunId } from '../src/run/runId.js';

const COUNT = 5;

for (let i = 0; i < COUNT; i++) {
  console.log(generateRunId());
}
