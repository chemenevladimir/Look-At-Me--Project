# Look At Me! Architecture

## Product boundary

Look At Me! collects explainable observations for human review. The Activity Score is a weighted summary of recorded activity, not a probability of cheating. Normal face presence and system/model availability events have zero score impact.

## Current flow (Blocks 1–6)

```text
Temporary toolbar popup
  ├─ Start / confirmed Finish Test
  ├─ read-only session status
  └─ Open local evidence page
                │ chrome.runtime messages
                ▼
MV3 service worker (single session authority)
  ├─ chrome.storage.local session + event persistence
  ├─ tab/window observations
  ├─ unified Event Engine + Activity Score
  ├─ Native Messaging port ──> Python security agent
  │                              └─ SQLite + PNG evidence writer
  └─ session commands
        ├─> current-tab content script
        │     ├─ Shadow DOM status overlay
        │     ├─ page-level browser observations
        │     └─ confirmed Google Forms completion
        └─> extension offscreen document
              └─ persistent camera stream
                   ├─ MediaPipe Face Landmarker
                   │    ├─ face count / landmarks
                   │    ├─ neutral-pose calibration
                   │    ├─ approximate head direction
                   │    └─ iris-based approximate gaze
                   └─ YOLOv8n / ONNX Runtime Web
                        ├─ COCO cell phone class score
                        ├─ bounding-box conversion + NMS
                        └─ immediate qualifying-frame event
```

The popup is disposable UI. Closing it only disconnects its status port; it does not send a stop command. The service worker persists the canonical session state and event list, while the offscreen document owns the camera tracks and real CV inference. This keeps camera and inference independent from popup mounting and from same-tab page navigation. The bundled `evidence.html` page is a separate local review surface: it reads and deletes SQLite evidence through validated service-worker messages and never owns the session lifecycle.

The Face Landmarker model, YOLOv8n ONNX model, and their WASM runtimes are copied into the extension bundle. Frames are passed directly from the offscreen document's local `HTMLVideoElement` to both local pipelines and are not uploaded. A single PNG is persisted only after the Event Engine confirms a scored violation; continuous video is not recorded.

## Event Engine

Every recorded event uses the same shape:

```text
id, type, timestamp, duration, confidence, severity,
scoreImpact, explanation, source, optional metadata
```

The engine owns per-type cooldown policy and score calculation. Activity Score starts at 0, adds positive impacts, and is clamped to 0–200; a higher number means more detected suspicious activity. Most event types retain confidence, duration, and repetition weighting. `HEAD_TURN` and `LOOKING_AWAY` use the exact episode formula `4 + recurrenceIndex + full additional seconds after the first`. The UI exposes every positive impact grouped by event type.

## Head and gaze pipeline

1. MediaPipe returns 478 normalized landmarks for each face.
2. A quality score is derived from face size, stable facial geometry, and agreement between both irises.
3. The first stable single-face samples calibrate a neutral nose, head roll, and iris position.
4. Exponential smoothing reduces frame-to-frame jitter.
5. Direction thresholds classify only approximate `left`, `right`, `up`, `down`, or `normal` states, reported from the student's perspective in the mirrored selfie preview.
6. A temporal tracker requires one second of sustained observation and emits one event per episode. Its timestamp is the measured episode start, not the later threshold-crossing frame. The first analyzed `normal` state ends the episode; any later deviation must pass the one-second threshold again and receives a recurrence increment.
7. While the deviation continues, the Event Engine updates that event's duration, end time and score. Finalization flushes the active episode once more before camera shutdown.

Gaze deviation is suppressed while a head turn is active so the same movement is not double-counted as both HEAD_TURN and LOOKING_AWAY.

No event is created for a 200–300 ms glance. If iris landmarks are unavailable, gaze is reported as unavailable and no LOOKING_AWAY event is generated.

## Phone pipeline

1. YOLOv8n is loaded from `models/yolov8n.onnx`; session creation first requests WebGPU with WASM available as fallback and then retries with WASM alone if needed.
2. A sampled webcam frame is letterboxed to 640 × 640 without changing aspect ratio, converted from canvas RGBA to normalized RGB CHW float32, and passed as `[1, 3, 640, 640]`.
3. The raw `[1, 84, 8400]` output is read directly. COCO class index 67 (`cell phone`) is filtered at 0.50 confidence, boxes are mapped back to camera coordinates, and overlapping boxes are removed by IoU NMS at 0.45.
4. The first current-frame detection at or above 0.50 immediately records `PHONE_DETECTED`; 750 ms recovery grace and a 1 second cooldown prevent duplicate frame-by-frame events inside a continuous episode.
5. The event explanation says “possible smartphone” and requires human review. The class score, bounding box, and sample count are preserved separately in metadata.

