import { describe, expect, it } from 'vitest';
import { TemporalSignalTracker } from './temporal';

const createTracker = () => new TemporalSignalTracker<'normal' | 'left'>({
  normalLabel: 'normal',
  minimumDurationMs: 1_000,
  cooldownMs: 0,
  recoveryGraceMs: 300,
  minimumConfidence: 0.6,
});

describe('TemporalSignalTracker', () => {
  it('ignores short deviations and low-confidence samples', () => {
    const tracker = createTracker();
    expect(tracker.update('left', 0.9, 0)).toBeNull();
    expect(tracker.update('left', 0.9, 700)).toBeNull();
    expect(tracker.update('left', 0.4, 1_100)).toBeNull();
  });

  it('emits once after a sustained episode and exposes its live progress', () => {
    const tracker = createTracker();
    tracker.update('left', 0.8, 0);
    tracker.update('left', 0.9, 500);
    const trigger = tracker.update('left', 1, 1_100);

    expect(trigger).toMatchObject({ label: 'left', duration: 1_100, samples: 3 });
    expect(trigger?.confidence).toBeCloseTo(0.9);
    expect(tracker.update('left', 1, 2_200)).toBeNull();
    expect(tracker.getActiveEpisode()).toMatchObject({ duration: 2_200, samples: 4, emitted: true });
  });

  it('tolerates a brief normal sample but resets after recovery grace', () => {
    const tracker = createTracker();
    tracker.update('left', 0.9, 0);
    tracker.update('normal', 1, 200);
    expect(tracker.update('left', 0.9, 1_050)?.duration).toBe(1_050);

    tracker.update('normal', 1, 1_400);
    tracker.update('normal', 1, 1_800);
    expect(tracker.getActiveEpisode()).toBeNull();
    expect(tracker.update('left', 0.9, 2_000)).toBeNull();
  });

  it('can emit on the first qualifying frame when the minimum duration is zero', () => {
    const tracker = new TemporalSignalTracker<'absent' | 'phone'>({
      normalLabel: 'absent',
      minimumDurationMs: 0,
      cooldownMs: 1_000,
      recoveryGraceMs: 750,
      minimumConfidence: 0.5,
    });

    expect(tracker.update('phone', 0.84, 5_000)).toMatchObject({
      label: 'phone',
      duration: 0,
      confidence: 0.84,
      samples: 1,
    });
    expect(tracker.update('phone', 0.9, 5_600)).toBeNull();
  });
});
