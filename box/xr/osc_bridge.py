#!/usr/bin/env python3
"""Local-only NCOM Focal OS to VRChat OSC bridge.

This sends only configured avatar parameters. It is not an HMD tracking driver.
SteamVR/OpenXR pose, display, hand tracking, and passthrough must come from a separate runtime.
"""
from __future__ import annotations

import json
import math
import os
import re
import socket
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
MAPPING_PATH = Path(os.environ.get("NCOM_OSC_MAPPING", str(HERE / "avatar-mapping.json")))
HTTP_PORT = int(os.environ.get("NCOM_OSC_HTTP_PORT", "8765"))
VRCHAT_SEND_PORT = int(os.environ.get("NCOM_VRCHAT_SEND_PORT", "9000"))
VRCHAT_RECV_PORT = int(os.environ.get("NCOM_VRCHAT_RECV_PORT", "9001"))
SIGNAL_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
PARAM_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")


def _osc_string(value: str) -> bytes:
    data = value.encode("utf-8") + b"\0"
    return data + (b"\0" * ((-len(data)) % 4))


def encode_osc_message(address: str, value: Any) -> bytes:
    """Encode one simple OSC message using a supported scalar argument."""
    if not isinstance(address, str) or not address.startswith("/") or "\0" in address:
        raise ValueError("OSC address must begin with / and contain no NUL")
    if isinstance(value, bool):
        tag = "T" if value else "F"
        args = b""
    elif isinstance(value, int):
        if not -(2**31) <= value < 2**31:
            raise ValueError("OSC integer is outside signed 32-bit range")
        tag, args = "i", struct.pack(">i", value)
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("OSC float must be finite")
        tag, args = "f", struct.pack(">f", value)
    elif isinstance(value, str):
        tag, args = "s", _osc_string(value)
    else:
        raise ValueError("OSC value must be a bool, int, float, or string")
    return _osc_string(address) + _osc_string("," + tag) + args


def _read_osc_string(packet: bytes, offset: int) -> tuple[str, int]:
    end = packet.find(b"\0", offset)
    if end < 0:
        raise ValueError("unterminated OSC string")
    value = packet[offset:end].decode("utf-8", errors="strict")
    return value, (end + 4) & ~3


def decode_osc_packet(packet: bytes) -> list[tuple[str, Any]]:
    """Decode scalar OSC messages and bundles; ignore unsupported type tags."""
    if packet.startswith(b"#bundle\0"):
        if len(packet) < 16:
            raise ValueError("truncated OSC bundle")
        offset = 16  # bundle header plus 64-bit timetag
        decoded: list[tuple[str, Any]] = []
        while offset + 4 <= len(packet):
            size = struct.unpack_from(">I", packet, offset)[0]
            offset += 4
            if size <= 0 or offset + size > len(packet):
                raise ValueError("invalid OSC bundle element size")
            decoded.extend(decode_osc_packet(packet[offset : offset + size]))
            offset += size
        if offset != len(packet):
            raise ValueError("trailing bytes in OSC bundle")
        return decoded

    address, offset = _read_osc_string(packet, 0)
    tags, offset = _read_osc_string(packet, offset)
    if not address.startswith("/") or not tags.startswith(","):
        raise ValueError("invalid OSC message header")
    values: list[Any] = []
    for tag in tags[1:]:
        if tag == "T":
            values.append(True)
        elif tag == "F":
            values.append(False)
        elif tag == "i":
            values.append(struct.unpack_from(">i", packet, offset)[0])
            offset += 4
        elif tag == "f":
            values.append(struct.unpack_from(">f", packet, offset)[0])
            offset += 4
        elif tag == "s":
            value, offset = _read_osc_string(packet, offset)
            values.append(value)
        else:
            raise ValueError("unsupported OSC type tag: " + tag)
    return [(address, values[0] if len(values) == 1 else values)]


