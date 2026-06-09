# mcp_bridge.py — Python bridge inside Felk's Dolphin fork
# ─────────────────────────────────────────────────────────
#
# This script runs INSIDE Dolphin via Felk's Python scripting panel
# (View → Scripting → Add New Script → point at this file). It opens a
# TCP server on 127.0.0.1:55355 and accepts newline-delimited JSON
# commands from the mcp-dolphin Node server, translating each one into
# a call against Felk's Python modules.
#
# Architecture: single-threaded, non-blocking socket polled from the
# main coroutine.
#
#   ┌──────────────────────────────────────────────────────────────┐
#   │ Main coroutine (Felk script context, on emu thread)          │
#   │   while True:                                                │
#   │     await event.frameadvance()                               │
#   │     _frame_count += 1                                        │
#   │     accept any new TCP connections (non-blocking)            │
#   │     for each client: read/parse JSON lines, dispatch,        │
#   │                      write response                          │
#   └──────────────────────────────────────────────────────────────┘
#
# Why this shape: tried threaded socketserver — Felk Preview 4
# segfaults on `threading.Thread(...).start()`. Embedded Python +
# native threads + Felk's GIL handling doesn't survive in this
# release. Polling a non-blocking socket from the coroutine avoids
# threads entirely and keeps all Dolphin API calls on the emu
# thread (where they're safe).
#
# Latency: bounded by one frame (~16.7 ms at 60 fps).
#
# Known limitation: when emu is paused (via dolphin_pause or the GUI
# pause key), `await event.frameadvance()` does not fire, the
# coroutine sleeps, and no new commands are dispatched. To recover,
# unpause Dolphin via the GUI (default Ctrl-P or the toolbar). For
# this reason `dolphin_pause`/`dolphin_resume` are not safe via MCP
# in v0.1.0 — drop them from the tool list or use sparingly with the
# manual-resume workaround.
#
# Wire format (per request, one line):
#   {"id": <int>, "method": "<group.method>", "params": [...]}\n
#
# Wire format (per response, one line):
#   {"id": <int>, "result": <value>}\n
#   OR
#   {"id": <int>, "error": "<message>"}\n

print("[mcp-bridge] script start")

from dolphin import controller, emulation, event, memory, savestate
print("[mcp-bridge] imported dolphin modules OK")

import base64
import json
import socket

BRIDGE_VERSION = "0.3.0"
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 55355


_frame_count = 0

# Most recent rendered frame, captured via Felk's event.on_framedrawn:
#   (width, height, rgb_bytes)  — rgb_bytes is width*height*3 (RGB, no alpha).
# Kept latest-only so dolphin_screenshot can return the current frame (and a
# GUI-paused frame stays available). None until the first frame is drawn, or
# if this Dolphin build doesn't expose on_framedrawn (see startup probe).
_last_frame = None
_framedrawn_supported = False


def _on_framedrawn(width, height, data):
    # Fires on every drawn frame while emulation runs. Keep only the latest.
    global _last_frame
    _last_frame = (width, height, data)


# ── API dispatch ───────────────────────────────────────────────────────
def _ping(_p):     return {"bridge_version": BRIDGE_VERSION, "dolphin": "Felk Python fork"}
def _status(_p):   return {"state": "unknown (use dolphin_pause/dolphin_resume to control — but see bridge known-limitation about paused-deadlock)"}

def _read_u8(p):   return memory.read_u8(p[0])
def _read_u16(p):  return memory.read_u16(p[0])
def _read_u32(p):  return memory.read_u32(p[0])
def _read_u64(p):  return memory.read_u64(p[0])
def _read_s8(p):   return memory.read_s8(p[0])
def _read_s16(p):  return memory.read_s16(p[0])
def _read_s32(p):  return memory.read_s32(p[0])
def _read_s64(p):  return memory.read_s64(p[0])

def _read_bytes(p):
    address, length = p[0], p[1]
    if length < 1 or length > 65536:
        raise ValueError(f"length must be 1..65536, got {length}")
    out = bytearray(length)
    for i in range(length):
        out[i] = memory.read_u8(address + i)
    return out.hex()

