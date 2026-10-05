# Local Security Agent

## Purpose

The Block 6 agent adds real Windows observations that a Chrome extension cannot obtain by itself. It contributes explainable events to the same Event Engine; it is not a complete operating-system lock and does not make a cheating decision.

## Architecture

```text
Monitored web page
  → content.js
  → validated MV3 service worker
  → dashboard runtime.Port
  → Event Engine

Windows keyboard / foreground process
  → local_security_agent.py
  → length-prefixed JSON on stdin/stdout
  → service worker connectNative()
  → dashboard runtime.Port
  → Event Engine (source: system)
```

The Native Messaging host name is `com.look_at_me.security`. Chrome requires the `nativeMessaging` extension permission, a host manifest with an exact `allowed_origins` extension ID, and a current-user or machine registry entry on Windows.

## Supported observations

| Signal | Event | Behavior |
| --- | --- | --- |
| Ctrl+C | `COPY_ATTEMPT` | Direct global shortcut observation |
| Ctrl+V | `PASTE_ATTEMPT` | Direct global shortcut observation |
| Alt+Tab | `ALT_TAB_ATTEMPT` | Direct global shortcut observation |
| Windows key | `SYSTEM_KEY_ATTEMPT` | Direct key observation where Windows exposes it |
| Print Screen | `PRINT_SCREEN_ATTEMPT` | Direct global key observation |
| Foreground HWND/process change | `APP_SWITCH` | Polls every 500 ms; sends process basenames |

The detector keeps only a small pressed-key set in memory to recognize protected combinations. It never emits ordinary characters, words, passwords, or general keystroke history. Shortcut events are debounced for 750 ms.

## Limitations

- The agent observes; it does not block or suppress shortcuts.
- Windows secure desktop and protected system surfaces are unavailable.
- A non-elevated process may not observe every event from an elevated application.
- Some Windows-reserved shortcuts may be consumed before a user-level hook receives them.
- Window titles are disabled by default because they can contain personal document names or messages.
- Another physical device remains outside the system boundary.
- Chrome Native Messaging requires registration after the final unpacked extension ID is known.

## Installation

1. Build and load `dist/` as an unpacked Chrome extension.
2. Copy its 32-character extension ID from `chrome://extensions`.
3. Register the native host for the current Windows user. The installer places the pinned Python dependency in a private `generated/python-packages` directory; it does not modify global Python packages:

   ```powershell
   .\native_host\install_native_host.ps1 `
     -ExtensionId <extension-id> `
     -PythonPath <absolute-path-to-python.exe>
   ```

4. Reload the extension. The Security Monitoring panel should report `ready`; starting a session should change it to `active`.

The production build copies the same files to `dist/native-host/`, so installation can be performed from the built package. The installer creates a generated launcher, a private dependency directory, and a manifest beside the script, then writes this current-user registry value:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.look_at_me.security
```

Remove it with:

```powershell
.\native_host\uninstall_native_host.ps1
```

## Protocol

Each message is UTF-8 JSON preceded by a native-endian unsigned 32-bit payload length. The host switches Windows stdin/stdout to binary mode. Debug output is written only to stderr.

Commands from the service worker:

- `capabilities`;
- `start` with a session ID;
- `stop`;
- `ping`;
- `shutdown`.

Host messages:

- `ready`;
- `status`;
- `event`;
- `pong`.

The service worker allow-lists every accepted event type and truncates strings/metadata before forwarding it to the dashboard. The dashboard validates the payload again before calling Event Engine.

## Verified integration

The packaged host was registered and exercised with the installed unpacked Chrome extension on Windows. The real route produced a Native Messaging heartbeat, changed the agent to `active` when monitoring started, and delivered foreground-process changes as `APP_SWITCH` events with `source: system`. Chrome tab and focus observations continued to arrive with `source: browser`; all events used the same Event Engine and ascending Activity Score. The current architecture keeps this port in the service worker, independent from the temporary toolbar popup and the current-tab overlay.

## Verification commands

```powershell
python -m unittest discover -s tests -v
python scripts/test_native_agent.py
python scripts/test_native_agent.py --exercise-windows
```

The last command requires the `keyboard` package and performs a real hook start/unhook plus foreground-monitor start/stop. It does not synthesize keys or store ordinary keyboard input.
