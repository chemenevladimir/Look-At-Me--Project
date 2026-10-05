LOOK AT ME!

Development Roadmap

Версия: MVP Hackathon

Главное правило: каждый блок должен быть полностью реализован, собран и протестирован перед переходом к следующему блоку.

---

BLOCK 1. FOUNDATION [~]

Phase 1. Repository and project initialization [x]

- создать структуру проекта;
- настроить package manager;
- настроить TypeScript;
- настроить Vite;
- подготовить Chrome Extension Manifest V3;
- настроить build.

Phase 2. Chrome Extension skeleton [~]

- background/service worker;
- content script;
- extension pages;
- permissions;
- базовая коммуникация между компонентами.

Phase 3. React UI foundation [x]

- базовый дизайн;
- layout;
- navigation;
- reusable components;
- состояние приложения.

Phase 4. Proctoring Session Screen [x]

- экран управления сессией прокторинга;
- timer;
- start/end monitoring;
- proctoring status.

Проверка Phase 4 (2026-10-05):

- [x] sample quiz, questions, answers и связанное UI-состояние удалены;
- [x] production preview показывает только session controls, timer и статусы мониторинга;
- [x] start/finish проверены в production preview с реальной камерой; завершение останавливает stream.

Phase 5. Camera Foundation [~]

- запрос camera permission;
- отображение webcam;
- camera status;
- обработка ошибок;
- корректное освобождение камеры.

---

BLOCK 2. PROCTORING CORE [x]

Phase 6. Event data model [x]

Создать единую модель события:

- id;
- type;
- timestamp;
- duration;
- confidence;
- severity;
- scoreImpact;
- explanation;
- source.

Phase 7. Event Engine [x]

- создание событий;
- обработка событий;
- deduplication;
- cooldown;
- temporal state.

Phase 8. Local Storage [x]

- IndexedDB;
- сохранение событий;
- сохранение proctoring session;
- восстановление состояния.

Phase 9. Activity Score [x]

- возрастающий score 0-200;
- severity;
- confidence;
- duration;
- repeated events;
- score breakdown.

Проверка Phase 9 (2026-10-05):

- [x] положительные `scoreImpact`, старт с 0 и ограничение итогового score на 200;
- [x] legacy negative impacts мигрируют при восстановлении IndexedDB;
- [x] HEAD_TURN / LOOKING_AWAY: `4 + recurrenceIndex + full extra seconds`;
- [x] один непрерывный эпизод обновляет одно событие, новый эпизод повышает recurrenceIndex;
- [x] unit tests проверяют 8 секунд первого эпизода = 11 и второго эпизода = 12.

Phase 10. Proctoring Status [x]

- AI status;
- camera status;
- browser monitoring status;
- current score;
- event counter.

---

BLOCK 3. FACE AI [~]

Phase 11. Real Face Detection [~]

- подключить реальную CV-модель;
- inference;
- face bounding box;
- confidence.

Phase 12. Face State Detection [~]

- FACE_DETECTED;
- FACE_NOT_DETECTED;
- temporal smoothing;
- minimum duration.

Phase 13. Multiple Faces [~]

- обнаружение нескольких лиц;
- MULTIPLE_FACES;
- confidence;
- duration;
- debouncing.

Phase 14. Face Landmarks [~]

- подключить landmarks;
- landmarks processing;
- подготовить данные для head pose/gaze.

Phase 15. Face Performance [~]

- оптимизация FPS;
- frame skipping;
- throttling;
- Web Worker при необходимости.

---

BLOCK 4. HEAD AND GAZE [x]

Phase 16. Head Pose [x]

- определить приблизительное направление головы;
- left/right/up/down;
- confidence.

Phase 17. HEAD_TURN Event [x]

- создать событие;
- duration;
- severity;
- confidence;
- cooldown.

Phase 18. Gaze Estimation [x]

- приблизительная оценка направления взгляда;
- normal/away;
- smoothing.

Phase 19. LOOKING_AWAY Event [x]

- minimum duration;
- threshold;
- confidence;
- score impact.

Phase 20. False Positive Protection [x]

- temporal filtering;
- cooldown;
- ignore short deviations;
- проверка нормального поведения.

Проверка BLOCK 4 (2026-10-05):

