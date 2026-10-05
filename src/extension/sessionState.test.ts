import { describe, expect, it } from 'vitest';
import { applySummary, createIdleSessionState, isMonitorableUrl, isSessionRunning, sanitizeStoredState } from './sessionState';

describe('extension session state', () => {
  it('accepts ordinary web pages but rejects protected browser pages', () => {
    expect(isMonitorableUrl('https://example.com/test')).toBe(true);
    expect(isMonitorableUrl('http://localhost:8080/form')).toBe(true);
    expect(isMonitorableUrl('chrome://extensions')).toBe(false);
    expect(isMonitorableUrl('chrome-extension://abc/popup.html')).toBe(false);
  });

  it('keeps running independently of popup lifecycle', () => {
    expect(isSessionRunning('PROCTORING_STARTING')).toBe(true);
    expect(isSessionRunning('PROCTORING_ACTIVE')).toBe(true);
    expect(isSessionRunning('PROCTORING_COMPLETED')).toBe(false);
  });

  it('clamps restored scores and applies the central Event Engine summary', () => {
    const restored = sanitizeStoredState({ status: 'PROCTORING_ACTIVE', activityScore: 900, eventCount: -2 });
    expect(restored.activityScore).toBe(200);
    expect(restored.eventCount).toBe(0);

    const summarized = applySummary(createIdleSessionState(), {
      score: 42,
      eventCount: 3,
      severeEvents: 1,
      confidence: 0.8,
      breakdown: { severity: 6, confidence: 0.8, duration: 0, repeatedEvents: 0, byType: {} },
    }, null);
    expect(summarized).toMatchObject({ activityScore: 42, eventCount: 3, severeEventCount: 1 });
  });
});
