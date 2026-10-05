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
  if (!state || !isSessionRunning(state.status)) return;
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
    host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:none;';
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
    </style>
    <section class="card" aria-label="Look At Me proctoring status">
      <div class="top"><div class="status"><i class="dot"></i>${active ? 'PROCTORING ACTIVE' : state.status.replace('PROCTORING_', '')}</div><div class="brand">LOOK AT ME!</div></div>
      <div class="score"><span>Activity Score</span><strong>${state.activityScore}<small style="font-size:11px;color:#64748b"> / 200</small></strong></div>
      <div class="grid">
        <div class="metric"><label>EVENTS</label><b>${state.eventCount}</b></div>
        <div class="metric"><label>CAMERA</label><b>${state.cameraStatus}</b></div>
        <div class="metric"><label>FACE</label><b>${state.faceStatus.replace('_', ' ')}</b></div>
        <div class="metric"><label>AI</label><b>${state.aiStatus}</b></div>
      </div>
      ${state.lastAlert ? `<div class="alert">⚠ ${state.lastAlert}</div>` : ''}
      <div class="note">Local analysis · human review required</div>
    </section>`;
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
  scheduleConfirmationCheck();
  return false;
});

void chrome.runtime.sendMessage({ type: 'content-ready', url: location.href }).then((response) => {
  state = response?.state ?? null;
  expectedFullscreen = Boolean(state && isSessionRunning(state.status) && document.fullscreenElement);
  renderOverlay();
  scheduleConfirmationCheck();
}).catch(() => {
  state = null;
  renderOverlay();
});