def _write_u8(p):   memory.write_u8(p[0], p[1]);  return None
def _write_u16(p):  memory.write_u16(p[0], p[1]); return None
def _write_u32(p):  memory.write_u32(p[0], p[1]); return None
def _write_u64(p):  memory.write_u64(p[0], p[1]); return None
def _write_s8(p):   memory.write_s8(p[0], p[1]);  return None
def _write_s16(p):  memory.write_s16(p[0], p[1]); return None
def _write_s32(p):  memory.write_s32(p[0], p[1]); return None
def _write_s64(p):  memory.write_s64(p[0], p[1]); return None

def _write_bytes(p):
    address, hex_data = p[0], p[1]
    data = bytes.fromhex(hex_data)
    for i, b in enumerate(data):
        memory.write_u8(address + i, b)
    return None

def _get_gc_buttons(p):       return controller.get_gc_buttons(p[0])
def _set_gc_buttons(p):       controller.set_gc_buttons(p[0], p[1]); return None
def _get_wiimote_buttons(p):  return controller.get_wiimote_buttons(p[0])
def _set_wiimote_buttons(p):  controller.set_wiimote_buttons(p[0], p[1]); return None

# Wii Remote motion (v0.2.0).
# Felk's set_wiimote_* helpers use ClearOn::NextFrame semantics — values
# reset after one frame, same as button state. To hold a pose across many
# frames, repeat the call. Pointer/accel/angular_velocity all return
# floats; tuple unpacks as (x, y) or (x, y, z).
def _get_wiimote_pointer(p):           return controller.get_wiimote_pointer(p[0])
def _set_wiimote_pointer(p):           controller.set_wiimote_pointer(p[0], p[1], p[2]); return None
def _get_wiimote_acceleration(p):      return controller.get_wiimote_acceleration(p[0])
def _set_wiimote_acceleration(p):      controller.set_wiimote_acceleration(p[0], p[1], p[2], p[3]); return None
def _get_wiimote_angular_velocity(p):  return controller.get_wiimote_angular_velocity(p[0])
def _set_wiimote_angular_velocity(p):  controller.set_wiimote_angular_velocity(p[0], p[1], p[2], p[3]); return None

def _pause(_p):   emulation.pause();  return None
def _resume(_p):  emulation.resume(); return None
def _reset(_p):   emulation.reset();  return None

def _save_to_slot(p):    savestate.save_to_slot(p[0]);   return None
def _load_from_slot(p):  savestate.load_from_slot(p[0]); return None

def _frame_get_count(_p):  return _frame_count

def _screenshot(_p):
    if not _framedrawn_supported:
        raise RuntimeError(
            "screenshots unavailable: this Dolphin build does not expose "
            "event.on_framedrawn (needs a newer Felk scripting build)")
    if _last_frame is None:
        raise RuntimeError(
            "no frame captured yet — let the game render at least one frame, then retry")
    width, height, data = _last_frame
    return {
        "width": width,
        "height": height,
        "format": "rgb",  # width*height*3 bytes, no alpha
        "rgb_base64": base64.b64encode(bytes(data)).decode("ascii"),
    }


HANDLERS = {
    "bridge.ping":                    _ping,
    "bridge.status":                  _status,
    "memory.read_u8":                 _read_u8,
    "memory.read_u16":                _read_u16,
    "memory.read_u32":                _read_u32,
    "memory.read_u64":                _read_u64,
    "memory.read_s8":                 _read_s8,
    "memory.read_s16":                _read_s16,
    "memory.read_s32":                _read_s32,
    "memory.read_s64":                _read_s64,
    "memory.read_bytes":              _read_bytes,
    "memory.write_u8":                _write_u8,
    "memory.write_u16":               _write_u16,
    "memory.write_u32":               _write_u32,
    "memory.write_u64":               _write_u64,
    "memory.write_s8":                _write_s8,
    "memory.write_s16":               _write_s16,
    "memory.write_s32":               _write_s32,
    "memory.write_s64":               _write_s64,
    "memory.write_bytes":             _write_bytes,
    "controller.get_gc_buttons":      _get_gc_buttons,
    "controller.set_gc_buttons":      _set_gc_buttons,
    "controller.get_wiimote_buttons": _get_wiimote_buttons,
    "controller.set_wiimote_buttons": _set_wiimote_buttons,
    "controller.get_wiimote_pointer":          _get_wiimote_pointer,
    "controller.set_wiimote_pointer":          _set_wiimote_pointer,
    "controller.get_wiimote_acceleration":     _get_wiimote_acceleration,
    "controller.set_wiimote_acceleration":     _set_wiimote_acceleration,
    "controller.get_wiimote_angular_velocity": _get_wiimote_angular_velocity,
    "controller.set_wiimote_angular_velocity": _set_wiimote_angular_velocity,
    "emulation.pause":                _pause,
    "emulation.resume":               _resume,
    "emulation.reset":                _reset,
    "savestate.save_to_slot":         _save_to_slot,
    "savestate.load_from_slot":       _load_from_slot,
    "frame.get_count":                _frame_get_count,
    "gui.screenshot":                 _screenshot,
}


