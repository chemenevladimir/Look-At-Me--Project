export type EventSource = 'cv' | 'browser' | 'system';

export type ProctorEventType =
  | 'FACE_DETECTED'
  | 'FACE_NOT_DETECTED'
  | 'MULTIPLE_FACES'
  | 'HEAD_TURN'
  | 'LOOKING_AWAY'
  | 'PHONE_DETECTED'
  | 'TAB_SWITCH'
  | 'WINDOW_BLUR'
  | 'FULLSCREEN_EXIT'
  | 'COPY_ATTEMPT'
  | 'PASTE_ATTEMPT'
  | 'CONTEXT_MENU'
  | 'DEVTOOLS_ATTEMPT'
  | 'ALT_TAB_ATTEMPT'
  | 'SYSTEM_KEY_ATTEMPT'
  | 'PRINT_SCREEN_ATTEMPT'
  | 'APP_SWITCH'
  | 'CAMERA_BLOCKED'
  | 'MODEL_FAILURE'
  | 'INFERENCE_FAILURE'
  | 'SESSION_STARTED'
  | 'SESSION_FINISHED'
  | 'FORM_SUBMITTED';

export interface ProctorEvent {
  id: string;
  type: ProctorEventType;
  timestamp: number;
  duration: number;
  confidence: number;
  severity: number;
  scoreImpact: number;
  explanation: string;
  source: EventSource;
  metadata?: Record<string, string | number | boolean>;
}

export interface ModelStatus {
  name: string;
  runtime: string;
  input: string;
  output: string;
  confidence: string;
  limitations: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
}

export interface ActivityBreakdown {
  severity: number;
  confidence: number;
  duration: number;
  repeatedEvents: number;
  byType: Partial<Record<ProctorEventType, number>>;
}

export interface SessionSummary {
  score: number;
  eventCount: number;
  severeEvents: number;
  confidence: number;
  breakdown: ActivityBreakdown;
}

export interface ProctoringSessionState {
  id: string;
  status: 'idle' | 'active' | 'completed';
  startedAt: number | null;
  endedAt: number | null;
  elapsedSeconds: number;
}

export type SecurityAgentState = 'unavailable' | 'connecting' | 'ready' | 'active' | 'stopped' | 'error';

export interface SecurityAgentStatus {
  state: SecurityAgentState;
  message: string;
  capabilities: string[];
  limitations: string[];
}
