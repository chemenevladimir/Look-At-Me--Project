import type { ProctorEvent, ProctorEventType, SessionSummary } from '../types';

interface EventPolicy {
  severity: number;
  baseImpact: number;
  cooldownMs: number;
}

export type EventInput = Omit<ProctorEvent, 'id' | 'timestamp' | 'scoreImpact' | 'severity'> & {
  severity?: number;
  scoreImpact?: number;
};

export interface EventProgressUpdate {
  duration: number;
  confidence?: number;
  explanation?: string;
  metadata?: Record<string, string | number | boolean>;
}

const policies: Record<ProctorEventType, EventPolicy> = {
  FACE_DETECTED: { severity: 0, baseImpact: 0, cooldownMs: 10_000 },
  FACE_NOT_DETECTED: { severity: 4, baseImpact: 6, cooldownMs: 6_000 },
  MULTIPLE_FACES: { severity: 6, baseImpact: 10, cooldownMs: 8_000 },
  HEAD_TURN: { severity: 4, baseImpact: 4, cooldownMs: 0 },
  LOOKING_AWAY: { severity: 4, baseImpact: 4, cooldownMs: 0 },
  PHONE_DETECTED: { severity: 8, baseImpact: 18, cooldownMs: 1_000 },
  TAB_SWITCH: { severity: 5, baseImpact: 5, cooldownMs: 2_000 },
  WINDOW_BLUR: { severity: 3, baseImpact: 3, cooldownMs: 2_000 },
  FULLSCREEN_EXIT: { severity: 5, baseImpact: 6, cooldownMs: 4_000 },
  COPY_ATTEMPT: { severity: 2, baseImpact: 2, cooldownMs: 1_500 },
  PASTE_ATTEMPT: { severity: 3, baseImpact: 3, cooldownMs: 1_500 },
  CONTEXT_MENU: { severity: 1, baseImpact: 1, cooldownMs: 1_500 },
  DEVTOOLS_ATTEMPT: { severity: 5, baseImpact: 6, cooldownMs: 2_000 },
  ALT_TAB_ATTEMPT: { severity: 6, baseImpact: 8, cooldownMs: 1_000 },
  SYSTEM_KEY_ATTEMPT: { severity: 5, baseImpact: 6, cooldownMs: 1_000 },
  PRINT_SCREEN_ATTEMPT: { severity: 6, baseImpact: 9, cooldownMs: 1_500 },
  APP_SWITCH: { severity: 5, baseImpact: 7, cooldownMs: 1_500 },
  CAMERA_BLOCKED: { severity: 5, baseImpact: 6, cooldownMs: 10_000 },
  MODEL_FAILURE: { severity: 0, baseImpact: 0, cooldownMs: 10_000 },
  INFERENCE_FAILURE: { severity: 0, baseImpact: 0, cooldownMs: 10_000 },
  SESSION_STARTED: { severity: 0, baseImpact: 0, cooldownMs: 1_000 },
  SESSION_FINISHED: { severity: 0, baseImpact: 0, cooldownMs: 1_000 },
  FORM_SUBMITTED: { severity: 0, baseImpact: 0, cooldownMs: 1_000 },
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const makeId = (type: ProctorEventType, now: number): string => {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${now}-${EventEngine.nextId++}`;
  return `${type}-${suffix}`;
};

const isDirectionEvent = (type: ProctorEventType): type is 'HEAD_TURN' | 'LOOKING_AWAY' =>
  type === 'HEAD_TURN' || type === 'LOOKING_AWAY';

export class EventEngine {
  public static nextId = 1;

  private events: ProctorEvent[] = [];
  private cooldowns = new Map<ProctorEventType, number>();
  private readonly now: () => number;

  constructor(initialEvents: ProctorEvent[] = [], now: () => number = Date.now) {
    this.now = now;
    this.hydrate(initialEvents);
  }

  public hydrate(events: ProctorEvent[]): void {
    const occurrenceCounts = new Map<ProctorEventType, number>();
    const chronological = [...events]
      .filter((event) => Number.isFinite(event.timestamp) && event.type in policies)
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-250);

    this.events = chronological.map((event) => {
      const policy = policies[event.type];
      const duration = Math.max(0, Number.isFinite(event.duration) ? event.duration : 0);
      const confidence = clamp(Number.isFinite(event.confidence) ? event.confidence : 0, 0, 1);
      const occurrenceIndex = occurrenceCounts.get(event.type) ?? 0;
      occurrenceCounts.set(event.type, occurrenceIndex + 1);
      const storedImpact = Number.isFinite(event.scoreImpact) ? event.scoreImpact : policy.baseImpact;
      const scoreImpact = storedImpact === 0
        ? 0
        : storedImpact > 0 && !isDirectionEvent(event.type)
          ? storedImpact
          : this.calculateImpact(event.type, policy.baseImpact, confidence, duration, occurrenceIndex);

      return {
        ...event,
        duration,
        confidence,
        severity: clamp(Number.isFinite(event.severity) ? event.severity : policy.severity, 0, 10),
        scoreImpact: clamp(Math.round(scoreImpact), 0, 200),
        metadata: isDirectionEvent(event.type)
          ? { ...event.metadata, recurrenceIndex: occurrenceIndex }
          : event.metadata,
      };
    }).sort((a, b) => b.timestamp - a.timestamp);

    this.cooldowns.clear();
    for (const event of this.events) {
      const previous = this.cooldowns.get(event.type) ?? 0;
      this.cooldowns.set(event.type, Math.max(previous, event.timestamp));
    }
  }

  public record(input: EventInput): ProctorEvent | null {
    const now = this.now();
    const policy = policies[input.type];
    const lastSeen = this.cooldowns.get(input.type);

    if (lastSeen !== undefined && now - lastSeen < policy.cooldownMs) {
      return null;
    }

    const confidence = clamp(input.confidence, 0, 1);
    const duration = Math.max(0, input.duration);
    const previousCount = this.events.filter((event) => event.type === input.type).length;
    const scoreImpact = input.scoreImpact ?? this.calculateImpact(
      input.type,
      policy.baseImpact,
      confidence,
      duration,
      previousCount,
    );

    const normalizedEvent: ProctorEvent = {
      ...input,
      id: makeId(input.type, now),
      timestamp: now,
      duration,
      severity: clamp(input.severity ?? policy.severity, 0, 10),
      confidence,
      scoreImpact: clamp(Math.round(scoreImpact), 0, 200),
      explanation: input.explanation.trim() || 'Observed by the monitoring pipeline.',
      source: input.source,
      metadata: isDirectionEvent(input.type)
        ? { ...input.metadata, recurrenceIndex: previousCount }
        : input.metadata,
    };

    this.events = [normalizedEvent, ...this.events].slice(0, 250);
    this.cooldowns.set(input.type, now);
    return normalizedEvent;
  }

  public updateEvent(id: string, update: EventProgressUpdate): ProctorEvent | null {
    const index = this.events.findIndex((event) => event.id === id);
    if (index < 0) return null;

    const current = this.events[index];
    const duration = Math.max(current.duration, Math.max(0, update.duration));
    const confidence = update.confidence === undefined
      ? current.confidence
      : clamp(update.confidence, 0, 1);
    const recurrenceIndex = typeof current.metadata?.recurrenceIndex === 'number'
      ? current.metadata.recurrenceIndex
      : this.events.filter((event) => event.type === current.type && event.timestamp < current.timestamp).length;
    const policy = policies[current.type];
    const scoreImpact = this.calculateImpact(
      current.type,
      policy.baseImpact,
      confidence,
      duration,
      recurrenceIndex,
    );
    const updated: ProctorEvent = {
      ...current,
      duration,
      confidence,
      scoreImpact: clamp(Math.round(scoreImpact), 0, 200),
      explanation: update.explanation?.trim() || current.explanation,
      metadata: { ...current.metadata, ...update.metadata },
    };

    this.events[index] = updated;
    return updated;
  }

  public getEvents(): ProctorEvent[] {
    return [...this.events];
  }

  public summarize(): SessionSummary {
    const scoredEvents = this.events.filter((event) => event.scoreImpact > 0);
    const severeEvents = this.events.filter((event) => event.severity >= 6).length;
    const confidence = scoredEvents.length
      ? scoredEvents.reduce((total, event) => total + event.confidence, 0) / scoredEvents.length
      : 0;
    const counts = new Map<ProctorEventType, number>();
    const byType: SessionSummary['breakdown']['byType'] = {};

    for (const event of this.events) {
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
      byType[event.type] = (byType[event.type] ?? 0) + event.scoreImpact;
    }

    const repeatedEvents = [...counts.values()].reduce(
      (total, count) => total + Math.max(0, count - 1),
      0,
    );
    const totalImpact = this.events.reduce((total, event) => total + event.scoreImpact, 0);

    return {
      score: clamp(totalImpact, 0, 200),
      eventCount: this.events.length,
      severeEvents,
      confidence,
      breakdown: {
        severity: scoredEvents.reduce((total, event) => total + event.severity, 0),
        confidence,
        duration: scoredEvents.reduce((total, event) => total + event.duration, 0),
        repeatedEvents,
        byType,
      },
    };
  }

  public clear(): void {
    this.events = [];
    this.cooldowns.clear();
  }

  private calculateImpact(
    type: ProctorEventType,
    baseImpact: number,
    confidence: number,
    duration: number,
    previousCount: number,
  ): number {
    if (baseImpact === 0) return 0;

    if (isDirectionEvent(type)) {
      const additionalSeconds = Math.max(0, Math.floor(duration / 1_000) - 1);
      return 4 + previousCount + additionalSeconds;
    }

    const confidenceFactor = 0.5 + confidence * 0.5;
    const durationFactor = 1 + Math.min(duration / 5_000, 1) * 0.35;
    const repetitionFactor = 1 + Math.min(previousCount * 0.15, 0.45);
    return baseImpact * confidenceFactor * durationFactor * repetitionFactor;
  }
}
