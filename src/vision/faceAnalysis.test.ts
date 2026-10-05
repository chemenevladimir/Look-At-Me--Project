import { describe, expect, it } from 'vitest';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { estimateFaceState, extractRawFaceSignals, type FaceCalibration } from './faceAnalysis';

const landmark = (x = 0.5, y = 0.5): NormalizedLandmark => ({ x, y, z: 0, visibility: 1 });

const neutralFace = (): NormalizedLandmark[] => {
  const result = Array.from({ length: 478 }, () => landmark());
  result[10] = landmark(0.5, 0.2);
  result[152] = landmark(0.5, 0.8);
  result[234] = landmark(0.25, 0.5);
  result[454] = landmark(0.75, 0.5);
  result[1] = landmark(0.5, 0.51);
  result[33] = landmark(0.32, 0.4);
  result[133] = landmark(0.43, 0.4);
  result[362] = landmark(0.57, 0.4);
  result[263] = landmark(0.68, 0.4);
  result[159] = landmark(0.375, 0.38);
  result[145] = landmark(0.375, 0.42);
  result[386] = landmark(0.625, 0.38);
  result[374] = landmark(0.625, 0.42);
  [468, 469, 470, 471, 472].forEach((index) => { result[index] = landmark(0.375, 0.4); });
  [473, 474, 475, 476, 477].forEach((index) => { result[index] = landmark(0.625, 0.4); });
  return result;
};

describe('face analysis', () => {
  it('extracts iris-supported signals from MediaPipe landmarks', () => {
    const raw = extractRawFaceSignals(neutralFace());
    expect(raw).not.toBeNull();
    expect(raw?.gazeAvailable).toBe(true);
    expect(raw?.gazeHorizontal).toBeCloseTo(0.5, 1);
    expect(raw?.quality).toBeGreaterThan(0.5);
  });

  it('classifies calibrated head and iris deviations', () => {
    const neutral = extractRawFaceSignals(neutralFace());
    expect(neutral).not.toBeNull();
    const calibration: FaceCalibration = {
      yaw: neutral!.yaw,
      pitch: neutral!.pitch,
      roll: neutral!.roll,
      gazeHorizontal: neutral!.gazeHorizontal,
      gazeVertical: neutral!.gazeVertical,
    };

    const turnedFace = neutralFace();
    turnedFace[1] = landmark(0.58, 0.51);
    const turned = estimateFaceState(extractRawFaceSignals(turnedFace)!, calibration);
    expect(turned.head.direction).toBe('left');

    const gazeFace = neutralFace();
    [468, 469, 470, 471, 472].forEach((index) => { gazeFace[index] = landmark(0.41, 0.4); });
    [473, 474, 475, 476, 477].forEach((index) => { gazeFace[index] = landmark(0.66, 0.4); });
    const gaze = estimateFaceState(extractRawFaceSignals(gazeFace)!, calibration);
    expect(gaze.gaze.direction).toBe('left');
  });
});
