import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { EvalTask, Grader } from '../types.js';

/**
 * Load one eval task from its dataset directory (evals/datasets/<name>/):
 * task.json for the task text and start URL, oracle/oracle.ts for
 * `fetchOracle`, and grader/grader.ts for `grade`.
 *
 * @param evalsDir - path of the directory holding the task directories
 * @param name - the task's directory name; only ASCII letters, digits, `_`
 *   and `-` are accepted (throws otherwise, so a CLI-supplied name can
 *   never traverse outside evalsDir)
 * @returns the task ready for the runner; throws with the task's name in
 *   the message if its directory, task.json, oracle, or grader is missing
 *   or malformed
 */
export async function loadEvalTask(evalsDir: string, name: string): Promise<EvalTask> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(
      `invalid task name (ASCII letters, digits, _ and - only): ${JSON.stringify(name)}`,
    );
  }
  const taskDir = join(resolve(evalsDir), name);
  const { task, startUrl, requiresAuth } = readTaskJson(taskDir, name);

  const fetchOracle = await importTaskFunction(taskDir, name, 'oracle/oracle.ts', 'fetchOracle');
  const grade = await importTaskFunction(taskDir, name, 'grader/grader.ts', 'grade');

  return {
    name,
    taskText: task,
    startUrl,
    requiresAuth,
    fetchOracle: fetchOracle as EvalTask['fetchOracle'],
    grade: grade as Grader,
  };
}

/** Read and validate <taskDir>/task.json: { task, startUrl?, requiresAuth? }. */
function readTaskJson(
  taskDir: string,
  name: string,
): { task: string; startUrl?: string; requiresAuth: boolean } {
  const jsonPath = join(taskDir, 'task.json');

  let raw: string;
  try {
    raw = readFileSync(jsonPath, 'utf8');
  } catch {
    throw new Error(`task "${name}" not found: missing ${jsonPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`task "${name}": task.json is not valid JSON`);
  }

  const obj = parsed as { task?: unknown; startUrl?: unknown; requiresAuth?: unknown };
  if (typeof parsed !== 'object' || parsed === null || typeof obj.task !== 'string' || obj.task === '') {
    throw new Error(`task "${name}": task.json must have a non-empty string "task" field`);
  }
  if (obj.startUrl !== undefined && typeof obj.startUrl !== 'string') {
    throw new Error(`task "${name}": task.json "startUrl" must be a string when present`);
  }
  if (obj.requiresAuth !== undefined && typeof obj.requiresAuth !== 'boolean') {
    throw new Error(`task "${name}": task.json "requiresAuth" must be a boolean when present`);
  }
  return {
    task: obj.task,
    ...(obj.startUrl !== undefined ? { startUrl: obj.startUrl } : {}),
    requiresAuth: obj.requiresAuth ?? false,
  };
}

/** Import <taskDir>/<relModulePath> and return its named function export. */
async function importTaskFunction(
  taskDir: string,
  name: string,
  relModulePath: string,
  exportName: string,
): Promise<unknown> {
  const moduleUrl = pathToFileURL(join(taskDir, ...relModulePath.split('/'))).href;

  let module: Record<string, unknown>;
  try {
    module = (await import(moduleUrl)) as Record<string, unknown>;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`task "${name}": cannot load ${relModulePath} (${reason})`);
  }

  const fn = module[exportName];
  if (typeof fn !== 'function') {
    throw new Error(`task "${name}": ${relModulePath} must export a function "${exportName}"`);
  }
  return fn;
}
