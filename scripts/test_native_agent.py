"""Protocol smoke test for the Native Messaging host without installing it."""

from __future__ import annotations

import json
import argparse
import os
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


def send(process: subprocess.Popen[bytes], message: dict[str, object]) -> None:
    payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
    assert process.stdin is not None
    process.stdin.write(struct.pack("@I", len(payload)) + payload)
    process.stdin.flush()


def receive(process: subprocess.Popen[bytes]) -> dict[str, object]:
    assert process.stdout is not None
    header = process.stdout.read(4)
    if len(header) != 4:
        raise RuntimeError("Native host returned no framed response")
    size = struct.unpack("@I", header)[0]
    return json.loads(process.stdout.read(size).decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--exercise-windows', action='store_true')
    parser.add_argument('--exercise-storage', action='store_true')
    parser.add_argument(
        '--registered-host',
        action='store_true',
        help='Launch the Native Messaging command registered for the current Windows user.',
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    command = [sys.executable, str(root / "local_security_agent.py")]
    if args.registered_host:
        if sys.platform != "win32":
            raise RuntimeError("--registered-host requires Windows")
        import winreg

        registry_path = r"Software\Google\Chrome\NativeMessagingHosts\com.look_at_me.security"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, registry_path) as key:
            manifest_path = Path(winreg.QueryValueEx(key, None)[0])
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        host_path = Path(manifest["path"])
        if not host_path.is_file():
            raise RuntimeError(f"Registered Native Messaging host is missing: {host_path}")
        command = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", str(host_path)]
    temporary_data = tempfile.TemporaryDirectory() if args.exercise_storage else None
    child_environment = os.environ.copy()
    if temporary_data:
        child_environment["LOOK_AT_ME_DATA_DIR"] = str(Path(temporary_data.name) / "LookAtMeViolations")
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=child_environment,
    )
    try:
        ready = receive(process)
        if ready.get("type") != "ready":
            raise RuntimeError(f"Unexpected handshake: {ready}")
        send(process, {"type": "ping", "timestamp": 12345})
        pong = receive(process)
        if pong != {"type": "pong", "timestamp": 12345}:
            raise RuntimeError(f"Unexpected heartbeat: {pong}")
        if args.exercise_windows:
            send(process, {"type": "start", "sessionId": "protocol-smoke"})
            active = receive(process)
            if active.get("type") != "status" or active.get("state") != "active":
                raise RuntimeError(f"Unexpected start status: {active}")
            send(process, {"type": "stop"})
            stopped = receive(process)
            if stopped.get("type") != "status" or stopped.get("state") != "stopped":
                raise RuntimeError(f"Unexpected stop status: {stopped}")
        if args.exercise_storage:
            session_id = f"session_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
            started_at = int(time.time() * 1000)

            def request(message: dict[str, object]) -> dict[str, object]:
                request_id = uuid.uuid4().hex
                send(process, {**message, "requestId": request_id})
                response = receive(process)
                if response.get("type") != "storage-response" or response.get("replyTo") != request_id:
                    raise RuntimeError(f"Unexpected storage response: {response}")
                if response.get("ok") is not True:
                    raise RuntimeError(f"Storage command failed: {response}")
                return response.get("result") or {}

            initialized = request({"type": "storage-initialize"})
            event_id = "PHONE_DETECTED-protocol-smoke"
            saved = request({
                "type": "storage-violation-save",
                "sessionId": session_id,
                "event": {
                    "id": event_id,
                    "type": "PHONE_DETECTED",
                    "timestamp": started_at + 1000,
                },
                "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9WQAAAAASUVORK5CYII=",
                "mimeType": "image/png",
            })
            screenshot = Path(str(saved["screenshotPath"]))
            database = Path(str(initialized["databasePath"]))
            if not screenshot.is_file() or screenshot.name != "image001.png" or not database.is_file():
                raise RuntimeError(f"Local violation evidence was not created correctly: {saved}")
            connection = sqlite3.connect(database)
            try:
                row = connection.execute(
                    "SELECT violation_time, violation_type, screenshot_name FROM violations WHERE event_id=?",
                    (event_id,),
                ).fetchone()
            finally:
                connection.close()
            if not row or row[1:] != ("PHONE_DETECTED", "image001.png"):
                raise RuntimeError(f"SQLite violation row is invalid: {row}")
            listed = request({"type": "storage-list-violations", "limit": 100})
            violations = listed.get("violations") or []
            if len(violations) != 1 or violations[0].get("event_id") != event_id:
                raise RuntimeError(f"Stored violation was not returned by the viewer API: {listed}")
            deleted = request({"type": "storage-delete-violation", "eventId": event_id})
            if deleted.get("deleted") is not True or screenshot.exists():
                raise RuntimeError(f"Violation screenshot was not deleted: {deleted}")
            connection = sqlite3.connect(database)
            try:
                remaining = connection.execute(
                    "SELECT COUNT(*) FROM violations WHERE event_id=?", (event_id,)
                ).fetchone()[0]
            finally:
                connection.close()
            if remaining != 0:
                raise RuntimeError("Deleted violation is still present in SQLite")
        send(process, {"type": "shutdown"})
        return process.wait(timeout=5)
    finally:
        if process.poll() is None:
            process.kill()
        if temporary_data:
            temporary_data.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
