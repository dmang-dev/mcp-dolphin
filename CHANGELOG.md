# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING: minimum Node version raised from >=18 to >=22.** Node 18 (EOL
  April 2025) and 20 (EOL April 2026) are no longer supported; only active
  LTS lines are. CI matrix now tests Node 22 + 24, and workflow actions
  bumped to `actions/checkout@v5` / `actions/setup-node@v5` (the v4 actions'
  Node 20 runtime is deprecated by GitHub as of June 2026).

## [0.2.0] - 2026-05-19

Wii Remote motion input — IR pointer, accelerometer, and MotionPlus
angular velocity. Plus an investigation that ruled out pause/resume
via the `framedrawn` event (deferred indefinitely).

### Added

- **`dolphin_set_wiimote_pointer(port, x, y)`** — IR pointer position
  for Remote port 0-3. Floats, typically -1.0..1.0 each axis.
- **`dolphin_set_wiimote_acceleration(port, x, y, z)`** — raw
  accelerometer reading in approximate g-units. Use for Wii Sports
  bowling/golf swings, Mario Galaxy shake-to-spin, etc.
- **`dolphin_set_wiimote_angular_velocity(port, x, y, z)`** — Wii
  MotionPlus rotation rate in rad/s. Requires a MotionPlus-enabled
  Remote in Dolphin's input config (Wii Sports Resort, Skyward Sword).
- Bridge bumped to **v0.2.0** with matching getters (returns float
  tuples) and setters that write through Felk's `wii_manip` with
  `ClearOn::NextFrame` semantics — same per-frame contract as the
  button setters from v0.1.0.

All three motion tools use ClearOn::NextFrame semantics — to hold a
pose, call repeatedly each frame (alternate with
`dolphin_frame_advance(1)` for TAS sequencing).

### Investigated, not shipped

- **Pause/resume via `event.framedrawn`** — hypothesis was that
  `framedrawn` fires while emu is paused (since the GUI keeps
  repainting), letting the coroutine drain commands and dispatch
  `emulation.resume()`. **Disproved** with a deadlock smoke test
  on Felk Preview 4 + Mario Party 4: framedrawn does not fire while
  paused, so pause/resume via MCP still deadlocks. Hidden cost found
  along the way: discarding `await event.framedrawn()`'s return
  value (a 1+ MB framebuffer bytes object) without explicit cleanup
  crashes Dolphin with SIGSEGV when combined with a busy poll loop.
  Won't ship pause/resume without an upstream Felk change (e.g. a
  `tick` event that fires regardless of emu state).

### Felk Preview 4 caveats (newly documented)

- **Removing a script from the Scripting panel can crash Dolphin**
  with SIGSEGV (observed twice during v0.2 testing). Workaround:
  if you need to swap scripts, restart Dolphin instead of removing.

### Known limitations (unchanged from v0.1.x)

- **Felk fork still required.** Mainline Dolphin has no scripting.
- **No `dolphin_pause` / `dolphin_resume`** — see "Investigated"
  above. Use Dolphin's GUI hotkey (default Ctrl-P) instead.
- **No swing / shake / tilt helpers** — Felk exposes them but the
  argument signatures aren't well documented; deferred to v0.3.
- **No Nunchuk / Classic Controller / GBA-via-Wii input.**
- **No screenshot tool.**
- **No memory breakpoints.**
- **Wii motion observability** — `controller.get_wiimote_*` returns
  zeros on a GameCube title because no Wii Remote emulation is
  active. To verify motion ingestion, load a Wii game.

## [0.1.1] - 2026-05-19

Quick follow-up to v0.1.0.

### Fixed

