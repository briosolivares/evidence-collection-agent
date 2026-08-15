/**
 * Element-ref resolution and outline parsing.
 *
 * Owns the mechanics behind {@link PlaywrightBrowserController.resolveElementRef}
 * and {@link PlaywrightBrowserController.stampOutlineElements}: giving aria
 * outline entries durable per-document identity, and resolving a previously
 * issued {@link ElementRef} back to a live {@link Locator}. Split out because
 * this is a self-contained mechanism — everything it needs (a page, a
 * `PageRecord`, a ref) is passed in explicitly; it never reaches back into
 * controller state that isn't handed to it.
 */
import type { Frame, Locator, Page } from 'playwright';

import { ACTION_TIMEOUT_MS, type PageRecord } from './playwrightBrowserController.js';
import type { ActionTargetHandle } from './browserActions.js';
import type { ElementRef } from './browserState.js';
import { BrowserRefNotFoundError } from './controller.js';
import { localUploadEncoder, type BrowserUploadEncoder } from './uploadEncoder.js';

/** Matches a bare Playwright aria-ref, e.g. `e12` or `f1e8` once the page has
 * navigated more than once. */
const ARIA_REF_PATTERN = /^(?:f\d+)?e\d+$/;

// --- T9 observation bounds (all finite literals). ---
/** Elements stamped per interactive observation; the outline itself still
 * lists everything, this only bounds per-element identity work. */
const MAX_OBSERVED_ELEMENTS = 150;
/* Element identity is limited to the page's TOP document until T11 adds
 * targeted per-frame observation — a subframe element stamped with the main
 * frame's frameId/documentId would go stale for the wrong reason. The test
 * is made *in the page* (see stampOutlineElements) rather than from the ref's
 * syntax: Playwright prefixes refs with a frame ordinal (`f1e8`) once the
 * page has navigated more than once, so a "bare `e12` means main frame"
 * rule silently drops every element on any page reached by two navigations,
 * which is precisely the page an action sequence lands on. */
/** The attribute stamped on observed elements. It is the ref's exact-node
 * identity within its document: DOM moves and unrelated mutation keep it,
 * document replacement destroys it. */
const ELEMENT_MARKER_ATTRIBUTE = 'data-sherlock-el';
/** Element ids are store-issued (`el-7`); enforcing the shape keeps the
 * marker CSS selector injection-proof even for a crafted ref. */
const ELEMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Roles worth element identity for the `interactive` need. The outline
 * shows every visible node; only action targets need durable refs. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
]);

