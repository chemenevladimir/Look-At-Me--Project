import { useEffect, useRef, useState, type RefObject } from 'react';
import { Cpu } from 'lucide-react';
import type { ModelStatus } from '../types';
import type { GazeDirection, HeadDirection } from '../vision/faceAnalysis';
import type { PhoneDetection, PhoneExecutionProvider } from '../vision/phoneDetection';

export interface CvDebugView {
  faceCount: number;
  landmarkCount: number;
  calibration: number;
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
  fps: number;
  inferenceMs: number;
  delegate: string;
}

export interface PhoneDebugView {
  fps: number;
  inferenceMs: number;
  preprocessMs: number;
  provider: PhoneExecutionProvider | '—';
}

interface MonitoringPanelProps {
  videoRef: RefObject<HTMLVideoElement>;
  cameraStatus: string;
  aiStatus: ModelStatus['status'];
  aiMessage: string;
  phoneMessage: string;
  debug: CvDebugView;
  phoneDebug: PhoneDebugView;
  phoneDetections: PhoneDetection[];
  models: ModelStatus[];
}

export function MonitoringPanel({
  videoRef,
  cameraStatus,
  aiStatus,
  aiMessage,
  phoneMessage,
  debug,
  phoneDebug,
  phoneDetections,
  models,
}: MonitoringPanelProps) {
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const [overlayEnabled, setOverlayEnabled] = useState(true);

  useEffect(() => {
    const canvas = overlayRef.current;
    const video = videoRef.current;
    if (!canvas || !video || video.videoWidth <= 0 || video.videoHeight <= 0) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!overlayEnabled) return;

    context.lineWidth = Math.max(3, canvas.width / 320);
    context.strokeStyle = '#fb7185';
    context.font = `700 ${Math.max(16, canvas.width / 46)}px Inter, sans-serif`;
    context.textBaseline = 'top';

    for (const detection of phoneDetections) {
      const mirroredX = canvas.width - detection.bbox.x - detection.bbox.width;
      context.strokeRect(mirroredX, detection.bbox.y, detection.bbox.width, detection.bbox.height);
      const label = `Phone ${(detection.confidence * 100).toFixed(0)}%`;
      const labelWidth = context.measureText(label).width + 18;
      const labelHeight = Math.max(25, canvas.width / 32);
      const labelY = Math.max(0, detection.bbox.y - labelHeight);
      context.fillStyle = 'rgba(190, 24, 93, 0.92)';
      context.fillRect(mirroredX, labelY, labelWidth, labelHeight);
      context.fillStyle = '#fff1f2';
      context.fillText(label, mirroredX + 9, labelY + 4);
    }
  }, [overlayEnabled, phoneDetections, videoRef]);

  const bestPhone = phoneDetections[0];

  return (
    <article className="panel camera-panel">
      <div className="section-heading">
        <div>
          <div className="eyebrow">Live proctoring</div>
          <h2>Camera and CV status</h2>
        </div>
        <span className={`model-state ${aiStatus}`}>{aiStatus}</span>
      </div>

      <div className="video-shell">
        <video ref={videoRef} autoPlay muted playsInline aria-label="Local camera preview" />
        <canvas ref={overlayRef} className="detection-overlay" aria-hidden="true" />
        <div className="camera-overlay">
          <span>{cameraStatus}</span>
          <span>Face {debug.fps.toFixed(1)} FPS · phone {phoneDebug.fps.toFixed(1)} FPS</span>
        </div>
      </div>

      <div className="ai-message"><Cpu size={16} /> {aiMessage}</div>
      <div className="ai-message phone-message"><Cpu size={16} /> {phoneMessage}</div>

      <div className="signal-grid">
        <div className="signal-card">
          <span>Face state</span>
          <strong>{debug.faceCount === 0 ? 'No face' : debug.faceCount === 1 ? 'One face' : `${debug.faceCount} faces`}</strong>
          <small>{debug.landmarkCount} landmarks</small>
        </div>
        <div className="signal-card">
          <span>Head pose</span>
          <strong>{debug.calibration < 1 ? 'Calibrating' : debug.head.direction}</strong>
          <small>yaw {debug.head.yaw.toFixed(1)}° · pitch {debug.head.pitch.toFixed(1)}°</small>
        </div>
        <div className="signal-card">
          <span>Approximate gaze</span>
          <strong>{debug.calibration < 1 ? 'Calibrating' : debug.gaze.direction}</strong>
          <small>{debug.gaze.available ? `${(debug.gaze.confidence * 100).toFixed(0)}% measurement quality` : 'Iris landmarks unavailable'}</small>
        </div>
        <div className="signal-card">
          <span>Calibration</span>
          <strong>{Math.round(debug.calibration * 100)}%</strong>
          <small>{debug.inferenceMs.toFixed(0)} ms inference · {debug.delegate}</small>
        </div>
        <div className={`signal-card ${bestPhone ? 'phone-positive' : ''}`}>
          <span>Phone detector</span>
          <strong>{bestPhone ? 'Possible phone' : 'No phone'}</strong>
          <small>{bestPhone ? `${(bestPhone.confidence * 100).toFixed(0)}% model confidence` : '50% confidence threshold'}</small>
        </div>
      </div>

      <details className="debug-panel">
        <summary>CV diagnostics and overlay</summary>
        <div className="debug-grid">
          <span>Head roll</span><strong>{debug.head.roll.toFixed(1)}°</strong>
          <span>Head confidence</span><strong>{(debug.head.confidence * 100).toFixed(0)}%</strong>
          <span>Gaze horizontal</span><strong>{debug.gaze.horizontal.toFixed(1)}</strong>
          <span>Gaze vertical</span><strong>{debug.gaze.vertical.toFixed(1)}</strong>
          <span>YOLO provider</span><strong>{phoneDebug.provider}</strong>
          <span>YOLO preprocessing</span><strong>{phoneDebug.preprocessMs.toFixed(0)} ms</strong>
          <span>YOLO inference</span><strong>{phoneDebug.inferenceMs.toFixed(0)} ms</strong>
          <span>Current phone boxes</span><strong>{phoneDetections.length}</strong>
        </div>
        <label className="overlay-toggle">
          <input
            type="checkbox"
            checked={overlayEnabled}
            onChange={(event) => setOverlayEnabled(event.target.checked)}
          />
          Show phone bounding boxes, labels, and confidence
        </label>
      </details>

      <div className="model-grid">
        {models.map((model) => (
          <div className="model-card" key={model.name}>
            <div>
              <div className="model-title-row">
                <strong>{model.name}</strong>
                <span className={`model-state ${model.status}`}>{model.status}</span>
              </div>
              <p>{model.runtime}</p>
              <small>{model.output}</small>
              <small className="limitation">{model.limitations}</small>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}
