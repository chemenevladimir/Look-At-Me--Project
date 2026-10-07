import type { ProctorEvent } from '../types';

const nonViolationTypes = new Set<ProctorEvent['type']>([
  'FACE_DETECTED',
  'SESSION_STARTED',
  'SESSION_FINISHED',
  'FORM_SUBMITTED',
]);

export const shouldCaptureScreenshot = (event: ProctorEvent): boolean =>
  event.scoreImpact > 0 && !nonViolationTypes.has(event.type);

export const serializeViolation = (event: ProctorEvent) => ({
  id: event.id,
  type: event.type,
  timestamp: event.timestamp,
  duration: event.duration,
  confidence: event.confidence,
  severity: event.severity,
  scoreImpact: event.scoreImpact,
  explanation: event.explanation,
  source: event.source,
});
