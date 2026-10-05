import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

export type HeadDirection = 'normal' | 'left' | 'right' | 'up' | 'down';
export type GazeDirection = 'normal' | 'left' | 'right' | 'up' | 'down' | 'unavailable';

export interface RawFaceSignals {
  yaw: number;
  pitch: number;
  roll: number;
  gazeHorizontal: number;
  gazeVertical: number;
  gazeAvailable: boolean;
  quality: number;
}

export interface FaceCalibration {
  yaw: number;
  pitch: number;
  roll: number;
  gazeHorizontal: number;
  gazeVertical: number;
}

export interface FaceEstimate {
  head: {
    direction: HeadDirection;
    yaw: number;
    pitch: number;
    roll: number;
    confidence: number;
  };
  gaze: {
    direction: GazeDirection;
    horizontal: number;
    vertical: number;
    confidence: number;
    available: boolean;
  };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const point = (landmarks: NormalizedLandmark[], index: number): NormalizedLandmark | null =>
  landmarks[index] ?? null;

const meanPoint = (landmarks: NormalizedLandmark[], indices: number[]): NormalizedLandmark | null => {
  const points = indices.map((index) => point(landmarks, index)).filter(Boolean) as NormalizedLandmark[];
  if (points.length !== indices.length) return null;

  return {
    x: points.reduce((total, item) => total + item.x, 0) / points.length,
    y: points.reduce((total, item) => total + item.y, 0) / points.length,
    z: points.reduce((total, item) => total + item.z, 0) / points.length,
    visibility: points.reduce((total, item) => total + (item.visibility ?? 1), 0) / points.length,
  };
};

const distance = (a: NormalizedLandmark, b: NormalizedLandmark): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

const projectionRatio = (
  target: NormalizedLandmark,
  start: NormalizedLandmark,
  end: NormalizedLandmark,
): number => {
  const axisX = end.x - start.x;
  const axisY = end.y - start.y;
  const lengthSquared = axisX * axisX + axisY * axisY;
  if (lengthSquared < 1e-8) return 0.5;
  return ((target.x - start.x) * axisX + (target.y - start.y) * axisY) / lengthSquared;
};

const verticalRatio = (
  target: NormalizedLandmark,
  top: NormalizedLandmark,
  bottom: NormalizedLandmark,
): number => {
  const span = bottom.y - top.y;
  if (Math.abs(span) < 1e-5) return 0.5;
  return (target.y - top.y) / span;
};

export function extractRawFaceSignals(landmarks: NormalizedLandmark[]): RawFaceSignals | null {
  const nose = point(landmarks, 1);
  const forehead = point(landmarks, 10);
  const chin = point(landmarks, 152);
  const leftCheek = point(landmarks, 234);
  const rightCheek = point(landmarks, 454);
  const rightOuterEye = point(landmarks, 33);
  const rightInnerEye = point(landmarks, 133);
  const leftInnerEye = point(landmarks, 362);
  const leftOuterEye = point(landmarks, 263);

  if (
    !nose || !forehead || !chin || !leftCheek || !rightCheek ||
    !rightOuterEye || !rightInnerEye || !leftInnerEye || !leftOuterEye
  ) {
    return null;
  }

  const faceWidth = distance(leftCheek, rightCheek);
  const faceHeight = distance(forehead, chin);
  const eyeSpan = distance(rightOuterEye, leftOuterEye);
  if (faceWidth < 0.01 || faceHeight < 0.01 || eyeSpan < 0.01) return null;

  const cheekCenterX = (leftCheek.x + rightCheek.x) / 2;
  const eyeCenterY = (rightOuterEye.y + rightInnerEye.y + leftInnerEye.y + leftOuterEye.y) / 4;
  const yaw = ((nose.x - cheekCenterX) / faceWidth) * 110;
  const pitch = ((nose.y - eyeCenterY) / faceHeight) * 95;
  const roll = (Math.atan2(leftOuterEye.y - rightOuterEye.y, leftOuterEye.x - rightOuterEye.x) * 180) / Math.PI;

  const rightIris = meanPoint(landmarks, [468, 469, 470, 471, 472]);
  const leftIris = meanPoint(landmarks, [473, 474, 475, 476, 477]);
  const rightTop = point(landmarks, 159);
  const rightBottom = point(landmarks, 145);
  const leftTop = point(landmarks, 386);
  const leftBottom = point(landmarks, 374);
  const gazeAvailable = Boolean(rightIris && leftIris && rightTop && rightBottom && leftTop && leftBottom);

  let gazeHorizontal = 0.5;
  let gazeVertical = 0.5;
  let eyeAgreement = 0;

  if (gazeAvailable && rightIris && leftIris && rightTop && rightBottom && leftTop && leftBottom) {
    const rightHorizontal = projectionRatio(rightIris, rightOuterEye, rightInnerEye);
    const leftHorizontal = projectionRatio(leftIris, leftInnerEye, leftOuterEye);
    const rightVertical = verticalRatio(rightIris, rightTop, rightBottom);
    const leftVertical = verticalRatio(leftIris, leftTop, leftBottom);
    gazeHorizontal = (rightHorizontal + leftHorizontal) / 2;
    gazeVertical = (rightVertical + leftVertical) / 2;
    eyeAgreement = 1 - clamp(
      Math.abs(rightHorizontal - leftHorizontal) + Math.abs(rightVertical - leftVertical),
      0,
      1,
    );
  }

  const sizeQuality = clamp((faceWidth - 0.08) / 0.2, 0, 1);
  const geometryQuality = clamp((eyeSpan / faceWidth - 0.35) / 0.25, 0, 1);
  const irisQuality = gazeAvailable ? 0.65 + eyeAgreement * 0.35 : 0.5;
  const quality = clamp(sizeQuality * 0.45 + geometryQuality * 0.25 + irisQuality * 0.3, 0, 1);

  return {
    yaw,
    pitch,
    roll,
    gazeHorizontal,
    gazeVertical,
    gazeAvailable,
    quality,
  };
}

export function estimateFaceState(
  raw: RawFaceSignals,
  calibration: FaceCalibration,
): FaceEstimate {
  const yaw = raw.yaw - calibration.yaw;
  const pitch = raw.pitch - calibration.pitch;
  const roll = raw.roll - calibration.roll;
  const gazeHorizontal = (raw.gazeHorizontal - calibration.gazeHorizontal) * 100;
  const gazeVertical = (raw.gazeVertical - calibration.gazeVertical) * 80;

  let headDirection: HeadDirection = 'normal';
  if (Math.abs(yaw) >= 11) {
    headDirection = yaw > 0 ? 'left' : 'right';
  } else if (Math.abs(pitch) >= 10) {
    headDirection = pitch > 0 ? 'down' : 'up';
  }

  let gazeDirection: GazeDirection = raw.gazeAvailable ? 'normal' : 'unavailable';
  if (raw.gazeAvailable && (Math.abs(gazeHorizontal) >= 12 || Math.abs(gazeVertical) >= 10)) {
    if (Math.abs(gazeHorizontal) >= Math.abs(gazeVertical)) {
      gazeDirection = gazeHorizontal > 0 ? 'left' : 'right';
    } else {
      gazeDirection = gazeVertical > 0 ? 'down' : 'up';
    }
  }

  const headMagnitude = Math.max(Math.abs(yaw) / 25, Math.abs(pitch) / 22);
  const gazeMagnitude = Math.max(Math.abs(gazeHorizontal) / 30, Math.abs(gazeVertical) / 25);

  return {
    head: {
      direction: headDirection,
      yaw,
      pitch,
      roll,
      confidence: clamp(raw.quality * 0.7 + Math.min(headMagnitude, 1) * 0.3, 0, 1),
    },
    gaze: {
      direction: gazeDirection,
      horizontal: gazeHorizontal,
      vertical: gazeVertical,
      confidence: raw.gazeAvailable
        ? clamp(raw.quality * 0.65 + Math.min(gazeMagnitude, 1) * 0.35, 0, 1)
        : 0,
      available: raw.gazeAvailable,
    },
  };
}

export class FaceCalibrator {
  private samples: RawFaceSignals[] = [];
  private readonly targetSamples: number;

