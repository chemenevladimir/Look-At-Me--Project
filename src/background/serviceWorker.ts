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
import { serializeViolation, shouldCaptureScreenshot } from '../evidence/localEvidence';

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
let evidenceConnections = 0;
let fullscreenRecoveryTimer: number | null = null;
let fullscreenExitExpected = false;
let nativeReconnectTimer: number | null = null;
let nativeReconnectDelay = 2_000;
let nativeEverAttempted = false;
const nativeRequests = new Map<string, {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: number;
}>();
const evidenceTasks = new Set<Promise<void>>();
const storageTasks = new Set<Promise<void>>();
let evidenceCaptureQueue: Promise<void> = Promise.resolve();
let lastEvidenceCaptureAt = 0;
let sessionFailures: string[] = [];

const registerSessionFailure = (message: string): void => {
  if (!sessionFailures.includes(message)) sessionFailures = [...sessionFailures, message].slice(-20);
};

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

const makeSessionId = (now = new Date()): string => {
  const parts = [
    now.getUTCFullYear().toString(),
    (now.getUTCMonth() + 1).toString().padStart(2, '0'),
    now.getUTCDate().toString().padStart(2, '0'),
    '_',
    now.getUTCHours().toString().padStart(2, '0'),
    now.getUTCMinutes().toString().padStart(2, '0'),
    now.getUTCSeconds().toString().padStart(2, '0'),
  ].join('');
  return `session_${parts}_${crypto.randomUUID().slice(0, 8)}`;
};

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

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

async function resolveCaptureWindowId(): Promise<number> {
  if (session.currentTabId !== null) {
    const monitoredTab = await chrome.tabs.get(session.currentTabId);
    await chrome.windows.get(monitoredTab.windowId);
    if (session.currentWindowId !== monitoredTab.windowId) {
      session = { ...session, currentWindowId: monitoredTab.windowId };
      await persist();
    }
    return monitoredTab.windowId;
  }
  const browserWindow = await chrome.windows.getLastFocused();
  if (browserWindow.id === undefined) throw new Error('Chrome has no capturable browser window.');
  return browserWindow.id;
}

async function activateMonitoredTabForCapture(): Promise<number> {
  if (session.currentTabId === null) throw new Error('The monitored test tab is unavailable.');
  const monitoredTabId = session.currentTabId;
  let lastActiveTabId: number | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const monitoredTab: chrome.tabs.Tab = await chrome.tabs.get(monitoredTabId);
    if (!isMonitorableUrl(monitoredTab.url)) throw new Error('The monitored test tab is no longer capturable.');
    session = { ...session, currentWindowId: monitoredTab.windowId, currentTabUrl: monitoredTab.url };
    await chrome.windows.update(monitoredTab.windowId, { focused: true });
    await chrome.tabs.update(monitoredTabId, { active: true });
    await new Promise((resolve) => setTimeout(resolve, 180));
    const [activeTab]: chrome.tabs.Tab[] = await chrome.tabs.query({ active: true, windowId: monitoredTab.windowId });
    lastActiveTabId = activeTab?.id;
    if (activeTab?.id === monitoredTabId) {
      await persist();
      return monitoredTab.windowId;
    }
  }
  throw new Error(`Chrome did not activate the monitored test tab before capture (active tab: ${lastActiveTabId ?? 'none'}).`);
}

async function captureVisiblePng(): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const windowId = await resolveCaptureWindowId();
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      if (dataUrl.startsWith('data:image/png;base64,')) return dataUrl;
      throw new Error('Chrome returned an unsupported screenshot format.');
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Chrome could not capture the visible tab.');
}

