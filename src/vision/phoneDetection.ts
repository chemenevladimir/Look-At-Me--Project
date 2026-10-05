import * as ort from 'onnxruntime-web/webgpu';

export const PHONE_CLASS_ID = 67;
export const PHONE_CLASS_NAME = 'cell phone';
export const PHONE_CONFIDENCE_THRESHOLD = 0.5;
export const PHONE_IOU_THRESHOLD = 0.45;

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PhoneDetection {
  classId: typeof PHONE_CLASS_ID;
  className: typeof PHONE_CLASS_NAME;
  confidence: number;
  bbox: BoundingBox;
}

export interface LetterboxTransform {
  sourceWidth: number;
  sourceHeight: number;
  inputWidth: number;
  inputHeight: number;
  scale: number;
  padX: number;
  padY: number;
}

export interface PhoneInferenceResult {
  detections: PhoneDetection[];
  inferenceMs: number;
  preprocessMs: number;
}

export type PhoneExecutionProvider = 'webgpu' | 'wasm';

const MODEL_PATH = 'models/yolov8n.onnx';
const ORT_ASSET_PATH = 'ort/';
const DEFAULT_INPUT_SIZE = 640;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum);

export function calculateLetterboxTransform(
  sourceWidth: number,
  sourceHeight: number,
  inputWidth = DEFAULT_INPUT_SIZE,
  inputHeight = DEFAULT_INPUT_SIZE,
): LetterboxTransform {
  if (sourceWidth <= 0 || sourceHeight <= 0 || inputWidth <= 0 || inputHeight <= 0) {
    throw new Error('YOLO preprocessing requires positive source and input dimensions.');
  }

  const scale = Math.min(inputWidth / sourceWidth, inputHeight / sourceHeight);
  const resizedWidth = sourceWidth * scale;
  const resizedHeight = sourceHeight * scale;

  return {
    sourceWidth,
    sourceHeight,
    inputWidth,
    inputHeight,
    scale,
    padX: (inputWidth - resizedWidth) / 2,
    padY: (inputHeight - resizedHeight) / 2,
  };
}

function intersectionOverUnion(first: BoundingBox, second: BoundingBox): number {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = first.width * first.height + second.width * second.height - intersection;
  return union > 0 ? intersection / union : 0;
}

export function suppressOverlappingDetections(
  detections: PhoneDetection[],
  iouThreshold = PHONE_IOU_THRESHOLD,
  maximumDetections = 5,
): PhoneDetection[] {
  const remaining = [...detections].sort((a, b) => b.confidence - a.confidence);
  const selected: PhoneDetection[] = [];

  while (remaining.length > 0 && selected.length < maximumDetections) {
    const candidate = remaining.shift();
    if (!candidate) break;
    selected.push(candidate);

    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (intersectionOverUnion(candidate.bbox, remaining[index].bbox) > iouThreshold) {
        remaining.splice(index, 1);
      }
    }
  }

  return selected;
}

