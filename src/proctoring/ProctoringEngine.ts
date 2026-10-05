import type { FaceLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { EventInput, EventProgressUpdate } from '../lib/eventEngine';
import type { ProctorEvent } from '../types';
import type { AiRuntimeStatus, CameraRuntimeStatus, FaceRuntimeStatus } from '../extension/sessionState';
import {
  FaceCalibrator,
  SignalSmoother,
  estimateFaceState,
  extractRawFaceSignals,
  type HeadDirection,
} from '../vision/faceAnalysis';
import { loadFaceLandmarker } from '../vision/faceModel';
import { PhoneDetector } from '../vision/phoneDetection';
import { TemporalSignalTracker, type TemporalEpisodeSnapshot } from '../vision/temporal';

export interface ProctoringEngineStatus {
  cameraStatus?: CameraRuntimeStatus;
  faceStatus?: FaceRuntimeStatus;
  aiStatus?: AiRuntimeStatus;
  proctoringStatus?: string;
  lastAlert?: string | null;
  error?: string | null;
  faceFps?: number;
  phoneFps?: number;
}

export interface ProctoringEngineCallbacks {
  recordEvent: (input: EventInput) => Promise<ProctorEvent | null>;
  updateEvent: (id: string, update: EventProgressUpdate) => Promise<ProctorEvent | null>;
  updateStatus: (status: ProctoringEngineStatus) => void;
}

type DirectionEventType = 'HEAD_TURN' | 'LOOKING_AWAY';

interface ActiveDirectionEvent {
  id: string;
  label: string;
  scoreImpact: number;
}

const createTrackers = () => ({
  facePresent: new TemporalSignalTracker<'missing' | 'present'>({
    normalLabel: 'missing', minimumDurationMs: 600, cooldownMs: 10_000, recoveryGraceMs: 450, minimumConfidence: 0.35,
  }),
  faceMissing: new TemporalSignalTracker<'present' | 'missing'>({
    normalLabel: 'present', minimumDurationMs: 1_800, cooldownMs: 6_000, recoveryGraceMs: 500, minimumConfidence: 0.7,
  }),
  multipleFaces: new TemporalSignalTracker<'single' | 'multiple'>({
    normalLabel: 'single', minimumDurationMs: 1_200, cooldownMs: 8_000, recoveryGraceMs: 500, minimumConfidence: 0.4,
  }),
  head: new TemporalSignalTracker<HeadDirection>({
    normalLabel: 'normal', minimumDurationMs: 1_000, cooldownMs: 0, recoveryGraceMs: 0, minimumConfidence: 0.55,
  }),
  gaze: new TemporalSignalTracker<'normal' | 'left' | 'right' | 'up' | 'down'>({
    normalLabel: 'normal', minimumDurationMs: 1_000, cooldownMs: 0, recoveryGraceMs: 0, minimumConfidence: 0.55,
  }),
  phone: new TemporalSignalTracker<'absent' | 'phone'>({
    normalLabel: 'absent', minimumDurationMs: 0, cooldownMs: 1_000, recoveryGraceMs: 750, minimumConfidence: 0.5,
  }),
});

const describeCameraError = (error: unknown): string => {
  const name = error instanceof Error ? error.name : 'UnknownError';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Camera permission was denied. Allow camera access for Look At Me! and retry.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No camera was found.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'The camera is busy or unavailable.';
  if (name === 'OverconstrainedError') return 'The camera does not support the requested video settings.';
  return `Camera could not start: ${error instanceof Error ? error.message : String(error)}`;
};

const formatDuration = (duration: number): string => `${(duration / 1_000).toFixed(1)} s`;

export class ProctoringEngine {
  private readonly callbacks: ProctoringEngineCallbacks;
  private readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private faceModel: FaceLandmarker | null = null;
  private phoneModel: PhoneDetector | null = null;
  private faceTimer: number | null = null;
  private phoneTimer: number | null = null;
  private active = false;
  private sessionId: string | null = null;
  private startingSessionId: string | null = null;
  private faceInferenceBusy = false;
  private phoneInferenceBusy = false;
  private lastVideoTime = -1;
  private lastPhoneInferenceAt = 0;
  private inferenceFailures = 0;
  private phoneInferenceFailures = 0;
  private trackers = createTrackers();
  private calibrator = new FaceCalibrator();
  private smoothers = {
    yaw: new SignalSmoother(),
    pitch: new SignalSmoother(),
    roll: new SignalSmoother(),
    gazeHorizontal: new SignalSmoother(),
    gazeVertical: new SignalSmoother(),
  };
  private activeDirectionEvents: Record<DirectionEventType, ActiveDirectionEvent | null> = {
    HEAD_TURN: null,
    LOOKING_AWAY: null,
  };
  private faceFps = { startedAt: performance.now(), frames: 0, fps: 0 };
  private phoneFps = { startedAt: performance.now(), frames: 0, fps: 0 };

  constructor(callbacks: ProctoringEngineCallbacks) {
    this.callbacks = callbacks;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.setAttribute('aria-hidden', 'true');
    this.video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.append(this.video);
  }

  public get isActive(): boolean {
    return this.active;
  }

  public async start(sessionId: string): Promise<void> {
    if ((this.active && this.sessionId === sessionId) || this.startingSessionId === sessionId) {
      this.callbacks.updateStatus({ proctoringStatus: 'Camera and local CV are already active.' });
      return;
    }
    await this.stop();
    this.resetRuntime();
    this.sessionId = sessionId;
    this.startingSessionId = sessionId;
    this.callbacks.updateStatus({
      cameraStatus: 'REQUESTING',
      faceStatus: 'UNKNOWN',
      aiStatus: 'LOADING',
      proctoringStatus: 'Starting camera and local AI models…',
      error: null,
    });

    if (!navigator.mediaDevices?.getUserMedia) {
      await this.failStart('This Chrome context does not expose the camera API.');
      this.startingSessionId = null;
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' },
        audio: false,
      });
      this.stream = stream;
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => void this.handleUnexpectedCameraEnd(stream), { once: true });
      }
      this.video.srcObject = stream;
      await this.video.play();
      this.callbacks.updateStatus({ cameraStatus: 'ON', proctoringStatus: 'Camera is on. Loading MediaPipe and YOLO…' });
    } catch (error) {
      await this.failStart(describeCameraError(error));
      this.startingSessionId = null;
      return;
    }

    const [faceLoad, phoneLoad] = await Promise.allSettled([
      loadFaceLandmarker(),
      PhoneDetector.load(),
    ]);
    const failures: string[] = [];

    if (faceLoad.status === 'fulfilled') {
      this.faceModel = faceLoad.value.model;
    } else {
      failures.push(`MediaPipe Face Landmarker: ${faceLoad.reason instanceof Error ? faceLoad.reason.message : String(faceLoad.reason)}`);
    }
    if (phoneLoad.status === 'fulfilled') {
      this.phoneModel = phoneLoad.value;
    } else {
      failures.push(`YOLOv8n: ${phoneLoad.reason instanceof Error ? phoneLoad.reason.message : String(phoneLoad.reason)}`);
    }

    if (!this.faceModel && !this.phoneModel) {
      const message = `Local AI models could not start. ${failures.join(' ')}`;
      await this.callbacks.recordEvent({
        type: 'MODEL_FAILURE', duration: 0, confidence: 1, severity: 0, explanation: message, source: 'system',
      });
      await this.failStart(message);
      this.startingSessionId = null;
      return;
    }

    if (failures.length) {
      await this.callbacks.recordEvent({
        type: 'MODEL_FAILURE',
        duration: 0,
        confidence: 1,
        severity: 0,
        explanation: failures.join(' '),
        source: 'system',
      });
    }

    this.active = true;
    this.startingSessionId = null;
    this.startInferenceLoops();
    this.callbacks.updateStatus({
      cameraStatus: 'ON',
      faceStatus: 'CALIBRATING',
      aiStatus: failures.length ? 'DEGRADED' : 'ACTIVE',
      proctoringStatus: failures.length
        ? 'Proctoring is active with a reported model limitation.'
        : 'Camera, MediaPipe, and YOLO are active locally.',
      error: failures.length ? failures.join(' ') : null,
    });
  }

  public async stop(): Promise<void> {
    this.active = false;
    if (this.faceTimer !== null) window.clearInterval(this.faceTimer);
    if (this.phoneTimer !== null) window.clearInterval(this.phoneTimer);
    this.faceTimer = null;
    this.phoneTimer = null;
    const stream = this.stream;
    this.stream = null;
    stream?.getTracks().forEach((track) => track.stop());
    this.video.pause();
    this.video.srcObject = null;
    this.faceModel?.close();
    this.faceModel = null;
    if (this.phoneModel) await this.phoneModel.dispose();
    this.phoneModel = null;
    this.sessionId = null;
    this.startingSessionId = null;
    this.callbacks.updateStatus({
      cameraStatus: 'OFF',
      faceStatus: 'UNKNOWN',
      aiStatus: 'IDLE',
      proctoringStatus: 'Local camera and CV stopped.',
      lastAlert: null,
    });
  }

  private resetRuntime(): void {
    this.trackers = createTrackers();
    this.calibrator.reset();
    Object.values(this.smoothers).forEach((smoother) => smoother.reset());
    this.activeDirectionEvents = { HEAD_TURN: null, LOOKING_AWAY: null };
    this.lastVideoTime = -1;
    this.lastPhoneInferenceAt = 0;
    this.inferenceFailures = 0;
    this.phoneInferenceFailures = 0;
    this.faceFps = { startedAt: performance.now(), frames: 0, fps: 0 };
    this.phoneFps = { startedAt: performance.now(), frames: 0, fps: 0 };
  }

  private startInferenceLoops(): void {
    this.faceTimer = window.setInterval(() => {
      if (!this.active || !this.faceModel || this.faceInferenceBusy) return;
      this.faceInferenceBusy = true;
      void this.analyzeFaceFrame().finally(() => { this.faceInferenceBusy = false; });
    }, 180);
    this.phoneTimer = window.setInterval(() => {
      if (!this.active || !this.phoneModel || this.phoneInferenceBusy) return;
      this.phoneInferenceBusy = true;
      void this.analyzePhoneFrame().finally(() => { this.phoneInferenceBusy = false; });
    }, 600);
  }

  private async analyzeFaceFrame(): Promise<void> {
    const model = this.faceModel;
    if (!model || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;
    const startedAt = performance.now();
    const now = Date.now();

    try {
      const result = model.detectForVideo(this.video, startedAt);
      const faces = result.faceLandmarks;
      await this.emitFaceEvents(faces.length, faces, now);
      this.tickFps(this.faceFps, startedAt);

      const faceStatus: FaceRuntimeStatus = faces.length === 0
        ? 'NOT_DETECTED'
        : faces.length > 1
          ? 'MULTIPLE'
          : this.calibrator.ready ? 'DETECTED' : 'CALIBRATING';
      this.callbacks.updateStatus({ faceStatus, faceFps: this.faceFps.fps });

      if (faces.length !== 1) {
        await this.updateDirectionEpisode('HEAD_TURN', this.trackers.head, 'normal', 0, now);
        await this.updateDirectionEpisode('LOOKING_AWAY', this.trackers.gaze, 'normal', 0, now);
        return;
      }

      const raw = extractRawFaceSignals(faces[0]);
      if (!raw) return;
      this.calibrator.add(raw);
      const calibration = this.calibrator.calibration;
      if (!calibration) {
        this.callbacks.updateStatus({
          faceStatus: 'CALIBRATING',
          proctoringStatus: 'Calibrating neutral head pose. Look at the center of the screen.',
        });
        return;
      }

      const estimate = estimateFaceState({
        ...raw,
        yaw: this.smoothers.yaw.update(raw.yaw),
        pitch: this.smoothers.pitch.update(raw.pitch),
        roll: this.smoothers.roll.update(raw.roll),
        gazeHorizontal: this.smoothers.gazeHorizontal.update(raw.gazeHorizontal),
        gazeVertical: this.smoothers.gazeVertical.update(raw.gazeVertical),
      }, calibration);
      await this.updateDirectionEpisode('HEAD_TURN', this.trackers.head, estimate.head.direction, estimate.head.confidence, now);
      const gazeLabel = estimate.head.direction === 'normal' && estimate.gaze.available && estimate.gaze.direction !== 'unavailable'
        ? estimate.gaze.direction
        : 'normal';
      await this.updateDirectionEpisode('LOOKING_AWAY', this.trackers.gaze, gazeLabel, estimate.gaze.confidence, now);
      this.inferenceFailures = 0;
      this.callbacks.updateStatus({
        faceStatus: 'DETECTED',
        proctoringStatus: 'Local face, head pose, gaze, and phone analysis is active.',
      });
    } catch (error) {
      this.inferenceFailures += 1;
      if (this.inferenceFailures === 3) {
        const message = error instanceof Error ? error.message : String(error);
        await this.callbacks.recordEvent({
          type: 'INFERENCE_FAILURE', duration: 0, confidence: 1, severity: 0,
          explanation: `MediaPipe inference failed repeatedly: ${message}`, source: 'system',
        });
        this.callbacks.updateStatus({ aiStatus: 'DEGRADED', error: `MediaPipe inference: ${message}` });
      }
    }
  }

  private async emitFaceEvents(faceCount: number, landmarks: NormalizedLandmark[][], now: number): Promise<void> {
    const qualities = landmarks.map(extractRawFaceSignals).filter((result) => result !== null).map((result) => result.quality);
    const quality = qualities.length ? qualities.reduce((sum, value) => sum + value, 0) / qualities.length : 0;
    const present = this.trackers.facePresent.update(faceCount > 0 ? 'present' : 'missing', quality, now);
    if (present) await this.callbacks.recordEvent({
      type: 'FACE_DETECTED', duration: present.duration, confidence: present.confidence, severity: 0,
      explanation: `A face was stably visible across ${present.samples} analyzed frames.`, source: 'cv',
      metadata: { samples: present.samples, confidenceKind: 'geometry-and-temporal' },
    });
    const missing = this.trackers.faceMissing.update(faceCount === 0 ? 'missing' : 'present', faceCount === 0 ? 1 : 0, now);
    if (missing) {
      await this.callbacks.recordEvent({
        type: 'FACE_NOT_DETECTED', duration: missing.duration, confidence: missing.confidence, severity: 4,
        explanation: `No face was returned by MediaPipe across ${missing.samples} analyzed frames.`, source: 'cv',
        metadata: { samples: missing.samples, confidenceKind: 'temporal-support' },
      });
      this.callbacks.updateStatus({ lastAlert: 'FACE NOT DETECTED' });
    }
    const multiple = this.trackers.multipleFaces.update(faceCount > 1 ? 'multiple' : 'single', quality, now);
    if (multiple) {
      await this.callbacks.recordEvent({
        type: 'MULTIPLE_FACES', duration: multiple.duration, confidence: multiple.confidence, severity: 6,
        explanation: `${faceCount} faces remained visible across ${multiple.samples} analyzed frames.`, source: 'cv',
        metadata: { samples: multiple.samples, faceCount, confidenceKind: 'geometry-and-temporal' },
      });
      this.callbacks.updateStatus({ lastAlert: 'MULTIPLE FACES' });
    }
  }

  private async updateDirectionEpisode<T extends string>(
    type: DirectionEventType,
    tracker: TemporalSignalTracker<T>,
    label: T,
    confidence: number,
    now: number,
  ): Promise<void> {
    const before = tracker.getActiveEpisode();
    const trigger = tracker.update(label, confidence, now);
    const after = tracker.getActiveEpisode();
    let active = this.activeDirectionEvents[type];

    if (active && before && (!after || after.label !== active.label)) {
      await this.writeDirectionProgress(type, active, before);
      this.activeDirectionEvents[type] = null;
      active = null;
      this.callbacks.updateStatus({ lastAlert: null });
    }

    if (trigger) {
      const event = await this.callbacks.recordEvent({
        type,
        duration: trigger.duration,
        confidence: trigger.confidence,
        severity: 4,
        explanation: type === 'HEAD_TURN'
          ? `Approximate head pose stayed ${trigger.label} for ${formatDuration(trigger.duration)}.`
          : `Possible gaze deviation stayed ${trigger.label} for ${formatDuration(trigger.duration)}.`,
        source: 'cv',
        metadata: { direction: trigger.label, samples: trigger.samples, confidenceKind: 'geometry-and-temporal' },
      });
      if (event) {
        active = { id: event.id, label: trigger.label, scoreImpact: event.scoreImpact };
        this.activeDirectionEvents[type] = active;
        this.callbacks.updateStatus({ lastAlert: type.replace(/_/g, ' ') });
      }
    }

    if (active && after?.emitted && after.label === active.label) {
      const previousSecond = Math.floor((before?.duration ?? 0) / 1_000);
      const currentSecond = Math.floor(after.duration / 1_000);
      if (currentSecond > previousSecond) {
        await this.writeDirectionProgress(type, active, after);
      }
    }
  }

  private async writeDirectionProgress<T extends string>(
    type: DirectionEventType,
    active: ActiveDirectionEvent,
    episode: TemporalEpisodeSnapshot<T>,
  ): Promise<void> {
    const updated = await this.callbacks.updateEvent(active.id, {
      duration: episode.duration,
      confidence: episode.confidence,
      explanation: type === 'HEAD_TURN'
        ? `Approximate head pose stayed ${episode.label} for ${formatDuration(episode.duration)}.`
        : `Possible gaze deviation stayed ${episode.label} for ${formatDuration(episode.duration)}.`,
      metadata: { direction: episode.label, samples: episode.samples, confidenceKind: 'geometry-and-temporal' },
    });
    if (updated) active.scoreImpact = updated.scoreImpact;
  }

  private async analyzePhoneFrame(): Promise<void> {
    const detector = this.phoneModel;
    if (!detector || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    try {
      const now = Date.now();
      const result = await detector.detect(this.video);
      if (this.lastPhoneInferenceAt > 0 && now - this.lastPhoneInferenceAt > 1_500) this.trackers.phone.reset();
      this.lastPhoneInferenceAt = now;
      const best = result.detections[0];
      const trigger = this.trackers.phone.update(best ? 'phone' : 'absent', best?.confidence ?? 0, now);
      this.tickFps(this.phoneFps, performance.now());
      this.phoneInferenceFailures = 0;
      this.callbacks.updateStatus({ phoneFps: this.phoneFps.fps });
      if (trigger && best) {
        await this.callbacks.recordEvent({
          type: 'PHONE_DETECTED',
          duration: trigger.duration,
          confidence: trigger.confidence,
          severity: 8,
          explanation: 'Possible smartphone (COCO cell phone) detected in the camera frame. Human review is required.',
          source: 'cv',
          metadata: {
            samples: trigger.samples,
            class: best.className,
            classId: best.classId,
            bboxX: Math.round(best.bbox.x),
            bboxY: Math.round(best.bbox.y),
            bboxWidth: Math.round(best.bbox.width),
            bboxHeight: Math.round(best.bbox.height),
            model: 'YOLOv8n COCO ONNX',
            confidenceKind: 'model-class-score',
          },
        });
        this.callbacks.updateStatus({ lastAlert: `PHONE DETECTED · ${Math.round(best.confidence * 100)}%` });
      }
    } catch (error) {
      this.phoneInferenceFailures += 1;
      if (this.phoneInferenceFailures === 3) {
        const message = error instanceof Error ? error.message : String(error);
        await this.callbacks.recordEvent({
          type: 'INFERENCE_FAILURE', duration: 0, confidence: 1, severity: 0,
          explanation: `YOLOv8n inference failed repeatedly: ${message}`, source: 'system',
        });
        this.callbacks.updateStatus({ aiStatus: 'DEGRADED', error: `YOLO inference: ${message}` });
      }
    }
  }

  private tickFps(counter: { startedAt: number; frames: number; fps: number }, now: number): void {
    counter.frames += 1;
    const elapsed = now - counter.startedAt;
    if (elapsed >= 1_000) {
      counter.fps = counter.frames * 1_000 / elapsed;
      counter.frames = 0;
      counter.startedAt = now;
    }
  }

  private async failStart(message: string): Promise<void> {
    this.callbacks.updateStatus({
      cameraStatus: 'ERROR', faceStatus: 'UNKNOWN', aiStatus: 'ERROR',
      proctoringStatus: message, error: message,
    });
    await this.callbacks.recordEvent({
      type: 'CAMERA_BLOCKED', duration: 0, confidence: 1, severity: 5,
      explanation: message, source: 'system', scoreImpact: 0,
    });
    await this.stop();
    this.callbacks.updateStatus({ cameraStatus: 'ERROR', aiStatus: 'ERROR', proctoringStatus: message, error: message });
  }

  private async handleUnexpectedCameraEnd(stream: MediaStream): Promise<void> {
    if (!this.active || this.stream !== stream) return;
    this.active = false;
    await this.callbacks.recordEvent({
      type: 'CAMERA_BLOCKED', duration: 0, confidence: 1, severity: 5,
      explanation: 'The active camera stream ended unexpectedly.', source: 'system',
    });
    this.callbacks.updateStatus({
      cameraStatus: 'ERROR', aiStatus: 'ERROR', proctoringStatus: 'Camera stream ended unexpectedly.',
      error: 'Camera stream ended unexpectedly.',
    });
  }
}
