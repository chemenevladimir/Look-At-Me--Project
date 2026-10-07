import { ProctoringEngine, type ProctoringEngineStatus } from '../proctoring/ProctoringEngine';
import type { EventInput, EventProgressUpdate } from '../lib/eventEngine';
import type { ProctorEvent } from '../types';

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
  if (message.type === 'capture-evidence') {
    const frame = engine.captureFrame();
    sendResponse(frame ? { captured: true, frame } : { captured: false, error: 'No current video frame is available.' });
    return false;
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
