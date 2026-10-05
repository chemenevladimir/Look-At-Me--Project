"""Windows Native Messaging security observer for Look At Me!.

The process writes only length-prefixed JSON to stdout. Diagnostics go to stderr.
It observes protected shortcut combinations and foreground-application changes;
it deliberately does not record ordinary typed text or claim complete OS locking.
"""

from __future__ import annotations

import ctypes
import importlib.util
import json
import os
import struct
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable
from ctypes import wintypes

MAX_INBOUND_BYTES = 64 * 1024 * 1024
MAX_OUTBOUND_BYTES = 1024 * 1024
POLL_INTERVAL_SECONDS = 0.5
DEBOUNCE_SECONDS = 0.75

CAPABILITIES = [
    "Ctrl+C and Ctrl+V shortcut observation",
    "Alt+Tab observation",
    "Windows-key observation",
    "Print Screen observation",
    "Foreground application changes",
]

LIMITATIONS = [
    "Observation only; shortcuts are not blocked",
    "Windows secure desktop and protected system surfaces are unavailable",
    "Elevated applications may not expose every event to a non-elevated agent",
    "No visibility into another physical device",
    "Window titles are omitted by default for privacy",
]


def log(message: str) -> None:
    print(f"[look-at-me-agent] {message}", file=sys.stderr, flush=True)


class NativeMessageIO:
    def __init__(self, reader: BinaryIO, writer: BinaryIO) -> None:
        self.reader = reader
        self.writer = writer
        self._write_lock = threading.Lock()

    def read_message(self) -> dict[str, Any] | None:
        header = self._read_exact(4)
        if not header:
            return None
        size = struct.unpack("@I", header)[0]
        if size > MAX_INBOUND_BYTES:
            raise ValueError(f"Inbound native message is too large: {size} bytes")
        payload = self._read_exact(size)
        if len(payload) != size:
            raise EOFError("Native message ended before the declared payload length")
        value = json.loads(payload.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("Native message must contain a JSON object")
        return value

    def send_message(self, message: dict[str, Any]) -> None:
        payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > MAX_OUTBOUND_BYTES:
            raise ValueError(f"Outbound native message is too large: {len(payload)} bytes")
        with self._write_lock:
            self.writer.write(struct.pack("@I", len(payload)))
            self.writer.write(payload)
            self.writer.flush()

    def _read_exact(self, size: int) -> bytes:
        chunks: list[bytes] = []
        remaining = size
        while remaining:
            chunk = self.reader.read(remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)


@dataclass(frozen=True)
class ShortcutSignal:
    event_type: str
    shortcut: str
    explanation: str


class ShortcutDetector:
    """Recognizes protected combinations without retaining ordinary key history."""

    CTRL_KEYS = {"ctrl", "left ctrl", "right ctrl"}
    ALT_KEYS = {"alt", "left alt", "right alt", "alt gr"}
    WINDOWS_KEYS = {"windows", "left windows", "right windows", "win", "left win", "right win"}
    PRINT_SCREEN_KEYS = {"print screen", "printscreen", "snapshot"}

    def __init__(self) -> None:
        self.pressed: set[str] = set()
        self.last_emitted: dict[str, float] = {}

    def process(self, name: str | None, event_type: str, now: float | None = None) -> list[ShortcutSignal]:
        if not name:
            return []
        key = name.strip().lower()
        current_time = time.monotonic() if now is None else now
        if event_type == "up":
            self.pressed.discard(key)
            return []
        if event_type != "down":
            return []

        self.pressed.add(key)
        candidates: list[ShortcutSignal] = []
        if key == "c" and self.pressed.intersection(self.CTRL_KEYS):
            candidates.append(ShortcutSignal("COPY_ATTEMPT", "ctrl+c", "The local security agent observed Ctrl+C."))
        elif key == "v" and self.pressed.intersection(self.CTRL_KEYS):
            candidates.append(ShortcutSignal("PASTE_ATTEMPT", "ctrl+v", "The local security agent observed Ctrl+V."))
        elif key == "tab" and self.pressed.intersection(self.ALT_KEYS):
            candidates.append(ShortcutSignal("ALT_TAB_ATTEMPT", "alt+tab", "The local security agent observed Alt+Tab."))
        elif key in self.WINDOWS_KEYS:
            candidates.append(ShortcutSignal("SYSTEM_KEY_ATTEMPT", "windows", "The local security agent observed a Windows key press."))
        elif key in self.PRINT_SCREEN_KEYS:
            candidates.append(ShortcutSignal("PRINT_SCREEN_ATTEMPT", "print-screen", "The local security agent observed Print Screen."))

        output: list[ShortcutSignal] = []
        for signal in candidates:
            previous = self.last_emitted.get(signal.shortcut, float("-inf"))
            if current_time - previous >= DEBOUNCE_SECONDS:
                self.last_emitted[signal.shortcut] = current_time
                output.append(signal)
        return output


@dataclass(frozen=True)
class ForegroundSnapshot:
    window_handle: int
    process_id: int
    process_name: str
    window_title: str | None = None


class ForegroundWindowProbe:
    def __init__(self, include_titles: bool = False) -> None:
        if sys.platform != "win32":
            raise RuntimeError("Foreground-window monitoring is supported only on Windows")
        self.include_titles = include_titles
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.user32.GetForegroundWindow.argtypes = []
        self.user32.GetForegroundWindow.restype = wintypes.HWND
        self.user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self.user32.GetWindowThreadProcessId.restype = wintypes.DWORD
        self.user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        self.user32.GetWindowTextLengthW.restype = ctypes.c_int
        self.user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        self.user32.GetWindowTextW.restype = ctypes.c_int
        self.kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel32.OpenProcess.restype = wintypes.HANDLE
        self.kernel32.QueryFullProcessImageNameW.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.LPWSTR,
            ctypes.POINTER(wintypes.DWORD),
        ]
        self.kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
        self.kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel32.CloseHandle.restype = wintypes.BOOL

    def snapshot(self) -> ForegroundSnapshot | None:
        hwnd = int(self.user32.GetForegroundWindow() or 0)
        if not hwnd:
            return None
        process_id = wintypes.DWORD(0)
        self.user32.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(process_id))
        process_name = self._process_name(process_id.value)
        title = self._window_title(hwnd) if self.include_titles else None
        return ForegroundSnapshot(hwnd, int(process_id.value), process_name, title)

    def _process_name(self, process_id: int) -> str:
        process_query_limited_information = 0x1000
        handle = self.kernel32.OpenProcess(process_query_limited_information, False, wintypes.DWORD(process_id))
        if not handle:
            return "unknown"
        try:
            size = wintypes.DWORD(1024)
            buffer = ctypes.create_unicode_buffer(size.value)
            if self.kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                return Path(buffer.value).name[:120] or "unknown"
            return "unknown"
        finally:
            self.kernel32.CloseHandle(handle)

    def _window_title(self, hwnd: int) -> str | None:
        length = int(self.user32.GetWindowTextLengthW(wintypes.HWND(hwnd)) or 0)
        if length <= 0:
            return None
        buffer = ctypes.create_unicode_buffer(min(length + 1, 241))
        self.user32.GetWindowTextW(wintypes.HWND(hwnd), buffer, len(buffer))
        return buffer.value[:240] or None


