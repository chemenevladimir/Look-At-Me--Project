import type { ProctorEvent, SessionSummary } from '../types';

export type ProctoringStatus =
  | 'PROCTORING_IDLE'
  | 'PROCTORING_STARTING'
  | 'PROCTORING_ACTIVE'
  | 'PROCTORING_PAUSED'
  | 'PROCTORING_FINALIZING'
  | 'PROCTORING_COMPLETED'
  | 'PROCTORING_ERROR';

export type CameraRuntimeStatus = 'OFF' | 'REQUESTING' | 'ON' | 'ERROR';
export type FaceRuntimeStatus = 'UNKNOWN' | 'CALIBRATING' | 'DETECTED' | 'NOT_DETECTED' | 'MULTIPLE';
export type AiRuntimeStatus = 'IDLE' | 'LOADING' | 'ACTIVE' | 'DEGRADED' | 'ERROR';
export type CloudSyncStatus = 'NOT_CONFIGURED' | 'PENDING' | 'SYNCED' | 'ERROR';
export type LocalStorageRuntimeStatus = 'IDLE' | 'CONNECTING' | 'READY' | 'SAVING' | 'SAVED' | 'ERROR';
export type FullscreenRuntimeStatus = 'IDLE' | 'ENTERING' | 'ACTIVE' | 'EXITED' | 'ERROR';
export type BrowserWindowState = 'normal' | 'fullscreen' | 'minimized' | 'maximized' | 'locked-fullscreen';

export interface ExtensionSessionState {
  sessionId: string | null;
  studentName: string;
  testName: string;
  status: ProctoringStatus;
  activityScore: number;
  eventCount: number;
  severeEventCount: number;
  cameraStatus: CameraRuntimeStatus;
  faceStatus: FaceRuntimeStatus;
  aiStatus: AiRuntimeStatus;
  proctoringStatus: string;
  currentTabId: number | null;
  currentWindowId: number | null;
  currentTabUrl: string | null;
  startTime: number | null;
  endTime: number | null;
  lastEvent: ProctorEvent | null;
  lastAlert: string | null;
  localAgentState: 'unavailable' | 'connecting' | 'ready' | 'active' | 'stopped' | 'error';
  localAgentMessage: string;
  storageStatus: LocalStorageRuntimeStatus;
  dataRoot: string | null;
  evidenceCount: number;
  fullscreenStatus: FullscreenRuntimeStatus;
  previousWindowState: BrowserWindowState | null;
  cloudSyncStatus: CloudSyncStatus;
  error: string | null;
}

export const SESSION_STORAGE_KEY = 'look-at-me.session';
export const EVENTS_STORAGE_KEY = 'look-at-me.events';

export const createIdleSessionState = (): ExtensionSessionState => ({
  sessionId: null,
  studentName: '',
  testName: '',
  status: 'PROCTORING_IDLE',
  activityScore: 0,
  eventCount: 0,
  severeEventCount: 0,
  cameraStatus: 'OFF',
  faceStatus: 'UNKNOWN',
  aiStatus: 'IDLE',
  proctoringStatus: 'Ready to start in the current tab.',
  currentTabId: null,
  currentWindowId: null,
  currentTabUrl: null,
  startTime: null,
  endTime: null,
  lastEvent: null,
  lastAlert: null,
  localAgentState: 'unavailable',
  localAgentMessage: 'Local Windows agent has not connected yet.',
  storageStatus: 'IDLE',
  dataRoot: null,
  evidenceCount: 0,
  fullscreenStatus: 'IDLE',
  previousWindowState: null,
  cloudSyncStatus: 'NOT_CONFIGURED',
  error: null,
});

export const isSessionRunning = (status: ProctoringStatus): boolean =>
  status === 'PROCTORING_STARTING'
  || status === 'PROCTORING_ACTIVE'
  || status === 'PROCTORING_PAUSED'
  || status === 'PROCTORING_FINALIZING';

export const applySummary = (
  state: ExtensionSessionState,
  summary: SessionSummary,
  lastEvent: ProctorEvent | null,
): ExtensionSessionState => ({
  ...state,
  activityScore: summary.score,
  eventCount: summary.eventCount,
  severeEventCount: summary.severeEvents,
  lastEvent,
  lastAlert: lastEvent && lastEvent.severity >= 4
    ? lastEvent.type.replace(/_/g, ' ')
    : state.lastAlert,
});

export const isMonitorableUrl = (value: string | undefined | null): value is string => {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export const sanitizeStoredState = (value: unknown): ExtensionSessionState => {
  const fallback = createIdleSessionState();
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as Partial<ExtensionSessionState>;
  const allowedStatuses: ProctoringStatus[] = [
    'PROCTORING_IDLE',
    'PROCTORING_STARTING',
    'PROCTORING_ACTIVE',
    'PROCTORING_PAUSED',
    'PROCTORING_FINALIZING',
    'PROCTORING_COMPLETED',
    'PROCTORING_ERROR',
  ];
  return {
    ...fallback,
    ...candidate,
    status: allowedStatuses.includes(candidate.status as ProctoringStatus)
      ? candidate.status as ProctoringStatus
      : fallback.status,
    activityScore: Math.min(200, Math.max(0, Number(candidate.activityScore) || 0)),
    eventCount: Math.max(0, Number(candidate.eventCount) || 0),
    severeEventCount: Math.max(0, Number(candidate.severeEventCount) || 0),
    currentTabId: typeof candidate.currentTabId === 'number' ? candidate.currentTabId : null,
    currentWindowId: typeof candidate.currentWindowId === 'number' ? candidate.currentWindowId : null,
    sessionId: typeof candidate.sessionId === 'string' ? candidate.sessionId.slice(0, 120) : null,
    studentName: typeof candidate.studentName === 'string' ? candidate.studentName.slice(0, 200) : '',
    testName: typeof candidate.testName === 'string' ? candidate.testName.slice(0, 240) : '',
    currentTabUrl: typeof candidate.currentTabUrl === 'string' ? candidate.currentTabUrl.slice(0, 2_000) : null,
    evidenceCount: Math.max(0, Number(candidate.evidenceCount) || 0),
    dataRoot: typeof candidate.dataRoot === 'string' ? candidate.dataRoot.slice(0, 2_000) : null,
    error: typeof candidate.error === 'string' ? candidate.error.slice(0, 500) : null,
  };
};
