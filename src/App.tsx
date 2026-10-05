import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Camera,
  CircleAlert,
  Eye,
  Gauge,
  ShieldCheck,
} from 'lucide-react';
import type { FaceLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { EventTimeline } from './components/EventTimeline';
import { MonitoringPanel } from './components/MonitoringPanel';
import { SecurityStatusPanel } from './components/SecurityStatusPanel';
import { SessionControls } from './components/SessionControls';
import { ExtensionSecurityBridge } from './browser/extensionBridge';
import { startLocalBrowserMonitor } from './browser/localBrowserMonitor';
import { normalizeSecurityEvent } from './browser/securityEvents';
import { EventEngine } from './lib/eventEngine';
import {
  loadProctoringSession,
  loadSessionEvents,
  saveProctoringSession,
  saveSessionEvents,
} from './lib/storage';
import type {
  ModelStatus,
  ProctorEvent,
  ProctorEventType,
  SecurityAgentStatus,
  SessionSummary,
  ProctoringSessionState,
} from './types';
import {
  FaceCalibrator,
  SignalSmoother,
  estimateFaceState,
  extractRawFaceSignals,
  type GazeDirection,
  type HeadDirection,
} from './vision/faceAnalysis';
import { loadFaceLandmarker } from './vision/faceModel';
import {
  PhoneDetector,
  type PhoneDetection,
  type PhoneExecutionProvider,
} from './vision/phoneDetection';
import { TemporalSignalTracker, type TemporalEpisodeSnapshot } from './vision/temporal';

const initialSession = (): ProctoringSessionState => ({
  id: `session-${Date.now()}`,
  status: 'idle',
  startedAt: null,
  endedAt: null,
  elapsedSeconds: 0,
});

const initialSummary: SessionSummary = {
  score: 0,
  eventCount: 0,
  severeEvents: 0,
  confidence: 0,
  breakdown: { severity: 0, confidence: 0, duration: 0, repeatedEvents: 0, byType: {} },
};

const initialAgentStatus: SecurityAgentStatus = {
  state: 'unavailable',
  message: 'The local Windows agent has not connected yet.',
  capabilities: [],
  limitations: [],
};

const emptyDebug = () => ({
  faceCount: 0,
  landmarkCount: 0,
  calibration: 0,
  head: { direction: 'normal' as HeadDirection, yaw: 0, pitch: 0, roll: 0, confidence: 0 },
  gaze: {
    direction: 'unavailable' as GazeDirection,
    horizontal: 0,
    vertical: 0,
    confidence: 0,
    available: false,
  },
  fps: 0,
  inferenceMs: 0,
  delegate: '—',
});

const emptyPhoneDebug = (provider: PhoneExecutionProvider | '—' = '—') => ({
  fps: 0,
  inferenceMs: 0,
  preprocessMs: 0,
  provider,
});

const createTrackers = () => ({
  facePresent: new TemporalSignalTracker<'missing' | 'present'>({
    normalLabel: 'missing',
    minimumDurationMs: 600,
    cooldownMs: 10_000,
    recoveryGraceMs: 450,
    minimumConfidence: 0.35,
  }),
  faceMissing: new TemporalSignalTracker<'present' | 'missing'>({
    normalLabel: 'present',
    minimumDurationMs: 1_800,
    cooldownMs: 6_000,
    recoveryGraceMs: 500,
    minimumConfidence: 0.7,
  }),
  multipleFaces: new TemporalSignalTracker<'single' | 'multiple'>({
    normalLabel: 'single',
    minimumDurationMs: 1_200,
    cooldownMs: 8_000,
    recoveryGraceMs: 500,
    minimumConfidence: 0.4,
  }),
  head: new TemporalSignalTracker<HeadDirection>({
    normalLabel: 'normal',
    minimumDurationMs: 1_000,
    cooldownMs: 0,
    recoveryGraceMs: 0,
    minimumConfidence: 0.55,
  }),
  gaze: new TemporalSignalTracker<'normal' | 'left' | 'right' | 'up' | 'down'>({
    normalLabel: 'normal',
    minimumDurationMs: 1_000,
    cooldownMs: 0,
    recoveryGraceMs: 0,
    minimumConfidence: 0.55,
  }),
  phone: new TemporalSignalTracker<'absent' | 'phone'>({
    normalLabel: 'absent',
    minimumDurationMs: 0,
    cooldownMs: 1_000,
    recoveryGraceMs: 750,
    minimumConfidence: 0.5,
  }),
});

const describeCameraError = (error: unknown): string => {
  const name = error instanceof Error ? error.name : 'UnknownError';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera permission was denied. Allow this extension page in Chrome and Windows camera privacy settings, then retry.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera was found. Connect or enable a camera and retry.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera is busy or unavailable. Close other apps using it and retry.';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'The camera does not support the requested video settings.';
    case 'SecurityError':
      return 'Chrome blocked camera access in this page context.';
    default:
      return `Camera could not start: ${error instanceof Error ? error.message : String(error)}`;
  }
};

