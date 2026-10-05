import { Activity, MonitorCheck } from 'lucide-react';
import type { ProctorEvent, SessionSummary } from '../types';

const formatTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const formatDuration = (duration: number): string => `${(duration / 1_000).toFixed(1)} s`;

interface EventTimelineProps {
  events: ProctorEvent[];
  summary: SessionSummary;
}

export function EventTimeline({ events, summary }: EventTimelineProps) {
  const scoreBreakdown = Object.entries(summary.breakdown.byType)
    .filter(([, impact]) => impact !== 0)
    .sort(([, left], [, right]) => right - left);

  return (
    <aside className="timeline panel">
      <div className="section-heading">
        <div>
          <div className="eyebrow">Explainable record</div>
          <h2>Event timeline</h2>
        </div>
        <MonitorCheck size={20} />
      </div>

      {scoreBreakdown.length > 0 && (
        <div className="score-breakdown">
          <strong>Score breakdown</strong>
          {scoreBreakdown.map(([type, impact]) => (
            <div key={type}><span>{type.replace(/_/g, ' ')}</span><b>+{impact}</b></div>
          ))}
        </div>
      )}

      {events.length === 0 ? (
        <div className="empty-state">No events yet. Start monitoring to create a local timeline.</div>
      ) : (
        <ol className="event-list">
          {events.map((event) => (
            <li className="event-item" key={event.id}>
              <div className={`event-icon severity-${event.severity >= 6 ? 'high' : event.severity >= 4 ? 'medium' : 'low'}`}>
                <Activity size={15} />
              </div>
              <div className="event-content">
                <div className="event-title-row">
                  <strong>{event.type.replace(/_/g, ' ')}</strong>
                  <time>{formatTime(event.timestamp)}</time>
                </div>
                <p>{event.explanation}</p>
                <div className="event-metrics">
                  <span>{event.source}</span>
                  <span>{(event.confidence * 100).toFixed(0)}% confidence</span>
                  {event.duration > 0 && <span>{formatDuration(event.duration)}</span>}
                  <span className={event.scoreImpact > 0 ? 'impact' : ''}>{event.scoreImpact > 0 ? '+' : ''}{event.scoreImpact} score</span>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