# ── Non-blocking listening socket ──────────────────────────────────────
_listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
_listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
_listener.bind((LISTEN_HOST, LISTEN_PORT))
_listener.listen(8)
_listener.setblocking(False)
print(f"[mcp-bridge] listening on {LISTEN_HOST}:{LISTEN_PORT} (bridge v{BRIDGE_VERSION})")


# Each client: (sock, rxbuffer_bytes)
_clients = []


def _dispatch_line(line_bytes):
    """Parse a single request line and return the response bytes."""
    req_id = None
    try:
        req = json.loads(line_bytes.decode("utf-8").strip())
        req_id = req.get("id")
        method = req["method"]
        params = req.get("params", [])
        handler = HANDLERS.get(method)
        if handler is None:
            raise KeyError(f"unknown method: {method}")
        result = handler(params)
        resp = {"id": req_id, "result": result}
    except Exception as e:
        resp = {"id": req_id, "error": f"{type(e).__name__}: {e}"}
    return (json.dumps(resp) + "\n").encode("utf-8")


def _poll_sockets():
    """Accept new connections and process any pending data on existing ones."""
    global _clients

    # Accept new connections (non-blocking — may raise BlockingIOError).
    while True:
        try:
            sock, addr = _listener.accept()
            sock.setblocking(False)
            _clients.append([sock, b""])
            print(f"[mcp-bridge] connection from {addr}")
        except BlockingIOError:
            break
        except Exception as e:
            print(f"[mcp-bridge] accept error: {type(e).__name__}: {e}")
            break

    # Process each existing client.
    keep = []
    for entry in _clients:
        sock, buf = entry
        alive = True
        # Read everything available.
        while True:
            try:
                chunk = sock.recv(4096)
            except BlockingIOError:
                break
            except Exception as e:
                print(f"[mcp-bridge] recv error: {type(e).__name__}: {e}")
                alive = False
                break
            if chunk == b"":
                # Peer closed.
                alive = False
                break
            buf += chunk

        # Dispatch any complete lines we have.
        while b"\n" in buf:
            line, _, buf = buf.partition(b"\n")
            response = _dispatch_line(line)
            try:
                sock.sendall(response)
            except Exception as e:
                print(f"[mcp-bridge] send error: {type(e).__name__}: {e}")
                alive = False
                break

        if alive:
            entry[1] = buf
            keep.append(entry)
        else:
            try:
                sock.close()
            except Exception:
                pass
    _clients = keep


# Register the framebuffer callback so dolphin_screenshot has a frame to return.
# event.on_framedrawn is a newer Felk addition — probe it so older builds keep
# working (screenshots just stay unavailable there).
try:
    event.on_framedrawn(_on_framedrawn)
    _framedrawn_supported = True
    print("[mcp-bridge] on_framedrawn registered — dolphin_screenshot enabled")
except Exception as e:
    print(f"[mcp-bridge] on_framedrawn unavailable ({type(e).__name__}: {e}) — dolphin_screenshot disabled")

print("[mcp-bridge] entering frame loop")
while True:
    await event.frameadvance()
    _frame_count += 1
    _poll_sockets()
