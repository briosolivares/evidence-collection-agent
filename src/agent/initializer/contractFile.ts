import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  outputContractSchema,
  type OutputContract,
} from './outputContract.js';
import { writeFileDurablyAtomic } from '../../run/atomicFile.js';
import { V3_HARNESS_DIR } from '../checkpoint.js';

export const V3_OUTPUT_CONTRACT_FILENAME = 'output-contract.json';
export const V3_OUTPUT_CONTRACT_PATH =
  `${V3_HARNESS_DIR}/${V3_OUTPUT_CONTRACT_FILENAME}`;

/** Publish the initializer's one immutable contract into harness-private
 * state. Repeated resume calls accept byte-equivalent content but never
 * replace, repair, or revise an existing file. */
export function ensureV3OutputContractFile(
  runDir: string,
  contract: OutputContract,
): void {
  const parsed = outputContractSchema.parse(contract);
  const path = join(runDir, V3_OUTPUT_CONTRACT_PATH);
  const bytes = `${JSON.stringify(parsed, null, 2)}\n`;
  try {
    writeFileDurablyAtomic(path, bytes, {
      mode: 'create',
      fileMode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readV3OutputContractFile(runDir);
    if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
      throw new Error(
        `${V3_OUTPUT_CONTRACT_PATH} already contains a different contract; refusing to revise immutable run requirements`,
      );
    }
  }
}

export function readV3OutputContractFile(runDir: string): OutputContract {
  const path = join(runDir, V3_OUTPUT_CONTRACT_PATH);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${V3_OUTPUT_CONTRACT_PATH} must be a regular file`);
  }
  const fd = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`${V3_OUTPUT_CONTRACT_PATH} must be a regular file`);
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(fd, 'utf8'));
    } catch (error) {
      throw new Error(
        `${V3_OUTPUT_CONTRACT_PATH} is not valid JSON: ${errorMessage(error)}`,
      );
    }
    const parsed = outputContractSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `${V3_OUTPUT_CONTRACT_PATH} failed contract validation: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  } finally {
    closeSync(fd);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
