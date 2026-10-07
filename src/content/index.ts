import type { ExtensionSessionState } from '../extension/sessionState';
import { isSessionRunning } from '../extension/sessionState';
import {
  isConfirmedGoogleFormsSubmission,
  isFreshIntent,
  isGoogleFormsUrl,
  isLikelySubmitControl,
  type GoogleFormsIntent,
} from './googleForms';

const OVERLAY_HOST_ID = 'look-at-me-proctoring-overlay';
const FORM_INTENT_KEY = 'look-at-me.google-form-submit-intent';
const FORM_REPORTED_KEY = 'look-at-me.google-form-submission-reported';

let state: ExtensionSessionState | null = null;
let expectedFullscreen = false;
let confirmationTimer: number | null = null;
let previewTimer: number | null = null;
let previewDataUrl = '';

const isCollecting = (): boolean => state?.status === 'PROCTORING_STARTING'
  || state?.status === 'PROCTORING_ACTIVE'
  || state?.status === 'PROCTORING_PAUSED';

const send = (message: unknown): void => {
  void chrome.runtime.sendMessage(message).catch(() => {
    // The service worker may be restarting; the next page event/content-ready reconnects it.
  });
};

const emitPageEvent = (
  eventType: string,
  explanation: string,
  metadata?: Record<string, string | number | boolean>,
): void => {
  if (!state || !isCollecting()) return;
  send({
    type: 'page-security-event',
    eventType,
    confidence: 1,
    duration: 0,
    explanation,
    metadata,
  });
};

const scoreColor = (score: number): string => {
  if (score <= 40) return '#34d399';
  if (score <= 90) return '#fbbf24';
  return '#fb7185';
};

