(() => {
  // src/browser/securityEvents.ts
  var eventDefaults = {
    TAB_SWITCH: { sources: ["browser"], explanation: "The active browser tab changed during monitoring." },
    WINDOW_BLUR: { sources: ["browser"], explanation: "The monitored browser window lost focus." },
    FULLSCREEN_EXIT: { sources: ["browser"], explanation: "Full-screen mode was exited during monitoring." },
    COPY_ATTEMPT: { sources: ["browser", "system"], explanation: "A copy shortcut or action was observed." },
    PASTE_ATTEMPT: { sources: ["browser", "system"], explanation: "A paste shortcut or action was observed." },
    CONTEXT_MENU: { sources: ["browser"], explanation: "The context menu was opened in the monitored page." },
    DEVTOOLS_ATTEMPT: { sources: ["browser"], explanation: "A browser developer-tools shortcut was observed." },
    ALT_TAB_ATTEMPT: { sources: ["system"], explanation: "The local security agent observed Alt+Tab." },
    SYSTEM_KEY_ATTEMPT: { sources: ["system"], explanation: "The local security agent observed a Windows system-key shortcut." },
    PRINT_SCREEN_ATTEMPT: { sources: ["system"], explanation: "The local security agent observed Print Screen." },
    APP_SWITCH: { sources: ["system"], explanation: "The foreground application changed during monitoring." }
  };
  var clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  var safeMetadata = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 12)) {
      if (typeof item === "string") output[key] = item.slice(0, 180);
      else if (typeof item === "number" && Number.isFinite(item)) output[key] = item;
      else if (typeof item === "boolean") output[key] = item;
    }
    return Object.keys(output).length ? output : void 0;
  };
  function normalizeSecurityEvent(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const input = value;
    if (typeof input.eventType !== "string") return null;
    const type = input.eventType;
    const defaults = eventDefaults[type];
    if (!defaults) return null;
    const requestedSource = input.source;
    const source = typeof requestedSource === "string" && defaults.sources.includes(requestedSource) ? requestedSource : defaults.sources[0];
    const explanation = typeof input.explanation === "string" && input.explanation.trim() ? input.explanation.trim().slice(0, 320) : defaults.explanation;
    const confidence = typeof input.confidence === "number" && Number.isFinite(input.confidence) ? clamp(input.confidence, 0, 1) : 1;
    const duration = typeof input.duration === "number" && Number.isFinite(input.duration) ? clamp(input.duration, 0, 864e5) : 0;
    const severity = typeof input.severity === "number" && Number.isFinite(input.severity) ? clamp(input.severity, 0, 10) : void 0;
    return {
      type,
      duration,
      confidence,
      severity,
      explanation,
      source,
      metadata: safeMetadata(input.metadata)
    };
  }

  // src/extension/sessionState.ts
  var SESSION_STORAGE_KEY = "look-at-me.session";
  var EVENTS_STORAGE_KEY = "look-at-me.events";
  var createIdleSessionState = () => ({
    sessionId: null,
    studentName: "",
    testName: "",
    status: "PROCTORING_IDLE",
    activityScore: 0,
    eventCount: 0,
    severeEventCount: 0,
    cameraStatus: "OFF",
    faceStatus: "UNKNOWN",
    aiStatus: "IDLE",
    proctoringStatus: "Ready to start in the current tab.",
    currentTabId: null,
    currentWindowId: null,
    currentTabUrl: null,
    startTime: null,
    endTime: null,
    lastEvent: null,
    lastAlert: null,
    localAgentState: "unavailable",
    localAgentMessage: "Local Windows agent has not connected yet.",
    storageStatus: "IDLE",
    dataRoot: null,
    evidenceCount: 0,
    fullscreenStatus: "IDLE",
    previousWindowState: null,
    cloudSyncStatus: "NOT_CONFIGURED",
    error: null
  });
  var isSessionRunning = (status) => status === "PROCTORING_STARTING" || status === "PROCTORING_ACTIVE" || status === "PROCTORING_PAUSED" || status === "PROCTORING_FINALIZING";
  var applySummary = (state, summary, lastEvent) => ({
    ...state,
    activityScore: summary.score,
    eventCount: summary.eventCount,
    severeEventCount: summary.severeEvents,
    lastEvent,
    lastAlert: lastEvent && lastEvent.severity >= 4 ? lastEvent.type.replace(/_/g, " ") : state.lastAlert
  });
  var isMonitorableUrl = (value) => {
    if (!value) return false;
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  };
  var sanitizeStoredState = (value) => {
    const fallback = createIdleSessionState();
    if (!value || typeof value !== "object") return fallback;
    const candidate = value;
    const allowedStatuses = [
      "PROCTORING_IDLE",
      "PROCTORING_STARTING",
      "PROCTORING_ACTIVE",
      "PROCTORING_PAUSED",
      "PROCTORING_FINALIZING",
      "PROCTORING_COMPLETED",
      "PROCTORING_ERROR"
    ];
    return {
      ...fallback,
      ...candidate,
      status: allowedStatuses.includes(candidate.status) ? candidate.status : fallback.status,
      activityScore: Math.min(200, Math.max(0, Number(candidate.activityScore) || 0)),
      eventCount: Math.max(0, Number(candidate.eventCount) || 0),
      severeEventCount: Math.max(0, Number(candidate.severeEventCount) || 0),
      currentTabId: typeof candidate.currentTabId === "number" ? candidate.currentTabId : null,
      currentWindowId: typeof candidate.currentWindowId === "number" ? candidate.currentWindowId : null,
      sessionId: typeof candidate.sessionId === "string" ? candidate.sessionId.slice(0, 120) : null,
      studentName: typeof candidate.studentName === "string" ? candidate.studentName.slice(0, 200) : "",
      testName: typeof candidate.testName === "string" ? candidate.testName.slice(0, 240) : "",
      currentTabUrl: typeof candidate.currentTabUrl === "string" ? candidate.currentTabUrl.slice(0, 2e3) : null,
      evidenceCount: Math.max(0, Number(candidate.evidenceCount) || 0),
      dataRoot: typeof candidate.dataRoot === "string" ? candidate.dataRoot.slice(0, 2e3) : null,
      error: typeof candidate.error === "string" ? candidate.error.slice(0, 500) : null
    };
  };

  // src/lib/eventEngine.ts
  var policies = {
    FACE_DETECTED: { severity: 0, baseImpact: 0, cooldownMs: 1e4 },
    FACE_NOT_DETECTED: { severity: 4, baseImpact: 6, cooldownMs: 6e3 },
    MULTIPLE_FACES: { severity: 6, baseImpact: 10, cooldownMs: 8e3 },
    HEAD_TURN: { severity: 4, baseImpact: 4, cooldownMs: 0 },
    LOOKING_AWAY: { severity: 4, baseImpact: 4, cooldownMs: 0 },
    PHONE_DETECTED: { severity: 8, baseImpact: 18, cooldownMs: 1e3 },
    TAB_SWITCH: { severity: 5, baseImpact: 5, cooldownMs: 2e3 },
    WINDOW_BLUR: { severity: 3, baseImpact: 3, cooldownMs: 2e3 },
    FULLSCREEN_EXIT: { severity: 5, baseImpact: 6, cooldownMs: 4e3 },
    COPY_ATTEMPT: { severity: 2, baseImpact: 2, cooldownMs: 1500 },
    PASTE_ATTEMPT: { severity: 3, baseImpact: 3, cooldownMs: 1500 },
    CONTEXT_MENU: { severity: 1, baseImpact: 1, cooldownMs: 1500 },
    DEVTOOLS_ATTEMPT: { severity: 5, baseImpact: 6, cooldownMs: 2e3 },
    ALT_TAB_ATTEMPT: { severity: 6, baseImpact: 8, cooldownMs: 1e3 },
    SYSTEM_KEY_ATTEMPT: { severity: 5, baseImpact: 6, cooldownMs: 1e3 },
    PRINT_SCREEN_ATTEMPT: { severity: 6, baseImpact: 9, cooldownMs: 1500 },
    APP_SWITCH: { severity: 5, baseImpact: 7, cooldownMs: 1500 },
    CAMERA_BLOCKED: { severity: 5, baseImpact: 6, cooldownMs: 1e4 },
    MODEL_FAILURE: { severity: 0, baseImpact: 0, cooldownMs: 1e4 },
    INFERENCE_FAILURE: { severity: 0, baseImpact: 0, cooldownMs: 1e4 },
    SESSION_STARTED: { severity: 0, baseImpact: 0, cooldownMs: 1e3 },
    SESSION_FINISHED: { severity: 0, baseImpact: 0, cooldownMs: 1e3 },
    FORM_SUBMITTED: { severity: 0, baseImpact: 0, cooldownMs: 1e3 }
  };
  var clamp2 = (value, min, max) => Math.min(Math.max(value, min), max);
  var makeId = (type, now) => {
    const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${now}-${EventEngine.nextId++}`;
    return `${type}-${suffix}`;
  };
  var isDirectionEvent = (type) => type === "HEAD_TURN" || type === "LOOKING_AWAY";
  var EventEngine = class {
    static nextId = 1;
    events = [];
    cooldowns = /* @__PURE__ */ new Map();
    now;
    constructor(initialEvents = [], now = Date.now) {
      this.now = now;
      this.hydrate(initialEvents);
    }
    hydrate(events2) {
      const occurrenceCounts = /* @__PURE__ */ new Map();
      const chronological = [...events2].filter((event) => Number.isFinite(event.timestamp) && event.type in policies).sort((a, b) => a.timestamp - b.timestamp).slice(-250);
      this.events = chronological.map((event) => {
        const policy = policies[event.type];
        const duration = Math.max(0, Number.isFinite(event.duration) ? event.duration : 0);
        const confidence = clamp2(Number.isFinite(event.confidence) ? event.confidence : 0, 0, 1);
        const occurrenceIndex = occurrenceCounts.get(event.type) ?? 0;
        occurrenceCounts.set(event.type, occurrenceIndex + 1);
        const storedImpact = Number.isFinite(event.scoreImpact) ? event.scoreImpact : policy.baseImpact;
        const scoreImpact = storedImpact === 0 ? 0 : storedImpact > 0 && !isDirectionEvent(event.type) ? storedImpact : this.calculateImpact(event.type, policy.baseImpact, confidence, duration, occurrenceIndex);
        return {
          ...event,
          duration,
          confidence,
          severity: clamp2(Number.isFinite(event.severity) ? event.severity : policy.severity, 0, 10),
          scoreImpact: clamp2(Math.round(scoreImpact), 0, 200),
          metadata: isDirectionEvent(event.type) ? { ...event.metadata, recurrenceIndex: occurrenceIndex } : event.metadata
        };
      }).sort((a, b) => b.timestamp - a.timestamp);
      this.cooldowns.clear();
      for (const event of this.events) {
        const previous = this.cooldowns.get(event.type) ?? 0;
        this.cooldowns.set(event.type, Math.max(previous, event.timestamp));
      }
    }
    record(input) {
      const now = this.now();
      const policy = policies[input.type];
      const lastSeen = this.cooldowns.get(input.type);
      if (lastSeen !== void 0 && now - lastSeen < policy.cooldownMs) {
        return null;
      }
      const confidence = clamp2(input.confidence, 0, 1);
      const duration = Math.max(0, input.duration);
      const previousCount = this.events.filter((event) => event.type === input.type).length;
      const scoreImpact = input.scoreImpact ?? this.calculateImpact(
        input.type,
        policy.baseImpact,
        confidence,
        duration,
        previousCount
      );
      const normalizedEvent = {
        ...input,
        id: makeId(input.type, now),
        timestamp: now,
        duration,
        severity: clamp2(input.severity ?? policy.severity, 0, 10),
        confidence,
        scoreImpact: clamp2(Math.round(scoreImpact), 0, 200),
        explanation: input.explanation.trim() || "Observed by the monitoring pipeline.",
        source: input.source,
        metadata: isDirectionEvent(input.type) ? { ...input.metadata, recurrenceIndex: previousCount } : input.metadata
      };
      this.events = [normalizedEvent, ...this.events].slice(0, 250);
      this.cooldowns.set(input.type, now);
      return normalizedEvent;
    }
    updateEvent(id, update) {
      const index = this.events.findIndex((event) => event.id === id);
      if (index < 0) return null;
      const current = this.events[index];
      const duration = Math.max(current.duration, Math.max(0, update.duration));
      const confidence = update.confidence === void 0 ? current.confidence : clamp2(update.confidence, 0, 1);
      const recurrenceIndex = typeof current.metadata?.recurrenceIndex === "number" ? current.metadata.recurrenceIndex : this.events.filter((event) => event.type === current.type && event.timestamp < current.timestamp).length;
      const policy = policies[current.type];
      const scoreImpact = this.calculateImpact(
        current.type,
        policy.baseImpact,
        confidence,
        duration,
        recurrenceIndex
      );
      const updated = {
        ...current,
        duration,
        confidence,
        scoreImpact: clamp2(Math.round(scoreImpact), 0, 200),
        explanation: update.explanation?.trim() || current.explanation,
        metadata: { ...current.metadata, ...update.metadata }
      };
      this.events[index] = updated;
      return updated;
    }
    getEvents() {
      return [...this.events];
    }
    summarize() {
      const scoredEvents = this.events.filter((event) => event.scoreImpact > 0);
      const severeEvents = this.events.filter((event) => event.severity >= 6).length;
      const confidence = scoredEvents.length ? scoredEvents.reduce((total, event) => total + event.confidence, 0) / scoredEvents.length : 0;
      const counts = /* @__PURE__ */ new Map();
      const byType = {};
      for (const event of this.events) {
        counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
        byType[event.type] = (byType[event.type] ?? 0) + event.scoreImpact;
      }
      const repeatedEvents = [...counts.values()].reduce(
        (total, count) => total + Math.max(0, count - 1),
        0
      );
      const totalImpact = this.events.reduce((total, event) => total + event.scoreImpact, 0);
      return {
        score: clamp2(totalImpact, 0, 200),
        eventCount: this.events.length,
        severeEvents,
        confidence,
        breakdown: {
          severity: scoredEvents.reduce((total, event) => total + event.severity, 0),
          confidence,
          duration: scoredEvents.reduce((total, event) => total + event.duration, 0),
          repeatedEvents,
          byType
        }
      };
    }
    clear() {
      this.events = [];
      this.cooldowns.clear();
    }
    calculateImpact(type, baseImpact, confidence, duration, previousCount) {
      if (baseImpact === 0) return 0;
      if (isDirectionEvent(type)) {
        const additionalSeconds = Math.max(0, Math.floor(duration / 1e3) - 1);
        return 4 + previousCount + additionalSeconds;
      }
      const confidenceFactor = 0.5 + confidence * 0.5;
      const durationFactor = 1 + Math.min(duration / 5e3, 1) * 0.35;
      const repetitionFactor = 1 + Math.min(previousCount * 0.15, 0.45);
      return baseImpact * confidenceFactor * durationFactor * repetitionFactor;
    }
  };

  // src/evidence/localEvidence.ts
  var nonViolationTypes = /* @__PURE__ */ new Set([
    "FACE_DETECTED",
    "SESSION_STARTED",
    "SESSION_FINISHED",
    "FORM_SUBMITTED"
  ]);
  var shouldCaptureScreenshot = (event) => event.scoreImpact > 0 && !nonViolationTypes.has(event.type);
  var serializeViolation = (event) => ({
    id: event.id,
    type: event.type,
    timestamp: event.timestamp
  });

  // src/background/serviceWorker.ts
  var NATIVE_HOST = "com.look_at_me.security";
  var POPUP_PORT = "look-at-me-popup";
  var OFFSCREEN_URL = "offscreen.html";
  var systemEventTypes = /* @__PURE__ */ new Set([
    "COPY_ATTEMPT",
    "PASTE_ATTEMPT",
    "ALT_TAB_ATTEMPT",
    "SYSTEM_KEY_ATTEMPT",
    "PRINT_SCREEN_ATTEMPT",
    "APP_SWITCH"
  ]);
  var engine = new EventEngine();
  var session = createIdleSessionState();
  var events = [];
  var loaded = false;
  var loadPromise = null;
  var mutationQueue = Promise.resolve();
  var nativePort = null;
  var popupConnections = 0;
  var fullscreenRecoveryTimer = null;
  var nativeRequests = /* @__PURE__ */ new Map();
  var evidenceTasks = /* @__PURE__ */ new Set();
  var sessionFailures = [];
  var registerSessionFailure = (message) => {
    if (!sessionFailures.includes(message)) sessionFailures = [...sessionFailures, message].slice(-20);
  };
  var enqueue = (work) => {
    const result = mutationQueue.then(work, work);
    mutationQueue = result.then(() => void 0, () => void 0);
    return result;
  };
  var safeText = (value, maxLength = 500) => typeof value === "string" ? value.slice(0, maxLength) : void 0;
  var safeMetadata2 = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 16)) {
      if (typeof item === "string") output[key] = item.slice(0, 200);
      else if (typeof item === "number" && Number.isFinite(item)) output[key] = item;
      else if (typeof item === "boolean") output[key] = item;
    }
    return Object.keys(output).length ? output : void 0;
  };
  var makeSessionId = (now = /* @__PURE__ */ new Date()) => {
    const parts = [
      now.getUTCFullYear().toString(),
      (now.getUTCMonth() + 1).toString().padStart(2, "0"),
      now.getUTCDate().toString().padStart(2, "0"),
      "_",
      now.getUTCHours().toString().padStart(2, "0"),
      now.getUTCMinutes().toString().padStart(2, "0"),
      now.getUTCSeconds().toString().padStart(2, "0")
    ].join("");
    return `session_${parts}_${crypto.randomUUID().slice(0, 8)}`;
  };
  async function hasOffscreenDocument() {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    return contexts.length > 0;
  }
  async function ensureLoaded() {
    if (loaded) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const stored = await chrome.storage.local.get([SESSION_STORAGE_KEY, EVENTS_STORAGE_KEY]);
      session = sanitizeStoredState(stored[SESSION_STORAGE_KEY]);
      events = Array.isArray(stored[EVENTS_STORAGE_KEY]) ? stored[EVENTS_STORAGE_KEY] : [];
      engine.hydrate(events);
      session = applySummary(session, engine.summarize(), engine.getEvents()[0] ?? null);
      loaded = true;
    })().finally(() => {
      loadPromise = null;
    });
    return loadPromise;
  }
  async function persist() {
    events = engine.getEvents();
    await chrome.storage.local.set({
      [SESSION_STORAGE_KEY]: session,
      [EVENTS_STORAGE_KEY]: events
    });
  }
  async function sendStateToContent() {
    if (session.currentTabId === null) return;
    try {
      await chrome.tabs.sendMessage(session.currentTabId, { type: "session-state", state: session });
    } catch {
    }
  }
  async function ensureContentScript(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "content-probe" });
      return;
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });
    }
  }
  async function broadcastState() {
    await persist();
    try {
      await chrome.runtime.sendMessage({ type: "session-state", state: session });
    } catch {
    }
    await sendStateToContent();
  }
  async function captureEvidenceForEvent(event, sessionId) {
    try {
      if (!await hasOffscreenDocument()) throw new Error("The offscreen camera context is unavailable.");
      if (session.currentWindowId === null) throw new Error("The monitored Chrome window is unavailable.");
      const dataUrl = await chrome.tabs.captureVisibleTab(session.currentWindowId, { format: "png" });
      const prefix = "data:image/png;base64,";
      if (!dataUrl.startsWith(prefix)) throw new Error("Chrome returned an unsupported screenshot format.");
      const response = await sendToOffscreen({
        type: "compose-evidence",
        pageFrame: { data: dataUrl.slice(prefix.length), mimeType: "image/png" },
        eventType: event.type,
        timestamp: event.timestamp
      });
      if (!response.captured || !response.frame?.data || response.frame.mimeType !== "image/png") {
        throw new Error(response.error || "The combined test-and-camera evidence frame was not created.");
      }
      const result = await nativeRequest({
        type: "storage-violation-save",
        sessionId,
        event: serializeViolation(event),
        data: response.frame.data,
        mimeType: response.frame.mimeType
      });
      if (session.sessionId === sessionId) {
        session = {
          ...session,
          evidenceCount: session.evidenceCount + (result.alreadyExisted === true ? 0 : 1),
          storageStatus: "READY",
          dataRoot: safeText(result.dataRoot, 2e3) ?? session.dataRoot
        };
        await broadcastState();
      }
    } catch (error) {
      if (session.sessionId === sessionId) {
        const message = `Evidence screenshot could not be saved: ${error instanceof Error ? error.message : String(error)}`;
        registerSessionFailure(message);
        session = { ...session, storageStatus: "ERROR", error: message };
        await broadcastState();
      }
    }
  }
  async function recordEventInternal(input) {
    const event = engine.record(input);
    if (!event) return null;
    session = applySummary(session, engine.summarize(), event);
    await broadcastState();
    if (shouldCaptureScreenshot(event) && session.sessionId) {
      const sessionId = session.sessionId;
      const task = new Promise((resolve) => setTimeout(resolve, 0)).then(() => captureEvidenceForEvent(event, sessionId));
      evidenceTasks.add(task);
      void task.finally(() => evidenceTasks.delete(task));
    }
    return event;
  }
  async function updateEventInternal(id, update) {
    const event = engine.updateEvent(id, update);
    if (!event) return null;
    session = applySummary(session, engine.summarize(), event);
    await broadcastState();
    return event;
  }
  async function ensureOffscreenDocument() {
    if (await hasOffscreenDocument()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Keep local webcam inference active after the temporary extension popup closes."
    });
  }
  function withTimeout(promise, timeoutMs, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }
  async function sendToOffscreen(message) {
    let lastError;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        return await withTimeout(
          chrome.runtime.sendMessage({ target: "offscreen", ...message }),
          15e3,
          "Offscreen operation timed out."
        );
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.message === "Offscreen operation timed out.") throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Offscreen proctoring engine did not respond.");
  }
  function emitAgentStatus(state, message) {
    void enqueue(async () => {
      await ensureLoaded();
      session = { ...session, localAgentState: state, localAgentMessage: message };
      await broadcastState();
    });
  }
  function disconnectNativeAgent(sendShutdown = true) {
    if (!nativePort) return;
    const port = nativePort;
    nativePort = null;
    for (const [id, pending] of nativeRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The local Native Messaging host disconnected."));
      nativeRequests.delete(id);
    }
    try {
      if (sendShutdown) port.postMessage({ type: "shutdown" });
      port.disconnect();
    } catch {
    }
  }
  function nativeRequest(message, timeoutMs = 2e4) {
    connectNativeAgent();
    const port = nativePort;
    if (!port) return Promise.reject(new Error("The local evidence helper is unavailable."));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        nativeRequests.delete(requestId);
        reject(new Error(`Local helper timed out while handling ${String(message.type)}.`));
      }, timeoutMs);
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
  function connectNativeAgent(forceRestart = false) {
    if (forceRestart) disconnectNativeAgent();
    if (nativePort) return;
    emitAgentStatus("connecting", "Connecting to the registered Windows security host\u2026");
    try {
      const port = chrome.runtime.connectNative(NATIVE_HOST);
      nativePort = port;
      port.onMessage.addListener((message) => {
        if (!message || typeof message !== "object") return;
        const value = message;
        if (value.type === "storage-response" && typeof value.replyTo === "string") {
          const pending = nativeRequests.get(value.replyTo);
          if (!pending) return;
          nativeRequests.delete(value.replyTo);
          clearTimeout(pending.timer);
          if (value.ok === true) pending.resolve(value.result ?? {});
          else pending.reject(new Error(safeText(value.error, 800) ?? "The local evidence helper rejected the request."));
        } else if (value.type === "ready" || value.type === "status") {
          const rawState = safeText(value.state, 32) ?? (value.type === "ready" ? "ready" : "error");
          const allowed = /* @__PURE__ */ new Set(["unavailable", "connecting", "ready", "active", "stopped", "error"]);
          emitAgentStatus(
            allowed.has(rawState) ? rawState : "error",
            safeText(value.message) ?? "Local security agent responded."
          );
        } else if (value.type === "event" && isSessionRunning(session.status) && systemEventTypes.has(String(value.eventType))) {
          const normalized = normalizeSecurityEvent({
            eventType: value.eventType,
            source: "system",
            confidence: value.confidence,
            duration: value.duration,
            explanation: safeText(value.explanation),
            metadata: safeMetadata2(value.metadata)
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
          pending.reject(new Error("The local Native Messaging host disconnected."));
          nativeRequests.delete(id);
        }
        const reason = chrome.runtime.lastError?.message ?? "Native host closed the connection.";
        emitAgentStatus("unavailable", `Local security agent unavailable: ${reason}`);
      });
      port.postMessage({ type: isSessionRunning(session.status) ? "start" : "capabilities", sessionId: session.sessionId });
    } catch (error) {
      nativePort = null;
      emitAgentStatus("error", `Local security agent could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function enterFullscreen(windowId) {
    session = { ...session, fullscreenStatus: "ENTERING" };
    try {
      const updated = await chrome.windows.update(windowId, { state: "fullscreen", focused: true });
      session = {
        ...session,
        fullscreenStatus: updated.state === "fullscreen" ? "ACTIVE" : "ERROR"
      };
    } catch (error) {
      session = {
        ...session,
        fullscreenStatus: "ERROR",
        error: `Fullscreen could not be enabled: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  async function restoreWindowState() {
    if (fullscreenRecoveryTimer !== null) {
      clearTimeout(fullscreenRecoveryTimer);
      fullscreenRecoveryTimer = null;
    }
    if (session.currentWindowId === null) return;
    const targetState = session.previousWindowState === "maximized" ? "maximized" : "normal";
    try {
      await chrome.windows.update(session.currentWindowId, { state: targetState });
    } catch {
    }
  }
  async function startSession(options) {
    await ensureLoaded();
    if (isSessionRunning(session.status)) return session;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id === void 0 || !isMonitorableUrl(tab.url)) {
      throw new Error("Open an ordinary http:// or https:// page before starting proctoring. Chrome system pages are not accessible.");
    }
    const browserWindow = await chrome.windows.get(tab.windowId);
    engine.clear();
    events = [];
    sessionFailures = [];
    const now = Date.now();
    session = {
      ...createIdleSessionState(),
      sessionId: makeSessionId(new Date(now)),
      studentName: safeText(options.studentName, 200)?.trim() || "Student",
      testName: safeText(options.testName, 240)?.trim() || new URL(tab.url).hostname,
      status: "PROCTORING_STARTING",
      cameraStatus: "REQUESTING",
      aiStatus: "LOADING",
      proctoringStatus: "Preparing local violation screenshots and AI monitoring\u2026",
      currentTabId: tab.id,
      currentWindowId: tab.windowId,
      currentTabUrl: tab.url,
      startTime: now,
      storageStatus: "CONNECTING",
      fullscreenStatus: "ENTERING",
      previousWindowState: browserWindow.state ?? "normal"
    };
    try {
      await ensureContentScript(tab.id);
    } catch (error) {
      const message = `The current page could not host the proctoring overlay: ${error instanceof Error ? error.message : String(error)}`;
      session = {
        ...session,
        status: "PROCTORING_ERROR",
        cameraStatus: "OFF",
        aiStatus: "ERROR",
        proctoringStatus: message,
        error: message
      };
      await broadcastState();
      return session;
    }
    await broadcastState();
    connectNativeAgent();
    try {
      const storage = await nativeRequest({
        type: "storage-initialize"
      });
      session = {
        ...session,
        storageStatus: "READY",
        dataRoot: safeText(storage.dataRoot, 2e3) ?? null
      };
      await ensureOffscreenDocument();
      session = { ...session, proctoringStatus: "Starting camera and local AI models\u2026" };
      await enterFullscreen(tab.windowId);
      await broadcastState();
      await sendToOffscreen({ type: "engine-start", sessionId: session.sessionId });
    } catch (error) {
      const message = `Proctoring engine could not start: ${error instanceof Error ? error.message : String(error)}`;
      session = {
        ...session,
        status: "PROCTORING_ERROR",
        cameraStatus: "ERROR",
        aiStatus: "ERROR",
        storageStatus: session.storageStatus === "READY" ? "ERROR" : session.storageStatus,
        proctoringStatus: message,
        error: message
      };
      try {
        if (await hasOffscreenDocument()) {
          await sendToOffscreen({ type: "engine-stop" });
        }
      } catch {
      }
      await broadcastState();
      await restoreWindowState();
      nativePort?.postMessage({ type: "stop", sessionId: session.sessionId });
      if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
    }
    return session;
  }
  async function finalizeSession(reason) {
    await ensureLoaded();
    if (!isSessionRunning(session.status)) return session;
    session = {
      ...session,
      status: "PROCTORING_FINALIZING",
      storageStatus: "SAVING",
      proctoringStatus: reason === "google-forms" ? "Google Forms submission confirmed. Finalizing the local session\u2026" : reason === "interrupted" ? "The monitored test was interrupted. Finalizing local evidence\u2026" : "Finalizing the local session\u2026"
    };
    await broadcastState();
    if (reason === "google-forms") {
      await recordEventInternal({
        type: "FORM_SUBMITTED",
        duration: 0,
        confidence: 1,
        severity: 0,
        explanation: "Google Forms displayed a confirmed response-submitted page after a submit intent.",
        source: "browser"
      });
    }
    const endedAt = Date.now();
    await recordEventInternal({
      type: "SESSION_FINISHED",
      duration: Math.max(0, endedAt - (session.startTime ?? endedAt)),
      confidence: 1,
      severity: 0,
      explanation: reason === "google-forms" ? "The local proctoring session finished after confirmed Google Forms submission." : reason === "interrupted" ? "The monitored test tab was closed before a confirmed submission." : reason === "error" ? "The local proctoring session stopped after a runtime error." : "The local proctoring session was stopped from the extension popup.",
      source: "system"
    });
    await Promise.allSettled([...evidenceTasks]);
    let finalStatus = reason === "error" || sessionFailures.length ? "ERROR" : reason === "interrupted" ? "INTERRUPTED" : "COMPLETED";
    const warnings = [...sessionFailures];
    if (reason === "error" && session.error && !warnings.includes(session.error)) warnings.push(session.error);
    try {
      if (await hasOffscreenDocument()) await sendToOffscreen({ type: "engine-stop" });
    } catch (error) {
      warnings.push(`CV shutdown warning: ${error instanceof Error ? error.message : String(error)}`);
    }
    session = { ...session, storageStatus: finalStatus === "ERROR" ? "ERROR" : "SAVED" };
    nativePort?.postMessage({ type: "stop", sessionId: session.sessionId });
    session = { ...session, fullscreenStatus: "IDLE" };
    await restoreWindowState();
    session = {
      ...session,
      status: finalStatus === "COMPLETED" ? "PROCTORING_COMPLETED" : "PROCTORING_ERROR",
      cameraStatus: "OFF",
      faceStatus: "UNKNOWN",
      aiStatus: "IDLE",
      proctoringStatus: finalStatus === "COMPLETED" ? "Session completed. Violation screenshots and their SQLite index were saved locally." : finalStatus === "INTERRUPTED" ? "The interrupted session ended; available violation screenshots remain saved locally." : "Session ended with a local screenshot storage or runtime error.",
      endTime: endedAt,
      cloudSyncStatus: "NOT_CONFIGURED",
      lastAlert: null,
      localAgentState: "stopped",
      localAgentMessage: "Local security agent stopped with the completed session.",
      fullscreenStatus: "IDLE",
      error: warnings.length ? warnings.join(" ") : null
    };
    await broadcastState();
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
    disconnectNativeAgent();
    return session;
  }
  async function applyEngineStatus(patch) {
    await ensureLoaded();
    if (!isSessionRunning(session.status)) return;
    const current = session;
    const changed = Object.entries(patch).some(([key, value]) => current[key] !== value);
    if (!changed) return;
    const wasStarting = session.status === "PROCTORING_STARTING";
    session = { ...session, ...patch };
    if (wasStarting && patch.cameraStatus === "ON" && (patch.aiStatus === "ACTIVE" || patch.aiStatus === "DEGRADED")) {
      session.status = "PROCTORING_ACTIVE";
      await recordEventInternal({
        type: "SESSION_STARTED",
        duration: 0,
        confidence: 1,
        severity: 0,
        explanation: "The local proctoring session started in the selected browser tab.",
        source: "system"
      });
      return;
    }
    if (patch.cameraStatus === "ERROR" && patch.aiStatus === "ERROR") session.status = "PROCTORING_ERROR";
    await broadcastState();
  }
  async function restoreRuntime() {
    await ensureLoaded();
    if (!isSessionRunning(session.status) || !session.sessionId) return;
    connectNativeAgent();
    await ensureOffscreenDocument();
    await sendToOffscreen({ type: "engine-start", sessionId: session.sessionId });
    await sendStateToContent();
  }
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== POPUP_PORT) return;
    popupConnections += 1;
    void enqueue(async () => {
      await ensureLoaded();
      port.postMessage({ type: "session-state", state: session });
      if (isSessionRunning(session.status)) connectNativeAgent();
    });
    port.onDisconnect.addListener(() => {
      popupConnections = Math.max(0, popupConnections - 1);
    });
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    const value = message;
    if (value.target === "offscreen") return false;
    const fromOffscreen = sender.url === chrome.runtime.getURL(OFFSCREEN_URL);
    const fromEvidencePage = sender.url === chrome.runtime.getURL("evidence.html");
    void enqueue(async () => {
      await ensureLoaded();
      if (value.type === "popup-get-state") return { state: session };
      if (value.type === "popup-get-events") return { events: engine.getEvents().slice(0, 12) };
      if (value.type === "popup-start") {
        return {
          state: await startSession({
            studentName: safeText(value.studentName, 200),
            testName: safeText(value.testName, 240)
          })
        };
      }
      if (value.type === "popup-stop") {
        if (value.confirmed !== true) {
          return { state: session, error: "Stopping an active session requires explicit confirmation." };
        }
        return { state: await finalizeSession("manual") };
      }
      if (value.type === "popup-retry-agent") {
        connectNativeAgent(true);
        return { state: session };
      }
      if (value.type === "popup-camera-preview") {
        if (!isSessionRunning(session.status) || !await hasOffscreenDocument()) return { available: false };
        return sendToOffscreen({ type: "camera-preview" });
      }
      if (value.type === "evidence-list") {
        if (!fromEvidencePage) return { error: "Evidence records are available only to the extension evidence page." };
        return nativeRequest({ type: "storage-list-violations", limit: 1e3 });
      }
      if (value.type === "evidence-delete") {
        if (!fromEvidencePage) return { error: "Evidence deletion is available only to the extension evidence page." };
        const eventId = safeText(value.eventId, 180);
        if (!eventId) return { error: "A valid event ID is required." };
        return nativeRequest({ type: "storage-delete-violation", eventId });
      }
      if (value.type === "content-ready") {
        if (sender.tab?.id === session.currentTabId && isSessionRunning(session.status)) {
          if (isMonitorableUrl(sender.tab.url)) {
            session = { ...session, currentTabUrl: sender.tab.url };
            await persist();
          }
          return { state: session };
        }
        return { state: null };
      }
      if (value.type === "page-security-event") {
        if (!sender.tab || sender.tab.id !== session.currentTabId || !isSessionRunning(session.status)) return { accepted: false };
        if (popupConnections > 0 && value.eventType === "WINDOW_BLUR") return { accepted: false, reason: "popup-open" };
        const normalized = normalizeSecurityEvent({
          eventType: value.eventType,
          source: "browser",
          confidence: value.confidence,
          duration: value.duration,
          explanation: safeText(value.explanation),
          metadata: { ...safeMetadata2(value.metadata), tabId: sender.tab.id, windowId: sender.tab.windowId }
        });
        if (!normalized) return { accepted: false };
        return { accepted: Boolean(await recordEventInternal(normalized)) };
      }
      if (value.type === "google-forms-submitted") {
        const validSender = sender.tab?.id === session.currentTabId && isSessionRunning(session.status) && isMonitorableUrl(sender.tab.url) && new URL(sender.tab.url).hostname === "docs.google.com" && new URL(sender.tab.url).pathname.startsWith("/forms/");
        if (!validSender || value.confirmed !== true || value.sessionId !== session.sessionId) return { accepted: false };
        return { accepted: true, state: await finalizeSession("google-forms") };
      }
      if (value.target === "background" && value.type === "engine-event") {
        if (!fromOffscreen) return { event: null, error: "untrusted-engine-sender" };
        const input = value.input;
        if (!isSessionRunning(session.status) || !input || typeof input.type !== "string") return { event: null };
        return { event: await recordEventInternal(input) };
      }
      if (value.target === "background" && value.type === "engine-event-update") {
        if (!fromOffscreen) return { event: null, error: "untrusted-engine-sender" };
        if (!isSessionRunning(session.status) || typeof value.id !== "string") return { event: null };
        return { event: await updateEventInternal(value.id, value.update) };
      }
      if (value.target === "background" && value.type === "engine-status") {
        if (!fromOffscreen) return { accepted: false, error: "untrusted-engine-sender" };
        await applyEngineStatus(value.patch);
        return { accepted: true };
      }
      if (value.target === "background" && value.type === "engine-fatal-error") {
        if (!fromOffscreen) return { accepted: false, error: "untrusted-engine-sender" };
        const error = safeText(value.message) ?? "Unknown proctoring engine failure.";
        session = { ...session, cameraStatus: "ERROR", aiStatus: "ERROR", error, proctoringStatus: error };
        return { accepted: true, state: await finalizeSession("error") };
      }
      if (value.type === "service-worker-health-check") {
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
        type: "TAB_SWITCH",
        duration: 0,
        confidence: 1,
        explanation: "The active Chrome tab changed away from the monitored test tab.",
        source: "browser",
        metadata: { fromTabId: session.currentTabId, toTabId: activeInfo.tabId, windowId: activeInfo.windowId }
      });
    });
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete") return;
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
        type: "TAB_SWITCH",
        duration: 0,
        confidence: 1,
        explanation: "The monitored test tab was closed before a confirmed submission.",
        source: "browser",
        metadata: { closedTabId: tabId }
      });
      await finalizeSession("interrupted");
    });
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    void enqueue(async () => {
      await ensureLoaded();
      if (!isSessionRunning(session.status) || popupConnections > 0) return;
      if (windowId === chrome.windows.WINDOW_ID_NONE) {
        await recordEventInternal({
          type: "WINDOW_BLUR",
          duration: 0,
          confidence: 1,
          explanation: "Chrome lost operating-system focus during proctoring.",
          source: "browser"
        });
      }
    });
  });
  chrome.windows.onBoundsChanged.addListener((changedWindow) => {
    void enqueue(async () => {
      await ensureLoaded();
      const enforce = session.status === "PROCTORING_STARTING" || session.status === "PROCTORING_ACTIVE" || session.status === "PROCTORING_PAUSED";
      if (!enforce || changedWindow.id !== session.currentWindowId) return;
      if (changedWindow.state === "fullscreen") {
        if (session.fullscreenStatus !== "ACTIVE") {
          session = { ...session, fullscreenStatus: "ACTIVE" };
          await broadcastState();
        }
        return;
      }
      if (session.fullscreenStatus !== "ACTIVE") return;
      session = { ...session, fullscreenStatus: "EXITED" };
      await recordEventInternal({
        type: "FULLSCREEN_EXIT",
        duration: 0,
        confidence: 1,
        severity: 5,
        explanation: "The monitored Chrome window left fullscreen. Look At Me! is restoring fullscreen mode.",
        source: "browser",
        metadata: { windowId: changedWindow.id, observedState: changedWindow.state ?? "unknown" }
      });
      if (fullscreenRecoveryTimer !== null) clearTimeout(fullscreenRecoveryTimer);
      fullscreenRecoveryTimer = setTimeout(() => {
        fullscreenRecoveryTimer = null;
        void enqueue(async () => {
          const stillActive = session.status === "PROCTORING_STARTING" || session.status === "PROCTORING_ACTIVE" || session.status === "PROCTORING_PAUSED";
          if (stillActive && session.currentWindowId === changedWindow.id) {
            await enterFullscreen(changedWindow.id);
            await broadcastState();
          }
        });
      }, 900);
    });
  });
  chrome.runtime.onInstalled.addListener(() => {
    void restoreRuntime();
  });
  chrome.runtime.onStartup.addListener(() => {
    void restoreRuntime();
  });
  void restoreRuntime().catch((error) => {
    console.error("Look At Me! runtime restore failed", error);
  });
})();
