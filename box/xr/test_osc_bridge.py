import importlib.util
import math
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("osc_bridge", HERE / "osc_bridge.py")
osc_bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = osc_bridge
spec.loader.exec_module(osc_bridge)


class OscBridgeTests(unittest.TestCase):
    def test_bool_round_trip(self):
        packet = osc_bridge.encode_osc_message("/avatar/parameters/NCOM_Wave", True)
        self.assertEqual(
            osc_bridge.decode_osc_packet(packet),
            [("/avatar/parameters/NCOM_Wave", True)],
        )

    def test_float_round_trip(self):
        packet = osc_bridge.encode_osc_message("/avatar/parameters/NCOM_HeadYaw", 0.25)
        address, value = osc_bridge.decode_osc_packet(packet)[0]
        self.assertEqual(address, "/avatar/parameters/NCOM_HeadYaw")
        self.assertAlmostEqual(value, 0.25, places=6)

    def test_int_round_trip(self):
        packet = osc_bridge.encode_osc_message("/input/Jump", 1)
        self.assertEqual(osc_bridge.decode_osc_packet(packet), [("/input/Jump", 1)])

    def test_bundle_round_trip(self):
        first = osc_bridge.encode_osc_message("/avatar/parameters/NCOM_Wave", True)
        second = osc_bridge.encode_osc_message("/input/Jump", 0)
        bundle = b"#bundle\0" + (1).to_bytes(8, "big")
        bundle += len(first).to_bytes(4, "big") + first
        bundle += len(second).to_bytes(4, "big") + second
        self.assertEqual(
            osc_bridge.decode_osc_packet(bundle),
            [("/avatar/parameters/NCOM_Wave", True), ("/input/Jump", 0)],
        )

    def test_float_range_is_clamped(self):
        spec = {"type": "float", "min": -1.0, "max": 1.0}
        self.assertEqual(osc_bridge.coerce_value(spec, 9.0), 1.0)
        self.assertEqual(osc_bridge.coerce_value(spec, -9.0), -1.0)

    def test_reject_nan(self):
        with self.assertRaises(ValueError):
            osc_bridge.coerce_value({"type": "float"}, math.nan)

    def test_bool_is_not_an_int(self):
        with self.assertRaises(ValueError):
            osc_bridge.coerce_value({"type": "int"}, True)

    def test_invalid_address_rejected(self):
        with self.assertRaises(ValueError):
            osc_bridge.encode_osc_message("not-an-address", 1)


if __name__ == "__main__":
    unittest.main()
