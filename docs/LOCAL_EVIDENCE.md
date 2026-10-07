# Local session and screenshot evidence

Look At Me! does not record video. The registered Native Messaging helper stores structured session/event metadata and PNG screenshots on the local Windows computer.

## Physical location

Production resolves the Windows Documents Known Folder, including OneDrive redirection, and creates:

```text
Documents\LookAtMe\
├── database.db
├── recordings\
└── screenshots\
    ├── image001.png
    ├── image002.png
    ├── final001.png
    └── ...
```

`LOOK_AT_ME_DATA_DIR` overrides this root only for isolated automated tests.

## SQLite schema

`sessions` is the durable session summary:

```text
id, student_name, test_name, started_at, ended_at, duration_seconds,
activity_score, violations_count, status, final_screenshot_name,
created_at, updated_at
```

`events` is the canonical event log:

```text
event_id, session_id, event_time, ended_at, event_type, duration_ms,
confidence, severity, score_impact, source, description,
screenshot_name, screenshot_path, created_at, updated_at
```

`violations` remains as a compatibility index for screenshot evidence created by earlier releases. `final_screenshots` provides monotonic `finalNNN.png` allocation. Startup migrates earlier violation rows into `sessions` and `events` without changing or deleting their PNG files.

`recordings` is created only to keep the local data layout stable. This release does not record video.

Every Event Engine event is upserted near its occurrence. A continuing `HEAD_TURN` or `LOOKING_AWAY` updates the same `event_id`; the row's duration, end, confidence and score grow without duplicate rows. The finalization flow flushes the last active duration before stopping camera inference.

## Screenshot capture

```text
confirmed scored event
        ↓
chrome.tabs.captureVisibleTab + current offscreen camera frame
        ↓
composite PNG (page + mirrored labeled camera inset)
        ↓
atomic screenshots/imageNNN.png + event screenshot_name

normal session finish
        ↓
page + camera + FINAL SCREENSHOT banner + score + time
        ↓
atomic screenshots/finalNNN.png + session final_screenshot_name
```

The helper validates a bounded PNG signature, writes a temporary file, flushes it with `fsync`, atomically replaces the final path, and then commits SQLite. File numbers are calculated against physical files while holding the storage lock, so orphaned or older files are never overwritten.

## Readable evidence page

The popup opens `evidence.html`. The page reads up to 1,000 records through the service worker and Native Messaging, then shows type, start time, duration, confidence, severity, score impact, source, session ID, description and screenshot filename.

The page has explicit Connecting, Online and Offline states. Native reconnect uses one exponential-backoff timer capped at 30 seconds. A user can request an immediate retry. Deleting a row moves the PNG aside, deletes SQLite metadata in an immediate transaction, commits, and removes the temporary file; rollback restores the PNG.

## Verification

```powershell
pnpm typecheck
pnpm test
python -m unittest discover -s tests -v
python scripts\test_native_agent.py --exercise-storage
pnpm build
pnpm test:extension-runtime
```

The Chrome runtime test loads the real unpacked `dist`, starts offscreen camera/CV, closes and reopens popup, creates browser events, saves composite evidence and `final001.png`, proves normal finish adds no `FULLSCREEN_EXIT`, reads/deletes a row through the real viewer, and verifies physical SQLite/PNG state.

## Limits

- Native Messaging is required because an MV3 extension cannot write arbitrary Documents files or SQLite directly.
- `<all_urls>` is required by `captureVisibleTab()` across ordinary sites; protected Chrome pages remain unavailable.
- The screenshot covers the visible Chrome tab and webcam, not the Windows desktop or another application.
- There is no cloud upload, video recording, screenshot retention policy, or automatic teacher verdict.
