import base64
import sqlite3
import tempfile
import unittest
from pathlib import Path

from local_evidence_store import LocalEvidenceStore, utc_iso_from_ms


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9WQAAAAASUVORK5CYII="
)


class LocalEvidenceStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "LookAtMeViolations"
        self.store = LocalEvidenceStore(self.root)

    def tearDown(self) -> None:
        self.store.close()
        self.temp.cleanup()

    def save(self, event_id: str, event_type: str, timestamp: int) -> dict[str, object]:
        return self.store.save_violation(
            "session_20261007_120000_a82f",
            {"id": event_id, "type": event_type, "timestamp": timestamp},
            base64.b64encode(PNG_1X1).decode(),
            "image/png",
        )

    def test_creates_simple_database_and_screenshot_folder(self) -> None:
        initialized = self.store.initialize()
        self.assertEqual(Path(initialized["dataRoot"]), self.root)
        self.assertTrue((self.root / "screenshots").is_dir())
        self.assertTrue((self.root / "violations.db").is_file())

        connection = sqlite3.connect(self.root / "violations.db")
        try:
            columns = [row[1] for row in connection.execute("PRAGMA table_info(violations)")]
        finally:
            connection.close()
        self.assertIn("violation_time", columns)
        self.assertIn("violation_type", columns)
        self.assertIn("screenshot_name", columns)

    def test_saves_png_and_links_exact_filename_to_violation(self) -> None:
        result = self.save("PHONE_DETECTED-test", "PHONE_DETECTED", 1_791_278_400_123)
        self.assertEqual(result["screenshotName"], "image001.png")
        screenshot = self.root / "screenshots" / "image001.png"
        self.assertEqual(screenshot.read_bytes(), PNG_1X1)

        connection = sqlite3.connect(self.root / "violations.db")
        try:
            row = connection.execute(
                "SELECT violation_time, violation_type, screenshot_name FROM violations"
            ).fetchone()
        finally:
            connection.close()
        self.assertEqual(row, (utc_iso_from_ms(1_791_278_400_123), "PHONE_DETECTED", "image001.png"))

    def test_uses_next_image_number_and_does_not_duplicate_event(self) -> None:
        first = self.save("PHONE_DETECTED-one", "PHONE_DETECTED", 1_791_278_400_000)
        duplicate = self.save("PHONE_DETECTED-one", "PHONE_DETECTED", 1_791_278_400_000)
        second = self.save("TAB_SWITCH-two", "TAB_SWITCH", 1_791_278_401_000)
        self.assertEqual(first["screenshotName"], "image001.png")
        self.assertTrue(duplicate["alreadyExisted"])
        self.assertEqual(second["screenshotName"], "image002.png")
        self.assertEqual(len(self.store.list_violations()), 2)

    def test_rejects_non_png_payload(self) -> None:
        with self.assertRaises(ValueError):
            self.store.save_violation(
                "session_20261007_120000_a82f",
                {"id": "PHONE_DETECTED-test", "type": "PHONE_DETECTED", "timestamp": 1},
                base64.b64encode(b"not-a-png").decode(),
                "image/png",
            )

    def test_deletes_database_row_and_matching_screenshot(self) -> None:
        saved = self.save("PHONE_DETECTED-delete", "PHONE_DETECTED", 1_791_278_400_000)
        screenshot = Path(str(saved["screenshotPath"]))
        self.assertTrue(screenshot.is_file())

        deleted = self.store.delete_violation("PHONE_DETECTED-delete")

        self.assertTrue(deleted["deleted"])
        self.assertTrue(deleted["screenshotDeleted"])
        self.assertFalse(screenshot.exists())
        self.assertEqual(self.store.list_violations(), [])

    def test_delete_missing_violation_is_idempotent(self) -> None:
        result = self.store.delete_violation("PHONE_DETECTED-missing")
        self.assertFalse(result["deleted"])


if __name__ == "__main__":
    unittest.main()
