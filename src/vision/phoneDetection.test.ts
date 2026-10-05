import { describe, expect, it } from 'vitest';
import {
  PHONE_CLASS_ID,
  calculateLetterboxTransform,
  parseYoloPhoneOutput,
  suppressOverlappingDetections,
  type PhoneDetection,
} from './phoneDetection';

describe('YOLOv8 phone postprocessing', () => {
  it('computes a centered 16:9 letterbox transform', () => {
    expect(calculateLetterboxTransform(1280, 720, 640, 640)).toEqual({
      sourceWidth: 1280,
      sourceHeight: 720,
      inputWidth: 640,
      inputHeight: 640,
      scale: 0.5,
      padX: 0,
      padY: 140,
    });
  });

  it('reads the COCO cell phone channel and maps the box to source pixels', () => {
    const candidates = 2;
    const channels = 84;
    const output = new Float32Array(channels * candidates);
    const set = (channel: number, candidate: number, value: number) => {
      output[channel * candidates + candidate] = value;
    };
    for (const candidate of [0, 1]) {
      set(0, candidate, 320 + candidate * 4);
      set(1, candidate, 320 + candidate * 4);
      set(2, candidate, 200);
      set(3, candidate, 300);
      set(4 + PHONE_CLASS_ID, candidate, candidate === 0 ? 0.91 : 0.72);
    }

    const detections = parseYoloPhoneOutput(
      output,
      [1, channels, candidates],
      calculateLetterboxTransform(1280, 720, 640, 640),
    );

    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({
      classId: 67,
      className: 'cell phone',
      confidence: expect.closeTo(0.91, 5),
      bbox: {
        x: expect.closeTo(440, 5),
        y: expect.closeTo(60, 5),
        width: expect.closeTo(400, 5),
        height: expect.closeTo(600, 5),
      },
    });
  });

  it('supports channel-last exports and filters low-confidence candidates', () => {
    const channels = 84;
    const output = new Float32Array(channels);
    output[0] = 320;
    output[1] = 320;
    output[2] = 120;
    output[3] = 180;
    output[4 + PHONE_CLASS_ID] = 0.49;

    expect(parseYoloPhoneOutput(
      output,
      [1, 1, channels],
      calculateLetterboxTransform(640, 640),
    )).toEqual([]);
  });

  it('keeps spatially separate phones during non-maximum suppression', () => {
    const detection = (x: number, confidence: number): PhoneDetection => ({
      classId: PHONE_CLASS_ID,
      className: 'cell phone',
      confidence,
      bbox: { x, y: 10, width: 100, height: 160 },
    });

    expect(suppressOverlappingDetections([
      detection(10, 0.9),
      detection(14, 0.7),
      detection(300, 0.65),
    ])).toEqual([detection(10, 0.9), detection(300, 0.65)]);
  });

  it('rejects an incompatible output shape instead of inventing detections', () => {
    expect(() => parseYoloPhoneOutput(
      new Float32Array(10),
      [1, 10],
      calculateLetterboxTransform(640, 640),
    )).toThrow(/Unexpected YOLO output shape/);
  });
});
