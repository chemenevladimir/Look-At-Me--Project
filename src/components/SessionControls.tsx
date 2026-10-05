import { Clock3, LockKeyhole, Play, ShieldCheck, Square } from 'lucide-react';
import type { ProctoringSessionState } from '../types';

interface SessionControlsProps {
  session: ProctoringSessionState;
  busy: boolean;
  onStart: () => void;
  onFinish: () => void;
}

const formatDuration = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
};

export function SessionControls({ session, busy, onStart, onFinish }: SessionControlsProps) {
  const active = session.status === 'active';

  return (
    <section className="session-panel" aria-labelledby="session-heading">
      <div className="session-header">
        <div>
          <div className="eyebrow">Local proctoring session</div>
          <h2 id="session-heading">Monitoring controls</h2>
          <p>Start camera analysis and browser monitoring when the assessment opens.</p>
        </div>
        <div className="session-meta">
          <span><Clock3 size={16} /> {formatDuration(session.status === 'idle' ? 0 : session.elapsedSeconds)}</span>
          <span><LockKeyhole size={16} /> Local processing</span>
          <span><ShieldCheck size={16} /> Human review</span>
        </div>
      </div>

      <div className="session-actions">
        <div className={`session-state ${session.status}`}>
          {session.status === 'idle' && 'Ready to request camera permission and begin monitoring.'}
          {session.status === 'active' && 'Camera AI and browser monitoring are active.'}
          {session.status === 'completed' && 'Monitoring finished. The local review record is preserved.'}
        </div>
        {active ? (
          <button className="danger-btn" type="button" onClick={onFinish}>
            <Square size={16} /> Finish monitoring
          </button>
        ) : (
          <button className="primary-btn" type="button" onClick={onStart} disabled={busy}>
            <Play size={16} /> {busy ? 'Starting…' : session.status === 'completed' ? 'Start new session' : 'Start monitoring'}
          </button>
        )}
      </div>
    </section>
  );
}
