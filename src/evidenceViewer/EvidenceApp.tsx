import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Database, FolderOpen, RefreshCw, Trash2, Wifi, WifiOff } from 'lucide-react';
import type { ExtensionSessionState } from '../extension/sessionState';
import './evidence.css';

interface ViolationRow {
  event_id: string;
  session_id: string;
  violation_time: string;
  ended_at: string | null;
  violation_type: string;
  duration_ms: number;
  confidence: number;
  severity: number;
  score_impact: number;
  source: string;
  description: string;
  screenshot_name: string | null;
  screenshot_path: string | null;
  created_at: string;
}

interface EvidenceResponse {
  violations?: ViolationRow[];
  dataRoot?: string;
  deleted?: boolean;
  opened?: boolean;
  error?: string;
}

type HelperState = ExtensionSessionState['localAgentState'];

const send = (message: Record<string, unknown>): Promise<EvidenceResponse> =>
  chrome.runtime.sendMessage(message) as Promise<EvidenceResponse>;
const readableType = (value: string): string => value.replace(/_/g, ' ');
const readableTime = (value: string): string => {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString('ru-RU');
};
const isOnline = (state: HelperState): boolean => state === 'ready' || state === 'active' || state === 'stopped';

export default function EvidenceApp() {
  const [rows, setRows] = useState<ViolationRow[]>([]);
  const [dataRoot, setDataRoot] = useState('');
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [error, setError] = useState('');
  const [helperState, setHelperState] = useState<HelperState>('connecting');
  const lastOnline = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await send({ type: 'evidence-list' });
      if (response.error) throw new Error(response.error);
      setRows(Array.isArray(response.violations) ? response.violations : []);
      setDataRoot(response.dataRoot ?? '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setHelperState('unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'look-at-me-evidence' });
    const handle = (message: unknown) => {
      if (!message || typeof message !== 'object' || (message as { type?: string }).type !== 'session-state') return;
      const state = (message as { state?: ExtensionSessionState }).state;
      if (state) setHelperState(state.localAgentState);
    };
    port.onMessage.addListener(handle);
    chrome.runtime.onMessage.addListener(handle);
    return () => {
      port.onMessage.removeListener(handle);
      chrome.runtime.onMessage.removeListener(handle);
      port.disconnect();
    };
  }, []);

  useEffect(() => {
    const online = isOnline(helperState);
    if (online && !lastOnline.current) void load();
    lastOnline.current = online;
  }, [helperState, load]);

  const remove = async (row: ViolationRow) => {
    if (deleting || !window.confirm(`Удалить ${row.screenshot_name || row.event_id} и запись из базы данных?`)) return;
    setDeleting(row.event_id);
    setError('');
    try {
      const response = await send({ type: 'evidence-delete', eventId: row.event_id });
      if (response.error) throw new Error(response.error);
      if (!response.deleted) throw new Error('Запись уже отсутствует в базе данных.');
      setRows((current) => current.filter((item) => item.event_id !== row.event_id));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setDeleting(null);
    }
  };

  const openScreenshots = async () => {
    if (openingFolder || !isOnline(helperState)) return;
    setOpeningFolder(true);
    setError('');
    try {
      const response = await send({ type: 'evidence-open-screenshots' });
      if (response.error) throw new Error(response.error);
      if (!response.opened) throw new Error('Helper не подтвердил открытие папки.');
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    } finally {
      setOpeningFolder(false);
    }
  };

  const countLabel = useMemo(() => `${rows.length} ${rows.length === 1 ? 'нарушение' : 'нарушений'}`, [rows.length]);

  return (
    <main className="evidence-page">
      <header>
        <div className="title-mark"><Database size={22} /></div>
        <div><p>LOOK AT ME!</p><h1>База нарушений</h1></div>
        <span className="count">{countLabel}</span>
        <button className="folder" onClick={() => { void openScreenshots(); }} disabled={!isOnline(helperState) || openingFolder}>
          <FolderOpen size={15} /> {openingFolder ? 'Открытие…' : 'Доказательства'}
        </button>
        <button className="refresh" onClick={() => { if (isOnline(helperState)) void load(); else chrome.runtime.sendMessage({ type: 'popup-retry-agent' }); }} disabled={loading}>
          <RefreshCw size={15} /> {isOnline(helperState) ? 'Обновить' : 'Подключить helper'}
        </button>
      </header>

      <section className={`helper-card ${isOnline(helperState) ? 'online' : helperState === 'connecting' ? 'connecting' : 'offline'}`}>
        {isOnline(helperState) ? <Wifi size={17} /> : <WifiOff size={17} />}
        <div>
          <b>Helper: {isOnline(helperState) ? 'Online' : helperState === 'connecting' ? 'Connecting' : 'Offline'}</b>
          <span>{isOnline(helperState) ? (dataRoot || 'Локальная база подключена.') : 'Запустите setup/helper. Повторное подключение выполняется в фоне без перезагрузки страницы.'}</span>
        </div>
      </section>

      {error && <div className="error"><b>Не удалось прочитать базу.</b><span>{error}</span></div>}

      <section className="table-card">
        {loading ? (
          <div className="empty">Загрузка данных…</div>
        ) : !isOnline(helperState) ? (
          <div className="empty"><WifiOff size={28} /><b>Helper недоступен</b><span>Интерфейс остаётся доступным и автоматически обновится после восстановления соединения.</span></div>
        ) : rows.length === 0 ? (
          <div className="empty"><Database size={28} /><b>Нарушений пока нет</b><span>Подтверждённые события появятся здесь во время теста.</span></div>
        ) : (
          <table>
            <thead><tr><th>Время / длительность</th><th>Нарушение</th><th>Оценка</th><th>Сессия / скриншот</th><th /></tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={row.event_id}>
                <td><b>{readableTime(row.violation_time)}</b><small>{(Number(row.duration_ms || 0) / 1_000).toFixed(1)} сек.</small></td>
                <td><strong>{readableType(row.violation_type)}</strong><small>{row.source} · confidence {Math.round(Number(row.confidence || 0) * 100)}%</small><p>{row.description}</p></td>
                <td><span className={`severity s${Math.min(10, Math.max(0, Number(row.severity || 0)))}`}>severity {row.severity}</span><b className="impact">+{row.score_impact}</b></td>
                <td><code>{row.session_id}</code><small title={row.screenshot_path || ''}>{row.screenshot_name || 'без скриншота'}</small></td>
                <td><button className="delete" onClick={() => { void remove(row); }} disabled={deleting === row.event_id}><Trash2 size={14} /> {deleting === row.event_id ? 'Удаление…' : 'Удалить'}</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      <footer>Удаление убирает событие из SQLite и связанный PNG-файл. Сессия и другие события сохраняются.</footer>
    </main>
  );
}
