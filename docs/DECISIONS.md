# Architecture Decisions

## ADR-001: Bundle MediaPipe assets locally

**Decision:** Ship the Face Landmarker model and required WASM files inside the extension bundle.

**Reason:** A hackathon demonstration must survive unreliable internet access, and local assets make the privacy boundary visible. The compiled extension is larger, but inference startup no longer depends on a CDN.

## ADR-002: Calibrate and temporally filter head/gaze signals

**Decision:** Establish a per-session neutral baseline, smooth measurements, and use a minimum duration with explicit episode boundaries before emitting events.

**Reason:** Raw normalized landmarks vary by camera position and face geometry. A fixed single-frame threshold creates avoidable false positives.

## ADR-003: Use YOLOv8n rather than COCO-SSD for phone detection

**Decision:** Remove COCO-SSD and run a locally exported YOLOv8n COCO checkpoint through ONNX Runtime Web. Only class 67 (`cell phone`) enters the phone-event pipeline.

**Reason:** COCO-SSD is a real detector, but it violates the mandatory hackathon stack. YOLOv8n satisfies the required stack and exposes the bounding box and native class score needed for explainable evidence.

## ADR-004: Use Native Messaging for the local security agent

**Decision:** Connect the Manifest V3 service worker to a Python agent through Chrome Native Messaging in Block 6.

**Reason:** Native Messaging provides a defined extension-to-local-process boundary and avoids exposing an unauthenticated localhost service. The agent must report capability limitations and errors and cannot claim complete OS control.

## ADR-011: Keep the session outside the toolbar popup

**Decision:** Use a normal `action.default_popup` only for Start, confirmed Stop, and current status. Keep canonical state and the Event Engine in the Manifest V3 service worker, persist them in `chrome.storage.local`, run camera/CV in an extension offscreen document, and render the status overlay from a content script in the monitored tab.

**Reason:** A toolbar popup is destroyed when it loses focus. Making it a disposable client prevents popup closure from stopping the camera or session, avoids opening a separate application window, and lets monitoring survive same-tab navigation. An explicit confirmed stop or verified Google Forms completion owns finalization.

## ADR-005: Bundle ONNX Runtime Web assets and use WebGPU with WASM fallback

**Decision:** Import `onnxruntime-web/webgpu`, request WebGPU first, retry with WASM when necessary, and ship all required ORT `.mjs`/`.wasm` binaries inside the extension.

**Reason:** YOLOv8n benefits from GPU execution on supported Chrome installations, while the WASM path keeps the demo operational on machines without usable WebGPU. Local runtime and model files remove network startup dependencies and keep camera frames inside the browser.

## ADR-006: Use a conservative phone threshold with immediate event creation

**Decision:** Use a 0.50 model-confidence threshold and IoU 0.45 NMS. Create `PHONE_DETECTED` on the first qualifying analyzed frame, then deduplicate the continuous episode with 750 ms recovery grace and a 1 second cooldown.

**Reason:** The product requirement treats even a brief confident phone appearance as reviewable activity. The confidence threshold and NMS still reject weaker and overlapping candidates, while per-episode state prevents event spam.

## ADR-007: Use an ascending 0–200 Activity Score and mutable direction episodes

**Decision:** Start Activity Score at 0, add positive event impacts, and clamp the displayed total to 200. `HEAD_TURN` and `LOOKING_AWAY` begin after one second at 4 points. Their event impact is `4 + recurrenceIndex + floor(durationSeconds) - 1`, with the duration term clamped at zero. A continuing episode updates its existing event by ID, and the first analyzed normal state closes it.

**Reason:** A higher value now directly communicates more detected suspicious activity. Updating one event preserves the actual episode boundary while making prolonged deviations progressively more visible. The score remains an explainable review aid, not a cheating probability.

## ADR-008: Route all extension security signals through the service worker

**Decision:** Content scripts send a small allow-listed payload to the Manifest V3 service worker; tabs/windows API observations originate there; the service worker records validated events and broadcasts persisted state. The popup uses a runtime port only while it is visible.

**Reason:** The previous content script received acknowledgements but its events never reached the React Event Engine. Central routing removes that split state, covers Chrome-internal tab changes through `tabs.onActivated`, and provides one validation boundary before score calculation.

## ADR-009: Observe OS shortcuts without keylogging or blocking

**Decision:** The Python agent uses `keyboard` only to recognize Ctrl+C/V, Alt+Tab, Windows key, and Print Screen. It discards ordinary keys, does not suppress input, and polls the Win32 foreground window with titles disabled by default.

**Reason:** The hackathon requires a real OS component, while explainable proctoring needs proportional evidence rather than a brittle lock-down claim. Suppression can fail across privilege boundaries and Windows-reserved surfaces. Process-level observations provide useful review context with a smaller privacy footprint.

## ADR-010: Use Native Messaging instead of a localhost server

**Decision:** The service worker owns a long-lived `connectNative('com.look_at_me.security')` port with handshake, capabilities, heartbeat, start/stop, event, error, and shutdown messages.

**Reason:** Chrome registers the allowed extension origin and transports framed messages over stdio. This avoids exposing an unauthenticated network port and keeps the host unavailable to unrelated web pages.

## ADR-012: Install the native host outside the build directory

**Decision:** Copy the packaged Python host, pinned dependency, launcher and Native Messaging manifest to `%LOCALAPPDATA%\LookAtMe\native-host`, and point the current-user registry entry at that stable manifest.

**Reason:** Vite intentionally replaces `dist` on every production build. Registering a manifest under `dist/native-host/generated` made a successful rebuild silently invalidate Chrome's Native Messaging registration. A stable per-user installation keeps build output disposable while preserving the registered runtime.

## ADR-013: Store screenshot-only evidence in Documents

**Decision:** Do not record full-session or short-event video. For every confirmed scored violation, compose one real PNG containing the visible test page and a labeled current-camera inset, save it to `Documents\LookAtMeViolations\screenshots\imageNNN.png`, and insert the violation time, type, and image filename into `Documents\LookAtMeViolations\violations.db`. Keep the Event Engine as the only event source and use the Native Messaging host for file/SQLite access.

**Reason:** The owner explicitly removed video recording and the earlier per-session JSON/WebM layout. Chrome extensions cannot write arbitrary local files or SQLite directly. A small native helper provides durable local evidence without cloud services, while one screenshot per confirmed event limits storage and preserves an explainable event-to-image relation.
