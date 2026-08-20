import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';

export type NoFollowFileErrorKind = 'not_regular' | 'max_bytes' | 'mode_mismatch' | 'changed';

interface NoFollowFileErrorDetails {
  observedBytes?: number;
  phase?: 'inspection' | 'read';
  actualMode?: number;
  expectedMode?: number;
}

/** Mechanism-level failure. Product boundaries translate this into their
 * own path/role vocabulary where needed. */
export class NoFollowFileError extends Error {
  override readonly name = 'NoFollowFileError';
  readonly observedBytes: number | undefined;
  readonly phase: 'inspection' | 'read' | undefined;
  readonly actualMode: number | undefined;
  readonly expectedMode: number | undefined;

  constructor(
    readonly kind: NoFollowFileErrorKind,
    message: string,
    details: NoFollowFileErrorDetails = {},
  ) {
    super(message);
    this.observedBytes = details.observedBytes;
    this.phase = details.phase;
    this.actualMode = details.actualMode;
    this.expectedMode = details.expectedMode;
  }
}

export interface InspectPathNoFollowOptions {
  checkActive?: () => void;
  maxBytes?: number;
  expectedMode?: number;
}

export interface ReadFileNoFollowOptions extends InspectPathNoFollowOptions {
  chunkBytes?: number;
  /** Require the opened size, bytes read, and final descriptor size to agree. */
  stableSize?: boolean;
}

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/** Inspect the final path through the same no-follow, nonblocking descriptor
 * whose type, mode, and size are validated. */
export function inspectPathNoFollow(path: string, options: InspectPathNoFollowOptions = {}): Stats {
  validateMaximum(options.maxBytes);
  options.checkActive?.();
  const descriptor = openNoFollow(path);
  try {
    const stats = inspectDescriptor(path, descriptor, options);
    options.checkActive?.();
    return stats;
  } finally {
    closeSync(descriptor);
  }
}

/** Yield copied chunks from one no-follow regular-file descriptor. The
 * descriptor stays open across yields and closes even when iteration stops
 * early or a guard throws. */
export function* readFileChunksNoFollow(
  path: string,
  options: ReadFileNoFollowOptions = {},
): Generator<Buffer, void, void> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error(`chunkBytes must be a positive integer, got ${chunkBytes}`);
  }
  validateMaximum(options.maxBytes);

  options.checkActive?.();
  const descriptor = openNoFollow(path);
  let openedSize = 0;
  let total = 0;
  try {
    const opened = inspectDescriptor(path, descriptor, options);
    openedSize = opened.size;
    for (;;) {
      options.checkActive?.();
      const maximum = options.maxBytes;
      const maximumCapacity = maximum === undefined ? chunkBytes : maximum - total + 1;
      const stableCapacity = options.stableSize === true ? openedSize - total + 1 : chunkBytes;
      const capacity = Math.min(chunkBytes, maximumCapacity, stableCapacity);
      const chunk = Buffer.allocUnsafe(capacity);
      const count = readSync(descriptor, chunk, 0, capacity, null);
      if (count === 0) break;
      total += count;
      if (maximum !== undefined && total > maximum) {
        const observedBytes = Math.max(total, fstatSync(descriptor).size);
        throw new NoFollowFileError(
          'max_bytes',
          `${path} grew above the ${maximum}-byte limit while being read`,
          { observedBytes, phase: 'read' },
        );
      }
      if (options.stableSize === true && total > openedSize) {
        const finalSize = fstatSync(descriptor).size;
        if (maximum !== undefined && finalSize > maximum) {
          throw new NoFollowFileError(
            'max_bytes',
            `${path} grew above the ${maximum}-byte limit while being read`,
            { observedBytes: finalSize, phase: 'read' },
          );
        }
        throw new NoFollowFileError('changed', `${path} changed while it was being read`, {
          observedBytes: Math.max(total, finalSize),
        });
      }
      yield chunk.subarray(0, count);
    }
    options.checkActive?.();
    if (options.stableSize === true) {
      const finalSize = fstatSync(descriptor).size;
      if (total !== openedSize || finalSize !== openedSize) {
        throw new NoFollowFileError('changed', `${path} changed while it was being read`, {
          observedBytes: Math.max(total, finalSize),
        });
      }
    }
  } finally {
    closeSync(descriptor);
  }
}

/** Read all chunks into one Buffer. */
export function readFileNoFollow(path: string, options: ReadFileNoFollowOptions = {}): Buffer {
  const chunks = [...readFileChunksNoFollow(path, options)];
  return Buffer.concat(chunks);
}

function openNoFollow(path: string): number {
  return openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );
}

function inspectDescriptor(
  path: string,
  descriptor: number,
  options: InspectPathNoFollowOptions,
): Stats {
  const stats = fstatSync(descriptor);
  if (!stats.isFile()) {
    throw new NoFollowFileError('not_regular', `${path} is not a regular file`);
  }
  if (options.expectedMode !== undefined) {
    const mode = stats.mode & 0o777;
    if (mode !== options.expectedMode) {
      throw new NoFollowFileError(
        'mode_mismatch',
        `${path} has mode 0${mode.toString(8)}, expected 0${options.expectedMode.toString(8)}`,
        { actualMode: mode, expectedMode: options.expectedMode },
      );
    }
  }
  if (options.maxBytes !== undefined && stats.size > options.maxBytes) {
    throw new NoFollowFileError(
      'max_bytes',
      `${path} is ${stats.size} bytes, above the ${options.maxBytes}-byte limit`,
      { observedBytes: stats.size, phase: 'inspection' },
    );
  }
  return stats;
}

function validateMaximum(maxBytes: number | undefined): void {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new Error(`maxBytes must be a non-negative safe integer, got ${maxBytes}`);
  }
}
