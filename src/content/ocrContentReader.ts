import {
  assertContentRange,
  throwIfAborted,
  type ContentObservation,
  type ContentReadRequest,
  type ContentReader,
} from './contentReader.js';

// Text recovered from an image, and the confidence that recovery deserves.
//
// The rule this adapter exists to enforce: OCR TEXT IS NEVER PRESENTED AS
// EXACT. A misread digit in a member count or a dollar figure is invisible
// downstream — it looks like data — so every observation carries the engine,
// its version, and a per-region confidence, and the source image is kept as
// evidence so a human or the verifier can look at what the machine read.
//
// A run that needs an exact string from an image should read it from the page
// that contains the image where possible; OCR is the fallback, labelled as
// one.

/** Below this mean confidence, the observation is explicitly flagged as
 * unreliable in its text as well as its metadata — a caller skimming the
 * text must not miss it. */
export const LOW_CONFIDENCE_THRESHOLD = 0.75;

/** Images processed per call when no range is given. */
export const DEFAULT_OCR_IMAGE_SPAN = 1;

/** Hard ceiling per call. OCR is the most expensive read here, so the ceiling
 * is deliberately small. */
export const MAX_OCR_IMAGE_SPAN = 5;

/** One recognized region. */
export interface OcrRegion {
  /** 1-based index of the source image within the request. */
  image: number;
  text: string;
  /** 0..1. */
  confidence: number;
  /** Image-space bounding box [x, y, width, height], when the engine reports it. */
  bbox?: [number, number, number, number];
}

/** What an OCR observation adds to the shared shape. */
export interface OcrMetadata extends Record<string, unknown> {
  engine: string;
  engineVersion: string;
  /** Mean confidence across returned regions, 0..1. */
  meanConfidence: number;
  /** True when meanConfidence is below LOW_CONFIDENCE_THRESHOLD. */
  lowConfidence: boolean;
  regions: OcrRegion[];
  imagesRead: { from: number; to: number };
  /** Run-dir-relative paths of the retained source images, when the caller
   * persisted them. Empty when the caller chose not to. */
  sourceEvidenceIds: string[];
}

/** One OCR result from an engine. */
export interface OcrEngineResult {
  text: string;
  /** 0..1. */
  confidence: number;
  regions?: Array<{ text: string; confidence: number; bbox?: [number, number, number, number] }>;
}

/** The engine surface this adapter needs. Injected so the adapter is testable
 * without loading a real OCR runtime. */
export interface OcrEngine {
  readonly name: string;
  readonly version: string;
  recognize(image: Uint8Array, signal?: AbortSignal): Promise<OcrEngineResult>;
}

/** Options; `engine` is the seam, `persistImage` lets the caller keep the
 * source as evidence. */
export interface OcrContentReaderOptions {
  /** Supplies the engine. Defaults to a lazily-imported tesseract.js. */
  loadEngine?: () => Promise<OcrEngine>;
  /** Persists one source image and returns its Evidence ID. Omitted means the
   * caller accepts OCR text with no retained image — allowed, but the
   * observation says so. */
  persistImage?: (image: Uint8Array, index: number) => string;
  /** Splits a multi-image payload. Defaults to treating the bytes as one
   * image, which is what a direct image read is. */
  splitImages?: (bytes: Uint8Array) => Uint8Array[];
}

/**
 * Create the OCR adapter.
 *
 * @returns a reader whose observations always carry engine identity and
 *   confidence. The text itself is prefixed with an explicit low-confidence
 *   warning when the mean falls below LOW_CONFIDENCE_THRESHOLD, so a caller
 *   reading only the text still cannot mistake it for exact
 */
export function createOcrContentReader(options: OcrContentReaderOptions = {}): ContentReader {
  const loadEngine = options.loadEngine ?? loadTesseract;
  const splitImages = options.splitImages ?? ((bytes: Uint8Array): Uint8Array[] => [bytes]);

  return {
    name: 'ocr',
    formats: ['image'],
    async read(request: ContentReadRequest): Promise<ContentObservation> {
      throwIfAborted(request.signal);
      const images = splitImages(request.bytes);
      if (images.length === 0) throw new Error('no image data to recognize');

      const requested =
        request.range ?? { from: 1, to: Math.min(images.length, DEFAULT_OCR_IMAGE_SPAN) };
      assertContentRange(requested);
      if (requested.from > images.length) {
        throw new Error(
          `payload has ${images.length} image(s); requested range starts at ${requested.from}`,
        );
      }
      const from = requested.from;
      const to = Math.min(requested.to, images.length, from + MAX_OCR_IMAGE_SPAN - 1);

      const engine = await loadEngine();
      throwIfAborted(request.signal);

      const regions: OcrRegion[] = [];
      const texts: string[] = [];
      const sourceEvidenceIds: string[] = [];

      for (let index = from; index <= to; index += 1) {
        // OCR is slow enough that a cancelled run must not wait for the whole
        // range; check before each image.
        throwIfAborted(request.signal);
        const image = images[index - 1]!;
        const result = await engine.recognize(image, request.signal);

        if (options.persistImage !== undefined) {
          sourceEvidenceIds.push(options.persistImage(image, index));
        }

        const resultRegions = result.regions ?? [
          { text: result.text, confidence: result.confidence },
        ];
        for (const region of resultRegions) {
          regions.push({
            image: index,
            text: region.text,
            confidence: region.confidence,
            ...(region.bbox === undefined ? {} : { bbox: region.bbox }),
          });
        }
        texts.push(result.text);
      }

      const meanConfidence =
        regions.length === 0
          ? 0
          : regions.reduce((sum, region) => sum + region.confidence, 0) / regions.length;
      const lowConfidence = meanConfidence < LOW_CONFIDENCE_THRESHOLD;

      const body = texts.join('\n\n');
      // The warning goes in the TEXT, not only the metadata: a caller that
      // reads the text and ignores metadata must still see it.
      const header =
        `[OCR via ${engine.name} ${engine.version}, mean confidence ` +
        `${(meanConfidence * 100).toFixed(1)}%${
          lowConfidence ? ' — LOW CONFIDENCE, treat every character as uncertain' : ''
        }${
          sourceEvidenceIds.length === 0
            ? '; source image NOT retained'
            : `; source image(s) ${sourceEvidenceIds.join(', ')}`
        }]`;

      const metadata: OcrMetadata = {
        engine: engine.name,
        engineVersion: engine.version,
        meanConfidence,
        lowConfidence,
        regions,
        imagesRead: { from, to },
        sourceEvidenceIds,
      };

      return {
        format: 'image',
        text: `${header}\n${body}`,
        locator: from === to ? `image ${from}` : `images ${from}-${to}`,
        ...(to < images.length
          ? {
              continuation: {
                from: to + 1,
                to: Math.min(images.length, to + DEFAULT_OCR_IMAGE_SPAN),
              },
            }
          : {}),
        total: images.length,
        metadata,
      };
    },
  };
}

/** The production engine: tesseract.js, imported lazily because it pulls a
 * WASM runtime most runs never need. */
async function loadTesseract(): Promise<OcrEngine> {
  const tesseract = (await import('tesseract.js')) as unknown as {
    recognize: (
      image: Uint8Array,
      language?: string,
    ) => Promise<{ data: { text: string; confidence: number } }>;
    version?: string;
  };
  return {
    name: 'tesseract.js',
    version: tesseract.version ?? 'unknown',
    async recognize(image) {
      const result = await tesseract.recognize(image, 'eng');
      return {
        text: result.data.text,
        // tesseract reports 0..100; this adapter's contract is 0..1.
        confidence: result.data.confidence / 100,
      };
    },
  };
}
