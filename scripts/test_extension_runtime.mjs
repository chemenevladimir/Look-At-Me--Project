import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const rootDir = resolve(import.meta.dirname, '..');
const extensionDir = resolve(rootDir, 'dist');
const chromePath = process.env.LOOK_AT_ME_CHROME
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!existsSync(chromePath)) throw new Error(`Chrome was not found: ${chromePath}`);
if (!existsSync(join(extensionDir, 'manifest.json'))) {
  throw new Error('dist/manifest.json is missing. Run pnpm build first.');
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitFor(work, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await work();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.opened = new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', rejectOpen, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result);
    });
  }

  async send(method, params = {}, sessionId) {
    await this.opened;
    const id = this.nextId++;
    const response = new Promise((resolveResponse, rejectResponse) => {
      this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse });
    });
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return response;
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, sessionId, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result?.value;
}

async function attach(client, targetId) {
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  await client.send('Runtime.enable', {}, sessionId);
  return sessionId;
}

async function clickPrimary(client, popupSessionId) {
  const { targetInfos } = await client.send('Target.getTargets');
  const popupTarget = targetInfos.find((item) => item.url?.endsWith('/popup.html'));
  if (popupTarget) await client.send('Target.activateTarget', { targetId: popupTarget.targetId });
  const point = await evaluate(client, popupSessionId, `(() => {
    const button = document.querySelector('button.primary-action');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2,disabled:button.disabled,text:button.textContent};
  })()`);
  if (!point || point.disabled) {
    const diagnostics = await evaluate(client, popupSessionId, '({url:location.href,title:document.title,body:document.body?.innerHTML,error:document.body?.innerText})');
    throw new Error(`Popup primary action is unavailable: ${JSON.stringify(point)} diagnostics=${JSON.stringify(diagnostics)}`);
  }
  await evaluate(client, popupSessionId, 'document.querySelector("button.primary-action").click()');
}

const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html><body><h1>Look At Me runtime smoke</h1><button>Finish test</button></body></html>');
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Local smoke server did not expose a port.');

const profileDir = await mkdtemp(join(tmpdir(), 'look-at-me-chrome-'));
const evidenceRoot = process.env.LOOK_AT_ME_TEST_DATA_DIR
  ? resolve(process.env.LOOK_AT_ME_TEST_DATA_DIR)
  : await mkdtemp(join(tmpdir(), 'look-at-me-violations-'));
const chromeArguments = [
  '--enable-extensions',
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  `--user-data-dir=${profileDir}`,
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,900',
  'about:blank',
];
if (process.env.LOOK_AT_ME_REAL_CAMERA !== '1') chromeArguments.push('--use-fake-device-for-media-stream');
if (process.env.LOOK_AT_ME_HEADFUL !== '1') chromeArguments.unshift('--headless=new');
const chrome = spawn(chromePath, chromeArguments, {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, LOOK_AT_ME_DATA_DIR: evidenceRoot },
});
const chromeExited = new Promise((resolveExit) => chrome.once('exit', resolveExit));
let chromeDiagnostics = '';
for (const stream of [chrome.stdout, chrome.stderr]) {
  stream?.on('data', (chunk) => {
    chromeDiagnostics = (chromeDiagnostics + chunk.toString()).slice(-12_000);
  });
}

