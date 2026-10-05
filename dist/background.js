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
    status: "PROCTORING_IDLE",
    activityScore: 0,
    eventCount: 0,
    severeEventCount: 0,
    cameraStatus: "OFF",
    faceStatus: "UNKNOWN",
    aiStatus: "IDLE",
    proctoringStatus: "Ready to start in the current tab.",
    currentTabId: null,
    currentTabUrl: null,
    startTime: null,
    endTime: null,
    lastEvent: null,
    lastAlert: null,
    localAgentState: "unavailable",
    localAgentMessage: "Local Windows agent has not connected yet.",
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
      sessionId: typeof candidate.sessionId === "string" ? candidate.sessionId.slice(0, 120) : null,
      currentTabUrl: typeof candidate.currentTabUrl === "string" ? candidate.currentTabUrl.slice(0, 2e3) : null,
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
  async function recordEventInternal(input) {
    const event = engine.record(input);
    if (!event) return null;
    session = applySummary(session, engine.summarize(), event);
    await broadcastState();
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
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Keep local webcam inference active after the temporary extension popup closes."
    });
  }
  async function sendToOffscreen(message) {
    let lastError;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        return await chrome.runtime.sendMessage({ target: "offscreen", ...message });
      } catch (error) {
        lastError = error;
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
    try {
      if (sendShutdown) port.postMessage({ type: "shutdown" });
      port.disconnect();
    } catch {
    }
  }
  function connectNativeAgent(forceRestart = false) {
    if (forceRestart) disconnectNativeAgent();
    if (nativePort) {
      nativePort.postMessage({ type: isSessionRunning(session.status) ? "start" : "capabilities", sessionId: session.sessionId });
      return;
    }
    emitAgentStatus("connecting", "Connecting to the registered Windows security host\u2026");
    try {
      const port = chrome.runtime.connectNative(NATIVE_HOST);
      nativePort = port;
      port.onMessage.addListener((message) => {
        if (!message || typeof message !== "object") return;
        const value = message;
        if (value.type === "ready" || value.type === "status") {
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
        const reason = chrome.runtime.lastError?.message ?? "Native host closed the connection.";
        emitAgentStatus("unavailable", `Local security agent unavailable: ${reason}`);
      });
      port.postMessage({ type: isSessionRunning(session.status) ? "start" : "capabilities", sessionId: session.sessionId });
    } catch (error) {
      nativePort = null;
      emitAgentStatus("error", `Local security agent could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function startSession() {
    await ensureLoaded();
    if (isSessionRunning(session.status)) return session;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id === void 0 || !isMonitorableUrl(tab.url)) {
      throw new Error("Open an ordinary http:// or https:// page before starting proctoring. Chrome system pages are not accessible.");
    }
    engine.clear();
    events = [];
    const now = Date.now();
    session = {
      ...createIdleSessionState(),
      sessionId: `session-${now}`,
      status: "PROCTORING_STARTING",
      cameraStatus: "REQUESTING",
      aiStatus: "LOADING",
      proctoringStatus: "Starting proctoring in the current tab\u2026",
      currentTabId: tab.id,
      currentTabUrl: tab.url,
      startTime: now
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
      await ensureOffscreenDocument();
      await sendToOffscreen({ type: "engine-start", sessionId: session.sessionId });
    } catch (error) {
      const message = `Proctoring engine could not start: ${error instanceof Error ? error.message : String(error)}`;
      session = { ...session, status: "PROCTORING_ERROR", cameraStatus: "ERROR", aiStatus: "ERROR", proctoringStatus: message, error: message };
      await broadcastState();
    }
    return session;
  }
  async function finalizeSession(reason) {
    await ensureLoaded();
    if (!isSessionRunning(session.status)) return session;
    session = {
      ...session,
      status: "PROCTORING_FINALIZING",
      proctoringStatus: reason === "google-forms" ? "Google Forms submission confirmed. Finalizing the local session\u2026" : "Finalizing the local session\u2026"
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
    try {
      if (await chrome.offscreen.hasDocument()) await sendToOffscreen({ type: "engine-stop" });
    } catch (error) {
      session = { ...session, error: `CV shutdown warning: ${error instanceof Error ? error.message : String(error)}` };
    }
    nativePort?.postMessage({ type: "stop", sessionId: session.sessionId });
    const endedAt = Date.now();
    await recordEventInternal({
      type: "SESSION_FINISHED",
      duration: Math.max(0, endedAt - (session.startTime ?? endedAt)),
      confidence: 1,
      severity: 0,
      explanation: reason === "google-forms" ? "The local proctoring session finished after confirmed Google Forms submission." : "The local proctoring session was stopped from the extension popup.",
      source: "system"
    });
    session = {
      ...session,
      status: "PROCTORING_COMPLETED",
      cameraStatus: "OFF",
      faceStatus: "UNKNOWN",
      aiStatus: "IDLE",
      proctoringStatus: "Session completed and saved locally.",
      endTime: endedAt,
      cloudSyncStatus: "NOT_CONFIGURED",
      lastAlert: null,
      localAgentState: "stopped",
      localAgentMessage: "Local security agent stopped with the completed session."
    };
    await broadcastState();
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
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
    void enqueue(async () => {
      await ensureLoaded();
      if (value.type === "popup-get-state") return { state: session };
      if (value.type === "popup-start") return { state: await startSession() };
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
        session = { ...session, status: "PROCTORING_ERROR", cameraStatus: "ERROR", aiStatus: "ERROR", error, proctoringStatus: error };
        await broadcastState();
        return { accepted: true };
      }
      if (value.type === "service-worker-health-check") {
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
        explanation: "The monitored test tab was closed. The session remains active until an explicit stop or confirmed submission.",
        source: "browser",
        metadata: { closedTabId: tabId }
      });
      session = { ...session, currentTabId: null, currentTabUrl: null, proctoringStatus: "Test tab closed; camera monitoring remains active." };
      await broadcastState();
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
