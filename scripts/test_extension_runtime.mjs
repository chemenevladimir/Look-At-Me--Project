import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
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

class PipeCdpClient {
  constructor(process) {
    this.writer = process.stdio[3];
    this.reader = process.stdio[4];
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.opened = Promise.resolve();
    this.reader.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (true) {
        const boundary = this.buffer.indexOf(0);
        if (boundary < 0) break;
        const payload = this.buffer.subarray(0, boundary).toString('utf8');
        this.buffer = this.buffer.subarray(boundary + 1);
        if (!payload) continue;
        const message = JSON.parse(payload);
        if (!message.id) continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result);
      }
    });
  }

  async send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const response = new Promise((resolveResponse, rejectResponse) => {
      this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse });
    });
    this.writer.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    return response;
  }

  close() {
    this.writer.end();
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
const exerciseHelperRecovery = process.env.LOOK_AT_ME_TEST_HELPER_RECOVERY === '1';
const helperRecoveryOnly = process.env.LOOK_AT_ME_HELPER_RECOVERY_ONLY === '1';
const nativeRegistryKey = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.look_at_me.security';
const originalNativeManifest = process.env.LOOK_AT_ME_NATIVE_MANIFEST || '';
const setNativeManifest = (manifestPath) => {
  const result = spawnSync('reg.exe', ['add', nativeRegistryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`Could not update Native Messaging registry: ${result.stderr || result.stdout}`);
};
if (exerciseHelperRecovery) {
  if (!originalNativeManifest) throw new Error('LOOK_AT_ME_NATIVE_MANIFEST is required for helper recovery testing.');
  setNativeManifest(join(profileDir, 'missing-native-host.json'));
}
const chromeArguments = [
  '--enable-extensions',
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  `--user-data-dir=${profileDir}`,
  '--remote-debugging-pipe',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--enable-unsafe-extension-debugging',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=1280,900',
  'about:blank',
];
if (process.env.LOOK_AT_ME_REAL_CAMERA !== '1') chromeArguments.push('--use-fake-device-for-media-stream');
if (process.env.LOOK_AT_ME_DISABLE_SANDBOX === '1') chromeArguments.push('--no-sandbox');
if (process.env.LOOK_AT_ME_HEADFUL !== '1') chromeArguments.unshift('--headless=new');
const chrome = spawn(chromePath, chromeArguments, {
  stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
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
  client = new PipeCdpClient(chrome);
  await client.opened;
  await waitFor(() => client.send('Browser.getVersion'), 'Chrome DevTools pipe');
  const loadedExtension = await client.send('Extensions.loadUnpacked', { path: extensionDir });
  if (!loadedExtension?.id) throw new Error('Chrome did not return an ID for the unpacked extension.');
  console.error(`[runtime-smoke] unpacked extension loaded: ${loadedExtension.id}`);
  const extensionInventory = await client.send('Extensions.getExtensions');
  console.error(`[runtime-smoke] extensions: ${JSON.stringify(extensionInventory)}`);
  if (!extensionInventory?.extensions?.some((item) => item.id === loadedExtension.id && item.enabled)) {
    throw new Error('Chrome rejected the unpacked extension. Set LOOK_AT_ME_CHROME to an official Chrome for Testing executable.');
  }
  await client.send('Target.setDiscoverTargets', { discover: true });
  const { targetId: warmExtensionTargetId } = await client.send('Target.createTarget', {
    url: `chrome-extension://${loadedExtension.id}/evidence.html`,
  });

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
    let extensionDiagnostics = '';
    try {
      const warmSession = await attach(client, warmExtensionTargetId);
      extensionDiagnostics = await evaluate(client, warmSession, 'document.body?.innerText || document.documentElement?.outerHTML || ""');
    } catch (diagnosticError) {
      extensionDiagnostics = `unavailable: ${diagnosticError.message}`;
    }
    throw new Error(`${error.message}; targets=${JSON.stringify(targetInfos.map(({type,url,title}) => ({type,url,title})))}; extensionPage=${JSON.stringify(extensionDiagnostics)}`);
  }
  const extensionId = new URL(worker.url).hostname;
  if (!workerSession) throw new Error('Look At Me! worker had no CDP session.');
  const evaluateWorker = async (expression) => {
    try {
      return await evaluate(client, workerSession, expression);
    } catch (error) {
      if (!/No SW|session|target/i.test(error.message)) throw error;
      const wake = await client.send('Target.createTarget', { url: `chrome-extension://${extensionId}/evidence.html` });
      const wakeSession = await attach(client, wake.targetId);
      await waitFor(() => evaluate(client, wakeSession, 'document.readyState === "complete"'), 'extension context fallback');
      try {
        return await evaluate(client, wakeSession, expression);
      } finally {
        await client.send('Target.closeTarget', { targetId: wake.targetId });
      }
    }
  };
  let helperRecoveryVerified = false;
  if (exerciseHelperRecovery) {
    const warmSession = await attach(client, warmExtensionTargetId);
    await waitFor(async () => {
      const body = await evaluate(client, warmSession, 'document.body.innerText');
      return /Helper:\s*Offline|Helper недоступен/i.test(body) ? true : null;
    }, 'explicit helper offline UI', 15_000);
    setNativeManifest(originalNativeManifest);
    await evaluate(client, warmSession, `document.querySelector('button.refresh')?.click()`);
    await waitFor(async () => {
      const body = await evaluate(client, warmSession, 'document.body.innerText');
      return /Helper:\s*Online/i.test(body) ? true : null;
    }, 'automatic helper recovery UI', 15_000);
    helperRecoveryVerified = true;
  }
  await client.send('Target.closeTarget', { targetId: warmExtensionTargetId });
  if (helperRecoveryOnly && helperRecoveryVerified) {
    console.log(JSON.stringify({ extensionId, helperOfflineUiVerified: true, helperRecoveryVerified: true }, null, 2));
    throw new Error('__LOOK_AT_ME_HELPER_RECOVERY_ONLY_PASSED__');
  }
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
  const openPopupPage = async () => {
    const { targetId } = await client.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/popup.html`,
      background: true,
    });
    const sessionId = await attach(client, targetId);
    await waitFor(() => evaluate(client, sessionId, 'document.readyState === "complete"'), 'popup page load');
    return { targetId, sessionId };
  };

  let popup = await openPopup();
  console.error('[runtime-smoke] action popup opened');
  await waitFor(async () => {
    const label = await evaluate(client, popup.sessionId, 'document.querySelector("button.primary-action")?.textContent || ""');
    return /Начать тест/i.test(label) ? true : null;
  }, 'popup ready state', 15_000);
  await clickPrimary(client, popup.sessionId);
  console.error('[runtime-smoke] start clicked');

  let activeState;
  try {
    activeState = await waitFor(async () => {
      const stored = await evaluateWorker('chrome.storage.local.get("look-at-me.session")');
      const current = stored?.['look-at-me.session'];
      if (current?.status === 'PROCTORING_ERROR') {
        throw new Error(current.error || current.proctoringStatus || 'Unknown runtime error');
      }
      return current?.status === 'PROCTORING_ACTIVE' ? current : null;
    }, 'active proctoring session', 60_000);
  } catch (error) {
    const stored = await evaluateWorker('chrome.storage.local.get("look-at-me.session")');
    let popupText = 'popup target closed';
    try { popupText = await evaluate(client, popup.sessionId, 'document.body.innerText'); } catch { /* fullscreen closes the action popup */ }
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
  try { await client.send('Target.closeTarget', { targetId: popup.targetId }); } catch { /* fullscreen may already close the popup */ }
  await delay(1_000);

  popup = await openPopupPage();
  await client.send('Target.activateTarget', { targetId: pageTargetId });
  const restored = await evaluateWorker('chrome.storage.local.get("look-at-me.session")');
  if (restored?.['look-at-me.session']?.sessionId !== sessionId || restored?.['look-at-me.session']?.status !== 'PROCTORING_ACTIVE') {
    throw new Error(`Popup reopen lost the active session: ${JSON.stringify(restored)}`);
  }
  const popupCameraVisible = await waitFor(
    () => evaluate(client, popup.sessionId, `document.querySelector('.camera-preview img')?.src?.startsWith('data:image/png;base64,') || false`),
    'popup live camera preview',
  );

  const contexts = await evaluateWorker('chrome.runtime.getContexts({contextTypes:["OFFSCREEN_DOCUMENT"]})');
  if (!contexts?.length) throw new Error('Offscreen document is not active after popup reopen.');
  await client.send('Target.closeTarget', { targetId: popup.targetId });
  await client.send('Target.activateTarget', { targetId: pageTargetId });

  await delay(2_200);
  const { targetId: distractorTargetId } = await client.send('Target.createTarget', {
    url: `http://127.0.0.1:${address.port}/other`,
  });
  await client.send('Target.activateTarget', { targetId: distractorTargetId });
  await waitFor(async () => {
    const stored = await evaluateWorker('chrome.storage.local.get("look-at-me.session")');
    return stored?.['look-at-me.session']?.eventCount > activeState.eventCount ? stored['look-at-me.session'] : null;
  }, 'browser event persistence');
  await client.send('Target.activateTarget', { targetId: pageTargetId });
  await delay(2_200);

  await client.send('Target.activateTarget', { targetId: pageTargetId });
  const fullscreenEventsBeforeFinish = await evaluateWorker(
    `chrome.storage.local.get("look-at-me.events").then((value) => (value["look-at-me.events"] || []).filter((event) => event.type === "FULLSCREEN_EXIT").length)`);
  const overlayFinishVisible = await evaluate(client, pageSession, `(() => {
    const button = document.getElementById('look-at-me-proctoring-overlay')?.shadowRoot?.querySelector('button.finish');
    return Boolean(button && /Завершить тест/i.test(button.textContent || ''));
  })()`);
  if (!overlayFinishVisible) throw new Error('The existing in-page overlay has no Finish Test action.');
  console.error('[runtime-smoke] overlay finish action ready');
  await client.send('Page.enable', {}, pageSession);
  const clickFinish = client.send('Runtime.evaluate', {
    expression: `document.getElementById('look-at-me-proctoring-overlay').shadowRoot.querySelector('button.finish').click()`,
    returnByValue: true,
  }, pageSession);
  await delay(150);
  await client.send('Page.handleJavaScriptDialog', { accept: true }, pageSession);
  await clickFinish;
  console.error('[runtime-smoke] overlay finish clicked');
  const stopped = await waitFor(async () => {
    const stored = await evaluateWorker('chrome.storage.local.get("look-at-me.session")');
    const current = stored?.['look-at-me.session'];
    if (current?.status === 'PROCTORING_ERROR') throw new Error(current.error || current.proctoringStatus);
    return current?.status === 'PROCTORING_COMPLETED' ? current : null;
  }, 'completed proctoring session', 30_000);
  console.error('[runtime-smoke] session completed from overlay');
  if (stopped?.status !== 'PROCTORING_COMPLETED') {
    throw new Error(`Stop did not complete the session: ${JSON.stringify(stopped)}`);
  }
  const fullscreenEventsAfterFinish = await evaluateWorker(
    `chrome.storage.local.get("look-at-me.events").then((value) => (value["look-at-me.events"] || []).filter((event) => event.type === "FULLSCREEN_EXIT").length)`);
  if (fullscreenEventsAfterFinish !== fullscreenEventsBeforeFinish) {
    throw new Error('Normal Finish Test flow created a false FULLSCREEN_EXIT event.');
  }

  const screenshotsDirectory = join(evidenceRoot, 'screenshots');
  console.error('[runtime-smoke] verifying local database and PNG files');
  const screenshots = (await readdir(screenshotsDirectory)).filter((name) => /^image\d+\.png$/.test(name));
  const finalScreenshots = (await readdir(screenshotsDirectory)).filter((name) => /^final\d+\.png$/.test(name));
  const databasePath = join(evidenceRoot, 'database.db');
  const database = await stat(databasePath);
  if (!screenshots.length) throw new Error('No PNG violation screenshot was written to disk.');
  if (finalScreenshots.length !== 1 || stopped.finalScreenshotName !== finalScreenshots[0]) {
    throw new Error(`Final screenshot was not saved or indexed: ${JSON.stringify({ finalScreenshots, stopped })}`);
  }
  const finalScreenshot = await readFile(join(screenshotsDirectory, finalScreenshots[0]));
  if (!finalScreenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('The final screenshot is not a PNG file.');
  }
  const firstScreenshot = await readFile(join(screenshotsDirectory, screenshots[0]));
  if (!firstScreenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('The saved violation screenshot is not a PNG file.');
  }
  if (database.size < 100) throw new Error('SQLite database was not written.');

  const { targetId: evidenceTargetId } = await client.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/evidence.html`,
  });
  const evidenceSession = await attach(client, evidenceTargetId);
  console.error('[runtime-smoke] evidence viewer opened');
  await waitFor(
    () => evaluate(client, evidenceSession, 'document.readyState === "complete"'),
    'evidence viewer load',
  );
  const viewerRows = await waitFor(
    () => evaluate(client, evidenceSession, `(() => {
      const rows = [...document.querySelectorAll('tbody tr')];
      return rows.length ? rows.map((row) => ({
        eventId: row.querySelector('button.delete')?.closest('tr')?.key,
        screenshotName: row.querySelector('td:nth-child(4) small')?.textContent,
      })) : null;
    })()`),
    'evidence viewer SQLite rows',
  );
  const firstViewerScreenshot = viewerRows[0]?.screenshotName;
  if (!firstViewerScreenshot || !screenshots.includes(firstViewerScreenshot)) {
    throw new Error(`Evidence viewer did not show a saved screenshot: ${JSON.stringify(viewerRows)}`);
  }
  if (process.env.LOOK_AT_ME_VIEWER_SCREENSHOT) {
    const screenshotPath = resolve(process.env.LOOK_AT_ME_VIEWER_SCREENSHOT);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await client.send('Page.enable', {}, evidenceSession);
    const capturedPage = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, evidenceSession);
    await writeFile(screenshotPath, Buffer.from(capturedPage.data, 'base64'));
  }
  await evaluate(client, evidenceSession, `(() => {
    window.confirm = () => true;
    document.querySelector('button.delete')?.click();
  })()`);
  await waitFor(async () => {
    const names = await evaluate(client, evidenceSession, `[...document.querySelectorAll('tbody tr td:nth-child(4) small')].map((node) => node.textContent)`);
    return !names.includes(firstViewerScreenshot) ? true : null;
  }, 'evidence viewer deletion');
  const screenshotsAfterDelete = (await readdir(screenshotsDirectory)).filter((name) => /^image\d+\.png$/.test(name));
  if (screenshotsAfterDelete.includes(firstViewerScreenshot)) {
    throw new Error(`Evidence viewer removed the row but left ${firstViewerScreenshot} on disk.`);
  }

  console.log(JSON.stringify({
    extensionId,
    sessionId,
    activeStatus: activeState.status,
    cameraStatus: activeState.cameraStatus,
    aiStatus: activeState.aiStatus,
    faceStatus: activeState.faceStatus,
    localAgentStateObserved: activeState.localAgentState,
    overlayVisible: /look at me/i.test(overlayText),
    popupCameraVisible,
    overlayFinishVerified: overlayFinishVisible,
    fullscreenStatus: activeState.fullscreenStatus,
    popupReopenPreservedSession: true,
    nativeStorageVerified: true,
    stoppedStatus: stopped.status,
    storageStatus: stopped.storageStatus,
    screenshotsOnDisk: screenshots.length,
    evidenceViewerRows: viewerRows.length,
    evidenceDeleteVerified: true,
    finalScreenshot: finalScreenshots[0],
    gracefulFullscreenExitVerified: fullscreenEventsAfterFinish === fullscreenEventsBeforeFinish,
    helperRecoveryVerified,
    screenshotsAfterDelete: screenshotsAfterDelete.length,
    screenshotsDirectory,
    sqlitePath: databasePath,
  }, null, 2));
} catch (error) {
  if (error.message === '__LOOK_AT_ME_HELPER_RECOVERY_ONLY_PASSED__') {
    // The shared finally block still closes Chrome, the server, and temporary directories.
  } else {
  if (chromeDiagnostics.trim()) console.error(chromeDiagnostics.trim());
  throw error;
  }
} finally {
  if (exerciseHelperRecovery && originalNativeManifest) {
    try { setNativeManifest(originalNativeManifest); } catch (error) { console.error(error.message); }
  }
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
