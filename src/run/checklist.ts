import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { z } from 'zod';

import {
  CHECKLIST_DIR,
  deleteTrackedRunFile,
  MANIFEST_FILENAME,
  writeArtifact,
  type Manifest,
} from './artifacts.js';
import { resolveRunPath } from './runDir.js';

const HIGHWATERMARK_FILENAME = '.highwatermark';
const TASK_FILENAME_PATTERN = /^([1-9]\d*)\.json$/;

/** Positive decimal checklist identifier. */
export const checklistTaskIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'task ID must be a positive decimal integer');

/** Durable checklist status. `deleted` is an update action, never a status. */
export const checklistTaskStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
]);

const expectedArtifactPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith('artifacts/') &&
      !value.includes('\\') &&
      !value.split('/').some((part) => part === '' || part === '.' || part === '..'),
    'expected artifact paths must be normalized run-relative artifacts/... paths',
  );

/** Extensible task metadata with one evidence-agent convention. */
export const checklistTaskMetadataSchema = z
  .object({
    expectedArtifacts: z.array(expectedArtifactPathSchema).optional(),
  })
  .catchall(z.unknown());

/** Strict on-disk schema shared by every checklist read and write. */
export const checklistTaskSchema = z.strictObject({
  id: checklistTaskIdSchema,
  subject: z.string().trim().min(1),
  description: z.string().trim().min(1),
  status: checklistTaskStatusSchema,
  activeForm: z.string().trim().min(1).optional(),
  metadata: checklistTaskMetadataSchema.optional(),
});

export type ChecklistTask = z.infer<typeof checklistTaskSchema>;
export type ChecklistTaskStatus = z.infer<typeof checklistTaskStatusSchema>;
export type ChecklistTaskMetadata = z.infer<typeof checklistTaskMetadataSchema>;

export interface CreateChecklistTaskInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: ChecklistTaskMetadata;
}

export interface ChecklistTaskPatch {
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: ChecklistTaskStatus;
  /** Keys merge into existing metadata; `null` removes one key. */
  metadata?: Record<string, unknown | null>;
}

type ChecklistUpdatedListener = (runDir: string) => void;
const checklistUpdatedListeners = new Set<ChecklistUpdatedListener>();

/** Subscribe to successful checklist mutations. Disk remains authoritative. */
export function onChecklistUpdated(listener: ChecklistUpdatedListener): () => void {
  checklistUpdatedListeners.add(listener);
  return () => checklistUpdatedListeners.delete(listener);
}

