import type { EventSource, ProctorEventType } from '../types';

export interface NormalizedSecurityEvent {
  type: ProctorEventType;
  duration: number;
  confidence: number;
  severity?: number;
  explanation: string;
  source: EventSource;
  metadata?: Record<string, string | number | boolean>;
}

const eventDefaults: Partial<Record<ProctorEventType, { sources: EventSource[]; explanation: string }>> = {
  TAB_SWITCH: { sources: ['browser'], explanation: 'The active browser tab changed during monitoring.' },
  WINDOW_BLUR: { sources: ['browser'], explanation: 'The monitored browser window lost focus.' },
  FULLSCREEN_EXIT: { sources: ['browser'], explanation: 'Full-screen mode was exited during monitoring.' },
  COPY_ATTEMPT: { sources: ['browser', 'system'], explanation: 'A copy shortcut or action was observed.' },
  PASTE_ATTEMPT: { sources: ['browser', 'system'], explanation: 'A paste shortcut or action was observed.' },
  CONTEXT_MENU: { sources: ['browser'], explanation: 'The context menu was opened in the monitored page.' },
  DEVTOOLS_ATTEMPT: { sources: ['browser'], explanation: 'A browser developer-tools shortcut was observed.' },
  ALT_TAB_ATTEMPT: { sources: ['system'], explanation: 'The local security agent observed Alt+Tab.' },
  SYSTEM_KEY_ATTEMPT: { sources: ['system'], explanation: 'The local security agent observed a Windows system-key shortcut.' },
  PRINT_SCREEN_ATTEMPT: { sources: ['system'], explanation: 'The local security agent observed Print Screen.' },
  APP_SWITCH: { sources: ['system'], explanation: 'The foreground application changed during monitoring.' },
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const safeMetadata = (value: unknown): Record<string, string | number | boolean> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value).slice(0, 12)) {
    if (typeof item === 'string') output[key] = item.slice(0, 180);
    else if (typeof item === 'number' && Number.isFinite(item)) output[key] = item;
    else if (typeof item === 'boolean') output[key] = item;
  }
  return Object.keys(output).length ? output : undefined;
};

export function normalizeSecurityEvent(value: unknown): NormalizedSecurityEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.eventType !== 'string') return null;
  const type = input.eventType as ProctorEventType;
  const defaults = eventDefaults[type];
  if (!defaults) return null;

  const requestedSource = input.source;
  const source = typeof requestedSource === 'string' && defaults.sources.includes(requestedSource as EventSource)
    ? requestedSource as EventSource
    : defaults.sources[0];
  const explanation = typeof input.explanation === 'string' && input.explanation.trim()
    ? input.explanation.trim().slice(0, 320)
    : defaults.explanation;
  const confidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence)
    ? clamp(input.confidence, 0, 1)
    : 1;
  const duration = typeof input.duration === 'number' && Number.isFinite(input.duration)
    ? clamp(input.duration, 0, 86_400_000)
    : 0;
  const severity = typeof input.severity === 'number' && Number.isFinite(input.severity)
    ? clamp(input.severity, 0, 10)
    : undefined;

  return {
    type,
    duration,
    confidence,
    severity,
    explanation,
    source,
    metadata: safeMetadata(input.metadata),
  };
}
