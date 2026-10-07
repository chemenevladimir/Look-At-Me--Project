"""Durable local session, event, and screenshot storage for Look At Me!."""

from __future__ import annotations

import base64
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
EVENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,180}$")
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,120}$")
EVENT_TYPE_PATTERN = re.compile(r"^[A-Z0-9_]{1,80}$")
SCREENSHOT_NAME_PATTERN = re.compile(r"^(?:image|final)[0-9]+\.png$")


def documents_root() -> Path:
    if os.name == "nt":
        try:
            import winreg

            key_path = r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                documents = os.path.expandvars(str(winreg.QueryValueEx(key, "Personal")[0]))
            if documents:
                return Path(documents)
        except (OSError, ImportError):
            pass
    return Path.home() / "Documents"


def default_data_root() -> Path:
    override = os.environ.get("LOOK_AT_ME_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    return documents_root() / "LookAtMe"


def _migrate_legacy_default_root(target: Path) -> None:
    """Move the former default store into the final portable location once."""
    legacy = documents_root() / "LookAtMeViolations"
    if target.exists() or not legacy.exists() or legacy.resolve() == target.resolve():
        return
    target.mkdir(parents=True, exist_ok=True)
    legacy_database = legacy / "violations.db"
    if legacy_database.exists():
        shutil.move(str(legacy_database), str(target / "database.db"))
    legacy_screenshots = legacy / "screenshots"
    if legacy_screenshots.exists():
        shutil.move(str(legacy_screenshots), str(target / "screenshots"))
    for suffix in ("-wal", "-shm"):
        legacy_sidecar = legacy / f"violations.db{suffix}"
        if legacy_sidecar.exists():
            shutil.move(str(legacy_sidecar), str(target / f"database.db{suffix}"))
    try:
        legacy.rmdir()
    except OSError:
        pass


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


def _decode_png(encoded_png: str, mime_type: str) -> bytes:
    if mime_type != "image/png":
        raise ValueError("Only PNG screenshots are accepted.")
    try:
        image = base64.b64decode(encoded_png, validate=True)
    except Exception as error:
        raise ValueError("Screenshot is not valid base64.") from error
    if len(image) < len(PNG_SIGNATURE) or len(image) > MAX_SCREENSHOT_BYTES or not image.startswith(PNG_SIGNATURE):
        raise ValueError("Screenshot is not a valid bounded PNG payload.")
    return image


class LocalEvidenceStore:
    """Stores SQLite metadata and atomic PNG evidence under Documents."""

    def __init__(self, root: Path | str | None = None) -> None:
        self.root = (Path(root) if root is not None else default_data_root()).expanduser().resolve()
        if root is None and not os.environ.get("LOOK_AT_ME_DATA_DIR", "").strip():
            _migrate_legacy_default_root(self.root)
        self.screenshots_root = self.root / "screenshots"
        self.recordings_root = self.root / "recordings"
        self.database_path = self.root / "database.db"
        self._lock = threading.RLock()
        self.screenshots_root.mkdir(parents=True, exist_ok=True)
        self.recordings_root.mkdir(parents=True, exist_ok=True)
        self._initialize_database()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=20)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize_database(self) -> None:
        connection = self._connect()
        try:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY, student_name TEXT NOT NULL, test_name TEXT NOT NULL,
                    started_at TEXT NOT NULL, ended_at TEXT, duration_seconds REAL NOT NULL DEFAULT 0,
                    activity_score INTEGER NOT NULL DEFAULT 0, violations_count INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL, final_screenshot_name TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS events (
                    event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, event_time TEXT NOT NULL,
                    ended_at TEXT, event_type TEXT NOT NULL, duration_ms REAL NOT NULL DEFAULT 0,
                    confidence REAL NOT NULL DEFAULT 0, severity INTEGER NOT NULL DEFAULT 0,
                    score_impact INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL,
                    description TEXT NOT NULL, screenshot_name TEXT UNIQUE, screenshot_path TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS violations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
                    session_id TEXT NOT NULL, violation_time TEXT NOT NULL,
                    violation_type TEXT NOT NULL, screenshot_name TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS final_screenshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL UNIQUE,
                    screenshot_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_events_time ON events(event_time);
                CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
                CREATE INDEX IF NOT EXISTS idx_violations_time ON violations(violation_time);
                CREATE INDEX IF NOT EXISTS idx_violations_session ON violations(session_id);
                """
            )
            event_columns = {row[1] for row in connection.execute("PRAGMA table_info(events)")}
            if "screenshot_path" not in event_columns:
                connection.execute("ALTER TABLE events ADD COLUMN screenshot_path TEXT")
            for row in connection.execute("SELECT * FROM violations ORDER BY id").fetchall():
                now = row["created_at"]
                connection.execute(
                    """INSERT OR IGNORE INTO sessions
                       (id, student_name, test_name, started_at, status, created_at, updated_at)
                       VALUES (?, '', '', ?, 'LEGACY', ?, ?)""",
                    (row["session_id"], row["violation_time"], now, now),
                )
                connection.execute(
                    """INSERT OR IGNORE INTO events
                       (event_id, session_id, event_time, event_type, source, description,
                        screenshot_name, created_at, updated_at)
                       VALUES (?, ?, ?, ?, 'unknown', 'Migrated local evidence record.', ?, ?, ?)""",
                    (row["event_id"], row["session_id"], row["violation_time"], row["violation_type"], row["screenshot_name"], now, now),
                )
            for row in connection.execute(
                "SELECT event_id, screenshot_name FROM events WHERE screenshot_name IS NOT NULL AND screenshot_path IS NULL"
            ).fetchall():
                connection.execute(
                    "UPDATE events SET screenshot_path=? WHERE event_id=?",
                    (str(self.screenshots_root / row["screenshot_name"]), row["event_id"]),
                )
            connection.commit()
        finally:
            connection.close()

    def initialize(self) -> dict[str, Any]:
        return {
            "dataRoot": str(self.root),
            "screenshotsPath": str(self.screenshots_root),
            "recordingsPath": str(self.recordings_root),
            "databasePath": str(self.database_path),
        }

    def open_screenshots_folder(self) -> dict[str, Any]:
        if os.name != "nt":
            raise OSError("Opening the screenshots folder is supported only by the Windows helper.")
        self.screenshots_root.mkdir(parents=True, exist_ok=True)
        process = subprocess.Popen(
            ["explorer.exe", str(self.screenshots_root)],
            close_fds=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            return_code = process.wait(timeout=0.35)
        except subprocess.TimeoutExpired:
            return_code = None
        # Explorer commonly exits its launcher with code 1 after handing the
        # folder to the already-running Windows shell. Popen itself failing is
        # the reliable launch failure; 0 and 1 are both normal hand-off results.
        if return_code not in (None, 0, 1):
            raise OSError(f"Windows Explorer failed to open the screenshots folder (exit code {return_code}).")
        return {**self.initialize(), "opened": True, "explorerStarted": True}

    def _next_screenshot_name(self, prefix: str) -> str:
        pattern = re.compile(rf"^{re.escape(prefix)}([0-9]+)\.png$")
        highest = 0
        for path in self.screenshots_root.glob(f"{prefix}*.png"):
            match = pattern.fullmatch(path.name)
            if match:
                highest = max(highest, int(match.group(1)))
        return f"{prefix}{highest + 1:03d}.png"

    def start_session(self, session: dict[str, Any]) -> dict[str, Any]:
        session_id = _safe_identifier(session.get("id"), SESSION_ID_PATTERN, "session ID")
        started_ms = int(session.get("startedAt") or 0)
        if started_ms <= 0:
            raise ValueError("Session start timestamp must be positive.")
        now = utc_now_iso()
        with self._lock, closing(self._connect()) as connection:
            connection.execute(
                """INSERT INTO sessions
                   (id, student_name, test_name, started_at, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, 'TESTING', ?, ?)
                   ON CONFLICT(id) DO UPDATE SET student_name=excluded.student_name,
                     test_name=excluded.test_name, status='TESTING', updated_at=excluded.updated_at""",
                (session_id, str(session.get("studentName") or "")[:200], str(session.get("testName") or "")[:240], utc_iso_from_ms(started_ms), now, now),
            )
            connection.commit()
        return {**self.initialize(), "sessionId": session_id, "status": "TESTING"}

    def save_event(self, session_id: str, event: dict[str, Any]) -> dict[str, Any]:
        session_id = _safe_identifier(session_id, SESSION_ID_PATTERN, "session ID")
        event_id = _safe_identifier(event.get("id"), EVENT_ID_PATTERN, "event ID")
        event_type = _safe_identifier(str(event.get("type") or "").upper(), EVENT_TYPE_PATTERN, "event type")
        timestamp_ms = int(event.get("timestamp") or 0)
        if timestamp_ms <= 0:
            raise ValueError("Event timestamp must be positive.")
        duration = max(0.0, float(event.get("duration") or 0))
        now = utc_now_iso()
        with self._lock, closing(self._connect()) as connection:
            connection.execute(
                """INSERT OR IGNORE INTO sessions
                   (id, student_name, test_name, started_at, status, created_at, updated_at)
                   VALUES (?, '', '', ?, 'TESTING', ?, ?)""",
                (session_id, utc_iso_from_ms(timestamp_ms), now, now),
            )
            connection.execute(
                """INSERT INTO events
                   (event_id, session_id, event_time, ended_at, event_type, duration_ms,
                    confidence, severity, score_impact, source, description, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(event_id) DO UPDATE SET
                     ended_at=excluded.ended_at, duration_ms=excluded.duration_ms,
                     confidence=excluded.confidence, severity=excluded.severity,
                     score_impact=excluded.score_impact, source=excluded.source,
                     description=excluded.description, updated_at=excluded.updated_at""",
                (event_id, session_id, utc_iso_from_ms(timestamp_ms), utc_iso_from_ms(timestamp_ms + int(duration)),
                 event_type, duration, min(1.0, max(0.0, float(event.get("confidence") or 0))),
                 min(10, max(0, int(event.get("severity") or 0))), min(200, max(0, int(event.get("scoreImpact") or 0))),
                 str(event.get("source") or "system")[:20], str(event.get("explanation") or "")[:2000], now, now),
            )
            connection.commit()
        return {"eventId": event_id, "saved": True}

    def save_violation(self, session_id: str, event: dict[str, Any], encoded_png: str, mime_type: str) -> dict[str, Any]:
        session_id = _safe_identifier(session_id, SESSION_ID_PATTERN, "session ID")
        event_id = _safe_identifier(event.get("id"), EVENT_ID_PATTERN, "event ID")
        event_type = _safe_identifier(str(event.get("type") or "").upper(), EVENT_TYPE_PATTERN, "event type")
        timestamp_ms = int(event.get("timestamp") or 0)
        if timestamp_ms <= 0:
            raise ValueError("Violation timestamp must be positive.")
        image = _decode_png(encoded_png, mime_type)
        self.save_event(session_id, event)
        with self._lock:
            connection = self._connect()
            screenshot_path: Path | None = None
            try:
                connection.execute("BEGIN IMMEDIATE")
                existing = connection.execute("SELECT screenshot_name FROM events WHERE event_id=?", (event_id,)).fetchone()
                if existing and existing["screenshot_name"]:
                    connection.commit()
                    existing_path = self.screenshots_root / existing["screenshot_name"]
                    return {**self.initialize(), "screenshotName": existing["screenshot_name"], "screenshotPath": str(existing_path), "alreadyExisted": True}
                connection.execute(
                    """INSERT OR IGNORE INTO violations
                       (event_id, session_id, violation_time, violation_type, screenshot_name, created_at)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (event_id, session_id, utc_iso_from_ms(timestamp_ms), event_type, f"pending-{event_id}", utc_now_iso()),
                )
                filename = self._next_screenshot_name("image")
                screenshot_path = self.screenshots_root / filename
                _atomic_write_bytes(screenshot_path, image)
                connection.execute("UPDATE violations SET screenshot_name=? WHERE event_id=?", (filename, event_id))
                connection.execute(
                    "UPDATE events SET screenshot_name=?, screenshot_path=?, updated_at=? WHERE event_id=?",
                    (filename, str(screenshot_path), utc_now_iso(), event_id),
                )
                connection.commit()
                return {**self.initialize(), "screenshotName": filename, "screenshotPath": str(screenshot_path), "alreadyExisted": False, "bytesWritten": len(image)}
            except Exception:
                connection.rollback()
                if screenshot_path is not None:
                    screenshot_path.unlink(missing_ok=True)
                raise
            finally:
                connection.close()

    def save_final_screenshot(self, session_id: str, encoded_png: str, mime_type: str) -> dict[str, Any]:
        session_id = _safe_identifier(session_id, SESSION_ID_PATTERN, "session ID")
        image = _decode_png(encoded_png, mime_type)
        with self._lock:
            connection = self._connect()
            screenshot_path: Path | None = None
            try:
                connection.execute("BEGIN IMMEDIATE")
                existing = connection.execute("SELECT screenshot_name FROM final_screenshots WHERE session_id=?", (session_id,)).fetchone()
                if existing:
                    connection.commit()
                    return {**self.initialize(), "screenshotName": existing["screenshot_name"], "screenshotPath": str(self.screenshots_root / existing["screenshot_name"]), "alreadyExisted": True}
                connection.execute("INSERT INTO final_screenshots(session_id, screenshot_name, created_at) VALUES (?, ?, ?)", (session_id, f"pending-final-{session_id}", utc_now_iso()))
                filename = self._next_screenshot_name("final")
                screenshot_path = self.screenshots_root / filename
                _atomic_write_bytes(screenshot_path, image)
                connection.execute("UPDATE final_screenshots SET screenshot_name=? WHERE session_id=?", (filename, session_id))
                connection.execute("UPDATE sessions SET final_screenshot_name=?, updated_at=? WHERE id=?", (filename, utc_now_iso(), session_id))
                connection.commit()
                return {**self.initialize(), "screenshotName": filename, "screenshotPath": str(screenshot_path), "alreadyExisted": False, "bytesWritten": len(image)}
            except Exception:
                connection.rollback()
                if screenshot_path is not None:
                    screenshot_path.unlink(missing_ok=True)
                raise
            finally:
                connection.close()

    def finish_session(self, session_id: str, data: dict[str, Any]) -> dict[str, Any]:
        session_id = _safe_identifier(session_id, SESSION_ID_PATTERN, "session ID")
        ended_ms = int(data.get("endedAt") or 0)
        if ended_ms <= 0:
            raise ValueError("Session end timestamp must be positive.")
        with self._lock, closing(self._connect()) as connection:
            cursor = connection.execute(
                """UPDATE sessions SET ended_at=?, duration_seconds=?, activity_score=?,
                   violations_count=?, status=?, updated_at=? WHERE id=?""",
                (utc_iso_from_ms(ended_ms), max(0.0, float(data.get("durationSeconds") or 0)),
                 min(200, max(0, int(data.get("activityScore") or 0))), max(0, int(data.get("violationsCount") or 0)),
                 str(data.get("status") or "COMPLETED")[:30], utc_now_iso(), session_id),
            )
            connection.commit()
        return {"sessionId": session_id, "saved": cursor.rowcount == 1}

    def list_violations(self, limit: int = 100) -> list[dict[str, Any]]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                """SELECT event_id, session_id, event_time AS violation_time, ended_at,
                          event_type AS violation_type, duration_ms, confidence, severity,
                          score_impact, source, description, screenshot_name, screenshot_path,
                          created_at, updated_at
                   FROM events WHERE score_impact > 0 OR screenshot_name IS NOT NULL
                   ORDER BY event_time DESC LIMIT ?""",
                (min(1_000, max(1, int(limit))),),
            ).fetchall()
        return [dict(row) for row in rows]

    def delete_violation(self, event_id: str) -> dict[str, Any]:
        event_id = _safe_identifier(event_id, EVENT_ID_PATTERN, "event ID")
        with self._lock:
            connection = self._connect()
            screenshot_path: Path | None = None
            temporary_path: Path | None = None
            try:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute("SELECT screenshot_name FROM events WHERE event_id=?", (event_id,)).fetchone()
                if row is None:
                    connection.commit()
                    return {"deleted": False, "eventId": event_id}
                screenshot_name = row["screenshot_name"]
                if screenshot_name:
                    screenshot_name = _safe_identifier(screenshot_name, SCREENSHOT_NAME_PATTERN, "screenshot filename")
                    screenshot_path = self.screenshots_root / screenshot_name
                    if screenshot_path.exists():
                        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{screenshot_name}.", suffix=".deleting", dir=self.screenshots_root)
                        os.close(descriptor)
                        temporary_path = Path(temporary_name)
                        temporary_path.unlink(missing_ok=True)
                        os.replace(screenshot_path, temporary_path)
                connection.execute("DELETE FROM violations WHERE event_id=?", (event_id,))
                connection.execute("DELETE FROM events WHERE event_id=?", (event_id,))
                connection.commit()
                if temporary_path is not None:
                    temporary_path.unlink(missing_ok=True)
                return {"deleted": True, "eventId": event_id, "screenshotName": screenshot_name,
                        "screenshotDeleted": screenshot_path is None or not screenshot_path.exists()}
            except Exception:
                connection.rollback()
                if temporary_path is not None and temporary_path.exists() and screenshot_path is not None:
                    os.replace(temporary_path, screenshot_path)
                raise
            finally:
                connection.close()

    def close(self) -> None:
        """Connections are short lived; kept for a stable host lifecycle API."""
