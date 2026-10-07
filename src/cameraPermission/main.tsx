import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Camera, CheckCircle2, CircleAlert } from 'lucide-react';
import { ensureCameraPermissionFromVisiblePage } from '../popup/cameraPermission';
import './permission.css';

const params = new URLSearchParams(location.search);
const targetTabId = Number(params.get('targetTabId'));
const studentName = params.get('studentName') || 'Student';
const testName = params.get('testName') || 'Current test';

function CameraPermissionPage() {
  const [state, setState] = useState<'ready' | 'requesting' | 'starting' | 'error'>('ready');
  const [error, setError] = useState('');

  const allow = async () => {
    if (state !== 'ready' && state !== 'error') return;
    setState('requesting');
    setError('');
    try {
      await ensureCameraPermissionFromVisiblePage();
      setState('starting');
      const response = await chrome.runtime.sendMessage({
        type: 'camera-permission-start', confirmed: true, targetTabId, studentName, testName,
      }) as { state?: { status?: string }; error?: string };
      if (response.error) throw new Error(response.error);
      if (!response.state || response.state.status === 'PROCTORING_ERROR') {
        throw new Error('The proctoring session could not start after camera permission was granted.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState('error');
    }
  };

  return <main>
    <section className="card">
      <div className="mark"><Camera size={34} /></div>
      <p className="brand">LOOK AT ME!</p>
      <h1>Разрешите доступ к камере</h1>
      <p>Chrome требует один раз подтвердить доступ для самого расширения. Видео обрабатывается локально.</p>
      <div className="test"><span>Тест</span><b>{testName}</b></div>
      {error && <div className="error"><CircleAlert size={18} /><span>{error}</span></div>}
      <button onClick={() => { void allow(); }} disabled={state === 'requesting' || state === 'starting'}>
        {state === 'starting' ? <CheckCircle2 size={19} /> : <Camera size={19} />}
        {state === 'requesting' ? 'Ожидание разрешения Chrome…' : state === 'starting' ? 'Запуск теста…' : 'Разрешить камеру и начать тест'}
      </button>
      <small>После разрешения эта служебная вкладка закроется, а тест продолжится в исходной вкладке.</small>
    </section>
  </main>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><CameraPermissionPage /></React.StrictMode>);
