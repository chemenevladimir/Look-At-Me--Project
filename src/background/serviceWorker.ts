import { normalizeSecurityEvent } from '../browser/securityEvents';
import {
  EVENTS_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  applySummary,
  createIdleSessionState,
  isMonitorableUrl,
  isSessionRunning,
  sanitizeStoredState,
  type ExtensionSessionState,
} from '../extension/sessionState';
import { EventEngine, type EventInput, type EventProgressUpdate } from '../lib/eventEngine';
import type { ProctorEvent } from '../types';
import type { ProctoringEngineStatus } from '../proctoring/ProctoringEngine';

const NATIVE_HOST = 'com.look_at_me.security';
const POPUP_PORT = 'look-at-me-popup';
const OFFSCREEN_URL = 'offscreen.html';

const systemEventTypes = new Set([
  'COPY_ATTEMPT', 'PASTE_ATTEMPT', 'ALT_TAB_ATTEMPT', 'SYSTEM_KEY_ATTEMPT', 'PRINT_SCREEN_ATTEMPT', 'APP_SWITCH',
]);

const engine = new EventEngine();
let session = createIdleSessionState();
let events: ProctorEvent[] = [];
let loaded = false;
let loadPromise: Promise<void> | null = null;
let mutationQueue: Promise<unknown> = Promise.resolve();
let nativePort: chrome.runtime.Port | null = null;
let popupConnections = 0;

const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
  const result = mutationQueue.then(work, work);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
};

const safeText = (value: unknown, maxLength = 500): string | undefined =>
  typeof value === 'string' ? value.slice(0, maxLength) : undefined;

const safeMetadata = (value: unknown): Record<string, string | number | boolean> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value).slice(0, 16)) {
    if (typeof item === 'string') output[key] = item.slice(0, 200);
    else if (typeof item === 'number' && Number.isFinite(item)) output[key] = item;
    else if (typeof item === 'boolean') output[key] = item;
  }
  return Object.keys(output).length ? output : undefined;
};

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const stored = await chrome.storage.local.get([SESSION_STORAGE_KEY, EVENTS_STORAGE_KEY]);
    session = sanitizeStoredState(stored[SESSION_STORAGE_KEY]);
    events = Array.isArray(stored[EVENTS_STORAGE_KEY]) ? stored[EVENTS_STORAGE_KEY] as ProctorEvent[] : [];
    engine.hydrate(events);
    session = applySummary(session, engine.summarize(), engine.getEvents()[0] ?? null);
    loaded = true;
  })().finally(() => { loadPromise = null; });
  return loadPromise;
}

async function persist(): Promise<void> {
  events = engine.getEvents();
  await chrome.storage.local.set({
    [SESSION_STORAGE_KEY]: session,
    [EVENTS_STORAGE_KEY]: events,
  });
}

async function sendStateToContent(): Promise<void> {
  if (session.currentTabId === null) return;
  try {
    await chrome.tabs.sendMessage(session.currentTabId, { type: 'session-state', state: session });
  } catch {
    // A navigation can temporarily remove the content script; content-ready restores the overlay.
  }
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'content-probe' });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  }
}

async function broadcastState(): Promise<void> {
  await persist();
  try {
    await chrome.runtime.sendMessage({ type: 'session-state', state: session });
  } catch {
    // No popup or extension page is currently open.
  }
  await sendStateToContent();
}

async function recordEventInternal(input: EventInput): Promise<ProctorEvent | null> {
  const event = engine.record(input);
  if (!event) return null;
  session = applySummary(session, engine.summarize(), event);
  await broadcastState();
  return event;
}

async function updateEventInternal(id: string, update: EventProgressUpdate): Promise<ProctorEvent | null> {
  const event = engine.updateEvent(id, update);
  if (!event) return null;
  session = applySummary(session, engine.summarize(), event);
  await broadcastState();
  return event;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Keep local webcam inference active after the temporary extension popup closes.',
  });
}

async function sendToOffscreen(message: unknown): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', ...(message as object) });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Offscreen proctoring engine did not respond.');
}

function emitAgentStatus(
  state: ExtensionSessionState['localAgentState'],
  message: string,
): void {
  void enqueue(async () => {
    await ensureLoaded();
    session = { ...session, localAgentState: state, localAgentMessage: message };
    await broadcastState();
  });
}

function disconnectNativeAgent(sendShutdown = true): void {
  if (!nativePort) return;
  const port = nativePort;
  nativePort = null;
  try {
    if (sendShutdown) port.postMessage({ type: 'shutdown' });
    port.disconnect();
  } catch {
    // The process may already be gone.
  }
}