async function captureEvidenceForEvent(event: ProctorEvent, sessionId: string): Promise<void> {
  try {
    const waitMs = Math.max(0, 650 - (Date.now() - lastEvidenceCaptureAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastEvidenceCaptureAt = Date.now();
    if (!await hasOffscreenDocument()) throw new Error('The offscreen camera context is unavailable.');
    await activateMonitoredTabForCapture();
    const dataUrl = await captureVisiblePng();
    const prefix = 'data:image/png;base64,';
    if (!dataUrl.startsWith(prefix)) throw new Error('Chrome returned an unsupported screenshot format.');
    const response = await sendToOffscreen({
      type: 'compose-evidence',
      pageFrame: { data: dataUrl.slice(prefix.length), mimeType: 'image/png' },
      eventType: event.type,
      timestamp: event.timestamp,
    }) as {
      captured?: boolean;
      error?: string;
      frame?: { data?: string; mimeType?: string };
    };
    if (!response.captured || !response.frame?.data || response.frame.mimeType !== 'image/png') {
      throw new Error(response.error || 'The combined test-and-camera evidence frame was not created.');
    }
    const result = await nativeRequest({
      type: 'storage-violation-save',
      sessionId,
      event: serializeViolation(event),
      data: response.frame.data,
      mimeType: response.frame.mimeType,
    });
    if (session.sessionId === sessionId) {
      session = {
        ...session,
        evidenceCount: session.evidenceCount + (result.alreadyExisted === true ? 0 : 1),
        storageStatus: 'READY',
        dataRoot: safeText(result.dataRoot, 2_000) ?? session.dataRoot,
      };
      await broadcastState();
    }
  } catch (error) {
    if (session.sessionId === sessionId) {
      const message = `Evidence screenshot could not be saved: ${error instanceof Error ? error.message : String(error)}`;
      registerSessionFailure(message);
      session = { ...session, storageStatus: 'ERROR', error: message };
      await broadcastState();
    }
  }
}

async function captureFinalScreenshot(sessionId: string, timestamp: number): Promise<string> {
  const waitMs = Math.max(0, 650 - (Date.now() - lastEvidenceCaptureAt));
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastEvidenceCaptureAt = Date.now();
  if (!await hasOffscreenDocument()) throw new Error('The offscreen camera context is unavailable.');
  await activateMonitoredTabForCapture();
  const dataUrl = await captureVisiblePng();
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) throw new Error('Chrome returned an unsupported screenshot format.');
  const response = await sendToOffscreen({
    type: 'compose-evidence',
    pageFrame: { data: dataUrl.slice(prefix.length), mimeType: 'image/png' },
    eventType: 'FINAL SCREENSHOT',
    timestamp,
    final: true,
    score: session.activityScore,
    status: 'COMPLETED',
  }) as { captured?: boolean; error?: string; frame?: { data?: string; mimeType?: string } };
  if (!response.captured || !response.frame?.data || response.frame.mimeType !== 'image/png') {
    throw new Error(response.error || 'The final test-and-camera screenshot was not created.');
  }
  const result = await nativeRequest({
    type: 'storage-final-screenshot-save',
    sessionId,
    data: response.frame.data,
    mimeType: response.frame.mimeType,
  }, 10_000);
  const name = safeText(result.screenshotName, 160);
  if (!name) throw new Error('The helper did not return a final screenshot filename.');
  return name;
}

function trackStorageTask(task: Promise<void>): void {
  storageTasks.add(task);
  void task.finally(() => storageTasks.delete(task));
}

async function persistEventToHelper(event: ProctorEvent, sessionId: string): Promise<void> {
  try {
    await nativeRequest({
      type: 'storage-event-upsert',
      sessionId,
      event: serializeViolation(event),
    }, 5_000);
  } catch (error) {
    const message = `Event metadata could not be saved: ${error instanceof Error ? error.message : String(error)}`;
    registerSessionFailure(message);
    if (session.sessionId === sessionId) {
      session = { ...session, storageStatus: 'ERROR', error: message };
      await broadcastState();
    }
  }
}

async function recordEventInternal(input: EventInput): Promise<ProctorEvent | null> {
  const event = engine.record(input);
  if (!event) return null;
  session = applySummary(session, engine.summarize(), event);
  await broadcastState();
  if (session.sessionId) trackStorageTask(persistEventToHelper(event, session.sessionId));
  if (shouldCaptureScreenshot(event) && session.sessionId) {
    const sessionId = session.sessionId;
    const task = evidenceCaptureQueue.then(() => captureEvidenceForEvent(event, sessionId));
    evidenceCaptureQueue = task.catch(() => undefined);
    evidenceTasks.add(task);
    void task.finally(() => evidenceTasks.delete(task));
  }
  return event;
}

async function updateEventInternal(id: string, update: EventProgressUpdate): Promise<ProctorEvent | null> {
  const event = engine.updateEvent(id, update);
  if (!event) return null;
  session = applySummary(session, engine.summarize(), event);
  await broadcastState();
  if (session.sessionId) trackStorageTask(persistEventToHelper(event, session.sessionId));
  return event;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Keep local webcam inference active after the temporary extension popup closes.',
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function sendToOffscreen(message: unknown): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      return await withTimeout(
        chrome.runtime.sendMessage({ target: 'offscreen', ...(message as object) }),
        15_000,
        'Offscreen operation timed out.',
      );
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message === 'Offscreen operation timed out.') throw error;
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
    if (session.localAgentState === state && session.localAgentMessage === message) return;
    session = { ...session, localAgentState: state, localAgentMessage: message };
    await broadcastState();
  });
}

