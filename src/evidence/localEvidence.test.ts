import { describe, expect, it } from 'vitest';
import { serializeViolation, shouldCaptureScreenshot } from './localEvidence';
import type { ProctorEvent } from '../types';

const phone: ProctorEvent = {
  id: 'PHONE_DETECTED-test', type: 'PHONE_DETECTED', timestamp: 12_500, duration: 800,
  confidence: 0.94, severity: 8, scoreImpact: 18, explanation: 'Possible phone.', source: 'cv',
};

describe('local evidence metadata', () => {
  it('serializes the minimum SQLite violation link', () => {
    expect(serializeViolation(phone)).toEqual({
      id: phone.id,
      type: 'PHONE_DETECTED',
      timestamp: 12_500,
    });
  });

  it('captures every confirmed scored violation and skips lifecycle events', () => {
    expect(shouldCaptureScreenshot(phone)).toBe(true);
    expect(shouldCaptureScreenshot({ ...phone, type: 'COPY_ATTEMPT', scoreImpact: 2 })).toBe(true);
    expect(shouldCaptureScreenshot({ ...phone, type: 'SESSION_STARTED', scoreImpact: 0 })).toBe(false);
  });
});
