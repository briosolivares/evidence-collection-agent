import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Protected browser-program helpers.
 *
 * This module deliberately knows nothing about a browser connection. Browser
 * operations use `requestCdp`; the one host file effect uses `requestHost`.
 * Neither closure reveals a CDP URL or provider credential to this layer.
 */

const MAX_STRING_ARGUMENT_BYTES = 256_000;
const MAX_AX_NODES = 1_000;
const MAX_AX_DEPTH = 50;
const MAX_WAIT_MS = 120_000;
const MAX_DIALOG_PROMPT_BYTES = 16_384;
const MAX_WORKSPACE_PATH_BYTES = 4_096;
const MAX_WORKSPACE_MODULE_BYTES = 1_048_576;

const KEY_DEFINITIONS = Object.freeze({
  Enter: [13, 'Enter', '\r'],
  Tab: [9, 'Tab', '\t'],
  Backspace: [8, 'Backspace', ''],
  Escape: [27, 'Escape', ''],
  Delete: [46, 'Delete', ''],
  ' ': [32, 'Space', ' '],
  ArrowLeft: [37, 'ArrowLeft', ''],
  ArrowUp: [38, 'ArrowUp', ''],
  ArrowRight: [39, 'ArrowRight', ''],
  ArrowDown: [40, 'ArrowDown', ''],
  Home: [36, 'Home', ''],
  End: [35, 'End', ''],
  PageUp: [33, 'PageUp', ''],
  PageDown: [34, 'PageDown', ''],
});

