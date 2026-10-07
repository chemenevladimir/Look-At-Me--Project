# Look At Me!

Look At Me! is a local, explainable AI-proctoring prototype for browser-based assessment. It records observable signals, calculates a transparent Activity Score, and leaves the final decision to a teacher. A signal is never presented as proof that a student cheated.

## Current verified scope

- React, TypeScript, Vite, and Chrome Extension Manifest V3 foundation.
- A small toolbar popup with Start, confirmed Stop, timer, score, event count, camera/face/AI status, and restored session state. The sample quiz was removed from the extension UI.
- Unified event model and event engine with per-type policy, cooldown, duration, confidence, repetition, and score breakdown.
- `chrome.storage.local` persistence for the canonical extension session and events; the earlier IndexedDB module is retained for later evidence/dashboard migration.
- Local MediaPipe Face Landmarker model and WASM assets; webcam frames are not uploaded.
- Face presence, sustained absence, and sustained multiple-face state handling.
- Calibrated approximate head direction and iris-based approximate gaze direction.
- Temporal smoothing, minimum duration, recovery grace period, cooldown, and non-overlapping inference.
- Real local YOLOv8n/ONNX phone detection for the COCO `cell phone` class, with WebGPU and WASM execution paths.
- Letterboxed 640 × 640 RGB preprocessing, confidence filtering, NMS, and source-pixel bounding boxes preserved in event metadata.
- Immediate phone events: the first analyzed YOLO frame at or above 50% confidence creates `PHONE_DETECTED`; the continuous episode is deduplicated.
- Ascending Activity Score from 0 to 200. Higher values mean more detected suspicious activity and require human review.
- A head/gaze episode starts scoring after one second at +4; recurrence and each full additional second add +1 while the same timeline event is updated.
- Browser-page focus, visibility, fullscreen, clipboard, and context-menu signals while a session is active.
- Manifest V3 service-worker routing for the canonical session lifecycle, tab activation, Chrome window focus, content-script events, offscreen CV events, and popup status updates.
- A pointer-transparent Shadow DOM overlay inside the monitored HTTP(S) tab. No test site, localhost page, new tab, or separate proctoring window is opened.
- Camera, MediaPipe, and YOLO run in an extension offscreen document and continue independently after the toolbar popup closes.
- Google Forms finalization requires a fresh submit intent plus a confirmed `/formResponse` completion state for the active session.
- Windows local security observer for Ctrl+C/V, Alt+Tab, Windows key, Print Screen, and foreground-process changes through Native Messaging.
- Screenshot-only violation evidence: confirmed CV violations save a real camera frame, while browser/system violations save the visible Chrome tab.
- A simple local SQLite index links violation time and type to sequential PNG names such as `image001.png`. No test video is recorded.

Blocks 4 and 5 remain verified complete. Live head/gaze episodes, duration scoring, physical-phone detection, confidence, and immediate `PHONE_DETECTED` were exercised on the current Windows setup. The installed Chrome-to-Native-Messaging-to-Python route, popup close/reopen persistence, fullscreen entry, real camera/CV state, and physical PNG/SQLite evidence were exercised on the latest `dist`. A live Google Forms completion check is still open, so Block 6 remains `[~]` in the roadmap.

## Commands

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

The scripts call their Node entrypoints directly so they work from a Windows path containing Cyrillic characters.

## Load the extension

1. Run `pnpm build`.
2. Open `chrome://extensions` in Chrome.
3. Enable Developer mode.
4. Select **Load unpacked** and choose the generated `dist` directory.
5. Open an ordinary `http://` or `https://` page and click the Look At Me! action. A small extension popup appears.
6. Select **Start Proctoring**. The popup may then be closed; monitoring continues in the selected tab and its Look At Me! overlay remains visible.
7. Open the popup again to read the same session score/status or press **Stop Proctoring** twice to confirm a manual stop.