- [x] automated: face geometry, temporal threshold and Event Engine episode tests passed;
- [x] live camera: MediaPipe GPU, calibration, head directions and approximate gaze confirmed;
- [x] user verification: HEAD_TURN / LOOKING_AWAY, duration growth, episode reset and recurrence work in the loaded project;
- [x] short deviations remain below the one-second event threshold.

---

BLOCK 5. PHONE AI [x]

Phase 21. Object Detection Architecture [x]

- использовать YOLOv8n, экспортированный в ONNX, с классом COCO `cell phone`;
- использовать ONNX Runtime Web (WebGPU с WASM fallback);
- определить model loading;
- подготовить inference pipeline.

Phase 22. Phone Detection [x]

- реальное обнаружение смартфона;
- bounding box;
- class;
- confidence.

Phase 23. Phone Event [x]

- PHONE_DETECTED;
- minimum confidence;
- немедленное событие на первом уверенном кадре;
- cooldown между отдельными эпизодами.

Phase 24. Phone False Positive Protection [x]

- одно событие на непрерывный эпизод;
- confidence threshold;
- NMS;
- устранение ложных срабатываний.

Phase 25. CV Debug Overlay [x]

- bounding boxes;
- labels;
- confidence;
- debug mode;
- FPS.

Проверка BLOCK 5 (2026-10-04):

- [x] unit: letterbox, обе раскладки YOLO output, confidence filter, NMS, inverse coordinates;
- [x] integration: ONNX Runtime CPU и `onnxruntime-web` WASM дали `cell phone = 0.8970006` на контрольном изображении;
- [x] build: model и локальные ORT assets присутствуют в `dist`, SHA-256 модели совпадает;
- [x] UI smoke: production preview без console errors, карточка Phone Detector и diagnostics отображаются;
- [x] 2026-10-05: `PHONE_DETECTED` unit/integration pipeline создаёт событие на первом qualifying frame без ожидания 1.2 секунды;
- [x] controlled webcam baseline (2026-10-05): camera live/stopped, MediaPipe GPU, 478 landmarks, calibration 100%, YOLOv8n WebGPU ~1.6 FPS;
- [x] controlled positive phone (user verification, 2026-10-05): physical-phone detection, bounding-box overlay, confidence and immediate event confirmed;
- [x] restored IndexedDB timeline contains a real `PHONE_DETECTED` event with model confidence and positive score impact.

---

BLOCK 6. BROWSER SECURITY [~]

Phase 26. Tab Monitoring [x]

- visibility change;
- tab switch;
- TAB_SWITCH.

Phase 27. Window Focus [x]

- blur;
- focus;
- WINDOW_BLUR.

Phase 28. Fullscreen Protection [x]

- fullscreen;
- FULLSCREEN_EXIT;
- warning UI.

Phase 29. Clipboard and Context Menu [x]

- copy;
- paste;
- right click;
- keyboard events.

Phase 30. Browser Event Integration [x]

- объединить browser events с Event Engine;
- confidence;
- severity;
- score impact;
- timeline integration.

Phase 30A. Local Security Agent [x]

- Python agent с `keyboard` и Windows foreground-window API;
- честная матрица поддерживаемых и неподдерживаемых OS-level действий;
- обработка запуска, остановки, прав доступа и ошибок;
- никаких mock-событий в основном режиме.

Phase 30B. Native Messaging Integration [x]

- Chrome Native Messaging host manifest;
- `nativeMessaging` permission;
- length-prefixed JSON protocol;
- heartbeat/capability handshake;
- преобразование agent events в единый Event Engine с `source: system`.

Phase 30C. In-tab MV3 Session Architecture [~]

- обычный `action.default_popup` только для Start / confirmed Stop / status;
- единое состояние сессии в service worker + `chrome.storage.local`;
- offscreen document владеет camera stream, MediaPipe и YOLO независимо от popup;
- content script показывает Shadow DOM overlay внутри текущей HTTP(S)-вкладки;
- закрытие popup не отправляет stop и не уничтожает camera/CV;
- Google Forms завершает сессию только после fresh submit intent и подтверждённого `/formResponse`;
- требуется финальный installed-Chrome close/reopen smoke и live Google Forms submit на последнем `dist`.

Проверка BLOCK 6 (2026-10-05):