Phone inference is throttled independently from face inference and does not overlap with itself. The first implementation runs canvas preprocessing on the UI thread; moving preprocessing and WASM-only inference into a worker remains a performance option after profiling on the target laptop.

## Browser and local-security flow

Block 6 uses a Python local security agent connected through Chrome Native Messaging:

```text
Extension service worker
  ⇄ length-prefixed JSON over Chrome Native Messaging
Python security agent
  ├─ keyboard hook for Ctrl+C/V, Alt+Tab, Win and Print Screen
  ├─ foreground-process observation through user32/kernel32
  ├─ explicit capability/error status
  └─ no ordinary-key logging and no blocking claim
```

The popup opens a runtime port only while it is visible so status changes can be rendered immediately. The port is not a session owner. The service worker validates content-script senders and allow-lists event types before recording them. It owns the `connectNative()` port, because Chrome does not expose Native Messaging to content scripts. Browser observations enter the Event Engine with `source: browser`; agent observations use `source: system`.

Native Messaging is preferred over an unauthenticated localhost port. Messages are UTF-8 JSON preceded by a native-endian 32-bit byte length. On Windows, stdin and stdout are switched to binary mode so newline conversion cannot corrupt the protocol. Heartbeats expose disconnects without inventing events.

Every unified Event Engine event is upserted into local SQLite with session ID, UTC start/end, duration, confidence, severity, score impact, source and explanation. Confirmed violations additionally use `chrome.tabs.captureVisibleTab()` and the current offscreen webcam frame to compose `imageNNN.png`. Normal finalization creates a separate `finalNNN.png` with page, camera, score, time and a FINAL SCREENSHOT banner before camera shutdown. Session summary and screenshot names are committed before the helper stops. If capture or storage fails, the session enters ERROR instead of claiming success.

The Native Messaging installer discovers the extension ID associated with the selected `dist` path (or accepts any valid ID), installs the bundled Python wheel without network access, and copies the host, dependency directory, launcher and generated manifest to `%LOCALAPPDATA%\LookAtMe\native-host` before registering it under HKCU. The registry never points into `dist`, because Vite replaces that directory. Evidence uses the Windows Documents Known Folder and is independent of a particular username or checkout path.

The Chrome toolbar action uses the normal `action.default_popup` entry point. Starting a session binds it to the current ordinary HTTP(S) tab and injects no new site, tab, or application window. The content script renders a pointer-transparent Shadow DOM overlay on that page. The offscreen document, service worker, and local agent continue after the toolbar popup loses focus.

Static content scripts cover normal navigation. At session start the service worker also probes the selected tab and uses `chrome.scripting.executeScript()` only when no content script is present, which covers a page that was already open when the unpacked extension was loaded or reloaded. This is the reason for the `scripting` permission. Content-script matches remain limited to HTTP(S). The manifest uses `<all_urls>` host permission because Chrome requires that literal permission for `captureVisibleTab()` across ordinary sites; protected Chrome surfaces remain unavailable.

Google Forms completion requires all of the following: an active session in the monitored tab, a fresh submit intent for the same session, a `docs.google.com/forms/.../formResponse` URL, and response-confirmation UI or the absence of question elements in a confirmation container. A random button, blur, refresh, tab close, or popup close cannot finalize the session.

The agent observes but does not suppress shortcuts. It omits foreground-window titles by default and sends only process basenames. Shortcuts reserved by Windows, the secure desktop, elevated applications, and another physical device remain outside the guarantee.

## Component boundaries

- `src/vision`: model loading, facial geometry, YOLO preprocessing/postprocessing, calibration, smoothing, and temporal state.
- `src/background/serviceWorker.ts`: canonical session lifecycle, storage, browser events, Native Messaging, Event Engine, and routing.
- `src/popup`: temporary React popup that reads state and sends explicit start/stop commands.
- `src/evidenceViewer`: readable local SQLite metadata table with refresh and confirmed row-plus-PNG deletion.
- `src/content`: current-page overlay, page-level monitoring, and Google Forms confirmation detection.
- `src/offscreen`: persistent extension document that hosts the camera and CV engine.
- `src/proctoring`: camera, MediaPipe, YOLO, temporal events, and status reporting independent from popup lifetime.
- `src/browser`: security-event normalization and retained compatibility helpers.
- `src/lib/eventEngine.ts`: unified events and score calculation.
- `src/lib/storage.ts`: retained IndexedDB storage for the earlier dashboard and future evidence migration; the active extension session currently uses `chrome.storage.local`.
- `src/components`: retained timeline/dashboard components for later roadmap blocks; they are not an extension entry point in the production bundle.
- `local_security_agent.py`: real Native Messaging host, protected-shortcut classifier, and Windows foreground-process observer.
- `local_evidence_store.py`: atomic PNG writer and simple SQLite violation index under the user's Documents folder.
- `native_host`: current-user install/uninstall scripts and host-manifest template.
