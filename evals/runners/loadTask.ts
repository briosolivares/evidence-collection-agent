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
  const { task, startUrl, headed } = readTaskJson(taskDir, name);

  const fetchOracle = await importTaskFunction(taskDir, name, 'oracle/oracle.ts', 'fetchOracle');
  const grade = await importTaskFunction(taskDir, name, 'grader/grader.ts', 'grade');

  return {
    name,
    taskText: task,
    startUrl,
    headed,
    fetchOracle: fetchOracle as EvalTask['fetchOracle'],
    grade: grade as Grader,
  };
}

/**
 * Read and validate <taskDir>/task.json: { task, startUrl?, headed? }.
 * `headed` puts the task on the serial headed persistent-profile browser
 * lane — for tasks that need a real login or that bot-block headless
 * browsers. Defaults to false (headless isolated pool).
 */
function readTaskJson(
  taskDir: string,
  name: string,
): { task: string; startUrl?: string; headed: boolean } {
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

  const obj = parsed as { task?: unknown; startUrl?: unknown; headed?: unknown; requiresAuth?: unknown };
  if (typeof parsed !== 'object' || parsed === null || typeof obj.task !== 'string' || obj.task === '') {
    throw new Error(`task "${name}": task.json must have a non-empty string "task" field`);
  }
  if (obj.startUrl !== undefined && typeof obj.startUrl !== 'string') {
    throw new Error(`task "${name}": task.json "startUrl" must be a string when present`);
  }
  if (obj.requiresAuth !== undefined) {
    throw new Error(
      `task "${name}": task.json "requiresAuth" was renamed to "headed" — ` +
        'silently ignoring it would drop the task to the headless lane',
    );
  }
  if (obj.headed !== undefined && typeof obj.headed !== 'boolean') {
    throw new Error(`task "${name}": task.json "headed" must be a boolean when present`);
  }
  return {
    task: obj.task,
    ...(obj.startUrl !== undefined ? { startUrl: obj.startUrl } : {}),
    headed: obj.headed ?? false,
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
