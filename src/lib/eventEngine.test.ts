import { describe, expect, it } from 'vitest';
import type { ProctorEvent } from '../types';
import { EventEngine, type EventInput } from './eventEngine';

const directionEvent = (type: 'HEAD_TURN' | 'LOOKING_AWAY', duration = 1_000): EventInput => ({
  type,
  duration,
  confidence: 0.85,
  severity: 4,
  explanation: 'Approximate direction deviation.',
  source: 'cv',
});

describe('EventEngine', () => {
  it('starts at zero and keeps normal face presence informational', () => {
    const engine = new EventEngine([], () => 1_000);
    engine.record({
      type: 'FACE_DETECTED',
      duration: 800,
      confidence: 0.8,
      severity: 0,
      explanation: 'Stable face.',
      source: 'cv',
    });

    expect(engine.summarize().score).toBe(0);
  });

  it('uses positive impacts and clamps the suspicious-activity score to 200', () => {
    let now = 1_000;
    const engine = new EventEngine([], () => now);

    for (let index = 0; index < 60; index += 1) {
      engine.record({
        type: 'PASTE_ATTEMPT',
        duration: 0,
        confidence: 1,
        severity: 3,
        explanation: 'Paste action.',
        source: 'browser',
      });
      now += 2_000;
    }

    expect(engine.getEvents().every((event) => event.scoreImpact >= 0)).toBe(true);
    expect(engine.summarize().score).toBe(200);
  });

  it('grows one direction event by whole seconds without creating duplicates', () => {
    let now = 1_000;
    const engine = new EventEngine([], () => now);
    const first = engine.record(directionEvent('HEAD_TURN'));

    expect(first?.scoreImpact).toBe(4);
    expect(first && engine.updateEvent(first.id, { duration: 8_000 })?.scoreImpact).toBe(11);
    expect(engine.getEvents()).toHaveLength(1);

    now = 12_000;
    const second = engine.record(directionEvent('HEAD_TURN', 8_000));
    expect(second?.scoreImpact).toBe(12);
    expect(second?.metadata?.recurrenceIndex).toBe(1);
    expect(engine.summarize().score).toBe(23);
  });

  it('preserves the measured episode start while using processing time for cooldowns', () => {
    const engine = new EventEngine([], () => 10_500);
    const event = engine.record({ ...directionEvent('HEAD_TURN', 1_200), timestamp: 9_300 });
    expect(event?.timestamp).toBe(9_300);
    expect(event?.duration).toBe(1_200);
  });

  it('applies recurrence independently to head and gaze episode types', () => {
    let now = 1_000;
    const engine = new EventEngine([], () => now);
    expect(engine.record(directionEvent('HEAD_TURN'))?.scoreImpact).toBe(4);

    now = 3_000;
    expect(engine.record(directionEvent('LOOKING_AWAY'))?.scoreImpact).toBe(4);

    now = 5_000;
    expect(engine.record(directionEvent('LOOKING_AWAY'))?.scoreImpact).toBe(5);
  });

  it('migrates legacy negative impacts into the ascending score model', () => {
    const legacy: ProctorEvent = {
      id: 'legacy-phone',
      type: 'PHONE_DETECTED',
      timestamp: 1_000,
      duration: 0,
      confidence: 0.9,
      severity: 8,
      scoreImpact: -18,
      explanation: 'Possible phone.',
      source: 'cv',
    };
    const engine = new EventEngine([legacy], () => 2_000);

    expect(engine.getEvents()[0].scoreImpact).toBeGreaterThan(0);
    expect(engine.summarize().score).toBe(engine.getEvents()[0].scoreImpact);
  });

  it('uses explicit zero impact for availability events', () => {
    const engine = new EventEngine([], () => 1_000);
    engine.record({
      type: 'CAMERA_BLOCKED',
      duration: 0,
      confidence: 1,
      severity: 5,
      scoreImpact: 0,
      explanation: 'Permission denied.',
      source: 'system',
    });
    expect(engine.summarize().score).toBe(0);
  });

  it('scores validated local security events through the same engine', () => {
    const engine = new EventEngine([], () => 1_000);
    const event = engine.record({
      type: 'ALT_TAB_ATTEMPT',
      duration: 0,
      confidence: 1,
      explanation: 'The local security agent observed Alt+Tab.',
      source: 'system',
      metadata: { shortcut: 'alt+tab' },
    });

    expect(event).toMatchObject({ type: 'ALT_TAB_ATTEMPT', source: 'system', scoreImpact: 8 });
    expect(engine.summarize().score).toBe(8);
  });
});