function connectNativeAgent(forceRestart = false): void {
  if (forceRestart) disconnectNativeAgent();
  if (nativePort) {
    nativePort.postMessage({ type: isSessionRunning(session.status) ? 'start' : 'capabilities', sessionId: session.sessionId });
    return;
  }
  emitAgentStatus('connecting', 'Connecting to the registered Windows security host…');
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    port.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const value = message as Record<string, unknown>;
      if (value.type === 'ready' || value.type === 'status') {
        const rawState = safeText(value.state, 32) ?? (value.type === 'ready' ? 'ready' : 'error');
        const allowed = new Set(['unavailable', 'connecting', 'ready', 'active', 'stopped', 'error']);
        emitAgentStatus(
          allowed.has(rawState) ? rawState as ExtensionSessionState['localAgentState'] : 'error',
          safeText(value.message) ?? 'Local security agent responded.',
        );
      } else if (value.type === 'event' && isSessionRunning(session.status) && systemEventTypes.has(String(value.eventType))) {
        const normalized = normalizeSecurityEvent({
          eventType: value.eventType,
          source: 'system',
          confidence: value.confidence,
          duration: value.duration,
          explanation: safeText(value.explanation),
          metadata: safeMetadata(value.metadata),
        });
        if (normalized) void enqueue(async () => {
          await ensureLoaded();
          if (!isSessionRunning(session.status)) return;
          await recordEventInternal(normalized);
        });
      }
    });
    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      nativePort = null;
      const reason = chrome.runtime.lastError?.message ?? 'Native host closed the connection.';
      emitAgentStatus('unavailable', `Local security agent unavailable: ${reason}`);
    });
    port.postMessage({ type: isSessionRunning(session.status) ? 'start' : 'capabilities', sessionId: session.sessionId });
  } catch (error) {
    nativePort = null;
    emitAgentStatus('error', `Local security agent could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function startSession(): Promise<ExtensionSessionState> {
  await ensureLoaded();
  if (isSessionRunning(session.status)) return session;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab.id === undefined || !isMonitorableUrl(tab.url)) {
    throw new Error('Open an ordinary http:// or https:// page before starting proctoring. Chrome system pages are not accessible.');
  }

  engine.clear();
  events = [];
  const now = Date.now();
  session = {
    ...createIdleSessionState(),
    sessionId: `session-${now}`,
    status: 'PROCTORING_STARTING',
    cameraStatus: 'REQUESTING',
    aiStatus: 'LOADING',
    proctoringStatus: 'Starting proctoring in the current tab…',
    currentTabId: tab.id,
    currentTabUrl: tab.url,
    startTime: now,
  };
  try {
    await ensureContentScript(tab.id);
  } catch (error) {
    const message = `The current page could not host the proctoring overlay: ${error instanceof Error ? error.message : String(error)}`;
    session = {
      ...session,
      status: 'PROCTORING_ERROR',
      cameraStatus: 'OFF',
      aiStatus: 'ERROR',
      proctoringStatus: message,
      error: message,
    };
    await broadcastState();
    return session;
  }
  await broadcastState();
  connectNativeAgent();

  try {
    await ensureOffscreenDocument();
    await sendToOffscreen({ type: 'engine-start', sessionId: session.sessionId });
  } catch (error) {
    const message = `Proctoring engine could not start: ${error instanceof Error ? error.message : String(error)}`;
    session = { ...session, status: 'PROCTORING_ERROR', cameraStatus: 'ERROR', aiStatus: 'ERROR', proctoringStatus: message, error: message };
    await broadcastState();
  }
  return session;
}

async function finalizeSession(reason: 'manual' | 'google-forms'): Promise<ExtensionSessionState> {
  await ensureLoaded();
  if (!isSessionRunning(session.status)) return session;
  session = {
    ...session,
    status: 'PROCTORING_FINALIZING',
    proctoringStatus: reason === 'google-forms'
      ? 'Google Forms submission confirmed. Finalizing the local session…'
      : 'Finalizing the local session…',
  };
  await broadcastState();

  if (reason === 'google-forms') {
    await recordEventInternal({
      type: 'FORM_SUBMITTED', duration: 0, confidence: 1, severity: 0,
      explanation: 'Google Forms displayed a confirmed response-submitted page after a submit intent.', source: 'browser',
    });
  }

  try {
    if (await chrome.offscreen.hasDocument()) await sendToOffscreen({ type: 'engine-stop' });
  } catch (error) {
    session = { ...session, error: `CV shutdown warning: ${error instanceof Error ? error.message : String(error)}` };
  }
  nativePort?.postMessage({ type: 'stop', sessionId: session.sessionId });
  const endedAt = Date.now();
  await recordEventInternal({
    type: 'SESSION_FINISHED',
    duration: Math.max(0, endedAt - (session.startTime ?? endedAt)),
    confidence: 1,
    severity: 0,
    explanation: reason === 'google-forms'
      ? 'The local proctoring session finished after confirmed Google Forms submission.'
      : 'The local proctoring session was stopped from the extension popup.',
    source: 'system',
  });
  session = {
    ...session,
    status: 'PROCTORING_COMPLETED',
    cameraStatus: 'OFF',
    faceStatus: 'UNKNOWN',
    aiStatus: 'IDLE',
    proctoringStatus: 'Session completed and saved locally.',
    endTime: endedAt,
    cloudSyncStatus: 'NOT_CONFIGURED',
    lastAlert: null,
    localAgentState: 'stopped',
    localAgentMessage: 'Local security agent stopped with the completed session.',
  };
  await broadcastState();
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  disconnectNativeAgent();
  return session;
}

async function applyEngineStatus(patch: ProctoringEngineStatus): Promise<void> {
  await ensureLoaded();
  if (!isSessionRunning(session.status)) return;
  const current = session as ExtensionSessionState & Record<string, unknown>;
  const changed = Object.entries(patch).some(([key, value]) => current[key] !== value);
  if (!changed) return;
  const wasStarting = session.status === 'PROCTORING_STARTING';
  session = { ...session, ...patch };
  if (wasStarting && patch.cameraStatus === 'ON' && (patch.aiStatus === 'ACTIVE' || patch.aiStatus === 'DEGRADED')) {
    session.status = 'PROCTORING_ACTIVE';
    await recordEventInternal({
      type: 'SESSION_STARTED', duration: 0, confidence: 1, severity: 0,
      explanation: 'The local proctoring session started in the selected browser tab.', source: 'system',
    });
    return;
  }
  if (patch.cameraStatus === 'ERROR' && patch.aiStatus === 'ERROR') session.status = 'PROCTORING_ERROR';
  await broadcastState();
}

async function restoreRuntime(): Promise<void> {
  await ensureLoaded();
  if (!isSessionRunning(session.status) || !session.sessionId) return;
  connectNativeAgent();
  await ensureOffscreenDocument();
  await sendToOffscreen({ type: 'engine-start', sessionId: session.sessionId });
  await sendStateToContent();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== POPUP_PORT) return;
  popupConnections += 1;
  void enqueue(async () => {
    await ensureLoaded();
    port.postMessage({ type: 'session-state', state: session });
    if (isSessionRunning(session.status)) connectNativeAgent();
  });
  port.onDisconnect.addListener(() => {
    popupConnections = Math.max(0, popupConnections - 1);
  });
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  const value = message as Record<string, unknown>;
  if (value.target === 'offscreen') return false;
  const fromOffscreen = sender.url === chrome.runtime.getURL(OFFSCREEN_URL);

  void enqueue(async () => {
    await ensureLoaded();
    if (value.type === 'popup-get-state') return { state: session };
    if (value.type === 'popup-start') return { state: await startSession() };
    if (value.type === 'popup-stop') {
      if (value.confirmed !== true) {
        return { state: session, error: 'Stopping an active session requires explicit confirmation.' };
      }
      return { state: await finalizeSession('manual') };
    }
    if (value.type === 'popup-retry-agent') {
      connectNativeAgent(true);
      return { state: session };
    }
    if (value.type === 'content-ready') {
      if (sender.tab?.id === session.currentTabId && isSessionRunning(session.status)) {
        if (isMonitorableUrl(sender.tab.url)) {
          session = { ...session, currentTabUrl: sender.tab.url };
          await persist();
        }
        return { state: session };
      }
      return { state: null };
    }
    if (value.type === 'page-security-event') {
      if (!sender.tab || sender.tab.id !== session.currentTabId || !isSessionRunning(session.status)) return { accepted: false };
      if (popupConnections > 0 && value.eventType === 'WINDOW_BLUR') return { accepted: false, reason: 'popup-open' };
      const normalized = normalizeSecurityEvent({
        eventType: value.eventType,
        source: 'browser',
        confidence: value.confidence,
        duration: value.duration,
        explanation: safeText(value.explanation),
        metadata: { ...safeMetadata(value.metadata), tabId: sender.tab.id, windowId: sender.tab.windowId },
      });
      if (!normalized) return { accepted: false };
      return { accepted: Boolean(await recordEventInternal(normalized)) };
    }
    if (value.type === 'google-forms-submitted') {
      const validSender = sender.tab?.id === session.currentTabId
        && isSessionRunning(session.status)
        && isMonitorableUrl(sender.tab.url)
        && new URL(sender.tab.url).hostname === 'docs.google.com'
        && new URL(sender.tab.url).pathname.startsWith('/forms/');
      if (!validSender || value.confirmed !== true || value.sessionId !== session.sessionId) return { accepted: false };
      return { accepted: true, state: await finalizeSession('google-forms') };
    }
    if (value.target === 'background' && value.type === 'engine-event') {
      if (!fromOffscreen) return { event: null, error: 'untrusted-engine-sender' };
      const input = value.input as EventInput;
      if (!isSessionRunning(session.status) || !input || typeof input.type !== 'string') return { event: null };
      return { event: await recordEventInternal(input) };
    }
    if (value.target === 'background' && value.type === 'engine-event-update') {
      if (!fromOffscreen) return { event: null, error: 'untrusted-engine-sender' };
      if (!isSessionRunning(session.status) || typeof value.id !== 'string') return { event: null };
      return { event: await updateEventInternal(value.id, value.update as EventProgressUpdate) };
    }
    if (value.target === 'background' && value.type === 'engine-status') {
      if (!fromOffscreen) return { accepted: false, error: 'untrusted-engine-sender' };
      await applyEngineStatus(value.patch as ProctoringEngineStatus);
      return { accepted: true };
    }
    if (value.target === 'background' && value.type === 'engine-fatal-error') {
      if (!fromOffscreen) return { accepted: false, error: 'untrusted-engine-sender' };
      const error = safeText(value.message) ?? 'Unknown proctoring engine failure.';
      session = { ...session, status: 'PROCTORING_ERROR', cameraStatus: 'ERROR', aiStatus: 'ERROR', error, proctoringStatus: error };
      await broadcastState();
      return { accepted: true };
    }
    if (value.type === 'service-worker-health-check') {
      return { ok: true, state: session, nativeConnected: Boolean(nativePort), offscreen: await chrome.offscreen.hasDocument() };
    }
    return { ignored: true };
  }).then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void enqueue(async () => {
    await ensureLoaded();
    if (!isSessionRunning(session.status) || session.currentTabId === null || activeInfo.tabId === session.currentTabId) return;
    await recordEventInternal({
      type: 'TAB_SWITCH', duration: 0, confidence: 1,
      explanation: 'The active Chrome tab changed away from the monitored test tab.', source: 'browser',
      metadata: { fromTabId: session.currentTabId, toTabId: activeInfo.tabId, windowId: activeInfo.windowId },
    });
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  void enqueue(async () => {
    await ensureLoaded();
    if (tabId !== session.currentTabId || !isSessionRunning(session.status)) return;
    if (isMonitorableUrl(tab.url)) session = { ...session, currentTabUrl: tab.url };
    await broadcastState();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueue(async () => {
    await ensureLoaded();
    if (tabId !== session.currentTabId || !isSessionRunning(session.status)) return;
    await recordEventInternal({
      type: 'TAB_SWITCH', duration: 0, confidence: 1,
      explanation: 'The monitored test tab was closed. The session remains active until an explicit stop or confirmed submission.',
      source: 'browser', metadata: { closedTabId: tabId },
    });
    session = { ...session, currentTabId: null, currentTabUrl: null, proctoringStatus: 'Test tab closed; camera monitoring remains active.' };
    await broadcastState();
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  void enqueue(async () => {
    await ensureLoaded();
    if (!isSessionRunning(session.status) || popupConnections > 0) return;
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      await recordEventInternal({
        type: 'WINDOW_BLUR', duration: 0, confidence: 1,
        explanation: 'Chrome lost operating-system focus during proctoring.', source: 'browser',
      });
    }
  });
});

chrome.runtime.onInstalled.addListener(() => { void restoreRuntime(); });
chrome.runtime.onStartup.addListener(() => { void restoreRuntime(); });
void restoreRuntime().catch((error) => {
  console.error('Look At Me! runtime restore failed', error);
});
