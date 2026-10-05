import type { SecurityAgentStatus } from '../types';

const DASHBOARD_PORT = 'look-at-me-dashboard';

interface BridgeCallbacks {
  onSecurityEvent: (payload: unknown) => void;
  onServiceWorkerStatus: (message: string) => void;
  onAgentStatus: (status: SecurityAgentStatus) => void;
  onFullscreenState: (active: boolean) => void;
}

interface BridgeMessage {
  type?: string;
  event?: unknown;
  message?: unknown;
  active?: unknown;
  state?: unknown;
  capabilities?: unknown;
  limitations?: unknown;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20) : [];

export class ExtensionSecurityBridge {
  private port: chrome.runtime.Port | null = null;
  private disposed = false;
  private reconnectTimer: number | null = null;
  private desiredSessionId: string | null = null;
  private readonly callbacks: BridgeCallbacks;

  constructor(callbacks: BridgeCallbacks) {
    this.callbacks = callbacks;
  }

  public static isAvailable(): boolean {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id && chrome.runtime?.connect);
  }

  public connect(): void {
    if (this.disposed || this.port) return;
    try {
      const port = chrome.runtime.connect({ name: DASHBOARD_PORT });
      this.port = port;
      port.onMessage.addListener(this.handleMessage);
      port.onDisconnect.addListener(this.handleDisconnect);
      port.postMessage({ type: 'dashboard-hello' });
      this.callbacks.onServiceWorkerStatus('Extension worker connected');
      if (this.desiredSessionId) {
        port.postMessage({ type: 'monitoring-control', action: 'start', sessionId: this.desiredSessionId });
      }
    } catch (error) {
      this.callbacks.onServiceWorkerStatus(`Extension worker unavailable: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleReconnect();
    }
  }

  public startMonitoring(sessionId: string): void {
    this.desiredSessionId = sessionId;
    this.post({ type: 'monitoring-control', action: 'start', sessionId });
  }

  public stopMonitoring(): void {
    this.desiredSessionId = null;
    this.post({ type: 'monitoring-control', action: 'stop' });
  }

  public heartbeat(): void {
    this.post({ type: 'dashboard-heartbeat', sessionId: this.desiredSessionId });
  }

  public retryAgent(): void {
    this.post({ type: 'native-agent-control', action: 'restart' });
  }

  public dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.port) {
      this.port.onMessage.removeListener(this.handleMessage);
      this.port.onDisconnect.removeListener(this.handleDisconnect);
      this.port.disconnect();
    }
    this.port = null;
  }

  private post(message: unknown): void {
    if (!this.port) {
      this.connect();
      return;
    }
    try {
      this.port.postMessage(message);
    } catch (error) {
      this.callbacks.onServiceWorkerStatus(`Extension message failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private readonly handleMessage = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as BridgeMessage;
    if (message.type === 'security-event') {
      this.callbacks.onSecurityEvent(message.event);
    } else if (message.type === 'service-worker-status') {
      this.callbacks.onServiceWorkerStatus(typeof message.message === 'string' ? message.message : 'Extension worker connected');
    } else if (message.type === 'fullscreen-state') {
      this.callbacks.onFullscreenState(message.active === true);
    } else if (message.type === 'agent-status') {
      const state = typeof message.state === 'string' ? message.state : 'error';
      const allowedStates: SecurityAgentStatus['state'][] = ['unavailable', 'connecting', 'ready', 'active', 'stopped', 'error'];
      this.callbacks.onAgentStatus({
        state: allowedStates.includes(state as SecurityAgentStatus['state'])
          ? state as SecurityAgentStatus['state']
          : 'error',
        message: typeof message.message === 'string' ? message.message : 'Unknown local-agent status.',
        capabilities: strings(message.capabilities),
        limitations: strings(message.limitations),
      });
    }
  };

  private readonly handleDisconnect = (): void => {
    const message = chrome.runtime.lastError?.message;
    this.port = null;
    this.callbacks.onServiceWorkerStatus(message ? `Extension worker disconnected: ${message}` : 'Extension worker disconnected');
    this.callbacks.onAgentStatus({
      state: 'unavailable',
      message: 'Local-agent connection is unavailable while the extension worker is disconnected.',
      capabilities: [],
      limitations: [],
    });
    this.scheduleReconnect();
  };

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1_500);
  }
}