- [x] service worker routes allow-listed content-script, tabs, windows and native-agent events;
- [x] React bridge normalizes browser/system payloads before Event Engine;
- [x] browser events and OS events share the unified event schema, score and timeline;
- [x] fullscreen warning and explicit re-entry action added to UI;
- [x] Python unit: length-prefixed UTF-8 protocol and protected-shortcut classifier passed;
- [x] Python integration: ready → ping/pong → start → active → stop → stopped → shutdown passed;
- [x] Windows smoke: `keyboard` global hook start/unhook and foreground process probe passed;
- [x] build packages host, requirements and install/uninstall scripts under `dist/native-host/`;
- [x] native host registered for the installed unpacked extension ID `modeenlenlcffbfmgakibilblmckcngb` under the current-user Chrome registry scope;
- [x] installed Chrome extension established the real Native Messaging process and received `native heartbeat` from the packaged Python host;
- [x] a live monitoring session changed the local agent to `active`; `APP_SWITCH` arrived with `source: system`, while `TAB_SWITCH` and `WINDOW_BLUR` arrived with `source: browser`, and all three updated the unified timeline and Activity Score;
- [x] browser copy observation created `COPY_ATTEMPT`, fullscreen exit and session stop remained visible and recoverable;
- [x] старая dedicated-window схема удалена из production manifest/build; action использует `default_popup`, а `dist` не содержит `index.html`;
- [x] installed Chrome session запустила реальную camera + MediaPipe + YOLO через offscreen architecture, popup показал `ACTIVE`, а Native Messaging agent перешёл в active state;
- [~] после финальной защиты Stop двойным подтверждением требуется повторить close popup → wait → reopen same session на последнем `dist`;
- [~] Google Forms rules покрыты unit-тестами, но live submit реальной формы ещё не выполнен;
- [x] finishing the integration session stopped the camera/browser route and returned the local agent to `stopped` without leaving monitoring active.

---

BLOCK 7. EVIDENCE AND TIMELINE

Phase 31. Timeline UI

- chronological events;
- filters;
- severity;
- timestamps;
- event details.

Phase 32. Evidence Capture

- screenshot;
- event metadata;
- timestamp;
- evidence relation.

Phase 33. Short Video Evidence

- MediaRecorder;
- short clips;
- pre/post event window при технической возможности;
- local storage.

Phase 34. Evidence Viewer

- screenshot preview;
- video preview;
- event information;
- confidence;
- duration.

Phase 35. Evidence Management

- unique IDs;
- relation event → evidence;
- deletion;
- storage limits;
- error handling.

---

BLOCK 8. CLOUD AND APPEALS

Phase 36. Cloud Storage Architecture

- storage provider;
- authentication;
- private bucket;
- upload architecture.

Phase 37. Evidence Upload

- upload evidence;
- progress;
- retry;
- network failure handling.

Phase 38. Secure Access

- signed URLs;
- access control;
- no secret keys in extension.

Phase 39. Student Appeals

- appeal form;
- comment;
- event reference;
- status.

Phase 40. Appeal Review

- teacher review;
- ACCEPTED;
- REJECTED;
- PENDING;
- audit information.

---

BLOCK 9. TEACHER DASHBOARD

Phase 41. Dashboard

- student list;
- test sessions;
- Activity Score;
- event count;
- status.

Phase 42. Student Session View

- complete timeline;
- events;
- evidence;
- score breakdown.

Phase 43. Review Workflow

- suspicious events;
- evidence;
- appeals;
- review status.

Phase 44. Reports

- session summary;
- score;
- events;
- evidence;
- appeal status.

---

BLOCK 10. DEMO, POLISH AND RELEASE

Phase 45. Demo Mode

Создать безопасный демонстрационный режим:

- normal activity;
- looking away;
- head turn;
- phone;
- multiple faces;
- tab switch;
- evidence;
- Activity Score.

Demo Mode не должен заменять настоящий AI.

Phase 46. Reliability and Error Handling

Проверить:

- camera failure;
- model loading failure;
- low FPS;
- network failure;
- cloud upload failure;
- storage failure;
- browser API limitations;
- extension reload.

Исправить критические ошибки.

Phase 47. Final QA and Hackathon Release

- clean build;
- TypeScript check;
- tests;
- manual testing;
- extension installation;
- demo scenario;
- README;
- architecture documentation;
- limitations;
- screenshots;
- final cleanup.

---

DEVELOPMENT STATUS

[x] = completed and tested
[~] = implemented but requires fixes/testing
[ ] = not started