  constructor(targetSamples = 12) {
    this.targetSamples = targetSamples;
  }

  public add(raw: RawFaceSignals): void {
    if (this.ready || raw.quality < 0.45) return;
    if (Math.abs(raw.yaw) > 18 || raw.gazeHorizontal < 0.2 || raw.gazeHorizontal > 0.8) return;
    this.samples.push(raw);
  }

  public get progress(): number {
    return clamp(this.samples.length / this.targetSamples, 0, 1);
  }

  public get ready(): boolean {
    return this.samples.length >= this.targetSamples;
  }

  public get calibration(): FaceCalibration | null {
    if (!this.ready) return null;
    return {
      yaw: median(this.samples.map((sample) => sample.yaw)),
      pitch: median(this.samples.map((sample) => sample.pitch)),
      roll: median(this.samples.map((sample) => sample.roll)),
      gazeHorizontal: median(this.samples.map((sample) => sample.gazeHorizontal)),
      gazeVertical: median(this.samples.map((sample) => sample.gazeVertical)),
    };
  }

  public reset(): void {
    this.samples = [];
  }
}

export class SignalSmoother {
  private value: number | null = null;
  private readonly alpha: number;

  constructor(alpha = 0.32) {
    this.alpha = clamp(alpha, 0.05, 1);
  }

  public update(next: number): number {
    this.value = this.value === null ? next : this.value + this.alpha * (next - this.value);
    return this.value;
  }

  public reset(): void {
    this.value = null;
  }
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};