function disconnectNativeAgent(sendShutdown = true): void {
  if (!nativePort) return;
  const port = nativePort;
  nativePort = null;
  for (const [id, pending] of nativeRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('The local Native Messaging host disconnected.'));
    nativeRequests.delete(id);
  }
  try {
    if (sendShutdown) port.postMessage({ type: 'shutdown' });
    port.disconnect();
  } catch {
    // The process may already be gone.
  }
}

function scheduleNativeReconnect(): void {
  if (nativeReconnectTimer !== null || nativePort) return;
  if (!isSessionRunning(session.status) && popupConnections === 0 && evidenceConnections === 0) return;
  const delay = nativeReconnectDelay;
  nativeReconnectTimer = setTimeout(() => {
    nativeReconnectTimer = null;
    connectNativeAgent();
  }, delay) as unknown as number;
  nativeReconnectDelay = Math.min(30_000, Math.round(nativeReconnectDelay * 1.8));
}

function nativeRequest(message: Record<string, unknown>, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  connectNativeAgent();
  const port = nativePort;
  if (!port) return Promise.reject(new Error('The local evidence helper is unavailable.'));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nativeRequests.delete(requestId);
      reject(new Error(`Local helper timed out while handling ${String(message.type)}.`));
    }, timeoutMs) as unknown as number;
    nativeRequests.set(requestId, { resolve, reject, timer });
    try {
      port.postMessage({ ...message, requestId });
    } catch (error) {
      clearTimeout(timer);
      nativeRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function connectNativeAgent(forceRestart = false): void {
  if (forceRestart) disconnectNativeAgent();
  if (nativePort) return;
  if (nativeReconnectTimer !== null) {
    clearTimeout(nativeReconnectTimer);
    nativeReconnectTimer = null;
  }
  if (forceRestart || !nativeEverAttempted) {
    emitAgentStatus('connecting', 'Connecting to the registered Windows security host…');
  }
  nativeEverAttempted = true;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    port.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const value = message as Record<string, unknown>;
      if (value.type === 'storage-response' && typeof value.replyTo === 'string') {
        const pending = nativeRequests.get(value.replyTo);
        if (!pending) return;
        nativeRequests.delete(value.replyTo);
        clearTimeout(pending.timer);
        if (value.ok === true) pending.resolve((value.result as Record<string, unknown>) ?? {});
        else pending.reject(new Error(safeText(value.error, 800) ?? 'The local evidence helper rejected the request.'));
      } else if (value.type === 'ready' || value.type === 'status') {
        nativeReconnectDelay = 2_000;
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
      for (const [id, pending] of nativeRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('The local Native Messaging host disconnected.'));
        nativeRequests.delete(id);
      }
      const reason = chrome.runtime.lastError?.message ?? 'Native host closed the connection.';
      emitAgentStatus('unavailable', `Local security agent unavailable: ${reason}`);
      scheduleNativeReconnect();
    });
    port.postMessage({ type: isSessionRunning(session.status) ? 'start' : 'capabilities', sessionId: session.sessionId });
  } catch (error) {
    nativePort = null;
    emitAgentStatus('error', `Local security agent could not start: ${error instanceof Error ? error.message : String(error)}`);
    scheduleNativeReconnect();
  }
}

interface StartSessionOptions {
  studentName?: string;
  testName?: string;
}

