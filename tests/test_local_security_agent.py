import io
import json
import struct
import unittest

from local_security_agent import NativeMessageIO, ShortcutDetector


class NativeMessageIOTests(unittest.TestCase):
    def test_round_trip_uses_length_prefixed_utf8_json(self) -> None:
        writer = io.BytesIO()
        protocol = NativeMessageIO(io.BytesIO(), writer)
        protocol.send_message({"type": "status", "message": "готово"})
        raw = writer.getvalue()
        size = struct.unpack("@I", raw[:4])[0]
        self.assertEqual(size, len(raw[4:]))
        self.assertEqual(json.loads(raw[4:].decode("utf-8"))["message"], "готово")

        reader = NativeMessageIO(io.BytesIO(raw), io.BytesIO())
        self.assertEqual(reader.read_message(), {"type": "status", "message": "готово"})


class ShortcutDetectorTests(unittest.TestCase):
    def test_detects_only_protected_combinations(self) -> None:
        detector = ShortcutDetector()
        self.assertEqual(detector.process("x", "down", 0), [])
        detector.process("x", "up", 0.1)
        detector.process("ctrl", "down", 1)
        signal = detector.process("c", "down", 1.1)
        self.assertEqual([(item.event_type, item.shortcut) for item in signal], [("COPY_ATTEMPT", "ctrl+c")])

    def test_detects_alt_tab_windows_and_print_screen_with_debounce(self) -> None:
        detector = ShortcutDetector()
        detector.process("alt", "down", 0)
        self.assertEqual(detector.process("tab", "down", 0.1)[0].event_type, "ALT_TAB_ATTEMPT")
        self.assertEqual(detector.process("tab", "down", 0.2), [])
        self.assertEqual(detector.process("left windows", "down", 1)[0].event_type, "SYSTEM_KEY_ATTEMPT")
        self.assertEqual(detector.process("print screen", "down", 2)[0].event_type, "PRINT_SCREEN_ATTEMPT")


if __name__ == "__main__":
    unittest.main()