export function parseYoloPhoneOutput(
  data: ArrayLike<number>,
  dimensions: readonly number[],
  transform: LetterboxTransform,
  confidenceThreshold = PHONE_CONFIDENCE_THRESHOLD,
): PhoneDetection[] {
  if (dimensions.length !== 3 || dimensions[0] !== 1) {
    throw new Error(`Unexpected YOLO output shape: [${dimensions.join(', ')}].`);
  }

  const channelFirst = dimensions[1] >= 84 && dimensions[1] <= 256;
  const channelLast = dimensions[2] >= 84 && dimensions[2] <= 256;
  if (!channelFirst && !channelLast) {
    throw new Error(`YOLO output must contain at least 84 channels, received [${dimensions.join(', ')}].`);
  }

  const channels = channelFirst ? dimensions[1] : dimensions[2];
  const candidates = channelFirst ? dimensions[2] : dimensions[1];
  if (PHONE_CLASS_ID + 4 >= channels || data.length < channels * candidates) {
    throw new Error('YOLO output does not contain the COCO cell phone confidence channel.');
  }

  const valueAt = (channel: number, candidate: number): number => channelFirst
    ? Number(data[channel * candidates + candidate])
    : Number(data[candidate * channels + channel]);
  const detections: PhoneDetection[] = [];

  for (let candidate = 0; candidate < candidates; candidate += 1) {
    const confidence = valueAt(4 + PHONE_CLASS_ID, candidate);
    if (!Number.isFinite(confidence) || confidence < confidenceThreshold) continue;

    const centerX = valueAt(0, candidate);
    const centerY = valueAt(1, candidate);
    const width = valueAt(2, candidate);
    const height = valueAt(3, candidate);
    if (![centerX, centerY, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;

    const modelLeft = centerX - width / 2;
    const modelTop = centerY - height / 2;
    const modelRight = centerX + width / 2;
    const modelBottom = centerY + height / 2;
    const left = clamp((modelLeft - transform.padX) / transform.scale, 0, transform.sourceWidth);
    const top = clamp((modelTop - transform.padY) / transform.scale, 0, transform.sourceHeight);
    const right = clamp((modelRight - transform.padX) / transform.scale, 0, transform.sourceWidth);
    const bottom = clamp((modelBottom - transform.padY) / transform.scale, 0, transform.sourceHeight);
    if (right <= left || bottom <= top) continue;

    detections.push({
      classId: PHONE_CLASS_ID,
      className: PHONE_CLASS_NAME,
      confidence,
      bbox: { x: left, y: top, width: right - left, height: bottom - top },
    });
  }

  return suppressOverlappingDetections(detections);
}

function preprocessVideoFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  inputWidth: number,
  inputHeight: number,
): { tensorData: Float32Array; transform: LetterboxTransform } {
  const transform = calculateLetterboxTransform(
    video.videoWidth,
    video.videoHeight,
    inputWidth,
    inputHeight,
  );
  canvas.width = inputWidth;
  canvas.height = inputHeight;
  context.fillStyle = 'rgb(114, 114, 114)';
  context.fillRect(0, 0, inputWidth, inputHeight);
  context.drawImage(
    video,
    transform.padX,
    transform.padY,
    transform.sourceWidth * transform.scale,
    transform.sourceHeight * transform.scale,
  );

  const pixels = context.getImageData(0, 0, inputWidth, inputHeight).data;
  const planeSize = inputWidth * inputHeight;
  const tensorData = new Float32Array(planeSize * 3);
  for (let pixel = 0; pixel < planeSize; pixel += 1) {
    const rgbaOffset = pixel * 4;
    tensorData[pixel] = pixels[rgbaOffset] / 255;
    tensorData[planeSize + pixel] = pixels[rgbaOffset + 1] / 255;
    tensorData[planeSize * 2 + pixel] = pixels[rgbaOffset + 2] / 255;
  }

  return { tensorData, transform };
}

function resolveAssetUrl(relativePath: string): string {
  return new URL(relativePath, document.baseURI).toString();
}

export class PhoneDetector {
  public readonly provider: PhoneExecutionProvider;
  public readonly inputWidth: number;
  public readonly inputHeight: number;

  private readonly session: ort.InferenceSession;
  private readonly inputName: string;
  private readonly outputName: string;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;

  private constructor(session: ort.InferenceSession, provider: PhoneExecutionProvider) {
    const metadata = session.inputMetadata[0];
    const shape = metadata && 'shape' in metadata ? metadata.shape : [];
    const height = shape[2];
    const width = shape[3];
    this.inputHeight = typeof height === 'number' ? height : DEFAULT_INPUT_SIZE;
    this.inputWidth = typeof width === 'number' ? width : DEFAULT_INPUT_SIZE;
    this.session = session;
    this.provider = provider;
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
    this.canvas = document.createElement('canvas');
    const context = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('A 2D canvas is required for YOLO frame preprocessing.');
    this.context = context;
  }

  public static async load(): Promise<PhoneDetector> {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = resolveAssetUrl(ORT_ASSET_PATH);
    const modelUrl = resolveAssetUrl(MODEL_PATH);
    const webGpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator;
    const attempts: Array<{ provider: PhoneExecutionProvider; executionProviders: ort.InferenceSession.ExecutionProviderConfig[] }> = webGpuAvailable
      ? [
          { provider: 'webgpu', executionProviders: ['webgpu', 'wasm'] },
          { provider: 'wasm', executionProviders: ['wasm'] },
        ]
      : [{ provider: 'wasm', executionProviders: ['wasm'] }];
    const failures: string[] = [];

    for (const attempt of attempts) {
      try {
        const session = await ort.InferenceSession.create(modelUrl, {
          executionProviders: attempt.executionProviders,
          graphOptimizationLevel: 'all',
        });
        return new PhoneDetector(session, attempt.provider);
      } catch (error) {
        failures.push(`${attempt.provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`YOLOv8n could not be loaded (${failures.join(' | ')}).`);
  }

  public async detect(video: HTMLVideoElement): Promise<PhoneInferenceResult> {
    if (video.videoWidth <= 0 || video.videoHeight <= 0) {
      throw new Error('The camera frame has no usable dimensions.');
    }

    const preprocessStartedAt = performance.now();
    const { tensorData, transform } = preprocessVideoFrame(
      video,
      this.canvas,
      this.context,
      this.inputWidth,
      this.inputHeight,
    );
    const preprocessMs = performance.now() - preprocessStartedAt;
    const tensor = new ort.Tensor('float32', tensorData, [1, 3, this.inputHeight, this.inputWidth]);
    const inferenceStartedAt = performance.now();
    const outputs = await this.session.run({ [this.inputName]: tensor });
    const inferenceMs = performance.now() - inferenceStartedAt;
    const output = outputs[this.outputName];
    if (!output || !('dims' in output) || !('data' in output)) {
      throw new Error(`YOLOv8n did not return the expected output '${this.outputName}'.`);
    }

    return {
      detections: parseYoloPhoneOutput(output.data as ArrayLike<number>, output.dims, transform),
      inferenceMs,
      preprocessMs,
    };
  }

  public async dispose(): Promise<void> {
    await this.session.release();
  }
}
