import { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, RefreshCw, Trash2 } from 'lucide-react';
import './evidence.css';

interface ViolationRow {
  event_id: string;
  session_id: string;
  violation_time: string;
  violation_type: string;
  screenshot_name: string;
  created_at: string;
}

interface EvidenceResponse {
  violations?: ViolationRow[];
  dataRoot?: string;
  databasePath?: string;
  screenshotsPath?: string;
  deleted?: boolean;
  error?: string;
}

const send = (message: Record<string, unknown>): Promise<EvidenceResponse> =>
  chrome.runtime.sendMessage(message) as Promise<EvidenceResponse>;

const readableType = (value: string): string => value.replace(/_/g, ' ');

const readableTime = (value: string): string => {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString('ru-RU');
};

export default function EvidenceApp() {
  const [rows, setRows] = useState<ViolationRow[]>([]);
  const [dataRoot, setDataRoot] = useState('');
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState('');

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
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const remove = async (row: ViolationRow) => {
    if (deleting || !window.confirm(`Удалить ${row.screenshot_name} и запись из базы данных?`)) return;
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

  const countLabel = useMemo(() => {
    const lastTwo = rows.length % 100;
    const last = rows.length % 10;
    const word = lastTwo >= 11 && lastTwo <= 14
      ? 'нарушений'
      : last === 1
        ? 'нарушение'
        : last >= 2 && last <= 4
          ? 'нарушения'
          : 'нарушений';
    return `${rows.length} ${word}`;
  }, [rows.length]);

  return (
    <main className="evidence-page">
      <header>
        <div className="title-mark"><Database size={22} /></div>
        <div>
          <p>LOOK AT ME!</p>
          <h1>База нарушений</h1>
        </div>
        <span className="count">{countLabel}</span>
        <button className="refresh" onClick={() => { void load(); }} disabled={loading}>
          <RefreshCw size={15} /> Обновить
        </button>
      </header>

      <section className="storage-card">
        <b>Локальное хранилище</b>
        <span>{dataRoot || 'Подключение к локальному helper…'}</span>
      </section>

      {error && <div className="error"><b>Не удалось прочитать базу.</b><span>{error}</span></div>}

      <section className="table-card">
        {loading ? (
          <div className="empty">Загрузка данных…</div>
        ) : rows.length === 0 ? (
          <div className="empty"><Database size={28} /><b>Нарушений пока нет</b><span>Подтверждённые события появятся здесь после сохранения скриншота.</span></div>
        ) : (
          <table>
            <thead><tr><th>Время</th><th>Тип нарушения</th><th>Сессия</th><th>Скриншот</th><th /></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.event_id}>
                  <td>{readableTime(row.violation_time)}</td>
                  <td><strong>{readableType(row.violation_type)}</strong></td>
                  <td><code>{row.session_id}</code></td>
                  <td><code>{row.screenshot_name}</code></td>
                  <td>
                    <button className="delete" onClick={() => { void remove(row); }} disabled={deleting === row.event_id}>
                      <Trash2 size={14} /> {deleting === row.event_id ? 'Удаление…' : 'Удалить'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer>Удаление убирает запись из SQLite и связанный PNG-файл из папки screenshots.</footer>
    </main>
  );
}
