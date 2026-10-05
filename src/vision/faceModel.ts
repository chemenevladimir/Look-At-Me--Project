import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerOptions,
} from '@mediapipe/tasks-vision';

const assetUrl = (path: string): string => new URL(path, window.location.href).toString();

const optionsFor = (delegate: 'GPU' | 'CPU'): FaceLandmarkerOptions => ({
  baseOptions: {
    modelAssetPath: assetUrl('models/face_landmarker.task'),
    delegate,
  },
  runningMode: 'VIDEO',
  numFaces: 3,
  minFaceDetectionConfidence: 0.55,
  minFacePresenceConfidence: 0.55,
  minTrackingConfidence: 0.55,
  outputFacialTransformationMatrixes: true,
});

export async function loadFaceLandmarker(): Promise<{ model: FaceLandmarker; delegate: 'GPU' | 'CPU' }> {
  const vision = await FilesetResolver.forVisionTasks(assetUrl('mediapipe/wasm'));

  try {
    const model = await FaceLandmarker.createFromOptions(vision, optionsFor('GPU'));
    return { model, delegate: 'GPU' };
  } catch (gpuError) {
    console.warn('MediaPipe GPU delegate failed; retrying on CPU.', gpuError);
    const model = await FaceLandmarker.createFromOptions(vision, optionsFor('CPU'));
    return { model, delegate: 'CPU' };
  }
}