/** One outline entry: `- role "name" ... [ref=e12]` (name optional). */
const OUTLINE_ELEMENT_PATTERN =
  /^\s*-\s+([A-Za-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?.*?\[ref=([A-Za-z0-9]+)\]/;

/** Parse the interactive entries out of an AI-mode aria snapshot: role,
 * unescaped accessible name, and the snapshot-scoped aria ref. Entries
 * whose role is not an action target (headings, generics, lists, ...) are
 * skipped — the outline text still shows them. */
export function parseOutlineElements(
  outline: string,
): Array<{ role: string; name: string; ariaRef: string }> {
  const entries: Array<{ role: string; name: string; ariaRef: string }> = [];
  for (const line of outline.split('\n')) {
    const match = OUTLINE_ELEMENT_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    const role = match[1] ?? '';
    if (!INTERACTIVE_ROLES.has(role)) {
      continue;
    }
    entries.push({
      role,
      // The snapshot backslash-escapes quotes inside names; undo that.
      name: (match[2] ?? '').replace(/\\(.)/g, '$1'),
      ariaRef: match[3] ?? '',
    });
  }
  return entries;
}

/** Give every interactive outline entry durable identity: stamp (or
 * re-read) the marker attribute on the exact node behind each aria ref.
 * Stamping is write-once per node, so re-observing an unchanged document
 * returns the SAME element ids — that stability is what makes
 * observation diffs and cross-observation refs meaningful.
 *
 * @param record - the page's registry record (read-only here: `pageId` is
 *   copied onto each produced ref, nothing on the record is mutated)
 * @param createElementId - issues a fresh store-scoped element id; passed in
 *   explicitly rather than a whole state store, since this is the only
 *   capability stamping needs
 */
export async function stampOutlineElements(
  record: PageRecord,
  frameId: string,
  documentId: string,
  outline: string,
  createElementId: () => string,
): Promise<ElementRef[]> {
  const refs: ElementRef[] = [];
  const ordinals = new Map<string, number>();
  for (const entry of parseOutlineElements(outline).slice(0, MAX_OBSERVED_ELEMENTS)) {
    let id: string | null;
    try {
      // The attribute name travels as an argument rather than being
      // inlined in the page function: resolution reads the marker through
      // ELEMENT_MARKER_ATTRIBUTE, and a hardcoded copy here would silently
      // stamp the old name (every ref instantly stale) if it ever changed.
      id = await record.page.locator(`aria-ref=${entry.ariaRef}`).evaluate(
        (element, { attribute, proposedId }) => {
          // Top-document-only identity, decided by the document itself.
          const view = element.ownerDocument.defaultView;
          if (view === null || view !== view.top) {
            return null;
          }
          const existing = element.getAttribute(attribute);
          if (existing !== null) {
            return existing;
          }
          element.setAttribute(attribute, proposedId);
          return proposedId;
        },
        {
          attribute: ELEMENT_MARKER_ATTRIBUTE,
          proposedId: createElementId(),
        },
      );
    } catch {
      // The element vanished between snapshot and stamping (or lives in a
      // frame this page-scoped locator cannot reach); observation stays
      // best-effort rather than failing wholesale.
      continue;
    }
    if (id === null) {
      // An element inside a subframe: skipped, and its issued id is simply
      // never used (ids are unique, not contiguous).
      continue;
    }
    // A literal NUL separator cannot appear in a role or an accessible
    // name, so no `role`/`name` pair can collide with another; written
    // as an escape because a raw NUL byte makes this file binary to
    // grep and other text tooling.
    const ordinalKey = `${entry.role}\u0000${entry.name}`;
    const ordinal = ordinals.get(ordinalKey) ?? 0;
    ordinals.set(ordinalKey, ordinal + 1);
    refs.push({
      id,
      pageId: record.pageId,
      frameId,
      documentId,
      // backendNodeId deliberately unset: the stamped marker already
      // provides same-document exact-node identity without CDP coupling.
      stableLocator: `[${ELEMENT_MARKER_ATTRIBUTE}="${id}"]`,
      role: entry.role,
      name: entry.name,
      ordinal,
    });
  }
  return refs;
}

/**
 * Resolve an {@link ElementRef} to an actionable locator, once the ref's page
 * record has already been located in the registry.
 *
 * Resolution ladder: (1) the exact node via the marker stamped at
 * observation time — survives reorders and unrelated DOM mutation within
 * the same document; (2) a unique role/name match in the ref's document.
 * A saved ordinal is deliberately NEVER used to retarget: after a list
 * reorder it would silently mutate the wrong row, the exact failure this
 * ladder exists to prevent.
 *
 * @param record - the ref's page record (caller has already checked it is
 *   open)
 * @param ref - an element ref from a prior observation
 * @returns a locator matching exactly one element
 * @throws BrowserRefNotFoundError when the ref's frame is gone, its
 *   document was replaced (navigation invalidates prior-document refs),
 *   or the target can no longer be resolved uniquely
 */
export async function resolveRefInRecord(record: PageRecord, ref: ElementRef): Promise<Locator> {
  const frameEntry = [...record.frames.entries()].find(
    ([, frameRecord]) => frameRecord.frameId === ref.frameId,
  );
  if (frameEntry === undefined) {
    throw new BrowserRefNotFoundError(ref.id);
  }
  const [frame, frameRecord] = frameEntry;
  if (frameRecord.documentId !== ref.documentId || frame.isDetached()) {
    // The document the element lived in was replaced — stale by
    // definition, regardless of what similar elements now exist.
    throw new BrowserRefNotFoundError(ref.id);
  }

  if (ELEMENT_ID_PATTERN.test(ref.id)) {
    const stamped = frame.locator(`[${ELEMENT_MARKER_ATTRIBUTE}="${ref.id}"]`);
    if ((await countRefMatches(stamped)) === 1) {
      return stamped;
    }
  }

  // Marker gone (e.g. the page stripped attributes): fall back to a
  // role/name match only when it is unique in the document. An empty
  // name can never be unique enough for a mutating action.
  if (ref.name !== '') {
    const byRole = frame.getByRole(ref.role as Parameters<Frame['getByRole']>[0], {
      name: ref.name,
      exact: true,
    });
    if ((await countRefMatches(byRole)) === 1) {
      return byRole;
    }
  }

  throw new BrowserRefNotFoundError(ref.id);
}

/** Resolve a raw Playwright aria-ref (e.g. from a `download` request's
 * `ref` field) to a locator, requiring it to match exactly one element. */
export async function locatorForRef(page: Page, ref: string): Promise<Locator> {
  if (!ARIA_REF_PATTERN.test(ref)) {
    // A wrong-kind ref, not a stale one — most likely an `ElementRef.id` from
    // an observation's `elements` list, which is the handle `browserAction`
    // takes. Say so: the default advice is to observe again, and observing
    // again returns that same id.
    throw new BrowserRefNotFoundError(
      ref,
      'that is not an outline ref; this field takes the [ref=…] stamp from an ' +
        'observe outline line, like e9 or f10e45, not an element object or an ' +
        'id from the observe elements list',
    );
  }

  const locator = page.locator(`aria-ref=${ref}`);
  if ((await countRefMatches(locator)) !== 1) {
    throw new BrowserRefNotFoundError(ref);
  }

  return locator;
}

export async function normalizeRefActionError(
  locator: Locator,
  ref: string,
  error: unknown,
): Promise<unknown> {
  if ((await countRefMatches(locator)) === 0) {
    return new BrowserRefNotFoundError(ref);
  }

  return error;
}

export async function countRefMatches(locator: Locator): Promise<number> {
  try {
    return await locator.count();
  } catch {
    return 0;
  }
}

/** Wrap a revalidated locator as an action handle. Every op carries the
 * finite {@link ACTION_TIMEOUT_MS} instead of Playwright's 30s default.
 *
 * @param uploadEncoder - how an upload path becomes something the browser can
 *   actually read; defaults to handing the path straight through, which is
 *   correct only when the browser shares this filesystem. See
 *   `uploadEncoder.ts` for why a remote browser needs bytes instead. */
export function actionTargetHandle(
  locator: Locator,
  uploadEncoder: BrowserUploadEncoder = localUploadEncoder,
): ActionTargetHandle {
  const options = { timeout: ACTION_TIMEOUT_MS };
  return {
    click: () => locator.click(options),
    fill: (text) => locator.fill(text, options),
    press: (key) => locator.press(key, options),
    selectOptions: (values) => locator.selectOption([...values], options).then(() => undefined),
    setChecked: (checked) => locator.setChecked(checked, options),
    hover: () => locator.hover(options),
    setFiles: async (absolutePaths) => {
      await locator.setInputFiles(await uploadEncoder.encode(absolutePaths), options);
    },
  };
}