const scoreColor = (score: number): string => {
  if (score <= 40) return '#38d39f';
  if (score <= 90) return '#f4bf4f';
  return '#fb7185';
};

const formatDuration = (duration: number): string => `${(duration / 1_000).toFixed(1)} s`;

type DirectionEventType = 'HEAD_TURN' | 'LOOKING_AWAY';

interface ActiveDirectionEvent {
  id: string;
  label: string;
  scoreImpact: number;
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const modelRef = useRef<FaceLandmarker | null>(null);
  const phoneModelRef = useRef<PhoneDetector | null>(null);
  const inferenceBusyRef = useRef(false);
  const phoneInferenceBusyRef = useRef(false);
  const lastVideoTimeRef = useRef(-1);
  const engineRef = useRef(new EventEngine());
  const trackersRef = useRef(createTrackers());
  const calibratorRef = useRef(new FaceCalibrator());
  const smoothersRef = useRef({
    yaw: new SignalSmoother(),
    pitch: new SignalSmoother(),
    roll: new SignalSmoother(),
    gazeHorizontal: new SignalSmoother(),
    gazeVertical: new SignalSmoother(),
  });
  const fpsRef = useRef({ startedAt: performance.now(), frames: 0, fps: 0 });
  const inferenceFailuresRef = useRef(0);
  const phoneInferenceFailuresRef = useRef(0);
  const phoneFpsRef = useRef({ startedAt: performance.now(), frames: 0, fps: 0 });
  const lastPhoneInferenceAtRef = useRef(0);
  const activeDirectionEventsRef = useRef<Record<DirectionEventType, ActiveDirectionEvent | null>>({
    HEAD_TURN: null,
    LOOKING_AWAY: null,
  });
  const securityBridgeRef = useRef<ExtensionSecurityBridge | null>(null);

  const [session, setSession] = useState<ProctoringSessionState>(initialSession);
  const [events, setEvents] = useState<ProctorEvent[]>([]);
  const [summary, setSummary] = useState<SessionSummary>(initialSummary);
  const [hydrated, setHydrated] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('Idle');
  const [aiStatus, setAiStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [aiMessage, setAiMessage] = useState('MediaPipe has not been loaded yet.');
  const [phoneModelStatus, setPhoneModelStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [phoneMessage, setPhoneMessage] = useState('YOLOv8n has not been loaded yet.');
  const [phoneDetections, setPhoneDetections] = useState<PhoneDetection[]>([]);
  const [phoneDebug, setPhoneDebug] = useState(emptyPhoneDebug);
  const [browserStatus, setBrowserStatus] = useState('Idle');
  const [serviceWorkerStatus, setServiceWorkerStatus] = useState('Checking extension worker…');
  const [agentStatus, setAgentStatus] = useState<SecurityAgentStatus>(initialAgentStatus);
  const [fullscreenWarning, setFullscreenWarning] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [debug, setDebug] = useState(emptyDebug);

  const sessionActive = session.status === 'active';
  const overallAiStatus = aiStatus === 'error' || phoneModelStatus === 'error'
    ? 'error'
    : aiStatus === 'loading' || phoneModelStatus === 'loading'
      ? 'loading'
      : aiStatus === 'ready' && phoneModelStatus === 'ready'
        ? 'ready'
        : 'idle';

  const refreshState = useCallback(() => {
    setEvents(engineRef.current.getEvents());
    setSummary(engineRef.current.summarize());
  }, []);

  const addEvent = useCallback((
    type: ProctorEventType,
    details: Omit<Parameters<EventEngine['record']>[0], 'type'>,
  ) => {
    const event = engineRef.current.record({ type, ...details });
    if (event) refreshState();
    return event;
  }, [refreshState]);

  const handleSecurityPayload = useCallback((payload: unknown) => {
    const event = normalizeSecurityEvent(payload);
    if (!event) return;
    const { type, ...details } = event;
    addEvent(type, details);
  }, [addEvent]);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([loadSessionEvents(), loadProctoringSession()]).then(([eventResult, sessionResult]) => {
      if (cancelled) return;

      if (eventResult.status === 'fulfilled') {
        engineRef.current.hydrate(eventResult.value);
        refreshState();
      } else {
        setStorageError(`Stored events could not be restored: ${eventResult.reason}`);
      }

      if (sessionResult.status === 'fulfilled' && sessionResult.value) {
        const restored = sessionResult.value;
        setSession({
          ...restored,
          status: restored.status === 'active' ? 'idle' : restored.status,
          startedAt: restored.status === 'active' ? null : restored.startedAt,
        });
      } else if (sessionResult.status === 'rejected') {
        setStorageError(`Session state could not be restored: ${sessionResult.reason}`);
      }
      setHydrated(true);
    });

    return () => {
      cancelled = true;
    };
  }, [refreshState]);