function plainObject(value, label) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function boundedString(
  value,
  label,
  { allowEmpty = false, maxBytes = MAX_STRING_ARGUMENT_BYTES } = {},
) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new RangeError(`${label} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function boundedInteger(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function remoteValue(value) {
  if (!value || typeof value !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : undefined;
}

function errorDescription(response) {
  const details = response?.exceptionDetails;
  const result = response?.result;
  const exception = details?.exception;
  return (
    result?.description ??
    exception?.description ??
    (Object.prototype.hasOwnProperty.call(exception ?? {}, 'value')
      ? String(exception.value)
      : undefined) ??
    exception?.className ??
    details?.text ??
    'JavaScript evaluation failed'
  );
}

function expressionPreview(expression) {
  const compact = expression.trim().replaceAll('\n', '\\n');
  return compact.length <= 180 ? compact : `${compact.slice(0, 177)}...`;
}

function decodeRuntimeValue(response, expression) {
  if (!response || typeof response !== 'object') {
    throw new Error('Runtime.evaluate returned a malformed response');
  }
  const details = response.exceptionDetails;
  const result = response.result;
  if (details || result?.subtype === 'error') {
    const line = details?.lineNumber;
    const column = details?.columnNumber;
    const location =
      Number.isInteger(line) && Number.isInteger(column)
        ? ` at line ${line}, column ${column}`
        : '';
    throw new Error(
      `JavaScript evaluation failed${location}: ${errorDescription(response)}; expression: ${expressionPreview(expression)}`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(result ?? {}, 'value')) return result.value;

  const unserializable = result?.unserializableValue;
  if (typeof unserializable !== 'string') return undefined;
  if (unserializable === 'NaN') return Number.NaN;
  if (unserializable === 'Infinity') return Number.POSITIVE_INFINITY;
  if (unserializable === '-Infinity') return Number.NEGATIVE_INFINITY;
  if (unserializable === '-0') return -0;
  // Returning a BigInt would make the browser program's final result
  // non-JSON-serializable. Preserve the exact CDP spelling instead.
  return unserializable;
}

function valueText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return String(value.value ?? '');
  }
  return String(value);
}

function compactAxNode(node) {
  const compact = {
    nodeId: node.nodeId,
    ignored: node.ignored === true,
    role: valueText(node.role),
    name: valueText(node.name),
  };
  if (node.backendDOMNodeId !== undefined) compact.backendDOMNodeId = node.backendDOMNodeId;
  if (node.parentId !== undefined) compact.parentId = node.parentId;
  if (Array.isArray(node.childIds) && node.childIds.length > 0) compact.childIds = node.childIds;
  const description = valueText(node.description);
  const value = valueText(node.value);
  if (description) compact.description = description;
  if (value) compact.value = value;
  if (Array.isArray(node.properties) && node.properties.length > 0) {
    compact.properties = node.properties.slice(0, 50).map((property) => ({
      name: String(property?.name ?? ''),
      value: valueText(property?.value),
    }));
  }
  return compact;
}

function normalizedAxQuery(input) {
  const query = plainObject(input, 'accessibility query');
  const maxDepth = query.maxDepth ?? 12;
  const maxNodes = query.maxNodes ?? 200;
  boundedInteger(maxDepth, 'accessibility maxDepth', 0, MAX_AX_DEPTH);
  boundedInteger(maxNodes, 'accessibility maxNodes', 1, MAX_AX_NODES);

  let roles;
  if (query.role !== undefined && query.roles !== undefined) {
    throw new TypeError('accessibility query accepts role or roles, not both');
  }
  const suppliedRoles = query.roles ?? query.role;
  if (suppliedRoles !== undefined) {
    const roleList = Array.isArray(suppliedRoles) ? suppliedRoles : [suppliedRoles];
    if (roleList.length === 0 || roleList.length > 50) {
      throw new RangeError('accessibility roles must contain 1 through 50 values');
    }
    roles = new Set(
      roleList.map((role, index) =>
        boundedString(role, `accessibility role ${index + 1}`).toLocaleLowerCase(),
      ),
    );
  }

  const name =
    query.name === undefined
      ? undefined
      : boundedString(query.name, 'accessibility name', { allowEmpty: true }).toLocaleLowerCase();
  const text =
    query.text === undefined
      ? undefined
      : boundedString(query.text, 'accessibility text', { allowEmpty: true }).toLocaleLowerCase();
  if (query.includeIgnored !== undefined && typeof query.includeIgnored !== 'boolean') {
    throw new TypeError('accessibility includeIgnored must be a boolean');
  }

  return {
    maxDepth,
    maxNodes,
    roles,
    name,
    text,
    includeIgnored: query.includeIgnored === true,
  };
}

function axMatches(node, query) {
  if (!query.includeIgnored && node.ignored) return false;
  if (query.roles && !query.roles.has(node.role.toLocaleLowerCase())) return false;
  if (query.name !== undefined && !node.name.toLocaleLowerCase().includes(query.name)) return false;
  if (query.text !== undefined) {
    const haystack = [node.role, node.name, node.description, node.value]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase();
    if (!haystack.includes(query.text)) return false;
  }
  return true;
}

function waitOptions(input) {
  const options = plainObject(input, 'wait options');
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  boundedInteger(timeoutMs, 'wait timeoutMs', 0, MAX_WAIT_MS);
  boundedInteger(pollIntervalMs, 'wait pollIntervalMs', 10, 5_000);
  return { timeoutMs, pollIntervalMs };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function workspaceModulePath(workspacePath) {
  boundedString(workspacePath, 'workspace module path', {
    maxBytes: MAX_WORKSPACE_PATH_BYTES,
  });
  if (workspacePath.includes('\0')) {
    throw new TypeError('workspace module path must not contain a NUL byte');
  }
  if (isAbsolute(workspacePath)) {
    throw new Error('workspace module path must be relative');
  }
  if (workspacePath.split(/[\\/]+/u).includes('..')) {
    throw new Error('workspace module path must stay within scratch/workspace');
  }

  const workspaceRoot = await realpath(process.cwd());
  const candidate = resolve(workspaceRoot, workspacePath);
  const confined = relative(workspaceRoot, candidate);
  if (
    confined === '' ||
    confined === '..' ||
    confined.startsWith(`..${sep}`) ||
    isAbsolute(confined)
  ) {
    throw new Error('workspace module path must name a file within scratch/workspace');
  }

  const components = confined.split(sep);
  let current = workspaceRoot;
  for (const [index, component] of components.entries()) {
    current = resolve(current, component);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      const code = typeof error?.code === 'string' ? ` (${error.code})` : '';
      throw new Error(`workspace module ${JSON.stringify(workspacePath)} is unavailable${code}`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error('workspace module path must not contain symbolic links');
    }
    const isEntry = index === components.length - 1;
    if (!isEntry && !stats.isDirectory()) {
      throw new Error('workspace module parent must be a directory');
    }
    if (isEntry && !stats.isFile()) {
      throw new Error('workspace module must be a regular file');
    }
  }

  const flags =
    fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW ?? 0) |
    (fsConstants.O_NONBLOCK ?? 0);
  let handle;
  try {
    handle = await open(current, flags);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error('workspace module path must not contain symbolic links');
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error('workspace module must be a regular file');
    }
    if (stats.size > MAX_WORKSPACE_MODULE_BYTES) {
      throw new RangeError(
        `workspace module exceeds ${MAX_WORKSPACE_MODULE_BYTES} bytes`,
      );
    }
  } finally {
    await handle.close();
  }
  return current;
}

function pageFromTargetInfo(targetInfo, pageId) {
  const targetId = boundedString(targetInfo?.targetId, 'target targetId');
  return {
    ...(pageId === undefined ? {} : { pageId }),
    targetId,
    title: typeof targetInfo.title === 'string' ? targetInfo.title : '',
    url: typeof targetInfo.url === 'string' ? targetInfo.url : '',
    type: typeof targetInfo.type === 'string' ? targetInfo.type : 'page',
  };
}

function normalizedInitialPage(value) {
  const identity = plainObject(value, 'initial page identity');
  return Object.freeze({
    pageId: boundedString(identity.pageId, 'initial pageId', { maxBytes: 4_096 }),
    targetId: boundedString(identity.targetId, 'initial targetId', { maxBytes: 4_096 }),
  });
}

/**
 * Build the frozen browser API made visible to one browser program.
 * Both RPC closures are owned by child.mjs and expose no transport authority.
 */
export function createBrowserApi(requestCdp, requestHost, initialPageIdentity) {
  if (typeof requestCdp !== 'function') throw new TypeError('requestCdp must be a function');
  if (typeof requestHost !== 'function') throw new TypeError('requestHost must be a function');
  const initialPage = normalizedInitialPage(initialPageIdentity);

  const cdp = async (method, params = {}) => {
    boundedString(method, 'CDP method');
    plainObject(params, 'CDP params');
    return requestCdp(method, params);
  };

  const evaluate = async (expression) => {
    boundedString(expression, 'JavaScript expression', { allowEmpty: true });
    const response = await cdp('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return decodeRuntimeValue(response, expression);
  };

  const js = async (expression) => {
    try {
      return await evaluate(expression);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Illegal return statement')) throw error;
      return evaluate(`(async()=>{${expression}\n})()`);
    }
  };

  const pageInfo = async () => {
    const [targetResponse, dimensions] = await Promise.all([
      cdp('Target.getTargetInfo'),
      js(`({
        url: location.href,
        title: document.title,
        width: innerWidth,
        height: innerHeight,
        scrollX,
        scrollY,
        pageWidth: document.documentElement.scrollWidth,
        pageHeight: document.documentElement.scrollHeight
      })`),
    ]);
    if (!dimensions || typeof dimensions !== 'object') {
      throw new Error('pageInfo JavaScript returned a malformed value');
    }
    const currentTargetId = boundedString(
      targetResponse?.targetInfo?.targetId,
      'current targetId',
    );
    if (currentTargetId !== initialPage.targetId) {
      throw new Error(
        `pageInfo target mismatch: command session is pinned to ${initialPage.targetId}, ` +
          `but CDP reported ${currentTargetId}`,
      );
    }
    const target = pageFromTargetInfo(targetResponse.targetInfo, initialPage.pageId);
    return {
      pageId: target.pageId,
      targetId: target.targetId,
      url: typeof dimensions.url === 'string' ? dimensions.url : target.url,
      title: typeof dimensions.title === 'string' ? dimensions.title : target.title,
      viewport: {
        width: finiteNumber(dimensions.width, 'viewport width'),
        height: finiteNumber(dimensions.height, 'viewport height'),
        scrollX: finiteNumber(dimensions.scrollX, 'viewport scrollX'),
        scrollY: finiteNumber(dimensions.scrollY, 'viewport scrollY'),
      },
      page: {
        width: finiteNumber(dimensions.pageWidth, 'page width'),
        height: finiteNumber(dimensions.pageHeight, 'page height'),
      },
    };
  };

  const accessibility = async (input = {}) => {
    const query = normalizedAxQuery(input);
    const response = await cdp('Accessibility.getFullAXTree', { depth: query.maxDepth });
    const allNodes = Array.isArray(response?.nodes) ? response.nodes : [];
    const nodes = [];
    let matchedNodes = 0;
    for (const rawNode of allNodes) {
      if (!rawNode || typeof rawNode !== 'object') continue;
      const node = compactAxNode(rawNode);
      if (!axMatches(node, query)) continue;
      matchedNodes += 1;
      if (nodes.length < query.maxNodes) nodes.push(node);
    }
    return {
      nodes,
      totalNodes: allNodes.length,
      matchedNodes,
      truncated: matchedNodes > nodes.length,
    };
  };

  const goto = async (url) => cdp('Page.navigate', { url: boundedString(url, 'URL') });

  const click = async (x, y, input = {}) => {
    const options = plainObject(input, 'click options');
    const button = options.button ?? 'left';
    if (!['left', 'middle', 'right', 'back', 'forward'].includes(button)) {
      throw new RangeError(`unsupported mouse button: ${String(button)}`);
    }
    const clickCount = options.clickCount ?? 1;
    const modifiers = options.modifiers ?? 0;
    boundedInteger(clickCount, 'clickCount', 1, 3);
    boundedInteger(modifiers, 'click modifiers', 0, 15);
    const event = {
      x: finiteNumber(x, 'click x'),
      y: finiteNumber(y, 'click y'),
      button,
      clickCount,
      modifiers,
    };
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...event });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...event });
  };

  const type = async (text) => {
    await cdp('Input.insertText', { text: boundedString(text, 'text', { allowEmpty: true }) });
  };

  const press = async (key, input = {}) => {
    boundedString(key, 'key');
    const options = plainObject(input, 'key options');
    const modifiers = options.modifiers ?? 0;
    boundedInteger(modifiers, 'key modifiers', 0, 15);
    const definition = KEY_DEFINITIONS[key];
    const virtualKeyCode = definition?.[0] ?? (key.length === 1 ? key.codePointAt(0) : 0);
    const code = options.code ?? definition?.[1] ?? key;
    const text = options.text ?? definition?.[2] ?? (key.length === 1 ? key : '');
    boundedString(code, 'key code');
    boundedString(text, 'key text', { allowEmpty: true });
    const base = {
      key,
      code,
      modifiers,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
    };
    const hasShortcutModifier = (modifiers & 7) !== 0;
    const isPrintable = key.length === 1 && text.length > 0 && !hasShortcutModifier;
    await cdp('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...base,
      ...(!isPrintable && text ? { text } : {}),
    });
    if (isPrintable) {
      await cdp('Input.dispatchKeyEvent', { type: 'char', ...base, text });
    }
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  const scroll = async (x, y, deltaY, deltaX = 0) => {
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: finiteNumber(x, 'scroll x'),
      y: finiteNumber(y, 'scroll y'),
      deltaY: finiteNumber(deltaY, 'scroll deltaY'),
      deltaX: finiteNumber(deltaX, 'scroll deltaX'),
    });
  };

  const waitFor = async (expression, input = {}) => {
    boundedString(expression, 'wait expression');
    const options = waitOptions(input);
    const deadline = Date.now() + options.timeoutMs;
    do {
      if (await js(expression)) return true;
      if (Date.now() >= deadline) return false;
      await delay(Math.min(options.pollIntervalMs, Math.max(0, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return false;
  };

  const waitForLoad = async (input = {}) => waitFor('document.readyState === "complete"', input);

  const handleDialog = async (action, promptText) => {
    if (action !== 'accept' && action !== 'dismiss') {
      throw new RangeError('dialog action must be accept or dismiss');
    }
    if (action === 'dismiss' && promptText !== undefined) {
      throw new TypeError('promptText is allowed only when accepting a dialog');
    }
    const params = { accept: action === 'accept' };
    if (promptText !== undefined) {
      params.promptText = boundedString(promptText, 'dialog promptText', {
        allowEmpty: true,
        maxBytes: MAX_DIALOG_PROMPT_BYTES,
      });
    }
    return cdp('Page.handleJavaScriptDialog', params);
  };

  const pages = async () => {
    const response = await cdp('Target.getTargets');
    const infos = Array.isArray(response?.targetInfos) ? response.targetInfos : [];
    return infos
      .filter((info) => info?.type === 'page' && typeof info.targetId === 'string')
      .map((info) =>
        pageFromTargetInfo(
          info,
          info.targetId === initialPage.targetId ? initialPage.pageId : undefined,
        ),
      );
  };

  const open = async (url = 'about:blank') => {
    boundedString(url, 'URL');
    const created = await cdp('Target.createTarget', { url });
    const targetId = boundedString(created?.targetId, 'created targetId');
    await cdp('Target.activateTarget', { targetId });
    const response = await cdp('Target.getTargetInfo', { targetId });
    return pageFromTargetInfo(response?.targetInfo ?? { targetId, title: '', url, type: 'page' });
  };

  const activate = async (targetId) => {
    await cdp('Target.activateTarget', { targetId: boundedString(targetId, 'targetId') });
  };

  const close = async (targetId) => {
    let resolvedTargetId = targetId;
    if (resolvedTargetId === undefined) {
      const response = await cdp('Target.getTargetInfo');
      resolvedTargetId = response?.targetInfo?.targetId;
    }
    await cdp('Target.closeTarget', {
      targetId: boundedString(resolvedTargetId, 'targetId'),
    });
  };

  const importModule = async (workspacePath) => {
    const modulePath = await workspaceModulePath(workspacePath);
    return import(pathToFileURL(modulePath).href);
  };

  const upload = async (backendDOMNodeId, workspacePath) => {
    boundedInteger(
      backendDOMNodeId,
      'upload backendDOMNodeId',
      1,
      2_147_483_647,
    );
    boundedString(workspacePath, 'upload workspace path', {
      maxBytes: MAX_WORKSPACE_PATH_BYTES,
    });
    await requestHost('upload', { backendDOMNodeId, workspacePath });
  };

  return Object.freeze({
    cdp,
    js,
    pageInfo,
    accessibility,
    goto,
    click,
    type,
    press,
    scroll,
    waitForLoad,
    waitFor,
    handleDialog,
    pages,
    open,
    activate,
    close,
    importModule,
    upload,
  });
}
