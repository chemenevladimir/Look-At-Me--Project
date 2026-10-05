import { useEffect, useMemo, useState } from 'react';
import { Camera, CircleAlert, Eye, ShieldCheck, Square, Play, Activity } from 'lucide-react';
import { createIdleSessionState, isSessionRunning, type ExtensionSessionState } from '../extension/sessionState';
import './popup.css';

type CommandResponse = { state?: ExtensionSessionState; error?: string };

const sendCommand = async (
  type: string,
  payload: Record<string, unknown> = {},
): Promise<CommandResponse> =>
  chrome.runtime.sendMessage({ type, ...payload }) as Promise<CommandResponse>;

const statusLabel = (state: ExtensionSessionState): string => {
  switch (state.status) {
    case 'PROCTORING_STARTING': return 'STARTING';
    case 'PROCTORING_ACTIVE': return 'ACTIVE';
    case 'PROCTORING_PAUSED': return 'PAUSED';
    case 'PROCTORING_FINALIZING': return 'FINALIZING';
    case 'PROCTORING_COMPLETED': return 'COMPLETED';
    case 'PROCTORING_ERROR': return 'ERROR';
    default: return 'READY';
  }
};

const siteLabel = (urlValue: string | null): string => {
  if (!urlValue) return 'Current web page';
  try {
    return new URL(urlValue).hostname;
  } catch {
    return 'Current web page';
  }
};

export default function PopupApp() {
  const [state, setState] = useState<ExtensionSessionState>(createIdleSessionState());
  const [busy, setBusy] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [localError, setLocalError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const running = isSessionRunning(state.status);

  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'look-at-me-popup' });
    const onPortMessage = (message: unknown) => {
      if (message && typeof message === 'object' && (message as { type?: string }).type === 'session-state') {
        setState((message as { state: ExtensionSessionState }).state);
      }
    };
    const onRuntimeMessage = (message: unknown) => {
      if (message && typeof message === 'object' && (message as { type?: string }).type === 'session-state') {
        setState((message as { state: ExtensionSessionState }).state);
      }
    };
    port.onMessage.addListener(onPortMessage);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    void sendCommand('popup-get-state').then((response) => {
      if (response.state) setState(response.state);
      if (response.error) setLocalError(response.error);
    });
    return () => {
      port.onMessage.removeListener(onPortMessage);
      port.disconnect();
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    };
  }, []);

  useEffect(() => {
    const update = () => setElapsed(state.startTime ? Math.max(0, Math.floor(((state.endTime ?? Date.now()) - state.startTime) / 1_000)) : 0);
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [state.endTime, state.startTime]);

  const duration = useMemo(() => {
    const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const seconds = (elapsed % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }, [elapsed]);

  const start = async () => {
    if (busy || running) return;
    setBusy(true);
    setLocalError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API is unavailable in this Chrome popup.');
      const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      permissionStream.getTracks().forEach((track) => track.stop());
      const response = await sendCommand('popup-start');
      if (response.error) throw new Error(response.error);
      if (response.state) setState(response.state);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (busy || !running) return;
    setBusy(true);
    setLocalError('');
    try {
      const response = await sendCommand('popup-stop', { confirmed: true });
      if (response.error) throw new Error(response.error);
      if (response.state) setState(response.state);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!confirmingStop) return;
    const timer = window.setTimeout(() => setConfirmingStop(false), 5_000);
    return () => window.clearTimeout(timer);
  }, [confirmingStop]);

  const handlePrimaryAction = () => {
    if (!running) {
      void start();
      return;
    }
    if (!confirmingStop) {
      setConfirmingStop(true);
      return;
    }
    setConfirmingStop(false);
    void stop();
  };

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <div className="logo"><Eye size={20} /></div>
        <div><span>LOOK AT ME!</span><h1>Local AI Proctoring</h1></div>
        <div className={`session-badge ${running ? 'active' : ''}`}><i />{statusLabel(state)}</div>
      </header>

      <section className="score-card">
        <div><span>Activity Score</span><strong>{state.activityScore}<small>/200</small></strong></div>
        <div className="score-meta"><Activity size={15} /> {state.eventCount} events · {duration}</div>
      </section>

      <section className="runtime-grid">
        <div><Camera size={15} /><span>Camera</span><b>{state.cameraStatus}</b></div>
        <div><Eye size={15} /><span>Face</span><b>{state.faceStatus.replace('_', ' ')}</b></div>
        <div><ShieldCheck size={15} /><span>AI</span><b>{state.aiStatus}</b></div>
        <div><ShieldCheck size={15} /><span>OS Agent</span><b>{state.localAgentState.toUpperCase()}</b></div>
      </section>

      <section className="target-card">
        <span>MONITORED TAB</span>
        <strong>{siteLabel(state.currentTabUrl)}</strong>
        <p>{state.proctoringStatus}</p>
      </section>

      {(localError || state.error) && (
        <div className="popup-error"><CircleAlert size={16} /><span>{localError || state.error}</span></div>
      )}
      {state.lastAlert && <div className="popup-alert">⚠ {state.lastAlert}</div>}

      <button className={`primary-action ${running ? 'stop' : ''}`} disabled={busy || state.status === 'PROCTORING_FINALIZING'} onClick={handlePrimaryAction}>
        {running ? <Square size={16} /> : <Play size={16} />}
        {busy ? 'Please wait…' : running ? confirmingStop ? 'Confirm Stop' : 'Stop Proctoring' : 'Start Proctoring'}
      </button>

      <footer>Popup may be closed after start. Camera, CV, and events continue in the current tab.</footer>
    </main>
  );
}
