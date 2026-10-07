"""Durable local screenshot evidence store for Look At Me!.

The Chrome extension cannot write arbitrary files or SQLite directly. The
registered Native Messaging host calls this module to save one PNG for each
confirmed violation and one small SQLite row that links the violation to the
image filename.
"""

from __future__ import annotations

import base64
import os
import re
import sqlite3
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
EVENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,180}$")
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,120}$")
VIOLATION_TYPE_PATTERN = re.compile(r"^[A-Z0-9_]{1,80}$")


def default_data_root() -> Path:
    override = os.environ.get("LOOK_AT_ME_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / "Documents" / "LookAtMeViolations"


def utc_iso_from_ms(value: int) -> str:
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _safe_identifier(value: Any, pattern: re.Pattern[str], label: str) -> str:
    text = str(value or "")
    if not pattern.fullmatch(text):
        raise ValueError(f"Invalid {label}.")
    return text


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


class LocalEvidenceStore:
    """Stores `screenshots/imageNNN.png` plus a simple `violations.db`."""

    def __init__(self, root: Path | str | None = None) -> None:
        self.root = Path(root) if root is not None else default_data_root()
        self.root = self.root.expanduser().resolve()
        self.screenshots_root = self.root / "screenshots"
        self.database_path = self.root / "violations.db"
        self._lock = threading.RLock()
        self.screenshots_root.mkdir(parents=True, exist_ok=True)
        self._initialize_database()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=20)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        return connection

    def _initialize_database(self) -> None:
        connection = self._connect()
        try:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS violations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT NOT NULL UNIQUE,
                    session_id TEXT NOT NULL,
                    violation_time TEXT NOT NULL,
                    violation_type TEXT NOT NULL,
                    screenshot_name TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_violations_time ON violations(violation_time)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_violations_session ON violations(session_id)"
            )
            connection.commit()
        finally:
            connection.close()

    def initialize(self) -> dict[str, Any]:
        return {
            "dataRoot": str(self.root),
            "screenshotsPath": str(self.screenshots_root),
            "databasePath": str(self.database_path),
        }

    def save_violation(
        self,
        session_id: str,
        event: dict[str, Any],
        encoded_png: str,
        mime_type: str,
    ) -> dict[str, Any]:
        session_id = _safe_identifier(session_id, SESSION_ID_PATTERN, "session ID")
        event_id = _safe_identifier(event.get("id"), EVENT_ID_PATTERN, "event ID")
        violation_type = _safe_identifier(
            str(event.get("type") or "").upper(), VIOLATION_TYPE_PATTERN, "violation type"
        )
        timestamp_ms = int(event.get("timestamp") or 0)
        if timestamp_ms <= 0:
            raise ValueError("Violation timestamp must be a positive Unix timestamp in milliseconds.")
        if mime_type != "image/png":
            raise ValueError("Only PNG violation screenshots are accepted.")
        try:
            image = base64.b64decode(encoded_png, validate=True)
        except Exception as error:
            raise ValueError("Screenshot is not valid base64.") from error
        if len(image) < len(PNG_SIGNATURE) or len(image) > MAX_SCREENSHOT_BYTES or not image.startswith(PNG_SIGNATURE):
            raise ValueError("Screenshot is not a valid bounded PNG payload.")

        with self._lock:
            connection = self._connect()
            screenshot_path: Path | None = None
            try:
                connection.execute("BEGIN IMMEDIATE")
                existing = connection.execute(
                    "SELECT screenshot_name FROM violations WHERE event_id=?", (event_id,)
                ).fetchone()
                if existing:
                    connection.commit()
                    existing_path = self.screenshots_root / existing["screenshot_name"]
                    return {
                        **self.initialize(),
                        "screenshotName": existing["screenshot_name"],
                        "screenshotPath": str(existing_path),
                        "alreadyExisted": True,
                    }

                cursor = connection.execute(
                    """
                    INSERT INTO violations (
                        event_id, session_id, violation_time, violation_type,
                        screenshot_name, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        event_id,
                        session_id,
                        utc_iso_from_ms(timestamp_ms),
                        violation_type,
                        f"pending-{event_id}",
                        utc_now_iso(),
                    ),
                )
                filename = f"image{cursor.lastrowid:03d}.png"
                screenshot_path = self.screenshots_root / filename
                _atomic_write_bytes(screenshot_path, image)
                connection.execute(
                    "UPDATE violations SET screenshot_name=? WHERE event_id=?",
                    (filename, event_id),
                )
                connection.commit()
                return {
                    **self.initialize(),
                    "screenshotName": filename,
                    "screenshotPath": str(screenshot_path),
                    "alreadyExisted": False,
                    "bytesWritten": len(image),
                }
            except Exception:
                connection.rollback()
                if screenshot_path is not None:
                    screenshot_path.unlink(missing_ok=True)
                raise
            finally:
                connection.close()

    def list_violations(self, limit: int = 100) -> list[dict[str, Any]]:
        bounded_limit = min(1_000, max(1, int(limit)))
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT event_id, session_id, violation_time, violation_type,
                       screenshot_name, created_at
                FROM violations ORDER BY id DESC LIMIT ?
                """,
                (bounded_limit,),
            ).fetchall()
        finally:
            connection.close()
        return [dict(row) for row in rows]

    def close(self) -> None:
        """Connections are short lived; kept for a stable host lifecycle API."""
