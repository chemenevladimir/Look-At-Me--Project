export interface TemporalSignalOptions<T extends string> {
  normalLabel: T;
  minimumDurationMs: number;
  cooldownMs: number;
  recoveryGraceMs: number;
  minimumConfidence: number;
}

export interface TemporalTrigger<T extends string> {
  label: T;
  duration: number;
  confidence: number;
  samples: number;
}

export interface TemporalEpisodeSnapshot<T extends string> extends TemporalTrigger<T> {
  emitted: boolean;
}

export class TemporalSignalTracker<T extends string> {
  private candidate: T | null = null;
  private startedAt = 0;
  private lastObservedAt = 0;
  private lastEventAt = Number.NEGATIVE_INFINITY;
  private emittedForEpisode = false;
  private confidenceTotal = 0;
  private sampleCount = 0;
  private readonly options: TemporalSignalOptions<T>;

  constructor(options: TemporalSignalOptions<T>) {
    this.options = options;
  }

  public update(label: T, confidence: number, now: number): TemporalTrigger<T> | null {
    const qualifies = label !== this.options.normalLabel && confidence >= this.options.minimumConfidence;

    if (!qualifies) {
      if (this.candidate && now - this.lastObservedAt > this.options.recoveryGraceMs) {
        this.clearEpisode();
      }
      return null;
    }

    if (this.candidate !== label) {
      this.candidate = label;
      this.startedAt = now;
      this.lastObservedAt = now;
      this.emittedForEpisode = false;
      this.confidenceTotal = confidence;
      this.sampleCount = 1;
      return this.tryEmit(now);
    }

    this.lastObservedAt = now;
    this.confidenceTotal += confidence;
    this.sampleCount += 1;
    return this.tryEmit(now);
  }

  public getActiveEpisode(): TemporalEpisodeSnapshot<T> | null {
    if (!this.candidate || this.sampleCount === 0) return null;
    return {
      label: this.candidate,
      duration: Math.max(0, this.lastObservedAt - this.startedAt),
      confidence: this.confidenceTotal / this.sampleCount,
      samples: this.sampleCount,
      emitted: this.emittedForEpisode,
    };
  }

  public reset(): void {
    this.clearEpisode();
    this.lastEventAt = Number.NEGATIVE_INFINITY;
  }

  private tryEmit(now: number): TemporalTrigger<T> | null {
    const episode = this.getActiveEpisode();
    if (
      !episode ||
      this.emittedForEpisode ||
      episode.duration < this.options.minimumDurationMs ||
      now - this.lastEventAt < this.options.cooldownMs
    ) {
      return null;
    }

    this.emittedForEpisode = true;
    this.lastEventAt = now;
    return {
      label: episode.label,
      duration: episode.duration,
      confidence: episode.confidence,
      samples: episode.samples,
    };
  }

  private clearEpisode(): void {
    this.candidate = null;
    this.startedAt = 0;
    this.lastObservedAt = 0;
    this.emittedForEpisode = false;
    this.confidenceTotal = 0;
    this.sampleCount = 0;
  }
}