let client;
try {
  const port = await waitFor(async () => {
    const file = join(profileDir, 'DevToolsActivePort');
    if (!existsSync(file)) return null;
    const [value] = (await readFile(file, 'utf8')).split(/\r?\n/);
    return Number(value) || null;
  }, 'Chrome DevTools port');
  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok ? response.json() : null;
  }, 'Chrome DevTools endpoint');
  client = new CdpClient(version.webSocketDebuggerUrl);
  await client.opened;
  await client.send('Target.setDiscoverTargets', { discover: true });

  let worker;
  let workerSession;
  try {
    worker = await waitFor(async () => {
      const { targetInfos } = await client.send('Target.getTargets');
      const candidates = targetInfos.filter((target) => target.type === 'service_worker'
        && /^chrome-extension:\/\/[^/]+\/background\.js$/.test(target.url));
      for (const candidate of candidates) {
        let candidateSession;
        try {
          candidateSession = await attach(client, candidate.targetId);
          const candidateManifest = await evaluate(client, candidateSession, 'chrome.runtime.getManifest()');
          if (candidateManifest?.name === 'Look At Me!') {
            workerSession = candidateSession;
            return candidate;
          }
          await client.send('Target.detachFromTarget', { sessionId: candidateSession });
        } catch {
          if (candidateSession) {
            try { await client.send('Target.detachFromTarget', { sessionId: candidateSession }); } catch { /* target vanished */ }
          }
        }
      }
      return null;
    }, 'extension service worker');
  } catch (error) {
    const { targetInfos } = await client.send('Target.getTargets');
    throw new Error(`${error.message}; targets=${JSON.stringify(targetInfos.map(({type,url,title}) => ({type,url,title})))}`);
  }
  const extensionId = new URL(worker.url).hostname;
  if (!workerSession) throw new Error('Look At Me! worker had no CDP session.');
  console.error('[runtime-smoke] extension worker ready');

  const { targetId: pageTargetId } = await client.send('Target.createTarget', {
    url: `http://127.0.0.1:${address.port}/test`,
  });
  await client.send('Target.activateTarget', { targetId: pageTargetId });
  const pageSession = await attach(client, pageTargetId);
  await waitFor(
    () => evaluate(client, pageSession, 'document.readyState === "complete"'),
    'monitored page load',
  );
  console.error('[runtime-smoke] monitored page ready');

  const openPopup = async () => {
    await client.send('Target.activateTarget', { targetId: pageTargetId });
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Y', code: 'KeyY', windowsVirtualKeyCode: 89, nativeVirtualKeyCode: 89,
      modifiers: 10,
    }, pageSession);
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Y', code: 'KeyY', windowsVirtualKeyCode: 89, nativeVirtualKeyCode: 89,
      modifiers: 10,
    }, pageSession);
    const target = await waitFor(async () => {
      const { targetInfos } = await client.send('Target.getTargets');
      return targetInfos.find((item) => item.url === `chrome-extension://${extensionId}/popup.html`);
    }, 'extension action popup');
    const targetId = target.targetId;
    const sessionId = await attach(client, targetId);
    await waitFor(
      () => evaluate(client, sessionId, 'document.readyState === "complete"'),
      'popup load',
    );
    return { targetId, sessionId };
  };

  let popup = await openPopup();
  console.error('[runtime-smoke] action popup opened');
  await client.send('Target.activateTarget', { targetId: pageTargetId });
  await clickPrimary(client, popup.sessionId);
  console.error('[runtime-smoke] start clicked');

  let activeState;
  try {
    activeState = await waitFor(async () => {
      const stored = await evaluate(
        client,
        workerSession,
        'chrome.storage.local.get("look-at-me.session")',
      );
      const current = stored?.['look-at-me.session'];
      if (current?.status === 'PROCTORING_ERROR') {
        throw new Error(current.error || current.proctoringStatus || 'Unknown runtime error');
      }
      return current?.status === 'PROCTORING_ACTIVE' ? current : null;
    }, 'active proctoring session', 60_000);
  } catch (error) {
    const stored = await evaluate(client, workerSession, 'chrome.storage.local.get("look-at-me.session")');
    const popupText = await evaluate(client, popup.sessionId, 'document.body.innerText');
    throw new Error(`${error.message}; stored=${JSON.stringify(stored)}; popup=${JSON.stringify(popupText)}`);
  }
  const sessionId = activeState.sessionId;
  console.error('[runtime-smoke] session active');
  if (!sessionId) throw new Error('Active state returned no session ID.');

  const overlayText = await waitFor(
    () => evaluate(client, pageSession, `document.getElementById('look-at-me-proctoring-overlay')?.shadowRoot?.textContent || ''`),
    'in-tab status overlay',
  );
  if (!/look at me/i.test(overlayText)) throw new Error(`Unexpected overlay content: ${overlayText}`);
  if (activeState.fullscreenStatus !== 'ACTIVE') {
    throw new Error(`Chrome window did not enter fullscreen: ${activeState.fullscreenStatus}`);
  }
  await client.send('Target.closeTarget', { targetId: popup.targetId });
  await delay(1_000);

  popup = await openPopup();
  const restored = await evaluate(client, workerSession, 'chrome.storage.local.get("look-at-me.session")');
  if (restored?.['look-at-me.session']?.sessionId !== sessionId || restored?.['look-at-me.session']?.status !== 'PROCTORING_ACTIVE') {
    throw new Error(`Popup reopen lost the active session: ${JSON.stringify(restored)}`);
  }
  const popupCameraVisible = await waitFor(
    () => evaluate(client, popup.sessionId, `document.querySelector('.camera-preview img')?.src?.startsWith('data:image/png;base64,') || false`),
    'popup live camera preview',
  );

  const contexts = await evaluate(client, workerSession, 'chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]})');
  if (!contexts?.length) throw new Error('Offscreen document is not active after popup reopen.');

  await delay(2_200);
  const { targetId: distractorTargetId } = await client.send('Target.createTarget', {
    url: `http://127.0.0.1:${address.port}/other`,
  });
  await client.send('Target.activateTarget', { targetId: distractorTargetId });
  await waitFor(async () => {
    const stored = await evaluate(client, workerSession, 'chrome.storage.local.get("look-at-me.session")');
    return stored?.['look-at-me.session']?.eventCount > activeState.eventCount ? stored['look-at-me.session'] : null;
  }, 'browser event persistence');
  await client.send('Target.activateTarget', { targetId: pageTargetId });
  await delay(2_200);

  popup = await openPopup();
  await clickPrimary(client, popup.sessionId);
  await delay(150);
  await clickPrimary(client, popup.sessionId);
  const stopped = await waitFor(async () => {
    const stored = await evaluate(client, workerSession, 'chrome.storage.local.get("look-at-me.session")');
    const current = stored?.['look-at-me.session'];
    if (current?.status === 'PROCTORING_ERROR') throw new Error(current.error || current.proctoringStatus);
    return current?.status === 'PROCTORING_COMPLETED' ? current : null;
  }, 'completed proctoring session', 30_000);
  if (stopped?.status !== 'PROCTORING_COMPLETED') {
    throw new Error(`Stop did not complete the session: ${JSON.stringify(stopped)}`);
  }

  const screenshotsDirectory = join(evidenceRoot, 'screenshots');
  const screenshots = (await readdir(screenshotsDirectory)).filter((name) => /^image\d+\.png$/.test(name));
  const databasePath = join(evidenceRoot, 'violations.db');
  const database = await stat(databasePath);
  if (!screenshots.length) throw new Error('No PNG violation screenshot was written to disk.');
  const firstScreenshot = await readFile(join(screenshotsDirectory, screenshots[0]));
  if (!firstScreenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('The saved violation screenshot is not a PNG file.');
  }
  if (database.size < 100) throw new Error('SQLite database was not written.');

  console.log(JSON.stringify({
    extensionId,
    sessionId,
    activeStatus: activeState.status,
    cameraStatus: activeState.cameraStatus,
    aiStatus: activeState.aiStatus,
    faceStatus: activeState.faceStatus,
    localAgentState: activeState.localAgentState,
    overlayVisible: /look at me/i.test(overlayText),
    popupCameraVisible,
    fullscreenStatus: activeState.fullscreenStatus,
    popupReopenPreservedSession: true,
    nativeConnected: activeState.localAgentState === 'active',
    stoppedStatus: stopped.status,
    storageStatus: stopped.storageStatus,
    screenshotsOnDisk: screenshots.length,
    screenshotsDirectory,
    sqlitePath: databasePath,
  }, null, 2));
} catch (error) {
  if (chromeDiagnostics.trim()) console.error(chromeDiagnostics.trim());
  throw error;
} finally {
  try {
    if (client) await client.send('Browser.close');
  } catch {
    chrome.kill();
  }
  await Promise.race([chromeExited, delay(5_000)]);
  client?.close();
  server.close();
  if (basename(profileDir).startsWith('look-at-me-chrome-')
      && resolve(profileDir).startsWith(resolve(tmpdir()))) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rm(profileDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 7) throw error;
        await delay(300);
      }
    }
  }
}
