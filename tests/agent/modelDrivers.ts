// Shared scripted model drivers and checkpoint reader for the lifecycle suites.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';

import { HARNESS_DIR, RUN_CHECKPOINT_FILENAME } from '../../src/agent/checkpoint.js';
import { checkpointSchema, type Checkpoint } from '../../src/agent/checkpoint.schema.js';
import type { Message } from '../../src/model/messages.js';
import type {
  AcceptedModelResponse,
  ModelDriver,
  ModelGenerateOptions,
} from '../../src/model/modelDriver.js';

export type ScriptStep =
  | AcceptedModelResponse
  | Error
  | ((options: ModelGenerateOptions) => AcceptedModelResponse | Promise<AcceptedModelResponse>);

/**
 * A driver that replays scripted steps in order, recording every request's
 * messages, and throws once the script is exhausted.
 */
export function scriptedDriver(steps: ScriptStep[]): ModelDriver & {
  generate: ReturnType<typeof vi.fn>;
  requests: Array<readonly Message[]>;
} {
  const requests: Array<readonly Message[]> = [];
  const generate = vi.fn(async (options: ModelGenerateOptions) => {
    requests.push(structuredClone(options.messages));
    const step = steps.shift();
    if (step === undefined) throw new Error('scripted model exhausted');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? await step(options) : step;
  });
  return { generate, requests };
}

/** A driver for a role the scenario must never reach. */
export function unexpectedDriver(role: string): ModelDriver & {
  generate: ReturnType<typeof vi.fn>;
} {
  return {
    generate: vi.fn(async () => {
      throw new Error(`${role} model must not be called`);
    }),
  };
}

/** Parse the run's durable checkpoint from disk through the full schema. */
export function readCheckpoint(runDir: string): Checkpoint {
  return checkpointSchema.parse(
    JSON.parse(readFileSync(join(runDir, HARNESS_DIR, RUN_CHECKPOINT_FILENAME), 'utf8')),
  );
}
