import { ProctoringEngine, type CameraEvidenceFrame, type ProctoringEngineStatus } from '../proctoring/ProctoringEngine';
import type { EventInput, EventProgressUpdate } from '../lib/eventEngine';
import type { ProctorEvent } from '../types';
import { composeEvidencePng } from '../evidence/composeEvidence';

const send = async <T>(message: unknown): Promise<T> => chrome.runtime.sendMessage(message) as Promise<T>;

const engine = new ProctoringEngine({
  recordEvent: async (input: EventInput) => {
    const response = await send<{ event?: ProctorEvent | null }>({
      target: 'background', type: 'engine-event', input,
    });
    return response?.event ?? null;
  },
  updateEvent: async (id: string, update: EventProgressUpdate) => {
    const response = await send<{ event?: ProctorEvent | null }>({
      target: 'background', type: 'engine-event-update', id, update,
    });
    return response?.event ?? null;
  },
  updateStatus: (patch: ProctoringEngineStatus) => {
    void chrome.runtime.sendMessage({ target: 'background', type: 'engine-status', patch });
  },
});

const captureCameraFrame = async (): Promise<CameraEvidenceFrame | null> => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const frame = engine.captureFrame(640);
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;
  if (message.type === 'engine-start' && typeof message.sessionId === 'string') {
    sendResponse({ accepted: true });
    void engine.start(message.sessionId).catch((error) => {
      void chrome.runtime.sendMessage({
        target: 'background',
        type: 'engine-fatal-error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return false;
  }
  if (message.type === 'engine-stop') {
    void engine.stop().then(() => sendResponse({ stopped: true })).catch((error) => {
      sendResponse({ stopped: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  if (message.type === 'engine-flush-events') {
    sendResponse({ flushed: true, updates: engine.getActiveDirectionProgress() });
    return false;
  }
  if (message.type === 'compose-evidence') {
    const pageFrame = message.pageFrame as CameraEvidenceFrame | undefined;
    if (!pageFrame?.data || pageFrame.mimeType !== 'image/png') {
      sendResponse({ captured: false, error: 'The visible test-page PNG is unavailable.' });
      return false;
    }
    void (async () => {
      const cameraFrame = await captureCameraFrame();
      if (!cameraFrame) throw new Error('The live camera frame is unavailable after retry.');
      return composeEvidencePng(
        pageFrame,
        cameraFrame,
        typeof message.eventType === 'string' ? message.eventType : 'VIOLATION',
        Number(message.timestamp) || Date.now(),
        message.final === true ? {
          final: true,
          score: Number(message.score) || 0,
          status: typeof message.status === 'string' ? message.status : 'COMPLETED',
        } : {},
      );
    })().then((frame) => sendResponse({ captured: true, frame })).catch((error) => {
      sendResponse({ captured: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }
  if (message.type === 'camera-preview') {
    const frame = engine.captureFrame(420);
    sendResponse(frame ? { available: true, frame } : { available: false });
    return false;
  }
  if (message.type === 'engine-health') {
    sendResponse({ active: engine.isActive });
    return false;
  }
  return false;
});

void chrome.runtime.sendMessage({ target: 'background', type: 'offscreen-ready' });
