import { AppWindow, Maximize2, MonitorUp, RefreshCw, ShieldAlert } from 'lucide-react';
import type { SecurityAgentStatus } from '../types';

interface SecurityStatusPanelProps {
  extensionStatus: string;
  agentStatus: SecurityAgentStatus;
  fullscreenWarning: boolean;
  onEnterFullscreen: () => void;
  onRetryAgent: () => void;
}

export function SecurityStatusPanel({
  extensionStatus,
  agentStatus,
  fullscreenWarning,
  onEnterFullscreen,
  onRetryAgent,
}: SecurityStatusPanelProps) {
  return (
    <section className="security-panel panel" aria-labelledby="security-heading">
      <div className="section-heading">
        <div>
          <div className="eyebrow">Browser + Windows signals</div>
          <h2 id="security-heading">Security monitoring</h2>
        </div>
        <ShieldAlert size={20} />
      </div>

      {fullscreenWarning && (
        <div className="fullscreen-warning">
          <div><Maximize2 size={18} /><span>Full-screen mode is not active. This state is recorded for review.</span></div>
          <button type="button" onClick={onEnterFullscreen}><Maximize2 size={15} /> Enter fullscreen</button>
        </div>
      )}

      <div className="security-status-grid">
        <div className="security-status-card">
          <AppWindow size={18} />
          <div><strong>Extension monitor</strong><span>{extensionStatus}</span></div>
        </div>
        <div className={`security-status-card agent-${agentStatus.state}`}>
          <MonitorUp size={18} />
          <div><strong>Local security agent · {agentStatus.state}</strong><span>{agentStatus.message}</span></div>
          {(agentStatus.state === 'error' || agentStatus.state === 'unavailable') && (
            <button type="button" className="icon-btn" onClick={onRetryAgent} aria-label="Retry local security agent">
              <RefreshCw size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="capability-columns">
        <div>
          <strong>Observed when agent is active</strong>
          <p>{agentStatus.capabilities.length
            ? agentStatus.capabilities.join(' · ')
            : 'Ctrl+C/V · Alt+Tab · Windows key · Print Screen · foreground application changes'}</p>
        </div>
        <div>
          <strong>Technical boundary</strong>
          <p>{agentStatus.limitations.length
            ? agentStatus.limitations.join(' · ')
            : 'Observation only; no guarantee for secure desktop, reserved Windows shortcuts, or another physical device.'}</p>
        </div>
      </div>
    </section>
  );
}
