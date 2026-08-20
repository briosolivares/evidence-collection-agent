import { lstatSync } from 'node:fs';
import { join } from 'node:path';

import { errorMessage } from '../../errors.js';
import { outputContractSchema, type OutputContract } from './outputContract.schema.js';
import { writeFileDurablyAtomic } from '../../run/atomicFile.js';
import { NoFollowFileError, readFileNoFollow } from '../../run/noFollowFile.js';
import { HARNESS_DIR } from '../checkpoint.js';

export const OUTPUT_CONTRACT_FILENAME = 'output-contract.json';
export const OUTPUT_CONTRACT_PATH = `${HARNESS_DIR}/${OUTPUT_CONTRACT_FILENAME}`;
/** A contract comes from one bounded initializer response. One MiB leaves
 * ample headroom while preventing a corrupt durable projection from causing
 * an unbounded allocation during resume. */
export const OUTPUT_CONTRACT_MAX_BYTES = 1024 * 1024;

/** Publish the initializer's one immutable contract into harness-private
 * state. Repeated resume calls accept byte-equivalent content but never
 * replace, repair, or revise an existing file. */
export function ensureOutputContractFile(runDir: string, contract: OutputContract): void {
  const parsed = outputContractSchema.parse(contract);
  const path = join(runDir, OUTPUT_CONTRACT_PATH);
  const bytes = `${JSON.stringify(parsed, null, 2)}\n`;
  const byteLength = Buffer.byteLength(bytes, 'utf8');
  if (byteLength > OUTPUT_CONTRACT_MAX_BYTES) {
    throw contractSizeLimitError(byteLength);
  }
  try {
    writeFileDurablyAtomic(path, bytes, {
      mode: 'create',
      fileMode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readOutputContractFile(runDir);
    if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
      throw new Error(
        `${OUTPUT_CONTRACT_PATH} already contains a different contract; refusing to revise immutable run requirements`,
      );
    }
  }
}

export function readOutputContractFile(runDir: string): OutputContract {
  const path = join(runDir, OUTPUT_CONTRACT_PATH);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${OUTPUT_CONTRACT_PATH} must be a regular file`);
  }

  let raw: string;
  try {
    raw = readFileNoFollow(path, {
      maxBytes: OUTPUT_CONTRACT_MAX_BYTES,
      stableSize: true,
    }).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`${OUTPUT_CONTRACT_PATH} must be a regular file`);
    }
    if (error instanceof NoFollowFileError && error.kind === 'not_regular') {
      throw new Error(`${OUTPUT_CONTRACT_PATH} must be a regular file`);
    }
    if (error instanceof NoFollowFileError && error.kind === 'max_bytes') {
      throw contractSizeLimitError(error.observedBytes!);
    }
    if (error instanceof NoFollowFileError && error.kind === 'changed') {
      throw new Error(`${OUTPUT_CONTRACT_PATH} changed while it was being read`);
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${OUTPUT_CONTRACT_PATH} is not valid JSON: ${errorMessage(error)}`);
  }
  const parsed = outputContractSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${OUTPUT_CONTRACT_PATH} failed contract validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

function contractSizeLimitError(observedBytes: number): Error {
  return new Error(
    `${OUTPUT_CONTRACT_PATH} is ${observedBytes} bytes, exceeding the ` +
      `${OUTPUT_CONTRACT_MAX_BYTES}-byte durable projection limit`,
  );
}
