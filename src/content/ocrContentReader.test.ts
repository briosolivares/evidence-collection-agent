import { describe, expect, it } from 'vitest';

import {
  createOcrContentReader,
  LOW_CONFIDENCE_THRESHOLD,
  MAX_OCR_IMAGE_SPAN,
  type OcrEngine,
  type OcrMetadata,
} from './ocrContentReader.js';

// The property under test is honesty: OCR text must never look exact. Every
// observation carries engine identity and confidence, and a low-confidence
// read says so in the TEXT as well as the metadata.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function fakeEngine(
  confidence: number,
  text = 'recognized text',
  onRecognize?: (call: number) => void,
): OcrEngine {
  let calls = 0;
  return {
    name: 'fake-ocr',
    version: '1.2.3',
    async recognize() {
      calls += 1;
      onRecognize?.(calls);
      return { text, confidence };
    },
  };
}

function reader(engine: OcrEngine, extra: Record<string, unknown> = {}) {
  return createOcrContentReader({ loadEngine: async () => engine, ...extra });
}

describe('createOcrContentReader', () => {
  it('records the engine, its version, and the confidence', async () => {
    const observation = await reader(fakeEngine(0.93)).read({ bytes: PNG });
    const metadata = observation.metadata as OcrMetadata;

    expect(metadata.engine).toBe('fake-ocr');
    expect(metadata.engineVersion).toBe('1.2.3');
    expect(metadata.meanConfidence).toBeCloseTo(0.93);
    expect(metadata.lowConfidence).toBe(false);
    // Engine identity and confidence appear in the text too, so a caller
    // reading only the text cannot mistake OCR output for exact data.
    expect(observation.text).toContain('OCR via fake-ocr 1.2.3');
    expect(observation.text).toContain('93.0%');
    expect(observation.text).toContain('recognized text');
  });

  it('flags a low-confidence read in the text, not only the metadata', async () => {
    const observation = await reader(fakeEngine(LOW_CONFIDENCE_THRESHOLD - 0.2)).read({
      bytes: PNG,
    });

    expect((observation.metadata as OcrMetadata).lowConfidence).toBe(true);
    expect(observation.text).toContain('LOW CONFIDENCE');
    expect(observation.text).toContain('treat every character as uncertain');
  });

  it('says plainly when no source image was retained', async () => {
    const observation = await reader(fakeEngine(0.9)).read({ bytes: PNG });
    expect(observation.text).toContain('source image NOT retained');
    expect((observation.metadata as OcrMetadata).sourceEvidenceIds).toEqual([]);
  });

  it('records retained source images as evidence ids', async () => {
    const persisted: number[] = [];
    const observation = await reader(fakeEngine(0.9), {
      persistImage: (_image: Uint8Array, index: number) => {
        persisted.push(index);
        return `E${index}`;
      },
    }).read({ bytes: PNG });

    expect(persisted).toEqual([1]);
    expect((observation.metadata as OcrMetadata).sourceEvidenceIds).toEqual(['E1']);
    expect(observation.text).toContain('source image(s) E1');
  });

  it('labels each slice with its image range and offers a continuation', async () => {
    const images = [PNG, PNG, PNG];
    const observation = await reader(fakeEngine(0.9), {
      splitImages: () => images,
    }).read({ bytes: PNG });

    expect(observation.locator).toBe('image 1');
    expect(observation.total).toBe(3);
    // One image per call by default — OCR is the most expensive read here, so
    // the continuation advances by a single image rather than a batch.
    expect(observation.continuation).toEqual({ from: 2, to: 2 });
  });

  it('omits the continuation once the last image is covered', async () => {
    const observation = await reader(fakeEngine(0.9)).read({ bytes: PNG });
    expect(observation.continuation).toBeUndefined();
  });

  it('clamps an over-large range to the OCR ceiling', async () => {
    const images = Array.from({ length: MAX_OCR_IMAGE_SPAN + 4 }, () => PNG);
    const observation = await reader(fakeEngine(0.9), { splitImages: () => images }).read({
      bytes: PNG,
      range: { from: 1, to: images.length },
    });

    expect((observation.metadata as OcrMetadata).imagesRead).toEqual({
      from: 1,
      to: MAX_OCR_IMAGE_SPAN,
    });
    expect(observation.continuation).toBeDefined();
  });

  it('rejects a range past the payload and an invalid range', async () => {
    await expect(
      reader(fakeEngine(0.9)).read({ bytes: PNG, range: { from: 4, to: 5 } }),
    ).rejects.toThrow(/has 1 image/);
    await expect(
      reader(fakeEngine(0.9)).read({ bytes: PNG, range: { from: 2, to: 1 } }),
    ).rejects.toThrow(/range\.to/);
  });

  it('rejects an empty payload rather than reporting empty text', async () => {
    await expect(
      reader(fakeEngine(0.9), { splitImages: () => [] }).read({ bytes: PNG }),
    ).rejects.toThrow(/no image data/);
  });

  it('stops between images when cancelled', async () => {
    const controller = new AbortController();
    const images = Array.from({ length: MAX_OCR_IMAGE_SPAN }, () => PNG);
    const engine = fakeEngine(0.9, 'text', (call) => {
      if (call === 2) controller.abort();
    });

    await expect(
      reader(engine, { splitImages: () => images }).read({
        bytes: PNG,
        range: { from: 1, to: MAX_OCR_IMAGE_SPAN },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('averages confidence across regions when the engine reports them', async () => {
    const engine: OcrEngine = {
      name: 'fake-ocr',
      version: '1',
      async recognize() {
        return {
          text: 'a b',
          confidence: 0.5,
          regions: [
            { text: 'a', confidence: 0.9, bbox: [0, 0, 10, 10] },
            { text: 'b', confidence: 0.7 },
          ],
        };
      },
    };
    const observation = await reader(engine).read({ bytes: PNG });
    const metadata = observation.metadata as OcrMetadata;

    expect(metadata.regions).toHaveLength(2);
    expect(metadata.meanConfidence).toBeCloseTo(0.8);
    expect(metadata.regions[0]?.bbox).toEqual([0, 0, 10, 10]);
    // Each region knows which image it came from.
    expect(metadata.regions.every((region) => region.image === 1)).toBe(true);
  });
});