Current status:

[~] BLOCK 1 — MV3 popup/service-worker/content/offscreen skeleton собран и установлен; требуется финальный close/reopen smoke последнего `dist`
[x] BLOCK 2 — Event Engine/scoring покрыты unit-тестами; IndexedDB restoration подтверждён перезагрузкой browser preview
[~] BLOCK 3 — реальный MediaPipe и temporal pipeline работают на реальной камере; требуется матрица порогов для разных пользователей/условий
[x] BLOCK 4 — head/gaze episodes, duration/repetition score and live behavior verified
[x] BLOCK 5 — real YOLOv8n phone detection, immediate event and overlay verified
[~] BLOCK 6 — browser/OS/native pipelines проверены; in-tab refactor реализован, но final close/reopen и live Google Forms submit требуют ручной проверки последнего `dist`
[ ] BLOCK 7
[ ] BLOCK 8
[ ] BLOCK 9
[ ] BLOCK 10

Verification record (2026-10-04):

- `pnpm typecheck` — passed;
- `pnpm test` — passed, 9 tests;
- `pnpm build` — passed, Manifest V3 bundle created in `dist/`;
- local MediaPipe model and WASM assets verified in `dist/`;
- responsive UI inspected in the local browser preview;
- IndexedDB restoration verified across a browser-preview reload;
- the local browser preview restored a real MediaPipe timeline containing 478-landmark face/head/gaze events, but no controlled multi-person/lighting threshold matrix was executed;
- unpacked-extension loading was not executed in this environment, therefore related phases remain `[~]`.

Verification record (2026-10-05):

- TypeScript `tsc --noEmit` — passed;
- Vitest — 5 files, 19 tests passed;
- Vite production build — passed, 1582 modules transformed;
- production preview — sample quiz отсутствует, Activity Score отображается как `0 / 200`;
- real camera baseline — start/finish, MediaPipe GPU, 478 landmarks, calibration 100%, YOLOv8n WebGPU and phone inference loop confirmed;
- the initial agent-run did not perform a physical-phone positive test; the later user verification below supersedes this open item.

User verification update (2026-10-05): physical-phone detection, overlay, head/gaze episodes and scoring were confirmed working; BLOCKS 4 and 5 are now `[x]`.

Verification record for BLOCK 6 (2026-10-05):

- TypeScript build and 24 Vitest tests passed;
- 3 Python unit tests and Native Messaging handshake/heartbeat/start/stop integration passed;
- actual Windows `keyboard` hook start/unhook passed without ordinary-key logging;
- Windows foreground probe returned the active process with window titles disabled;
- service worker/content script JavaScript and installer PowerShell syntax passed;
- production Security Monitoring UI inspected in responsive preview;
- Этот ранний пункт superseded последующей регистрацией host для ID `modeenlenlcffbfmgakibilblmckcngb` и installed-Chrome Native Messaging smoke выше.

Verification record for the in-tab MV3 refactor (2026-10-05):

- `pnpm install --frozen-lockfile` — passed;
- TypeScript `tsc -b` — passed;
- Vitest — 8 files, 30 tests passed, включая session-state и Google Forms confirmation rules;
- Python unittest — 3 tests passed; Native Messaging protocol smoke exited with code 0;
- production build — passed; `dist/manifest.json` uses `background.js`, `popup.html`, `content.js`, `offscreen` plus justified `scripting` permission and only HTTP(S) host permissions;
- JavaScript syntax checks for background/content/popup/offscreen bundles — passed;
- production bundle contains no `index.html`; MediaPipe/ORT resources and YOLOv8n are packaged; source/dist YOLO SHA-256 matches;
- native host was reinstalled after the final build for extension ID `modeenlenlcffbfmgakibilblmckcngb`;
- final installed-Chrome close/reopen and live Google Forms submission remain `[~]` and are not claimed as completed.

---

RULES

1. Do not skip phases.
2. Do not start the next block before the current block is tested.
3. Do not replace real ML with mocks.
4. Do not break previously completed functionality.
5. Run build after major changes.
6. Run tests after major changes.
7. Update this roadmap after completing each phase.
8. Mark a phase [x] only when it is actually implemented and tested.
9. If a phase cannot be implemented as specified, document the reason and technical limitation.
10. Stability has higher priority than adding unnecessary features.