async function enterFullscreen(windowId: number): Promise<void> {
  session = { ...session, fullscreenStatus: 'ENTERING' };
  try {
    const updated = await chrome.windows.update(windowId, { state: 'fullscreen', focused: true });
    session = {
      ...session,
      fullscreenStatus: updated.state === 'fullscreen' ? 'ACTIVE' : 'ERROR',
    };
  } catch (error) {
    session = {
      ...session,
      fullscreenStatus: 'ERROR',
      error: `Fullscreen could not be enabled: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function restoreWindowState(): Promise<void> {
  if (fullscreenRecoveryTimer !== null) {
    clearTimeout(fullscreenRecoveryTimer);
    fullscreenRecoveryTimer = null;
  }
  if (session.currentWindowId === null) return;
  const targetState = session.previousWindowState === 'maximized' ? 'maximized' : 'normal';
  try {
    await chrome.windows.update(session.currentWindowId, { state: targetState });
  } catch {
    // The user may have closed the monitored Chrome window.
  }
}

async function startSession(options: StartSessionOptions): Promise<ExtensionSessionState> {
  await ensureLoaded();
  if (isSessionRunning(session.status)) return session;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab.id === undefined || !isMonitorableUrl(tab.url)) {
    throw new Error('Open an ordinary http:// or https:// page before starting proctoring. Chrome system pages are not accessible.');
  }
  const browserWindow = await chrome.windows.get(tab.windowId);

  engine.clear();
  events = [];
  sessionFailures = [];
  const now = Date.now();
  session = {
    ...createIdleSessionState(),
    sessionId: makeSessionId(new Date(now)),
    studentName: safeText(options.studentName, 200)?.trim() || 'Student',
    testName: safeText(options.testName, 240)?.trim() || new URL(tab.url).hostname,
    status: 'PROCTORING_STARTING',
    cameraStatus: 'REQUESTING',
    aiStatus: 'LOADING',
    proctoringStatus: 'Preparing local violation screenshots and AI monitoring…',
    currentTabId: tab.id,
    currentWindowId: tab.windowId,
    currentTabUrl: tab.url,
    startTime: now,
    storageStatus: 'CONNECTING',
    fullscreenStatus: 'ENTERING',
    previousWindowState: browserWindow.state ?? 'normal',
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
    const storage = await nativeRequest({
      type: 'storage-initialize',
    });
    await nativeRequest({
      type: 'storage-session-start',
      session: {
        id: session.sessionId,
        studentName: session.studentName,
        testName: session.testName,
        startedAt: session.startTime,
      },
    });
    session = {
      ...session,
      storageStatus: 'READY',
      dataRoot: safeText(storage.dataRoot, 2_000) ?? null,
    };
    await ensureOffscreenDocument();
    session = { ...session, proctoringStatus: 'Starting camera and local AI models…' };
    await enterFullscreen(tab.windowId);
    await broadcastState();
    await sendToOffscreen({ type: 'engine-start', sessionId: session.sessionId });
  } catch (error) {
    const message = `Proctoring engine could not start: ${error instanceof Error ? error.message : String(error)}`;
    session = {
      ...session,
      status: 'PROCTORING_ERROR',
      cameraStatus: 'ERROR',
      aiStatus: 'ERROR',
      storageStatus: session.storageStatus === 'READY' ? 'ERROR' : session.storageStatus,
      proctoringStatus: message,
      error: message,
    };
    try {
      if (await hasOffscreenDocument()) {
        await sendToOffscreen({ type: 'engine-stop' });
      }
    } catch {
      // The primary startup error is reported below.
    }
    await broadcastState();
    await restoreWindowState();
    nativePort?.postMessage({ type: 'stop', sessionId: session.sessionId });
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
  }
  return session;
}

async function finalizeSession(reason: 'manual' | 'google-forms' | 'error' | 'interrupted'): Promise<ExtensionSessionState> {
  await ensureLoaded();
  if (!isSessionRunning(session.status)) return session;
  if (session.status === 'PROCTORING_FINALIZING') return session;
  fullscreenExitExpected = true;
  session = {
    ...session,
    status: 'PROCTORING_FINALIZING',
    storageStatus: 'SAVING',
    proctoringStatus: reason === 'google-forms'
      ? 'Google Forms submission confirmed. Finalizing the local session…'
      : reason === 'interrupted'
        ? 'The monitored test was interrupted. Finalizing local evidence…'
        : 'Finalizing the local session…',
  };
  await broadcastState();

  try {
    if (await hasOffscreenDocument()) {
      const flush = await sendToOffscreen({ type: 'engine-flush-events' }) as {
        updates?: Array<{ id?: string; update?: EventProgressUpdate }>;
      };
      for (const item of flush.updates ?? []) {
        if (typeof item.id === 'string' && item.update) await updateEventInternal(item.id, item.update);
      }
    }
  } catch (error) {
    registerSessionFailure(`Long-event finalization warning: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (reason === 'google-forms') {
    await recordEventInternal({
      type: 'FORM_SUBMITTED', duration: 0, confidence: 1, severity: 0,
      explanation: 'Google Forms displayed a confirmed response-submitted page after a submit intent.', source: 'browser',
    });
  }

  const endedAt = Date.now();
  await recordEventInternal({
    type: 'SESSION_FINISHED',
    duration: Math.max(0, endedAt - (session.startTime ?? endedAt)),
    confidence: 1,
    severity: 0,
    explanation: reason === 'google-forms'
      ? 'The local proctoring session finished after confirmed Google Forms submission.'
      : reason === 'interrupted'
        ? 'The monitored test tab was closed before a confirmed submission.'
        : reason === 'error'
          ? 'The local proctoring session stopped after a runtime error.'
          : 'The local proctoring session was stopped from the extension popup.',
    source: 'system',
  });

  await Promise.allSettled([...storageTasks, ...evidenceTasks]);
  if ((reason === 'manual' || reason === 'google-forms') && session.sessionId) {
    try {
      const finalScreenshotName = await captureFinalScreenshot(session.sessionId, endedAt);
      session = { ...session, finalScreenshotName, storageStatus: 'SAVING' };
      await broadcastState();
    } catch (error) {
      registerSessionFailure(`Final screenshot could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let finalStatus: 'COMPLETED' | 'ERROR' | 'INTERRUPTED' = reason === 'error' || sessionFailures.length
    ? 'ERROR'
    : reason === 'interrupted'
      ? 'INTERRUPTED'
      : 'COMPLETED';
  const warnings: string[] = [...sessionFailures];
  if (reason === 'error' && session.error && !warnings.includes(session.error)) warnings.push(session.error);
  try {
    if (await hasOffscreenDocument()) await sendToOffscreen({ type: 'engine-stop' });
  } catch (error) {
    warnings.push(`CV shutdown warning: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (session.sessionId) {
    try {
      await nativeRequest({
        type: 'storage-session-finish',
        sessionId: session.sessionId,
        session: {
          endedAt,
          durationSeconds: Math.max(0, (endedAt - (session.startTime ?? endedAt)) / 1_000),
          activityScore: session.activityScore,
          violationsCount: engine.getEvents().filter((event) => event.scoreImpact > 0).length,
          status: finalStatus,
        },
      }, 5_000);
    } catch (error) {
      warnings.push(`Session metadata warning: ${error instanceof Error ? error.message : String(error)}`);
      finalStatus = 'ERROR';
    }
  }

  session = { ...session, storageStatus: finalStatus === 'ERROR' ? 'ERROR' : 'SAVED' };
  nativePort?.postMessage({ type: 'stop', sessionId: session.sessionId });
  session = { ...session, fullscreenStatus: 'IDLE' };
  await restoreWindowState();
  fullscreenExitExpected = false;
  session = {
    ...session,
    status: finalStatus === 'COMPLETED' ? 'PROCTORING_COMPLETED' : 'PROCTORING_ERROR',
    cameraStatus: 'OFF',
    faceStatus: 'UNKNOWN',
    aiStatus: 'IDLE',
    proctoringStatus: finalStatus === 'COMPLETED'
      ? `Session completed. ${session.finalScreenshotName ?? 'Final screenshot'} and event metadata were saved locally.`
      : finalStatus === 'INTERRUPTED'
        ? 'The interrupted session ended; available violation screenshots remain saved locally.'
        : 'Session ended with a local screenshot storage or runtime error.',
    endTime: endedAt,
    cloudSyncStatus: 'NOT_CONFIGURED',
    lastAlert: null,
    localAgentState: 'stopped',
    localAgentMessage: 'Local security agent stopped with the completed session.',
    fullscreenStatus: 'IDLE',
    error: warnings.length ? warnings.join(' ') : null,
  };
  await broadcastState();
  if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
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
  if (port.name === POPUP_PORT) {
    popupConnections += 1;
    void enqueue(async () => {
      await ensureLoaded();
      port.postMessage({ type: 'session-state', state: session });
      connectNativeAgent();
    });
    port.onDisconnect.addListener(() => { popupConnections = Math.max(0, popupConnections - 1); });
    return;
  }
  if (port.name === 'look-at-me-evidence') {
    evidenceConnections += 1;
    void enqueue(async () => {
      await ensureLoaded();
      port.postMessage({ type: 'session-state', state: session });
      connectNativeAgent();
    });
    port.onDisconnect.addListener(() => { evidenceConnections = Math.max(0, evidenceConnections - 1); });
  }
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  const value = message as Record<string, unknown>;
  if (value.target === 'offscreen') return false;
  const fromOffscreen = sender.url === chrome.runtime.getURL(OFFSCREEN_URL);
  const fromEvidencePage = sender.url === chrome.runtime.getURL('evidence.html');

  void enqueue(async () => {
    await ensureLoaded();
    if (value.type === 'popup-get-state') return { state: session };
    if (value.type === 'popup-get-events') return { events: engine.getEvents().slice(0, 12) };
    if (value.type === 'popup-start') {
      return {
        state: await startSession({
          studentName: safeText(value.studentName, 200),
          testName: safeText(value.testName, 240),
        }),
      };
    }
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
    if (value.type === 'popup-camera-preview') {
      if (!isSessionRunning(session.status) || !await hasOffscreenDocument()) return { available: false };
      return sendToOffscreen({ type: 'camera-preview' });
    }
    if (value.type === 'evidence-list') {
      if (!fromEvidencePage) return { error: 'Evidence records are available only to the extension evidence page.' };
      return nativeRequest({ type: 'storage-list-violations', limit: 1_000 });
    }
    if (value.type === 'evidence-delete') {
      if (!fromEvidencePage) return { error: 'Evidence deletion is available only to the extension evidence page.' };
      const eventId = safeText(value.eventId, 180);
      if (!eventId) return { error: 'A valid event ID is required.' };
      return nativeRequest({ type: 'storage-delete-violation', eventId });
    }
    if (value.type === 'evidence-open-screenshots') {
      if (!fromEvidencePage) return { error: 'The screenshots folder can be opened only from the extension evidence page.' };
      return nativeRequest({ type: 'storage-open-screenshots' });
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
    if (value.type === 'content-finish-session') {
      const validSender = sender.tab?.id === session.currentTabId && isSessionRunning(session.status);
      if (!validSender || value.confirmed !== true) return { accepted: false };
      return { accepted: true, state: await finalizeSession('manual') };
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
      session = { ...session, cameraStatus: 'ERROR', aiStatus: 'ERROR', error, proctoringStatus: error };
      return { accepted: true, state: await finalizeSession('error') };
    }
    if (value.type === 'service-worker-health-check') {
      return { ok: true, state: session, nativeConnected: Boolean(nativePort), offscreen: await hasOffscreenDocument() };
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
      explanation: 'The monitored test tab was closed before a confirmed submission.',
      source: 'browser', metadata: { closedTabId: tabId },
    });
    await finalizeSession('interrupted');
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

chrome.windows.onBoundsChanged.addListener((changedWindow) => {
  void enqueue(async () => {
    await ensureLoaded();
    const enforce = session.status === 'PROCTORING_STARTING'
      || session.status === 'PROCTORING_ACTIVE'
      || session.status === 'PROCTORING_PAUSED';
    if (!enforce || fullscreenExitExpected || changedWindow.id !== session.currentWindowId) return;
    if (changedWindow.state === 'fullscreen') {
      if (session.fullscreenStatus !== 'ACTIVE') {
        session = { ...session, fullscreenStatus: 'ACTIVE' };
        await broadcastState();
      }
      return;
    }
    if (session.fullscreenStatus !== 'ACTIVE') return;
    session = { ...session, fullscreenStatus: 'EXITED' };
    await recordEventInternal({
      type: 'FULLSCREEN_EXIT',
      duration: 0,
      confidence: 1,
      severity: 5,
      explanation: 'The monitored Chrome window left fullscreen. Look At Me! is restoring fullscreen mode.',
      source: 'browser',
      metadata: { windowId: changedWindow.id, observedState: changedWindow.state ?? 'unknown' },
    });
    if (fullscreenRecoveryTimer !== null) clearTimeout(fullscreenRecoveryTimer);
    fullscreenRecoveryTimer = setTimeout(() => {
      fullscreenRecoveryTimer = null;
      void enqueue(async () => {
        const stillActive = session.status === 'PROCTORING_STARTING'
          || session.status === 'PROCTORING_ACTIVE'
          || session.status === 'PROCTORING_PAUSED';
        if (stillActive && session.currentWindowId === changedWindow.id) {
          await enterFullscreen(changedWindow.id!);
          await broadcastState();
        }
      });
    }, 900) as unknown as number;
  });
});

chrome.runtime.onInstalled.addListener(() => { void restoreRuntime(); });
chrome.runtime.onStartup.addListener(() => { void restoreRuntime(); });
void restoreRuntime().catch((error) => {
  console.error('Look At Me! runtime restore failed', error);
});
