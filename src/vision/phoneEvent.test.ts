import { describe, expect, it } from 'vitest';
import { EventEngine } from '../lib/eventEngine';
import { TemporalSignalTracker } from './temporal';

const createPhoneTracker = () => new TemporalSignalTracker<'absent' | 'phone'>({
  normalLabel: 'absent',
  minimumDurationMs: 0,
  cooldownMs: 1_000,
  recoveryGraceMs: 750,
  minimumConfidence: 0.5,
});

describe('phone event pipeline', () => {
  it('scores the first qualifying YOLO frame immediately', () => {
    const tracker = createPhoneTracker();
    const trigger = tracker.update('phone', 0.82, 0);
    expect(trigger).toMatchObject({ label: 'phone', duration: 0, samples: 1, confidence: 0.82 });

    const engine = new EventEngine([], () => 1_200);
    const event = engine.record({
      type: 'PHONE_DETECTED',
      duration: trigger?.duration ?? 0,
      confidence: trigger?.confidence ?? 0,
      severity: 8,
      explanation: 'Possible smartphone detected. Human review is required.',
      source: 'cv',
      metadata: { class: 'cell phone', samples: trigger?.samples ?? 0 },
    });

    expect(event).toMatchObject({ type: 'PHONE_DETECTED', severity: 8, source: 'cv' });
    expect(event?.scoreImpact).toBeGreaterThan(0);
    expect(engine.summarize().breakdown.byType.PHONE_DETECTED).toBe(event?.scoreImpact);
  });

  it('never promotes sub-threshold phone candidates into an event', () => {
    const tracker = createPhoneTracker();
    expect(tracker.update('phone', 0.49, 0)).toBeNull();
  });
});