The extension requests camera access only after **Start Proctoring** is pressed. If access is denied, check Chrome camera settings and Windows camera privacy settings before retrying. Chrome internal pages (`chrome://...`), the Chrome Web Store, and other protected browser surfaces cannot host the content script.

## Install the Windows security agent

Native Messaging registration needs the concrete 32-character ID assigned by Chrome after the unpacked extension is loaded.

1. Install Python 3.10 or newer.
2. Copy the extension ID from `chrome://extensions`.
3. Register the current-user native host. Pass the absolute Python path when Python is not available in `PATH`:

   ```powershell
   .\native_host\install_native_host.ps1 -ExtensionId <32-character-extension-id> -PythonPath <absolute-path-to-python.exe>
   ```

4. Reload the unpacked extension and start monitoring. The Security Monitoring panel must change the local-agent state from `connecting` to `ready` and then `active`.

The installer copies the host and `keyboard==0.13.5` into `%LOCALAPPDATA%\LookAtMe\native-host` and does not alter global Python packages. The production build places the installer payload under `dist/native-host/`; rebuilding `dist` no longer deletes the registered host. Registration writes only the current-user `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.look_at_me.security` key. Remove it with `uninstall_native_host.ps1`. See `docs/SECURITY_AGENT.md` for the protocol, tests, supported signals, and limitations.

## Local violation evidence

The helper creates this layout automatically when proctoring starts:

```text
Documents/
└── LookAtMeViolations/
    ├── violations.db
    └── screenshots/
        ├── image001.png
        ├── image002.png
        └── ...
```

`violations.db` contains one `violations` table. Every saved row includes the exact UTC violation time, event type, and matching screenshot filename, plus event/session IDs used to avoid duplicates. The extension does not create WebM files, session JSON exports, or per-session file trees. See `docs/LOCAL_EVIDENCE.md` for the schema and verification commands.

## Models and privacy

MediaPipe Face Landmarker runs locally from `public/models/face_landmarker.task` through local WASM files in `public/mediapipe/wasm`. It outputs 478 normalized landmarks for each detected face. Look At Me! derives face count, a calibrated approximate head direction, and an iris-position estimate from those landmarks. Displayed confidence is measurement quality combined with temporal support; MediaPipe Face Landmarker does not expose a raw per-face detection score through this result API.

The phone detector runs the bundled `public/models/yolov8n.onnx` through `onnxruntime-web`. Frames and detections stay in the extension. The detector first tries WebGPU and falls back to single-threaded WASM when WebGPU is unavailable or model session creation fails. The bundled YOLO model is distributed under the applicable Ultralytics licensing terms; see `docs/MODELS.md` and `THIRD_PARTY_NOTICES.md` before any deployment outside the open hackathon prototype.

See `docs/ARCHITECTURE.md`, `docs/MODELS.md`, and `docs/DECISIONS.md` for the detailed boundaries and extension-to-agent connection.

## Current limitations

- A live Google Forms submit check remains open; unit tests cover the confirmation rules, but do not replace a real form submission.
- Native Messaging registration is local to the Windows user and exact Chrome extension ID. Reinstall the host if the unpacked extension receives a different ID or is moved to another package/profile.
- Head/gaze and phone behavior is verified on the current setup; broader multi-user lighting, glasses, camera-angle, phone-distance and occlusion validation is still desirable.
- Approximate gaze is not eye tracking and cannot identify an exact point on screen.
- Browser and local-agent monitoring cannot guarantee complete OS control, intercept the Windows secure desktop, or detect a second physical device outside the camera view.
- The agent observes protected shortcuts and foreground-process changes; it does not log ordinary typed text and does not block shortcuts.
- Supabase/cloud synchronization is not configured. Runtime session/events stay in extension storage, while confirmed violation evidence is written only to `Documents\LookAtMeViolations`.
- Saved screenshot preview/deletion, appeals, teacher dashboard, cloud storage, and Demo Mode remain later roadmap work.