class SecurityAgent:
    def __init__(self, send: Callable[[dict[str, Any]], None]) -> None:
        self.send = send
        self.active = False
        self.session_id: str | None = None
        self.stop_event = threading.Event()
        self.foreground_thread: threading.Thread | None = None
        self.keyboard_module: Any = None
        self.keyboard_hook: Any = None
        self.shortcut_detector = ShortcutDetector()
        self.include_window_titles = False

    def capabilities(self) -> dict[str, Any]:
        keyboard_available = importlib.util.find_spec("keyboard") is not None
        available = sys.platform == "win32"
        return {
            "type": "ready",
            "state": "ready" if available else "unavailable",
            "message": "Windows security host is ready." if available else "This security host requires Windows.",
            "capabilities": CAPABILITIES if available else [],
            "limitations": LIMITATIONS + ([] if keyboard_available else ["Python package 'keyboard' is not installed"]),
            "metadata": {
                "platform": sys.platform,
                "keyboardPackage": keyboard_available,
                "ordinaryKeyLogging": False,
                "blocking": False,
            },
        }

    def start(self, session_id: str | None, include_window_titles: bool = False) -> None:
        if self.active:
            self.send(self._status("active", "Local security monitoring is already active."))
            return
        if sys.platform != "win32":
            self.send(self._status("error", "Local security monitoring requires Windows."))
            return

        self.session_id = session_id[:100] if isinstance(session_id, str) else None
        self.include_window_titles = bool(include_window_titles)
        self.stop_event.clear()
        keyboard_error: str | None = None
        try:
            import keyboard  # type: ignore

            self.keyboard_module = keyboard
            self.keyboard_hook = keyboard.hook(self._on_keyboard_event, suppress=False)
        except Exception as error:  # pragma: no cover - depends on OS permissions
            keyboard_error = str(error)
            self.keyboard_module = None
            self.keyboard_hook = None

        try:
            probe = ForegroundWindowProbe(include_titles=self.include_window_titles)
            self.foreground_thread = threading.Thread(
                target=self._foreground_loop,
                args=(probe,),
                name="look-at-me-foreground-monitor",
                daemon=True,
            )
            self.foreground_thread.start()
        except Exception as error:
            self.send(self._status("error", f"Foreground-window monitoring failed: {error}"))
            self._unhook_keyboard()
            return

        self.active = True
        message = "Keyboard shortcuts and foreground applications are being observed."
        if keyboard_error:
            message = f"Foreground applications are being observed; keyboard hook unavailable: {keyboard_error}"
        self.send(self._status("active", message))

    def stop(self, notify: bool = True) -> None:
        was_active = self.active
        self.active = False
        self.stop_event.set()
        self._unhook_keyboard()
        if self.foreground_thread and self.foreground_thread.is_alive():
            self.foreground_thread.join(timeout=1.5)
        self.foreground_thread = None
        self.session_id = None
        if notify:
            self.send(self._status("stopped", "Local security monitoring stopped." if was_active else "Local security monitoring is idle."))

    def _on_keyboard_event(self, event: Any) -> None:
        if not self.active:
            return
        for signal in self.shortcut_detector.process(
            getattr(event, "name", None),
            getattr(event, "event_type", ""),
        ):
            self.send({
                "type": "event",
                "eventType": signal.event_type,
                "confidence": 1,
                "duration": 0,
                "explanation": signal.explanation,
                "metadata": {"shortcut": signal.shortcut, "sessionId": self.session_id or ""},
            })

    def _foreground_loop(self, probe: ForegroundWindowProbe) -> None:
        previous = probe.snapshot()
        while not self.stop_event.wait(POLL_INTERVAL_SECONDS):
            try:
                current = probe.snapshot()
                if current and previous and current.window_handle != previous.window_handle:
                    metadata: dict[str, str | int | bool] = {
                        "fromProcess": previous.process_name,
                        "toProcess": current.process_name,
                        "processChanged": previous.process_id != current.process_id,
                    }
                    if self.include_window_titles:
                        metadata["fromTitle"] = previous.window_title or ""
                        metadata["toTitle"] = current.window_title or ""
                    self.send({
                        "type": "event",
                        "eventType": "APP_SWITCH",
                        "confidence": 1,
                        "duration": 0,
                        "explanation": f"Foreground application changed from {previous.process_name} to {current.process_name}.",
                        "metadata": metadata,
                    })
                if current:
                    previous = current
            except Exception as error:  # pragma: no cover - depends on transient OS state
                log(f"Foreground probe failed: {error}")

    def _unhook_keyboard(self) -> None:
        if self.keyboard_module is not None and self.keyboard_hook is not None:
            try:
                self.keyboard_module.unhook(self.keyboard_hook)
            except Exception as error:  # pragma: no cover - depends on OS hook state
                log(f"Keyboard unhook failed: {error}")
        self.keyboard_hook = None
        self.keyboard_module = None
        self.shortcut_detector = ShortcutDetector()

    @staticmethod
    def _status(state: str, message: str) -> dict[str, Any]:
        return {
            "type": "status",
            "state": state,
            "message": message,
            "capabilities": CAPABILITIES,
            "limitations": LIMITATIONS,
        }


