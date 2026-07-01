# mcp-dolphin

[![npm version](https://img.shields.io/npm/v/mcp-dolphin.svg)](https://www.npmjs.com/package/mcp-dolphin)
[![npm downloads](https://img.shields.io/npm/dm/mcp-dolphin.svg)](https://www.npmjs.com/package/mcp-dolphin)
[![CI](https://github.com/dmang-dev/mcp-dolphin/actions/workflows/ci.yml/badge.svg)](https://github.com/dmang-dev/mcp-dolphin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/mcp-dolphin.svg)](LICENSE)
[![Snyk](https://snyk.io/test/npm/mcp-dolphin/badge.svg)](https://snyk.io/test/npm/mcp-dolphin)
[![Socket](https://img.shields.io/badge/Socket-security-2F7BFF?logo=socket)](https://socket.dev/npm/package/mcp-dolphin)
[![Bundlephobia](https://img.shields.io/badge/bundlephobia-size-FF6B81)](https://bundlephobia.com/package/mcp-dolphin)
[![npmgraph](https://img.shields.io/badge/npmgraph-dependencies-2496ED)](https://npmgraph.js.org/?q=mcp-dolphin)

An [MCP](https://modelcontextprotocol.io) server for **Dolphin** (GameCube + Wii) — drives memory r/w, controller input (GameCube + Wii Remote), pause/resume/reset, savestates, and frame advance from MCP-compatible clients (Claude Desktop, Claude Code, etc.).

## What you can do with it

- **Read & write emulated PowerPC memory** — 8/16/32/64-bit, MEM1 + MEM2
- **Send controller input** — GameCube (digital + analog sticks + triggers), Wii Remote (buttons + IR pointer + accelerometer + MotionPlus angular velocity)
- **Reset** the emulator (pause/resume not in v0.1.0 — see Known limitations)
- **Save / load state** to numbered slots (0-255; 1-10 map to F1-F10 in Dolphin)
- **Frame advance** — wait N frames synchronously for TAS-style precision

Not yet wired in v0.1.0 (deferred to a later release):
- Wii Remote motion (pointer, accelerometer, swing, shake, tilt)
- Nunchuk / Classic Controller / GBA-via-Wii input
- Memory breakpoints, register access, screenshots

## Architecture (and the hard prerequisite)

```
┌─────────────────────────────────────────────────┐
│ Dolphin (Felk's fork — required, not mainline)  │
│                                                 │
│   mcp_bridge.py loaded via Scripting panel      │
│   └─ TCP server on 127.0.0.1:55355              │
└─────────────────────────────────────────────────┘
                  ↕ TCP loopback (newline-delimited JSON)
┌─────────────────────────────────────────────────┐
│ mcp-dolphin (Node.js — this package)            │
└─────────────────────────────────────────────────┘
                  ↕ MCP stdio
              MCP client (Claude etc.)
```

**Mainline Dolphin does not have Python scripting.** mcp-dolphin talks to [Felk's actively-maintained Dolphin fork](https://github.com/Felk/dolphin) which embeds Python with first-class access to memory, controllers, savestates, and the frame loop. Mainline Dolphin Python PRs ([#7064](https://github.com/dolphin-emu/dolphin/pull/7064)) have been stuck since 2022; the Lua forks ([dolphinWatch](https://github.com/TwitchPlaysPokemon/dolphinWatch), [SwareJonge/Dolphin-Lua-Core](https://github.com/SwareJonge/Dolphin-Lua-Core)) are dead. Felk is the only living scripting path.

## One-time setup

### 1. Install Felk's Dolphin fork

Grab a build from [Felk/dolphin Releases](https://github.com/Felk/dolphin/releases) — currently **Python Scripting Preview 4** (December 2025). Unzip it somewhere you can find. It's a regular Dolphin build plus a **Scripting** panel under the View menu.

If you see Python errors when loading the bridge, enable the Scripting log type: **View → Show Log Configuration → check Scripting** (set verbosity to "Info" or "Error"), then **View → Show Log** so the log window is visible.

### 2. Print the bridge script and load it

```bash
npx -y mcp-dolphin --print-bridge > mcp_bridge.py
```

Then in Felk's Dolphin:
1. **View → Scripting** to open the scripting panel.
2. Click **Add New Script** and pick the `mcp_bridge.py` you just wrote.
3. Verify in Dolphin's Log window — you should see `[mcp-bridge] listening on 127.0.0.1:55355 (bridge v0.1.0)`.

The script keeps running as long as Dolphin is open. Remove it from the Scripting panel to stop the bridge.

### 3. Register mcp-dolphin in your MCP client

**Claude Code:**
```bash
claude mcp add dolphin --scope user mcp-dolphin
```

**Claude Desktop** — edit `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "dolphin": {
      "command": "npx",
      "args": ["-y", "mcp-dolphin"]
    }
  }
}
```

Restart your MCP client after editing.

### 4. Verify

Load a GameCube or Wii game in Dolphin, then ask the agent to call `dolphin_ping`. You should see `OK — bridge v0.1.0 (Felk Python fork)`.

## Tools

| Tool | Description |
|------|-------------|
| `dolphin_ping` | Liveness probe + bridge-version sniff |
| `dolphin_get_info` | Report bridge version and Dolphin label |
| `dolphin_read8/16/32/64` | Read PowerPC memory (big-endian) |
| `dolphin_read_range` | Bulk read up to 64 KiB as hex dump |
| `dolphin_write8/16/32/64` | Write PowerPC memory |
| `dolphin_press_gc_buttons` | Set GameCube controller state (port + button/axis dict) |
| `dolphin_press_wiimote_buttons` | Set Wii Remote button state |
| `dolphin_set_wiimote_pointer` | Set Wii Remote IR pointer position (port + x + y) |
| `dolphin_set_wiimote_acceleration` | Set Wii Remote accelerometer (port + x + y + z, ~g units) |
| `dolphin_set_wiimote_angular_velocity` | Set Wii MotionPlus angular velocity (port + x + y + z, rad/s) |
| `dolphin_reset` | Emulation soft-reset (pause/resume deferred to v0.2 — see Known limitations) |
| `dolphin_frame_advance` | Wait N frames (TAS sequencing) |
| `dolphin_save_state` / `dolphin_load_state` | Slot-based savestate (0-255) |

## GameCube + Wii address space (cheat sheet)

| Range | Region |
|-------|--------|
| `0x80000000-0x817FFFFF` | MEM1 main RAM (24 MiB) — GC + Wii |
| `0x80000020` | `OS_GLOBALS` — disc ID, FST pointer, etc. |
| `0x90000000-0x93FFFFFF` | MEM2 (64 MiB) — **Wii only** |
| `0xCC000000+` | Flipper / Hollywood I/O — reads usually safe, writes can wedge |
| `0xCD000000+` | Wii-only Hollywood registers |

PowerPC is **big-endian** on hardware. The bridge handles byte-swap on read/write — pass and receive the value the game logically sees, not the byte order.

## Controller input

### GameCube (`dolphin_press_gc_buttons`)

```json
{
  "port": 0,
  "state": {
    "A": true, "B": false, "Start": true,
    "StickX": 200, "StickY": 128,
    "TriggerLeft": 0, "TriggerRight": 255
  }
}
```

- Digital buttons: `A, B, X, Y, Z, Start, L, R, Up, Down, Left, Right`
- Analog axes: `StickX, StickY, CStickX, CStickY` (0-255, 128 = center)
- Triggers: `TriggerLeft, TriggerRight` (0-255, 0 = released)
- Omitted keys default to released / center.

### Wii Remote (`dolphin_press_wiimote_buttons`)

```json
{ "port": 0, "state": { "A": true, "Plus": true, "Up": true } }
```

- Buttons: `A, B, One, Two, Plus, Minus, Home, Up, Down, Left, Right`
- v0.1.0 covers buttons only — motion, pointer, Nunchuk, Classic Controller deferred to a future release.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `DOLPHIN_BRIDGE_HOST` | `127.0.0.1` | Bridge host (the Dolphin process is local, so this rarely changes) |
| `DOLPHIN_BRIDGE_PORT` | `55355` | Bridge port (must match `LISTEN_PORT` in `mcp_bridge.py`) |
| `DOLPHIN_TIMEOUT_MS` | `10000` | Per-call timeout |
| `MCP_DOLPHIN_DEBUG` | unset | Set to `1` to trace every TX message on stderr |

If you change the port, edit both `mcp_bridge.py` (in your scripts dir) and set `DOLPHIN_BRIDGE_PORT`.

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `Dolphin bridge not reachable` | Dolphin not running, script not loaded in Scripting panel, or wrong port. Check Dolphin's Log window for `[mcp-bridge] listening on ...`. |
| `unknown method: <something>` from bridge | Bridge script is older than mcp-dolphin. Re-export with `npx mcp-dolphin --print-bridge > mcp_bridge.py` and reload in Dolphin. |
| Memory reads return 0xFFFFFFFF or error | Address is unmapped on the current title. MEM2 (`0x90000000+`) is Wii-only; reading it on a GameCube game returns garbage. |
| Controller input has no effect | Game expects input on a different port. Try `port: 0` first, then 1-3. For Wii games requiring motion, this v0.1.0 doesn't cover Wii Remote pointer/accel yet. |
| Tool calls hang ~10 s then time out | Bridge script crashed inside Dolphin. Open Felk's Scripting panel, remove the script, re-add it. |

## Debugging with the MCP Inspector

Browse and call this server's tools interactively with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npm run inspector
```

Build first if you've edited `src/` since your last `npm install` (`npm run build`, or keep `npm run dev` running). Override the bridge address with `DOLPHIN_BRIDGE_HOST` / `DOLPHIN_BRIDGE_PORT` (default `127.0.0.1:55355`). `tools/list` works even without Dolphin connected; *calling* a tool needs Felk's Dolphin running `bridge/mcp_bridge.py`.

## License

MIT — see [LICENSE](LICENSE).