- **`package.json` description** — v0.1.0 shipped with the draft
  feature list ("controllers GC + Wii Remote + Nunchuk + Classic +
  GBA, pause/resume/reset") that didn't match what actually landed.
  Replaced with the accurate "GameCube + Wii Remote controllers,
  reset, savestate, and frame advance" line so the npm listing
  matches the README and CHANGELOG.

### Added

- **`glama.json`** + **`Dockerfile`** for the [Glama MCP registry](https://glama.ai/mcp/servers).
  The Dockerfile builds the Node server and ships the Python bridge
  alongside; the server starts cleanly without Dolphin present
  (logs a warning, serves `tools/list` regardless), which is what
  Glama's introspection check expects.

## [0.1.0] - 2026-05-19

Initial public release. Live-tested end-to-end against Felk Dolphin
"Python Scripting Preview 4" running Mario Party 4 — verified
memory reads return the real disc ID `GMPP01` at `0x80000000`,
controller state round-trips, savestate save/load work, and the
frame counter advances at 60 fps.

### Added

- **Node.js MCP server** that talks to a Python bridge running inside
  [Felk's Dolphin fork](https://github.com/Felk/dolphin) — the only
  living scripting path for Dolphin (mainline has no Python/Lua,
  the dolphinWatch and SwareJonge Lua forks are dead, the mainline
  Python PR has been stuck since 2022).
- **Python bridge (`bridge/mcp_bridge.py`)** — loaded into Dolphin
  via Felk's Scripting panel. Single-threaded coroutine: opens a
  non-blocking TCP listener on `127.0.0.1:55355` and polls it from
  the main coroutine between `await event.frameadvance()` calls.
  All Dolphin API dispatch happens on the emu thread.
- **`npx mcp-dolphin --print-bridge`** — emits the bridge script to
  stdout so users can pipe it into a file and load it into Dolphin
  without a separate download. Single source of truth: the bridge
  ships in the same npm package as the Node server.
- **13 MCP tools** covering:
  - Memory r/w: `dolphin_read8/16/32/64`, `dolphin_write8/16/32/64`,
    `dolphin_read_range` (up to 64 KiB hex dump). PowerPC big-endian
    handled by the bridge.
  - Controllers: `dolphin_press_gc_buttons` (full GameCube — digital
    + analog sticks + triggers), `dolphin_press_wiimote_buttons`
    (basic Wii Remote buttons).
  - Emulation: `dolphin_reset`.
  - Savestate: `dolphin_save_state` / `dolphin_load_state` (slots
    0-255; 1-10 mirror F1-F10 in Dolphin's GUI).
  - Frame advance: `dolphin_frame_advance` — client-side polling on
    `frame.get_count` (which the bridge increments after each
    `await event.frameadvance()`).
  - Introspection: `dolphin_ping`, `dolphin_get_info`.
- **Lazy reconnect** — the Node side memoises the connect promise
  and clears it in the close handler so calls survive a Dolphin
  restart or bridge-script reload without restarting the MCP
  server. (Lesson directly imported from mcp-ppsspp v0.1.4.)
- **TDQS-templated tool descriptions** — PURPOSE / USAGE / BEHAVIOR
  / RETURNS, with GameCube + Wii memory map embedded in every
  memory-tool description.

### Architecture notes (why the bridge is single-threaded)

First attempt used `socketserver.ThreadingTCPServer` with one Python
thread per connection, plus an `event.on_frameadvance(callback)` hook
for the frame counter. Felk Preview 4 segfaulted with SIGSEGV on
script load. Removing the callback alone didn't help; the
`threading.Thread(...).start()` call appears to be the trigger
inside Felk's embedded Python (Preview 4, Python 3.12 embedded).

The working pattern is single-threaded:
- Non-blocking `socket.socket` (no `socketserver`)
- All accept + recv + dispatch happens in the main coroutine
- The coroutine yields with `await event.frameadvance()` between polls

Round-trip latency is bounded by one frame (~16.7 ms at 60 fps) which
is fine for agent workflows. No threading inside the bridge means no
GIL or refcount races with Felk's C++ side.

### Known limitations

- **Felk fork required.** Mainline Dolphin doesn't support Python
  scripting; mcp-dolphin will not work with stock Dolphin. Build link:
  https://github.com/Felk/dolphin/releases — currently "Python Scripting Preview 4".
- **No `dolphin_pause` / `dolphin_resume` in v0.1.0.** When emu is
  paused, `await event.frameadvance()` doesn't fire, the coroutine
  sleeps, and no new commands can be dispatched (including resume).
  Pause emu via Dolphin's GUI hotkey (default Ctrl-P) instead.
  v0.2.0 will explore using `event.framedrawn` (fires even while
  paused) as the coroutine yield point.
- **No Wii Remote motion in v0.1.0** — pointer, accelerometer,
  swing, shake, tilt are deferred. Wii titles requiring motion
  input have limited agent control until v0.2.
- **No Nunchuk / Classic Controller / GBA-via-Wii input** in v0.1.0
  — Felk exposes these but the MCP wrappers aren't wired yet.
- **No screenshot tool** — Felk's `gui` module has draw primitives
  (lines, rects, text overlays) but no capture export. Workaround:
  use Dolphin's built-in screenshot hotkey.
- **No memory breakpoints** — Felk's `memory.add_memcheck` is
  available but not yet wrapped.
- **`dolphin_get_info` doesn't query game metadata** — Felk's API
  doesn't expose disc ID / title directly. Read OS_GLOBALS at
  `0x80000000` with `dolphin_read_range`: first 4 bytes are the
  disc ID ASCII (e.g. `GMPP` for Mario Party 4), bytes 4-5 are the
  maker code, byte 6 is disc number, byte 7 is disc version.

[Unreleased]: https://github.com/dmang-dev/mcp-dolphin/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/dmang-dev/mcp-dolphin/releases/tag/v0.2.0
[0.1.1]: https://github.com/dmang-dev/mcp-dolphin/releases/tag/v0.1.1
[0.1.0]: https://github.com/dmang-dev/mcp-dolphin/releases/tag/v0.1.0