/** Create one pending task using the durable numeric high-water mark. */
export function createChecklistTask(
  runDir: string,
  input: CreateChecklistTaskInput,
): ChecklistTask {
  const nextId = readHighwatermark(runDir) + 1n;
  const id = nextId.toString();
  const task = parseTask(
    {
      id,
      subject: input.subject,
      description: input.description,
      status: 'pending',
      ...(input.activeForm === undefined ? {} : { activeForm: input.activeForm }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
    taskRelativePath(id),
  );

  // Advance first: if the following task write ever fails, the allocated ID
  // remains burned rather than being silently recycled.
  writeManagedState(runDir, HIGHWATERMARK_FILENAME, `${id}\n`);
  writeTask(runDir, task);
  emitChecklistUpdated(runDir);
  return task;
}

/** Read every task from disk, validate it, and sort by numeric ID. */
export function listChecklistTasks(runDir: string): ChecklistTask[] {
  const checklistDir = resolveRunPath(runDir, CHECKLIST_DIR);
  let filenames: string[];
  try {
    filenames = readdirSync(checklistDir);
  } catch (error) {
    throw new Error(`cannot read checklist directory ${checklistDir}: ${errorMessage(error)}`);
  }

  return filenames
    .filter((filename) => filename.endsWith('.json'))
    .map((filename) => {
      const match = TASK_FILENAME_PATTERN.exec(filename);
      if (match === null) {
        throw new Error(`invalid checklist task filename: ${resolveRunPath(runDir, `${CHECKLIST_DIR}/${filename}`)}`);
      }
      return readTask(runDir, match[1]!);
    })
    .sort((left, right) => compareIds(left.id, right.id));
}

/** Read one task, or return undefined when its JSON file does not exist. */
export function getChecklistTask(
  runDir: string,
  taskId: string,
): ChecklistTask | undefined {
  const id = checklistTaskIdSchema.parse(taskId);
  const absPath = resolveRunPath(runDir, taskRelativePath(id));
  if (!existsSync(absPath)) return undefined;
  return readTask(runDir, id);
}

/** Apply a partial update, preserving all unspecified fields. */
export function updateChecklistTask(
  runDir: string,
  taskId: string,
  patch: ChecklistTaskPatch,
): ChecklistTask {
  const id = checklistTaskIdSchema.parse(taskId);
  if (Object.keys(patch).length === 0) {
    throw new Error(`TaskUpdate for task #${id} must change at least one field`);
  }
  const current = getChecklistTask(runDir, id);
  if (current === undefined) {
    throw new Error(`Checklist task #${id} was not found`);
  }

  const nextMetadata = mergeMetadata(current.metadata, patch.metadata);
  const candidate = {
    ...current,
    ...(patch.subject === undefined ? {} : { subject: patch.subject }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.activeForm === undefined ? {} : { activeForm: patch.activeForm }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(nextMetadata === undefined ? { metadata: undefined } : { metadata: nextMetadata }),
  };
  const task = parseTask(candidate, taskRelativePath(id));

  if (current.status !== 'completed' && task.status === 'completed') {
    assertExpectedArtifactsPublished(runDir, task);
  }

  writeTask(runDir, task);
  emitChecklistUpdated(runDir);
  return task;
}

/** Delete one task without lowering the high-water mark. */
export function deleteChecklistTask(runDir: string, taskId: string): boolean {
  const id = checklistTaskIdSchema.parse(taskId);
  const deleted = deleteTrackedRunFile(runDir, taskRelativePath(id), {
    managedState: 'checklist',
  });
  if (deleted) emitChecklistUpdated(runDir);
  return deleted;
}

function readTask(runDir: string, taskId: string): ChecklistTask {
  const relPath = taskRelativePath(taskId);
  const absPath = resolveRunPath(runDir, relPath);
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read checklist task ${absPath}: ${errorMessage(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid checklist task JSON at ${absPath}: ${errorMessage(error)}`);
  }
  const task = parseTask(value, absPath);
  if (task.id !== taskId) {
    throw new Error(
      `invalid checklist task at ${absPath}: file ID ${taskId} does not match task ID ${task.id}`,
    );
  }
  return task;
}

function parseTask(value: unknown, path: string): ChecklistTask {
  const parsed = checklistTaskSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid checklist task at ${path}: ${parsed.error.message}`);
  }
  return parsed.data;
}

function writeTask(runDir: string, task: ChecklistTask): void {
  writeManagedState(
    runDir,
    `${task.id}.json`,
    `${JSON.stringify(task, null, 2)}\n`,
  );
}

function writeManagedState(runDir: string, filename: string, contents: string): void {
  writeArtifact(
    runDir,
    `${CHECKLIST_DIR}/${filename}`,
    Buffer.from(contents, 'utf8'),
    { managedState: 'checklist' },
  );
}

function readHighwatermark(runDir: string): bigint {
  const path = resolveRunPath(runDir, `${CHECKLIST_DIR}/${HIGHWATERMARK_FILENAME}`);
  const highestLiveId = (): bigint =>
    listChecklistTasks(runDir).reduce(
      (highest, task) => (BigInt(task.id) > highest ? BigInt(task.id) : highest),
      0n,
    );
  if (!existsSync(path)) {
    return highestLiveId();
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch (error) {
    throw new Error(`cannot read checklist high-water mark ${path}: ${errorMessage(error)}`);
  }
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`invalid checklist high-water mark at ${path}: ${JSON.stringify(raw)}`);
  }
  const highwatermark = BigInt(raw);
  if (highwatermark < highestLiveId()) {
    throw new Error(`invalid checklist high-water mark at ${path}: lower than a live task ID`);
  }
  return highwatermark;
}

function mergeMetadata(
  current: ChecklistTaskMetadata | undefined,
  patch: Record<string, unknown | null> | undefined,
): ChecklistTaskMetadata | undefined {
  if (patch === undefined) return current;
  const merged: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function assertExpectedArtifactsPublished(runDir: string, task: ChecklistTask): void {
  const expected = task.metadata?.expectedArtifacts;
  if (expected === undefined || expected.length === 0) return;

  const manifestPath = resolveRunPath(runDir, MANIFEST_FILENAME);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  } catch (error) {
    throw new Error(`cannot verify task #${task.id} artifacts from ${manifestPath}: ${errorMessage(error)}`);
  }

  for (const relPath of expected) {
    const absPath = resolveRunPath(runDir, relPath);
    const normalized = relative(resolve(runDir), absPath);
    const requestedOutput = manifest.artifacts.some(
      (entry) =>
        entry.filename === normalized &&
        (entry.roles?.includes('requested_output') ?? false),
    );
    if (!existsSync(absPath) || !requestedOutput) {
      throw new Error(
        `Cannot complete task #${task.id}: promised artifact ${JSON.stringify(relPath)} ` +
          `is missing or is not published with the requested_output role. ` +
          `Create and verify it before marking the task completed.`,
      );
    }
  }
}

function taskRelativePath(taskId: string): string {
  const id = checklistTaskIdSchema.parse(taskId);
  return `${CHECKLIST_DIR}/${id}.json`;
}

function compareIds(left: string, right: string): number {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function emitChecklistUpdated(runDir: string): void {
  for (const listener of checklistUpdatedListeners) {
    try {
      listener(runDir);
    } catch {
      // Mutation already succeeded. Notifications are best-effort
      // invalidations, so one UI listener cannot turn success into failure.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