const renderOverlay = (): void => {
  const existing = document.getElementById(OVERLAY_HOST_ID);
  if (!state || !isSessionRunning(state.status)) {
    existing?.remove();
    return;
  }

  const host = existing ?? document.createElement('div');
  host.id = OVERLAY_HOST_ID;
  if (!existing) {
    host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:auto;';
    document.documentElement.append(host);
  }
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  const active = state.status === 'PROCTORING_ACTIVE';
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .card { width: 252px; box-sizing: border-box; border: 1px solid rgba(148,163,184,.24); border-radius: 16px;
        color: #e5edf8; background: rgba(8,15,30,.94); box-shadow: 0 16px 42px rgba(0,0,0,.32);
        padding: 14px; font: 600 12px/1.35 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        backdrop-filter: blur(12px); }
      .top { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
      .preview { position:relative; overflow:hidden; height:104px; margin-bottom:11px; border-radius:11px; background:#020617; }
      .preview img { width:100%; height:100%; object-fit:cover; transform:scaleX(-1); display:${previewDataUrl ? 'block' : 'none'}; }
      .preview span { position:absolute; left:8px; bottom:7px; padding:4px 6px; border-radius:999px; color:#d1fae5; background:rgba(2,6,23,.75); font-size:9px; }
      .status { display:flex; align-items:center; gap:7px; font-size:11px; letter-spacing:.08em; color:${active ? '#6ee7b7' : '#fcd34d'}; }
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
      <div class="top"><div class="status"><i class="dot"></i>${active ? 'PROCTORING ACTIVE' : state.status.replace('PROCTORING_', '')}</div><div class="brand">LOOK AT ME!</div></div>
      <div class="preview"><img alt="Live camera preview" src="${previewDataUrl}"><span>● LIVE CAMERA</span></div>
      <div class="score"><span>Activity Score</span><strong>${state.activityScore}<small style="font-size:11px;color:#64748b"> / 200</small></strong></div>
      <div class="grid">
        <div class="metric"><label>EVENTS</label><b>${state.eventCount}</b></div>
        <div class="metric"><label>CAMERA</label><b>${state.cameraStatus}</b></div>
        <div class="metric"><label>FACE</label><b>${state.faceStatus.replace('_', ' ')}</b></div>
        <div class="metric"><label>AI</label><b>${state.aiStatus}</b></div>
        <div class="metric"><label>SCREENSHOTS</label><b>${state.evidenceCount}</b></div>
      </div>
      ${state.lastAlert ? `<div class="alert">⚠ ${state.lastAlert}</div>` : ''}
      <button class="finish" type="button">Завершить тест</button>
      <div class="note">Local analysis · human review required</div>
    </section>`;
  const finishButton = root.querySelector<HTMLButtonElement>('button.finish');
  finishButton?.addEventListener('click', () => {
    if (!state || !isSessionRunning(state.status)) return;
    if (!window.confirm('Вы действительно хотите завершить тест?')) return;
    finishButton.disabled = true;
    finishButton.textContent = 'Завершение…';
    void chrome.runtime.sendMessage({ type: 'content-finish-session', confirmed: true }).then((response) => {
      if (response?.state) {
        state = response.state as ExtensionSessionState;
        renderOverlay();
      } else if (!response?.accepted) {
        finishButton.disabled = false;
        finishButton.textContent = 'Завершить тест';
      }
    }).catch(() => {
      finishButton.disabled = false;
      finishButton.textContent = 'Завершить тест';
    });
  });
};

const updateCameraPreview = async (): Promise<void> => {
  if (!state || !isSessionRunning(state.status)) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'overlay-camera-preview' }) as {
      available?: boolean; frame?: { data?: string; mimeType?: string };
    };
    if (response.available && response.frame?.data && response.frame.mimeType === 'image/png') {
      previewDataUrl = `data:image/png;base64,${response.frame.data}`;
      const image = document.getElementById(OVERLAY_HOST_ID)?.shadowRoot?.querySelector<HTMLImageElement>('.preview img');
      if (image) { image.src = previewDataUrl; image.style.display = 'block'; }
    }
  } catch { /* State updates retry the existing offscreen camera pipeline. */ }
};

const syncPreviewTimer = (): void => {
  if (state && isSessionRunning(state.status)) {
    if (previewTimer === null) {
      void updateCameraPreview();
      previewTimer = window.setInterval(() => { void updateCameraPreview(); }, 650);
    }
  } else if (previewTimer !== null) {
    window.clearInterval(previewTimer);
    previewTimer = null;
    previewDataUrl = '';
  }
};

const readIntent = (): GoogleFormsIntent | null => {
  try {
    const raw = sessionStorage.getItem(FORM_INTENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GoogleFormsIntent>;
    return typeof parsed.sessionId === 'string' && typeof parsed.timestamp === 'number'
      ? { sessionId: parsed.sessionId, timestamp: parsed.timestamp }
      : null;
  } catch {
    return null;
  }
};

const rememberSubmitIntent = (): void => {
  if (!state?.sessionId || !isSessionRunning(state.status) || !isGoogleFormsUrl(location.href)) return;
  sessionStorage.setItem(FORM_INTENT_KEY, JSON.stringify({ sessionId: state.sessionId, timestamp: Date.now() }));
  sessionStorage.removeItem(FORM_REPORTED_KEY);
};

const checkGoogleFormsConfirmation = (): void => {
  if (!state?.sessionId || !isSessionRunning(state.status) || !isGoogleFormsUrl(location.href)) return;
  if (!isFreshIntent(readIntent(), state.sessionId) || sessionStorage.getItem(FORM_REPORTED_KEY) === state.sessionId) return;
  const bodyText = document.body?.innerText ?? '';
  const hasQuestions = Boolean(document.querySelector('[role="listitem"], .Qr7Oae, [data-params]'));
  const hasConfirmation = Boolean(document.querySelector('.vHW8K, .freebirdFormviewerViewResponseConfirmContentContainer, [role="heading"]'));
  if (!isConfirmedGoogleFormsSubmission(location.href, bodyText, hasQuestions, hasConfirmation)) return;
  sessionStorage.setItem(FORM_REPORTED_KEY, state.sessionId);
  send({ type: 'google-forms-submitted', confirmed: true, sessionId: state.sessionId });
};

const scheduleConfirmationCheck = (): void => {
  if (confirmationTimer !== null) window.clearTimeout(confirmationTimer);
  confirmationTimer = window.setTimeout(() => {
    confirmationTimer = null;
    checkGoogleFormsConfirmation();
  }, 1_200);
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    emitPageEvent('TAB_SWITCH', 'The monitored test page became hidden.');
  }
});
window.addEventListener('blur', () => {
  window.setTimeout(() => emitPageEvent('WINDOW_BLUR', 'The monitored test page lost focus.'), 300);
});
document.addEventListener('copy', () => emitPageEvent('COPY_ATTEMPT', 'A copy action occurred in the monitored page.'));
document.addEventListener('paste', () => emitPageEvent('PASTE_ATTEMPT', 'A paste action occurred in the monitored page.'));
document.addEventListener('contextmenu', () => emitPageEvent('CONTEXT_MENU', 'The context menu was opened in the monitored page.'));
document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'f12' || (event.ctrlKey && event.shiftKey && ['i', 'j', 'c'].includes(key))) {
    emitPageEvent('DEVTOOLS_ATTEMPT', `A DevTools keyboard shortcut was pressed (${event.key}).`, { key: event.key });
  }
}, true);
document.addEventListener('fullscreenchange', () => {
  if (expectedFullscreen && !document.fullscreenElement) {
    expectedFullscreen = false;
    emitPageEvent('FULLSCREEN_EXIT', 'The monitored page exited a fullscreen state that was active when proctoring started.');
  }
});

document.addEventListener('submit', () => rememberSubmitIntent(), true);
document.addEventListener('click', (event) => {
  if (isLikelySubmitControl(event.target instanceof Element ? event.target : null)) rememberSubmitIntent();
}, true);

new MutationObserver(() => scheduleConfirmationCheck()).observe(document.documentElement, { subtree: true, childList: true });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'content-probe') {
    sendResponse({ ready: true });
    return false;
  }
  if (message?.type !== 'session-state') return false;
  state = message.state as ExtensionSessionState;
  if (state && isSessionRunning(state.status)) expectedFullscreen ||= Boolean(document.fullscreenElement);
  renderOverlay();
  syncPreviewTimer();
  scheduleConfirmationCheck();
  return false;
});

void chrome.runtime.sendMessage({ type: 'content-ready', url: location.href }).then((response) => {
  state = response?.state ?? null;
  expectedFullscreen = Boolean(state && isSessionRunning(state.status) && document.fullscreenElement);
  renderOverlay();
  syncPreviewTimer();
  scheduleConfirmationCheck();
}).catch(() => {
  state = null;
  renderOverlay();
  syncPreviewTimer();
});
