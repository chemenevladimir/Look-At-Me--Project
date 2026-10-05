"""Protocol smoke test for the Native Messaging host without installing it."""

from __future__ import annotations

import json
import argparse
import struct
import subprocess
import sys
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
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    process = subprocess.Popen(
        [sys.executable, str(root / "local_security_agent.py")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
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
        send(process, {"type": "shutdown"})
        return process.wait(timeout=5)
    finally:
        if process.poll() is None:
            process.kill()


if __name__ == "__main__":
    raise SystemExit(main())