  useEffect(() => {
    if (!hydrated) return;
    saveSessionEvents(events).catch((error) => {
      setStorageError(`Events could not be saved locally: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [events, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    saveProctoringSession(session).catch((error) => {
      setStorageError(`Session state could not be saved locally: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [session, hydrated]);

  useEffect(() => {
    if (!sessionActive || session.startedAt === null) return;
    const updateElapsed = () => {
      setSession((current) => current.status === 'active' && current.startedAt !== null
        ? { ...current, elapsedSeconds: Math.floor((Date.now() - current.startedAt) / 1_000) }
        : current);
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [sessionActive, session.startedAt]);

  useEffect(() => {
    if (!ExtensionSecurityBridge.isAvailable()) {
      setServiceWorkerStatus('Web preview · local DOM fallback');
      setAgentStatus({
        state: 'unavailable',
        message: 'Native Messaging is available only in the installed Chrome extension.',
        capabilities: [],
        limitations: ['Web preview cannot connect to a registered native host'],
      });
      return;
    }

    const bridge = new ExtensionSecurityBridge({
      onSecurityEvent: handleSecurityPayload,
      onServiceWorkerStatus: setServiceWorkerStatus,
      onAgentStatus: setAgentStatus,
      onFullscreenState: (active) => setFullscreenWarning(!active),
    });
    securityBridgeRef.current = bridge;
    bridge.connect();
    return () => {
      bridge.dispose();
      if (securityBridgeRef.current === bridge) securityBridgeRef.current = null;
    };
  }, [handleSecurityPayload]);

  useEffect(() => {
    if (!sessionActive) {
      setBrowserStatus('Idle');
      return;
    }

    const stopLocalMonitor = startLocalBrowserMonitor({
      onEvent: handleSecurityPayload,
      onFullscreenState: (active) => setFullscreenWarning(!active),
    });
    const bridge = securityBridgeRef.current;
    if (bridge) {
      bridge.startMonitoring(session.id);
      setBrowserStatus('Extension security routing active');
      const heartbeat = window.setInterval(() => bridge.heartbeat(), 5_000);
      return () => {
        window.clearInterval(heartbeat);
        bridge.stopMonitoring();
        stopLocalMonitor();
      };
    }

    setBrowserStatus('Web preview · DOM monitoring active');
    return stopLocalMonitor;
  }, [handleSecurityPayload, session.id, sessionActive]);

  const resetVisionState = useCallback(() => {
    trackersRef.current = createTrackers();
    calibratorRef.current.reset();
    Object.values(smoothersRef.current).forEach((smoother) => smoother.reset());
    fpsRef.current = { startedAt: performance.now(), frames: 0, fps: 0 };
    inferenceFailuresRef.current = 0;
    phoneInferenceFailuresRef.current = 0;
    phoneFpsRef.current = { startedAt: performance.now(), frames: 0, fps: 0 };
    lastPhoneInferenceAtRef.current = 0;
    lastVideoTimeRef.current = -1;
    activeDirectionEventsRef.current = { HEAD_TURN: null, LOOKING_AWAY: null };
    setDebug(emptyDebug());
    setPhoneDetections([]);
    setPhoneDebug(emptyPhoneDebug(phoneModelRef.current?.provider));
  }, []);

  const emitFaceEvents = useCallback((
    faceCount: number,
    landmarks: NormalizedLandmark[][],
    now: number,
  ) => {
    const qualities = landmarks
      .map(extractRawFaceSignals)
      .filter((result) => result !== null)
      .map((result) => result.quality);
    const quality = qualities.length
      ? qualities.reduce((total, value) => total + value, 0) / qualities.length
      : 0;

    const present = trackersRef.current.facePresent.update(
      faceCount > 0 ? 'present' : 'missing',
      quality,
      now,
    );
    if (present) {
      addEvent('FACE_DETECTED', {
        duration: present.duration,
        confidence: present.confidence,
        severity: 0,
        explanation: `A face was stably visible across ${present.samples} analyzed frames.`,
        source: 'cv',
        metadata: { samples: present.samples, confidenceKind: 'geometry-and-temporal' },
      });
    }

    const missing = trackersRef.current.faceMissing.update(
      faceCount === 0 ? 'missing' : 'present',
      faceCount === 0 ? 1 : 0,
      now,
    );
    if (missing) {
      addEvent('FACE_NOT_DETECTED', {
        duration: missing.duration,
        confidence: missing.confidence,
        severity: 4,
        explanation: `No face was returned by MediaPipe across ${missing.samples} analyzed frames.`,
        source: 'cv',
        metadata: { samples: missing.samples, confidenceKind: 'temporal-support' },
      });
    }

    const multiple = trackersRef.current.multipleFaces.update(
      faceCount > 1 ? 'multiple' : 'single',
      quality,
      now,
    );
    if (multiple) {
      addEvent('MULTIPLE_FACES', {
        duration: multiple.duration,
        confidence: multiple.confidence,
        severity: 6,
        explanation: `${faceCount} faces remained visible across ${multiple.samples} analyzed frames.`,
        source: 'cv',
        metadata: { samples: multiple.samples, faceCount, confidenceKind: 'geometry-and-temporal' },
      });
    }
  }, [addEvent]);

  const updateDirectionEpisode = useCallback(<T extends string,>(
    type: DirectionEventType,
    tracker: TemporalSignalTracker<T>,
    label: T,
    confidence: number,
    now: number,
  ) => {
    const before = tracker.getActiveEpisode();
    const trigger = tracker.update(label, confidence, now);
    const after = tracker.getActiveEpisode();

    const writeProgress = (
      activeEvent: ActiveDirectionEvent,
      episode: TemporalEpisodeSnapshot<T>,
      forceRefresh = false,
    ) => {
      const explanation = type === 'HEAD_TURN'
        ? `Approximate head pose stayed ${episode.label} for ${formatDuration(episode.duration)}.`
        : `Possible gaze deviation stayed ${episode.label} for ${formatDuration(episode.duration)}.`;
      const updated = engineRef.current.updateEvent(activeEvent.id, {
        duration: episode.duration,
        confidence: episode.confidence,
        explanation,
        metadata: {
          direction: episode.label,
          samples: episode.samples,
          confidenceKind: 'geometry-and-temporal',
        },
      });
      if (updated && (forceRefresh || updated.scoreImpact !== activeEvent.scoreImpact)) {
        activeEvent.scoreImpact = updated.scoreImpact;
        refreshState();
      }
    };

    let active = activeDirectionEventsRef.current[type];
    if (active && before && (!after || after.label !== active.label)) {
      writeProgress(active, before, true);
      activeDirectionEventsRef.current[type] = null;
      active = null;
    }

    if (trigger) {
      const event = addEvent(type, {
        duration: trigger.duration,
        confidence: trigger.confidence,
        severity: 4,
        explanation: type === 'HEAD_TURN'
          ? `Approximate head pose stayed ${trigger.label} for ${formatDuration(trigger.duration)}.`
          : `Possible gaze deviation stayed ${trigger.label} for ${formatDuration(trigger.duration)}.`,
        source: 'cv',
        metadata: {
          direction: trigger.label,
          samples: trigger.samples,
          confidenceKind: 'geometry-and-temporal',
        },
      });
      if (event) {
        active = { id: event.id, label: trigger.label, scoreImpact: event.scoreImpact };
        activeDirectionEventsRef.current[type] = active;
      }
    }

    if (active && after?.emitted && after.label === active.label) {
      writeProgress(active, after);
    }
  }, [addEvent, refreshState]);

  const analyzeFrame = useCallback(() => {
    const video = videoRef.current;
    const model = modelRef.current;
    if (!video || !model || !sessionActive || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (video.currentTime === lastVideoTimeRef.current) return;
    lastVideoTimeRef.current = video.currentTime;

    const startedAt = performance.now();
    const now = Date.now();
    const result = model.detectForVideo(video, startedAt);
    const faces = result.faceLandmarks;
    emitFaceEvents(faces.length, faces, now);

    fpsRef.current.frames += 1;
    const fpsWindow = startedAt - fpsRef.current.startedAt;
    if (fpsWindow >= 1_000) {
      fpsRef.current.fps = (fpsRef.current.frames * 1_000) / fpsWindow;
      fpsRef.current.frames = 0;
      fpsRef.current.startedAt = startedAt;
    }

    if (faces.length !== 1) {
      updateDirectionEpisode('HEAD_TURN', trackersRef.current.head, 'normal', 0, now);
      updateDirectionEpisode('LOOKING_AWAY', trackersRef.current.gaze, 'normal', 0, now);
      setDebug((current) => ({
        ...current,
        faceCount: faces.length,
        landmarkCount: faces[0]?.length ?? 0,
        fps: fpsRef.current.fps,
        inferenceMs: performance.now() - startedAt,
      }));
      return;
    }

    const raw = extractRawFaceSignals(faces[0]);
    if (!raw) return;
    calibratorRef.current.add(raw);
    const calibration = calibratorRef.current.calibration;

    if (!calibration) {
      setAiMessage('Calibrating neutral head pose and iris position. Look at the center of the screen.');
      setDebug((current) => ({
        ...current,
        faceCount: 1,
        landmarkCount: faces[0].length,
        calibration: calibratorRef.current.progress,
        fps: fpsRef.current.fps,
        inferenceMs: performance.now() - startedAt,
      }));
      return;
    }

    const smoothedRaw = {
      ...raw,
      yaw: smoothersRef.current.yaw.update(raw.yaw),
      pitch: smoothersRef.current.pitch.update(raw.pitch),
      roll: smoothersRef.current.roll.update(raw.roll),
      gazeHorizontal: smoothersRef.current.gazeHorizontal.update(raw.gazeHorizontal),
      gazeVertical: smoothersRef.current.gazeVertical.update(raw.gazeVertical),
    };
    const estimate = estimateFaceState(smoothedRaw, calibration);
    setAiMessage('On-device face, head pose, and approximate gaze analysis is active.');

    updateDirectionEpisode(
      'HEAD_TURN',
      trackersRef.current.head,
      estimate.head.direction,
      estimate.head.confidence,
      now,
    );

    const gazeLabel = estimate.head.direction === 'normal' && estimate.gaze.available && estimate.gaze.direction !== 'unavailable'
      ? estimate.gaze.direction
      : 'normal';
    updateDirectionEpisode(
      'LOOKING_AWAY',
      trackersRef.current.gaze,
      gazeLabel,
      estimate.gaze.confidence,
      now,
    );

    inferenceFailuresRef.current = 0;
    setDebug({
      faceCount: 1,
      landmarkCount: faces[0].length,
      calibration: 1,
      head: estimate.head,
      gaze: estimate.gaze,
      fps: fpsRef.current.fps,
      inferenceMs: performance.now() - startedAt,
      delegate: debug.delegate,
    });
  }, [debug.delegate, emitFaceEvents, sessionActive, updateDirectionEpisode]);

  useEffect(() => {
    if (!sessionActive || !modelRef.current) return;
    const timer = window.setInterval(() => {
      if (inferenceBusyRef.current) return;
      inferenceBusyRef.current = true;
      try {
        analyzeFrame();
      } catch (error) {
        inferenceFailuresRef.current += 1;
        const message = error instanceof Error ? error.message : String(error);
        setAiStatus('error');
        setAiMessage(`Frame analysis failed: ${message}`);
        if (inferenceFailuresRef.current === 3) {
          addEvent('INFERENCE_FAILURE', {
            duration: 0,
            confidence: 1,
            severity: 0,
            explanation: `MediaPipe inference failed repeatedly: ${message}`,
            source: 'system',
          });
        }
      } finally {
        inferenceBusyRef.current = false;
      }
    }, 180);
    return () => window.clearInterval(timer);
  }, [addEvent, analyzeFrame, sessionActive]);

  const analyzePhoneFrame = useCallback(async () => {
    const video = videoRef.current;
    const detector = phoneModelRef.current;
    if (!video || !detector || !sessionActive || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    const now = Date.now();
    const result = await detector.detect(video);
    if (lastPhoneInferenceAtRef.current > 0 && now - lastPhoneInferenceAtRef.current > 1_500) {
      trackersRef.current.phone.reset();
    }
    lastPhoneInferenceAtRef.current = now;
    const bestDetection = result.detections[0];
    const trigger = trackersRef.current.phone.update(
      bestDetection ? 'phone' : 'absent',
      bestDetection?.confidence ?? 0,
      now,
    );

    phoneFpsRef.current.frames += 1;
    const fpsWindow = performance.now() - phoneFpsRef.current.startedAt;
    if (fpsWindow >= 2_000) {
      phoneFpsRef.current.fps = (phoneFpsRef.current.frames * 1_000) / fpsWindow;
      phoneFpsRef.current.frames = 0;
      phoneFpsRef.current.startedAt = performance.now();
    }

    setPhoneDetections(result.detections);
    setPhoneDebug({
      fps: phoneFpsRef.current.fps,
      inferenceMs: result.inferenceMs,
      preprocessMs: result.preprocessMs,
      provider: detector.provider,
    });
    setPhoneModelStatus('ready');
    setPhoneMessage(bestDetection
      ? `${result.detections.length} possible phone object${result.detections.length === 1 ? '' : 's'} in the current analyzed frame.`
      : 'YOLOv8n is active; no phone object passed the confidence threshold.');
    phoneInferenceFailuresRef.current = 0;

    if (trigger && bestDetection) {
      addEvent('PHONE_DETECTED', {
        duration: trigger.duration,
        confidence: trigger.confidence,
        severity: 8,
        explanation: 'Possible smartphone (COCO cell phone) detected in the current analyzed frame. Human review is required.',
        source: 'cv',
        metadata: {
          samples: trigger.samples,
          class: bestDetection.className,
          classId: bestDetection.classId,
          bboxX: Math.round(bestDetection.bbox.x),
          bboxY: Math.round(bestDetection.bbox.y),
          bboxWidth: Math.round(bestDetection.bbox.width),
          bboxHeight: Math.round(bestDetection.bbox.height),
          model: 'YOLOv8n COCO ONNX',
          confidenceKind: 'model-class-score',
        },
      });
    }
  }, [addEvent, sessionActive]);

  useEffect(() => {
    if (!sessionActive || !phoneModelRef.current) return;
    const timer = window.setInterval(() => {
      if (phoneInferenceBusyRef.current) return;
      phoneInferenceBusyRef.current = true;
      void analyzePhoneFrame()
        .catch((error) => {
          phoneInferenceFailuresRef.current += 1;
          const message = error instanceof Error ? error.message : String(error);
          setPhoneModelStatus('error');
          setPhoneMessage(`Phone inference failed: ${message}`);
          if (phoneInferenceFailuresRef.current === 3) {
            addEvent('INFERENCE_FAILURE', {
              duration: 0,
              confidence: 1,
              severity: 0,
              explanation: `YOLOv8n inference failed repeatedly: ${message}`,
              source: 'system',
            });
          }
        })
        .finally(() => {
          phoneInferenceBusyRef.current = false;
        });
    }, 600);
    return () => window.clearInterval(timer);
  }, [addEvent, analyzePhoneFrame, sessionActive]);

  const stopCamera = useCallback(() => {
    const activeStream = streamRef.current;
    streamRef.current = null;
    activeStream?.getTracks().forEach((track) => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraStatus('Stopped');
  }, []);

  const enterFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      setFullscreenWarning(false);
      return;
    }
    if (!document.fullscreenEnabled) {
      setFullscreenWarning(true);
      return;
    }
    try {
      await document.documentElement.requestFullscreen();
      setFullscreenWarning(false);
    } catch {
      setFullscreenWarning(true);
    }
  }, []);

  const startSession = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setCameraError('');
    setStorageError('');
    stopCamera();
    resetVisionState();
    await enterFullscreen();

    engineRef.current.clear();
    refreshState();

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus('Unsupported');
      setCameraError('This browser context does not provide the camera API.');
      setStarting(false);
      return;
    }

    setCameraStatus('Requesting permission');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' },
        audio: false,
      });
      stream.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (streamRef.current !== stream) return;
          setCameraStatus('Disconnected');
          setCameraError('The camera stream ended unexpectedly. Finish monitoring or start a new session to reconnect.');
          addEvent('CAMERA_BLOCKED', {
            duration: 0,
            confidence: 1,
            severity: 5,
            explanation: 'The active camera stream ended unexpectedly.',
            source: 'system',
            scoreImpact: 0,
          });
        }, { once: true });
      });
      streamRef.current = stream;
      if (!videoRef.current) throw new Error('Camera preview element is unavailable.');
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraStatus('Live');
    } catch (error) {
      const failedStream = streamRef.current;
      streamRef.current = null;
      failedStream?.getTracks().forEach((track) => track.stop());
      setCameraStatus('Unavailable');
      const message = describeCameraError(error);
      setCameraError(message);
      addEvent('CAMERA_BLOCKED', {
        duration: 0,
        confidence: 1,
        severity: 5,
        explanation: message,
        source: 'system',
        scoreImpact: 0,
      });
      setStarting(false);
      return;
    }

    setAiStatus('loading');
    setAiMessage('Loading local MediaPipe runtime and face landmarker model…');
    setPhoneModelStatus('loading');
    setPhoneMessage('Loading local YOLOv8n ONNX model and runtime…');
    const [faceLoad, phoneLoad] = await Promise.allSettled([
      modelRef.current ? Promise.resolve(null) : loadFaceLandmarker(),
      phoneModelRef.current ? Promise.resolve(null) : PhoneDetector.load(),
    ]);
    const modelFailures: string[] = [];

    if (faceLoad.status === 'fulfilled') {
      const loadedFace = faceLoad.value;
      if (loadedFace) {
        modelRef.current = loadedFace.model;
        setDebug((current) => ({ ...current, delegate: loadedFace.delegate }));
      }
      setAiStatus('ready');
      setAiMessage('MediaPipe loaded. Calibrating neutral pose…');
    } else {
      const message = faceLoad.reason instanceof Error ? faceLoad.reason.message : String(faceLoad.reason);
      setAiStatus('error');
      setAiMessage(`MediaPipe model failed to load: ${message}`);
      modelFailures.push(`Face model unavailable: ${message}`);
    }

    if (phoneLoad.status === 'fulfilled') {
      if (phoneLoad.value) phoneModelRef.current = phoneLoad.value;
      const provider = phoneModelRef.current?.provider ?? 'wasm';
      setPhoneDebug(emptyPhoneDebug(provider));
      setPhoneModelStatus('ready');
      setPhoneMessage(`YOLOv8n loaded locally with ${provider.toUpperCase()}. Waiting for analyzed frames…`);
    } else {
      const message = phoneLoad.reason instanceof Error ? phoneLoad.reason.message : String(phoneLoad.reason);
      setPhoneModelStatus('error');
      setPhoneMessage(`YOLOv8n failed to load: ${message}`);
      modelFailures.push(`Phone model unavailable: ${message}`);
    }

    if (modelFailures.length > 0) {
      addEvent('MODEL_FAILURE', {
        duration: 0,
        confidence: 1,
        severity: 0,
        explanation: modelFailures.join(' '),
        source: 'system',
      });
    }

    const startedAt = Date.now();
    setSession({
      id: `session-${startedAt}`,
      status: 'active',
      startedAt,
      endedAt: null,
      elapsedSeconds: 0,
    });
    addEvent('SESSION_STARTED', {
      duration: 0,
      confidence: 1,
      severity: 0,
      explanation: 'The local proctoring session started.',
      source: 'system',
    });
    setStarting(false);
  }, [addEvent, enterFullscreen, refreshState, resetVisionState, starting, stopCamera]);

  const finishSession = useCallback(() => {
    addEvent('SESSION_FINISHED', {
      duration: session.elapsedSeconds * 1_000,
      confidence: 1,
      severity: 0,
      explanation: 'The local proctoring session finished.',
      source: 'system',
    });
    stopCamera();
    setBrowserStatus('Idle');
    setFullscreenWarning(false);
    setSession((current) => ({ ...current, status: 'completed', endedAt: Date.now() }));
  }, [addEvent, session.elapsedSeconds, stopCamera]);

  useEffect(() => () => {
    const activeStream = streamRef.current;
    streamRef.current = null;
    activeStream?.getTracks().forEach((track) => track.stop());
    modelRef.current?.close();
    if (phoneModelRef.current) void phoneModelRef.current.dispose();
  }, []);

  const modelCatalog = useMemo<ModelStatus[]>(() => [
    {
      name: 'Face Landmarker',
      runtime: `MediaPipe Tasks Vision · ${debug.delegate}`,
      input: 'Local webcam frames, sampled at about 5 FPS',
      output: '478 landmarks, face count, head and iris geometry',
      confidence: 'Geometry quality + temporal support',
      limitations: 'Approximate direction only; lighting, glasses and camera angle affect accuracy.',
      status: aiStatus,
    },
    {
      name: 'Phone Detector',
      runtime: `YOLOv8n COCO · ONNX Runtime Web · ${phoneDebug.provider}`,
      input: '640 × 640 RGB letterboxed local webcam frame, sampled at about 1.7 FPS',
      output: 'COCO cell phone class, model confidence, and source-pixel bounding box',
      confidence: 'Class score ≥ 50% on the first qualifying analyzed frame',
      limitations: 'Small, covered, screen-only, or unusual phones can be missed; similar handheld objects can be false positives.',
      status: phoneModelStatus,
    },
    {
      name: 'Browser Monitor',
      runtime: 'DOM + Chrome Extension MV3 service worker',
      input: 'Tabs, windows, visibility, fullscreen, clipboard, context menu and DevTools shortcuts',
      output: 'Validated unified browser events',
      confidence: 'Direct browser signal',
      limitations: 'Cannot observe a second physical device or fully control the operating system.',
      status: sessionActive ? 'ready' : 'idle',
    },
    {
      name: 'Local Security Agent',
      runtime: 'Python · keyboard · Windows user32 · Native Messaging',
      input: 'Protected shortcuts and foreground-window changes only',
      output: 'Validated source:system events',
      confidence: 'Direct local OS observation',
      limitations: 'Observation only; secure desktop, elevated apps and reserved shortcuts are not guaranteed.',
      status: agentStatus.state === 'active' || agentStatus.state === 'ready'
        ? 'ready'
        : agentStatus.state === 'connecting'
          ? 'loading'
          : agentStatus.state === 'error'
            ? 'error'
            : 'idle',
    },
  ], [agentStatus.state, aiStatus, debug.delegate, phoneDebug.provider, phoneModelStatus, sessionActive]);

  return (
    <main className="app">
      <div className="container">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark"><Eye size={22} /></div>
            <div>
              <div className="eyebrow">Explainable local AI proctoring</div>
              <h1>Look At Me!</h1>
              <p className="lead">Signals and evidence for human review — never an automatic accusation.</p>
            </div>
          </div>
          <div className={`status-chip ${sessionActive ? 'online' : ''}`}>
            <span className="status-dot" />
            {sessionActive ? 'Session active' : 'Session inactive'}
          </div>
        </header>

        {(storageError || cameraError) && (
          <div className="alert-banner" role="alert">
            <CircleAlert size={18} />
            <span>{storageError || cameraError}</span>
          </div>
        )}

        <section className="stats-grid" aria-label="Session summary">
          <div className="stat-card featured">
            <div className="stat-label"><Gauge size={17} /> Activity Score</div>
            <div className="stat-value score-value" style={{ color: scoreColor(summary.score) }}>
              {summary.score}<span>/ 200</span>
            </div>
            <div className="stat-help">Higher means more suspicious activity · requires review</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Activity size={17} /> Events</div>
            <div className="stat-value">{summary.eventCount}</div>
            <div className="stat-help">{summary.severeEvents} high-severity signals</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Camera size={17} /> Camera</div>
            <div className="stat-value text-value">{cameraStatus}</div>
            <div className="stat-help">Frames stay on this device</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><ShieldCheck size={17} /> Browser</div>
            <div className="stat-value text-value">{browserStatus}</div>
            <div className="stat-help">{serviceWorkerStatus}</div>
          </div>
        </section>

        <SessionControls
          session={session}
          busy={starting}
          onStart={() => void startSession()}
          onFinish={finishSession}
        />

        <SecurityStatusPanel
          extensionStatus={serviceWorkerStatus}
          agentStatus={agentStatus}
          fullscreenWarning={sessionActive && fullscreenWarning}
          onEnterFullscreen={() => void enterFullscreen()}
          onRetryAgent={() => securityBridgeRef.current?.retryAgent()}
        />

        <section className="monitor-grid">
          <MonitoringPanel
            videoRef={videoRef}
            cameraStatus={cameraStatus}
            aiStatus={overallAiStatus}
            aiMessage={aiMessage}
            phoneMessage={phoneMessage}
            debug={debug}
            phoneDebug={phoneDebug}
            phoneDetections={phoneDetections}
            models={modelCatalog}
          />
          <EventTimeline events={events} summary={summary} />
        </section>
      </div>
    </main>
  );
}