def load_mapping(path: Path) -> dict[str, dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    signals = data.get("signals")
    if not isinstance(signals, dict) or not signals:
        raise ValueError("mapping config must contain a non-empty signals object")
    cleaned: dict[str, dict[str, Any]] = {}
    used_parameters: set[str] = set()
    for signal, spec in signals.items():
        if not isinstance(signal, str) or not SIGNAL_RE.fullmatch(signal):
            raise ValueError("invalid signal key: " + str(signal))
        if not isinstance(spec, dict):
            raise ValueError("signal spec must be an object: " + signal)
        parameter = spec.get("parameter")
        value_type = spec.get("type")
        if not isinstance(parameter, str) or not PARAM_RE.fullmatch(parameter):
            raise ValueError("invalid avatar parameter for signal: " + signal)
        if parameter in used_parameters:
            raise ValueError("avatar parameter is mapped more than once: " + parameter)
        if value_type not in {"bool", "int", "float", "string"}:
            raise ValueError("unsupported type for signal: " + signal)
        if value_type == "float":
            low, high = spec.get("min"), spec.get("max")
            if (low is None) != (high is None):
                raise ValueError("float min/max must be specified together: " + signal)
            if low is not None and (not math.isfinite(float(low)) or not math.isfinite(float(high)) or float(low) > float(high)):
                raise ValueError("invalid float range: " + signal)
        cleaned[signal] = {**spec, "parameter": parameter, "type": value_type}
        used_parameters.add(parameter)
    return cleaned


def coerce_value(spec: dict[str, Any], value: Any) -> Any:
    kind = spec["type"]
    if kind == "bool":
        if not isinstance(value, bool):
            raise ValueError("value must be a JSON boolean")
        return value
    if kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("value must be a JSON integer")
        low, high = spec.get("min", -(2**31)), spec.get("max", 2**31 - 1)
        if not -(2**31) <= value < 2**31:
            raise ValueError("integer is outside OSC signed 32-bit range")
        return max(int(low), min(int(high), value))
    if kind == "float":
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(float(value)):
            raise ValueError("value must be a finite JSON number")
        result = float(value)
        if "min" in spec:
            result = max(float(spec["min"]), min(float(spec["max"]), result))
        return result
    if not isinstance(value, str):
        raise ValueError("value must be a JSON string")
    if len(value) > 256 or "\0" in value:
        raise ValueError("string value is too long or contains a NUL")
    return value


class BridgeState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.avatar_id: str | None = None
        self.last_seen_at: float | None = None
        self.parameters: dict[str, Any] = {}
        self.messages = 0
        self.last_error: str | None = None

    def on_osc(self, address: str, value: Any) -> None:
        now = time.time()
        with self.lock:
            self.last_seen_at = now
            self.messages += 1
            self.last_error = None
            if address == "/avatar/change" and isinstance(value, str):
                self.avatar_id = value[:256]
            elif address.startswith("/avatar/parameters/"):
                name = address.rsplit("/", 1)[-1]
                if PARAM_RE.fullmatch(name):
                    self.parameters[name] = value
                    if len(self.parameters) > 128:
                        self.parameters.pop(next(iter(self.parameters)))


STATE = BridgeState()


class OscListener(threading.Thread):
    def __init__(self) -> None:
        super().__init__(name="ncom-vrchat-osc-listener", daemon=True)
        self.stop_event = threading.Event()

    def run(self) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.bind(("127.0.0.1", VRCHAT_RECV_PORT))
            sock.settimeout(0.5)
            while not self.stop_event.is_set():
                try:
                    packet, _peer = sock.recvfrom(65535)
                except socket.timeout:
                    continue
                try:
                    for address, value in decode_osc_packet(packet):
                        STATE.on_osc(address, value)
                except (ValueError, UnicodeError, struct.error) as exc:
                    with STATE.lock:
                        STATE.last_error = str(exc)[:200]
        except OSError as exc:
            with STATE.lock:
                STATE.last_error = "OSC listener failed: " + str(exc)[:160]
        finally:
            sock.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "NCOM-FocalOS-OSC/0.1"

    def log_message(self, _format: str, *_args: Any) -> None:
        # Avoid logging user chat/avatar data by default.
        return

    def _json(self, code: int, value: dict[str, Any]) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path not in {"/health", "/v1/status"}:
            self._json(404, {"error": "not found"})
            return
        with STATE.lock:
            body = {
                "ok": True,
                "service": "NCOM Focal OS VRChat OSC bridge",
                "listen_host": "127.0.0.1",
                "vrchat_send_port": VRCHAT_SEND_PORT,
                "vrchat_receive_port": VRCHAT_RECV_PORT,
                "avatar_id": STATE.avatar_id,
                "last_seen_at": STATE.last_seen_at,
                "received_messages": STATE.messages,
                "parameters": dict(STATE.parameters),
                "last_error": STATE.last_error,
            }
        self._json(200, body)

    def do_POST(self) -> None:
        if self.path != "/v1/signal":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 8192:
                raise ValueError("body length must be between 1 and 8192 bytes")
            payload = json.loads(self.rfile.read(length))
            signal_name = payload.get("signal") if isinstance(payload, dict) else None
            if not isinstance(signal_name, str) or not SIGNAL_RE.fullmatch(signal_name):
                raise ValueError("signal must be a configured signal key")
            spec = MAPPING.get(signal_name)
            if spec is None:
                self._json(403, {"error": "signal is not allow-listed in the mapping config"})
                return
            value = coerce_value(spec, payload.get("value"))
            address = "/avatar/parameters/" + spec["parameter"]
            packet = encode_osc_message(address, value)
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sender:
                sender.sendto(packet, ("127.0.0.1", VRCHAT_SEND_PORT))
            self._json(200, {"ok": True, "signal": signal_name, "parameter": spec["parameter"], "value": value})
        except (ValueError, TypeError, json.JSONDecodeError, UnicodeError) as exc:
            self._json(400, {"error": str(exc)[:240]})
        except OSError as exc:
            self._json(502, {"error": "OSC send failed: " + str(exc)[:180]})


def main() -> None:
    global MAPPING
    if not 1 <= HTTP_PORT <= 65535 or not 1 <= VRCHAT_SEND_PORT <= 65535 or not 1 <= VRCHAT_RECV_PORT <= 65535:
        raise SystemExit("Ports must be between 1 and 65535")
    try:
        MAPPING = load_mapping(MAPPING_PATH)
    except FileNotFoundError as exc:
        raise SystemExit(
            f"Missing {MAPPING_PATH}. Copy avatar-mapping.example.json to avatar-mapping.json "
            "and edit it to match parameters declared by the VRChat avatar."
        ) from exc
    receiver = OscListener()
    receiver.start()
    server = ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), Handler)
    print(f"NCOM Focal OS OSC bridge listening only on 127.0.0.1:{HTTP_PORT}; VRChat OSC "
          f"send={VRCHAT_SEND_PORT}, receive={VRCHAT_RECV_PORT}; {len(MAPPING)} signals allow-listed.", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        receiver.stop_event.set()
        receiver.join(timeout=2)


MAPPING: dict[str, dict[str, Any]] = {}

if __name__ == "__main__":
    main()