def configure_binary_stdio() -> None:
    if sys.platform == "win32":
        import msvcrt

        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)


def run_host(reader: BinaryIO | None = None, writer: BinaryIO | None = None) -> int:
    input_stream = reader or sys.stdin.buffer
    output_stream = writer or sys.stdout.buffer
    protocol = NativeMessageIO(input_stream, output_stream)
    agent = SecurityAgent(protocol.send_message)
    protocol.send_message(agent.capabilities())

    try:
        while True:
            message = protocol.read_message()
            if message is None:
                break
            message_type = message.get("type")
            if message_type == "capabilities":
                protocol.send_message(agent.capabilities())
            elif message_type == "start":
                agent.start(message.get("sessionId"), bool(message.get("includeWindowTitles", False)))
            elif message_type == "stop":
                agent.stop()
            elif message_type == "ping":
                protocol.send_message({"type": "pong", "timestamp": message.get("timestamp")})
            elif message_type == "shutdown":
                break
            else:
                protocol.send_message(agent._status("error", f"Unsupported command: {message_type!r}"))
    except (EOFError, ValueError, json.JSONDecodeError) as error:
        log(str(error))
        return 2
    finally:
        if agent.active:
            agent.stop(notify=False)
    return 0


def main() -> int:
    configure_binary_stdio()
    return run_host()


if __name__ == "__main__":
    raise SystemExit(main())
