(() => {
  // src/extension/sessionState.ts
  var isSessionRunning = (status) => status === "PROCTORING_STARTING" || status === "PROCTORING_ACTIVE" || status === "PROCTORING_PAUSED" || status === "PROCTORING_FINALIZING";

  // src/content/googleForms.ts
  var INTENT_MAX_AGE_MS = 5 * 6e4;
  var confirmationText = /(?:your response has been recorded|response submitted|ответ записан|ответ отправлен|ваш ответ|жауабыңыз жазылды|жауап жіберілді)/i;
  var submitText = /^(?:submit|send|отправить|отправить форму|жіберу|жiберу)$/i;
  var isGoogleFormsUrl = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "docs.google.com" && url.pathname.startsWith("/forms/");
    } catch {
      return false;
    }
  };
  var isLikelySubmitControl = (element) => {
    if (!element) return false;
    const control = element.closest('button, input[type="submit"], [role="button"]');
    if (!control) return false;
    if (control instanceof HTMLInputElement && control.type === "submit") return true;
    const label = `${control.getAttribute("aria-label") ?? ""} ${control.textContent ?? ""}`.replace(/\s+/g, " ").trim();
    return submitText.test(label);
  };
  var isConfirmedGoogleFormsSubmission = (urlValue, bodyText, hasQuestionElements, hasConfirmationContainer) => {
    if (!isGoogleFormsUrl(urlValue)) return false;
    const url = new URL(urlValue);
    const responsePath = url.pathname.includes("/formResponse");
    if (!responsePath) return false;
    return confirmationText.test(bodyText) || hasConfirmationContainer && !hasQuestionElements;
  };
  var isFreshIntent = (intent, sessionId, now = Date.now()) => Boolean(
    intent && intent.sessionId === sessionId && now >= intent.timestamp && now - intent.timestamp <= INTENT_MAX_AGE_MS
  );

  // src/content/index.ts
  var OVERLAY_HOST_ID = "look-at-me-proctoring-overlay";
  var FORM_INTENT_KEY = "look-at-me.google-form-submit-intent";
  var FORM_REPORTED_KEY = "look-at-me.google-form-submission-reported";
  var state = null;
  var expectedFullscreen = false;
  var confirmationTimer = null;
  var send = (message) => {
    void chrome.runtime.sendMessage(message).catch(() => {
    });
  };
  var emitPageEvent = (eventType, explanation, metadata) => {
    if (!state || !isSessionRunning(state.status)) return;
    send({
      type: "page-security-event",
      eventType,
      confidence: 1,
      duration: 0,
      explanation,
      metadata
    });
  };
  var scoreColor = (score) => {
    if (score <= 40) return "#34d399";
    if (score <= 90) return "#fbbf24";
    return "#fb7185";
  };
  var renderOverlay = () => {
    const existing = document.getElementById(OVERLAY_HOST_ID);
    if (!state || !isSessionRunning(state.status)) {
      existing?.remove();
      return;
    }
    const host = existing ?? document.createElement("div");
    host.id = OVERLAY_HOST_ID;
    if (!existing) {
      host.style.cssText = "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:none;";
      document.documentElement.append(host);
    }
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const active = state.status === "PROCTORING_ACTIVE";
    root.innerHTML = `
    <style>
      :host { all: initial; }
      .card { width: 252px; box-sizing: border-box; border: 1px solid rgba(148,163,184,.24); border-radius: 16px;
        color: #e5edf8; background: rgba(8,15,30,.94); box-shadow: 0 16px 42px rgba(0,0,0,.32);
        padding: 14px; font: 600 12px/1.35 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        backdrop-filter: blur(12px); }
      .top { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
      .status { display:flex; align-items:center; gap:7px; font-size:11px; letter-spacing:.08em; color:${active ? "#6ee7b7" : "#fcd34d"}; }
      .dot { width:8px; height:8px; border-radius:50%; background:currentColor; box-shadow:0 0 0 4px color-mix(in srgb,currentColor 15%,transparent); }
      .brand { color:#94a3b8; font-size:10px; letter-spacing:.08em; }
      .score { display:flex; align-items:end; justify-content:space-between; padding:10px 0; border-top:1px solid rgba(148,163,184,.15); border-bottom:1px solid rgba(148,163,184,.15); }
      .score strong { font-size:27px; line-height:1; color:${scoreColor(state.activityScore)}; }
      .score span { color:#94a3b8; font-weight:500; }
      .grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:11px; }
      .metric { border-radius:10px; background:rgba(30,41,59,.66); padding:8px; }
      .metric label { display:block; color:#94a3b8; font-size:9px; letter-spacing:.08em; margin-bottom:3px; }
      .metric b { font-size:11px; color:#f8fafc; }
      .alert { margin-top:10px; border-radius:10px; padding:8px 9px; color:#fecdd3; background:rgba(190,24,93,.18); border:1px solid rgba(251,113,133,.24); }
      .note { margin-top:9px; color:#94a3b8; font-weight:500; font-size:10px; }
      .finish { width:100%; height:34px; margin-top:10px; border:1px solid rgba(251,113,133,.4); border-radius:10px;
        color:#fff1f2; background:rgba(190,24,93,.28); font:800 11px/1 system-ui,sans-serif; cursor:pointer; pointer-events:auto; }
      .finish:hover { background:rgba(225,29,72,.42); }.finish:disabled { opacity:.6; cursor:wait; }
    </style>
    <section class="card" aria-label="Look At Me proctoring status">
      <div class="top"><div class="status"><i class="dot"></i>${active ? "PROCTORING ACTIVE" : state.status.replace("PROCTORING_", "")}</div><div class="brand">LOOK AT ME!</div></div>
      <div class="score"><span>Activity Score</span><strong>${state.activityScore}<small style="font-size:11px;color:#64748b"> / 200</small></strong></div>
      <div class="grid">
        <div class="metric"><label>EVENTS</label><b>${state.eventCount}</b></div>
        <div class="metric"><label>CAMERA</label><b>${state.cameraStatus}</b></div>
        <div class="metric"><label>FACE</label><b>${state.faceStatus.replace("_", " ")}</b></div>
        <div class="metric"><label>AI</label><b>${state.aiStatus}</b></div>
        <div class="metric"><label>SCREENSHOTS</label><b>${state.evidenceCount}</b></div>
      </div>
      ${state.lastAlert ? `<div class="alert">\u26A0 ${state.lastAlert}</div>` : ""}
      <button class="finish" type="button">\u0417\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C \u0442\u0435\u0441\u0442</button>
      <div class="note">Local analysis \xB7 human review required</div>
    </section>`;
    const finishButton = root.querySelector("button.finish");
    finishButton?.addEventListener("click", () => {
      if (!state || !isSessionRunning(state.status)) return;
      if (!window.confirm("\u0412\u044B \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043B\u044C\u043D\u043E \u0445\u043E\u0442\u0438\u0442\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C \u0442\u0435\u0441\u0442?")) return;
      finishButton.disabled = true;
      finishButton.textContent = "\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u0435\u2026";
      void chrome.runtime.sendMessage({ type: "content-finish-session", confirmed: true }).then((response) => {
        if (response?.state) {
          state = response.state;
          renderOverlay();
        } else if (!response?.accepted) {
          finishButton.disabled = false;
          finishButton.textContent = "\u0417\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C \u0442\u0435\u0441\u0442";
        }
      }).catch(() => {
        finishButton.disabled = false;
        finishButton.textContent = "\u0417\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C \u0442\u0435\u0441\u0442";
      });
    });
  };
  var readIntent = () => {
    try {
      const raw = sessionStorage.getItem(FORM_INTENT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return typeof parsed.sessionId === "string" && typeof parsed.timestamp === "number" ? { sessionId: parsed.sessionId, timestamp: parsed.timestamp } : null;
    } catch {
      return null;
    }
  };
  var rememberSubmitIntent = () => {
    if (!state?.sessionId || !isSessionRunning(state.status) || !isGoogleFormsUrl(location.href)) return;
    sessionStorage.setItem(FORM_INTENT_KEY, JSON.stringify({ sessionId: state.sessionId, timestamp: Date.now() }));
    sessionStorage.removeItem(FORM_REPORTED_KEY);
  };
  var checkGoogleFormsConfirmation = () => {
    if (!state?.sessionId || !isSessionRunning(state.status) || !isGoogleFormsUrl(location.href)) return;
    if (!isFreshIntent(readIntent(), state.sessionId) || sessionStorage.getItem(FORM_REPORTED_KEY) === state.sessionId) return;
    const bodyText = document.body?.innerText ?? "";
    const hasQuestions = Boolean(document.querySelector('[role="listitem"], .Qr7Oae, [data-params]'));
    const hasConfirmation = Boolean(document.querySelector('.vHW8K, .freebirdFormviewerViewResponseConfirmContentContainer, [role="heading"]'));
    if (!isConfirmedGoogleFormsSubmission(location.href, bodyText, hasQuestions, hasConfirmation)) return;
    sessionStorage.setItem(FORM_REPORTED_KEY, state.sessionId);
    send({ type: "google-forms-submitted", confirmed: true, sessionId: state.sessionId });
  };
  var scheduleConfirmationCheck = () => {
    if (confirmationTimer !== null) window.clearTimeout(confirmationTimer);
    confirmationTimer = window.setTimeout(() => {
      confirmationTimer = null;
      checkGoogleFormsConfirmation();
    }, 1200);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      emitPageEvent("TAB_SWITCH", "The monitored test page became hidden.");
    }
  });
  window.addEventListener("blur", () => {
    window.setTimeout(() => emitPageEvent("WINDOW_BLUR", "The monitored test page lost focus."), 300);
  });
  document.addEventListener("copy", () => emitPageEvent("COPY_ATTEMPT", "A copy action occurred in the monitored page."));
  document.addEventListener("paste", () => emitPageEvent("PASTE_ATTEMPT", "A paste action occurred in the monitored page."));
  document.addEventListener("contextmenu", () => emitPageEvent("CONTEXT_MENU", "The context menu was opened in the monitored page."));
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (key === "f12" || event.ctrlKey && event.shiftKey && ["i", "j", "c"].includes(key)) {
      emitPageEvent("DEVTOOLS_ATTEMPT", `A DevTools keyboard shortcut was pressed (${event.key}).`, { key: event.key });
    }
  }, true);
  document.addEventListener("fullscreenchange", () => {
    if (expectedFullscreen && !document.fullscreenElement) {
      expectedFullscreen = false;
      emitPageEvent("FULLSCREEN_EXIT", "The monitored page exited a fullscreen state that was active when proctoring started.");
    }
  });
  document.addEventListener("submit", () => rememberSubmitIntent(), true);
  document.addEventListener("click", (event) => {
    if (isLikelySubmitControl(event.target instanceof Element ? event.target : null)) rememberSubmitIntent();
  }, true);
  new MutationObserver(() => scheduleConfirmationCheck()).observe(document.documentElement, { subtree: true, childList: true });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "content-probe") {
      sendResponse({ ready: true });
      return false;
    }
    if (message?.type !== "session-state") return false;
    state = message.state;
    if (state && isSessionRunning(state.status)) expectedFullscreen ||= Boolean(document.fullscreenElement);
    renderOverlay();
    scheduleConfirmationCheck();
    return false;
  });
  void chrome.runtime.sendMessage({ type: "content-ready", url: location.href }).then((response) => {
    state = response?.state ?? null;
    expectedFullscreen = Boolean(state && isSessionRunning(state.status) && document.fullscreenElement);
    renderOverlay();
    scheduleConfirmationCheck();
  }).catch(() => {
    state = null;
    renderOverlay();
  });
})();
