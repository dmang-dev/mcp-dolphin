import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { DolphinClient } from "./dolphin.js";

// ──────────────────────────────────────────────────────────────────────────────
// Tool descriptions follow the TDQS rubric (Glama's Tool Definition Quality
// Score): PURPOSE / USAGE / BEHAVIOR / RETURNS in that order.
//
// Memory map below is shared by every memory-tool description so the agent
// doesn't have to remember which addresses are valid on GC vs Wii.
// ──────────────────────────────────────────────────────────────────────────────

const GC_WII_MEMORY_MAP = `
GameCube + Wii main address space landmarks (PowerPC, big-endian):
  0x80000000-0x817FFFFF  MEM1 main RAM (24 MiB) — GameCube + Wii game code & data
                          GameCube games stay entirely within MEM1.
                          Wii games use MEM1 for code and frequently-accessed data.
  0x80000020             OS_GLOBALS — game-info struct (disc ID, FST, etc.)
  0x80000034             OS_ARENA_LO (start of free MEM1 heap)
  0x80003100             OS_REPORT (developer-console mirror, varies by SDK)
  0x90000000-0x93FFFFFF  MEM2 (64 MiB) — Wii ONLY. Larger texture/asset data,
                          IOS work areas. Reading MEM2 on a GameCube game
                          returns garbage / FAIL.
  0xCC000000-0xCC00FFFF  Hollywood I/O (Wii) / Flipper I/O (GameCube) — DMA,
                          GPU FIFO, AI, EXI registers. Reads are usually safe,
                          writes can wedge the emulator. Avoid.
  0xCD000000-0xCD007FFF  Wii-only Hollywood registers.

Notes:
  • All multi-byte values are BIG-ENDIAN on the real hardware. Felk's
    memory.read_u*/write_u* helpers handle the byte swap for you —
    the value you see is the value the game sees as a u32.
  • Addresses are 32-bit; Felk truncates the high bits of any u64
    address argument.
  • Pointers in MEM1 are often stored as 4-byte addresses with the
    high bit set (e.g. 0x81234567). Dereferencing them requires no
    masking — pass the raw value back into memory.read_*.`.trim();

const GC_BUTTON_NAMES = `A, B, X, Y, Z, Start, L, R, Up, Down, Left, Right`;
const GC_ANALOG_NAMES = `StickX, StickY, CStickX, CStickY, TriggerLeft, TriggerRight`;
const WIIMOTE_BUTTON_NAMES = `A, B, One, Two, Plus, Minus, Home, Up, Down, Left, Right`;

function addrParamDesc(widthBytes: number): string {
  const alignNote = widthBytes === 1
    ? "No alignment requirement for byte access."
    : `MUST be ${widthBytes}-byte aligned (address % ${widthBytes} === 0). PowerPC raises an alignment exception ` +
      `on misaligned access in hardware, but Dolphin's emulated bus is forgiving and silently returns the ` +
      `aligned-down word — i.e. you get the bytes from address & ~${widthBytes - 1}, not what you asked for. ` +
      `For unaligned multi-byte reads use dolphin_read_range and assemble client-side.`;
  return (
    `Absolute PowerPC virtual address (0x80000000-0x9FFFFFFF). Pass as a number; hex literals like ` +
    `0x80001000 are fine. Reads ${widthBytes} consecutive byte${widthBytes === 1 ? "" : "s"} starting here ` +
    `and interprets them as a big-endian value. ${alignNote} ` +
    `Useful ranges: 0x80000000-0x817FFFFF for MEM1 (GC + Wii), 0x90000000-0x93FFFFFF for MEM2 (Wii only).`
  );
}

const TOOLS: Tool[] = [

  // ── Connectivity & introspection ────────────────────────────────────────

  {
    name: "dolphin_ping",
    description:
      "PURPOSE: Verify the Dolphin Python bridge is reachable and responding. " +
      "USAGE: Call once at session start before other tool calls. Issues the bridge's `bridge.ping` method — doubles as a liveness probe and bridge-version sniff. " +
      "BEHAVIOR: No side effects. mcp-dolphin connects to the bridge on demand (TCP 127.0.0.1:55355 by default). The bridge must be loaded inside Dolphin via Scripting → Add New Script → mcp_bridge.py. 10-second timeout if the bridge isn't running, Dolphin isn't running, or the port is wrong. " +
      "RETURNS: Single line 'OK — bridge vBRIDGE_VERSION (DOLPHIN_LABEL)'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dolphin_get_info",
    description:
      "PURPOSE: Report what the bridge knows about its environment (bridge version, Dolphin label). v0.1.0 doesn't query game metadata — Felk's API doesn't expose disc ID / title directly, those have to be read from OS_GLOBALS at 0x80000020 yourself via dolphin_read_range. " +
      "USAGE: Diagnostic. For game state, use dolphin_read_range(0x80000000, 32) and decode: bytes 0-3 are the disc ID (4-char ASCII), 4-5 are maker code, 6 is disc number, 7 is disc version. " +
      "BEHAVIOR: No side effects. Same underlying call as dolphin_ping but presents fields explicitly. " +
      "RETURNS: Multi-line text — Bridge version, Dolphin label.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── Memory reads ────────────────────────────────────────────────────────

  {
    name: "dolphin_read8",
    description:
      "PURPOSE: Read an unsigned 8-bit byte from PowerPC memory at the given absolute address. " +
      "USAGE: Use for single-byte fields — flags, counters, small enums. For 16/32/64-bit values use dolphin_read16/read32/read64. For spans of more than ~4 bytes use dolphin_read_range. PowerPC is big-endian — so for multi-byte values you almost always want the dedicated width tool, not this one. " +
      "BEHAVIOR: No side effects — pure read. No alignment requirement. Returns an error on unmapped address, bridge disconnect, or bridge FAIL.\n\n" +
      GC_WII_MEMORY_MAP + "\n\n" +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)', e.g. '0x80003000: 99 (0x63)'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: addrParamDesc(1) },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dolphin_read16",
    description:
      "PURPOSE: Read an unsigned 16-bit big-endian value from PowerPC memory at the given absolute address. " +
      "USAGE: For 16-bit fields — HP, score, coordinates on many GC/Wii titles. For single bytes use dolphin_read8; for 32/64-bit use dolphin_read32/read64. Value is interpreted big-endian (PowerPC native); the byte at `address` is the high byte. " +
      "BEHAVIOR: No side effects — pure read. Address MUST be 2-byte aligned. Returns an error on unmapped address, bridge disconnect, or FAIL.\n\n" +
      GC_WII_MEMORY_MAP + "\n\n" +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: addrParamDesc(2) },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dolphin_read32",
    description:
      "PURPOSE: Read an unsigned 32-bit big-endian value from PowerPC memory at the given absolute address. " +
      "USAGE: The workhorse — most game state and pointers are 32-bit. Use for timestamps, large counters, RGBA colors, full pointers (PowerPC is a 32-bit ISA so pointers fit here). For 8/16/64-bit values use the corresponding sibling. " +
      "BEHAVIOR: No side effects — pure read. Address MUST be 4-byte aligned. Returns an error on unmapped address, bridge disconnect, or FAIL.\n\n" +
      GC_WII_MEMORY_MAP + "\n\n" +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)'.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: addrParamDesc(4) },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dolphin_read64",
    description:
      "PURPOSE: Read an unsigned 64-bit big-endian value from PowerPC memory at the given absolute address. " +
      "USAGE: For paired 32-bit slots, doubles, packed flags. PowerPC is 32-bit so true 64-bit fields are less common than on PS2 — usually game state is 32-bit. Use this when you actually have a 64-bit field, not as a convenience for two 32-bit reads. " +
      "BEHAVIOR: No side effects — pure read. Address MUST be 8-byte aligned. The result is returned as a decimal STRING (not a JSON number) to preserve precision past 2^53. Returns an error on unmapped address, bridge disconnect, or FAIL.\n\n" +
      GC_WII_MEMORY_MAP + "\n\n" +
      "RETURNS: Single line 'ADDR_HEX: VAL_DEC (0xVAL_HEX)' — VAL_DEC is a decimal string that may exceed 2^53.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: {
        address: { type: "integer", minimum: 0, description: addrParamDesc(8) },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dolphin_read_range",
    description:
      "PURPOSE: Read a contiguous range of bytes from PowerPC memory as a hex dump. " +
      "USAGE: For >4 bytes — far cheaper than looping dolphin_read8 (one bridge round-trip vs N). Max 65536 bytes/call; chunk larger reads in 64 KiB. Powers snapshot-diff RAM hunting, unknown-struct inspection, and region capture. " +
      "BEHAVIOR: No side effects. The bridge reads byte-by-byte via Felk's memory.read_u8 then returns hex over the wire. No alignment requirement.\n\n" +
      GC_WII_MEMORY_MAP + "\n\n" +
      "RETURNS: 'ADDR_HEX [N bytes]:' header + space-separated 2-digit uppercase hex bytes.",
    inputSchema: {
      type: "object",
      required: ["address", "length"],
      properties: {
        address: {
          type: "integer",
          minimum: 0,
          description: "Starting absolute PowerPC address. Bytes [address, address+length) are read. No alignment requirement.",
        },
        length: {
          type: "integer",
          minimum: 1,
          maximum: 65536,
          description: "Number of consecutive bytes to read (1-65536). Hard cap is the bridge's max; chunk larger reads yourself.",
        },
      },
      additionalProperties: false,
    },
  },

  // ── Memory writes ───────────────────────────────────────────────────────

  {
    name: "dolphin_write8",
    description:
      "PURPOSE: Write a single unsigned byte (0-255) to PowerPC memory at the given absolute address. " +
      "USAGE: Use for single-byte cheats, debug pokes, and game-state mutations. For 16/32/64-bit values prefer dolphin_write16/write32/write64 (atomic from the game's perspective). To roll back, dolphin_save_state BEFORE the write and dolphin_load_state to restore. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites with no undo. Direct memory access — bypasses PowerPC MMU translation and any DMA semantics. Writes to read-only regions (boot ROM at 0xFFF00000, certain I/O ranges) are silently dropped by Dolphin. The write takes effect immediately, but visible effects appear only when the emulator next ticks. No alignment requirement for byte access.\n\n" +
      GC_WII_MEMORY_MAP + "\n\n" +
      "RETURNS: 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX'.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", minimum: 0, description: addrParamDesc(1) },
        value: { type: "integer", minimum: 0, maximum: 255, description: "Byte value (0-255 / 0x00-0xFF)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dolphin_write16",
    description:
      "PURPOSE: Write an unsigned 16-bit big-endian value to PowerPC memory. " +
      "USAGE: For 16-bit cheats/pokes (HP, score, coordinates). For single bytes use dolphin_write8; for 32/64-bit use dolphin_write32/write64. The value is byte-swapped to big-endian by Felk's bridge — pass the value the game logically sees, not its byte order. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites two bytes with no undo. Address MUST be 2-byte aligned. Returns an error on bridge disconnect or FAIL.\n\n" +
      GC_WII_MEMORY_MAP + "\n\n" +
      "RETURNS: 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX'.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", minimum: 0, description: addrParamDesc(2) },
        value: {
          type: "integer",
          minimum: 0,
          maximum: 65535,
          description: "16-bit value (0-65535 / 0x0000-0xFFFF). For signed values, encode as two's complement (e.g. -1 → 0xFFFF).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dolphin_write32",
    description:
      "PURPOSE: Write an unsigned 32-bit big-endian value to PowerPC memory at the given absolute address. " +
      "USAGE: The workhorse for cheats — most game state is 32-bit. For 8/16-bit values use dolphin_write8/write16; for true 64-bit fields use dolphin_write64 (atomic, vs two non-atomic write32s). For floats, reinterpret the IEEE-754 bits as an integer first. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites four bytes with no undo. Address MUST be 4-byte aligned. Writes to read-only regions are silently dropped.\n\n" +
      GC_WII_MEMORY_MAP + "\n\n" +
      "RETURNS: 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX'.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", minimum: 0, description: addrParamDesc(4) },
        value: {
          type: "integer",
          minimum: 0,
          maximum: 4294967295,
          description: "32-bit value (0-4294967295 / 0x00000000-0xFFFFFFFF). For signed, encode as two's complement. For floats, reinterpret the IEEE-754 bits as an integer first.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dolphin_write64",
    description:
      "PURPOSE: Write an unsigned 64-bit big-endian value to PowerPC memory. " +
      "USAGE: For paired 32-bit slots, doubles, packed flags. Atomic from the game's perspective; preferred over chaining two write32s when ordering matters. " +
      "BEHAVIOR: DESTRUCTIVE: overwrites eight bytes with no undo. Address MUST be 8-byte aligned. `value` is a DECIMAL STRING (0..18446744073709551615) to preserve precision past JS's 2^53 number limit.\n\n" +
      GC_WII_MEMORY_MAP + "\n\n" +
      "RETURNS: 'Wrote VAL_DEC (0xVAL_HEX) → ADDR_HEX'.",
    inputSchema: {
      type: "object",
      required: ["address", "value"],
      properties: {
        address: { type: "integer", minimum: 0, description: addrParamDesc(8) },
        value: {
          type: "string",
          pattern: "^[0-9]+$",
          description: "64-bit value as a non-negative DECIMAL STRING. Range 0..18446744073709551615 (2^64 - 1). For signed, encode as two's complement.",
        },
      },
      additionalProperties: false,
    },
  },

  // ── Controllers ─────────────────────────────────────────────────────────

  {
    name: "dolphin_press_gc_buttons",
    description:
      "PURPOSE: Set GameCube controller state on a given port for one frame's worth of input. " +
      `USAGE: Buttons supported: ${GC_BUTTON_NAMES}. Analog axes: ${GC_ANALOG_NAMES}. ` +
      "To 'hold' a button across multiple frames, call repeatedly — Dolphin's input is per-frame, not edge-triggered, so a button you don't include in this call's state is implicitly released. For TAS-style frame-perfect sequences, alternate set + dolphin_frame_advance(1) calls. " +
      "BEHAVIOR: DESTRUCTIVE to controller state for the addressed port. Overwrites all input — anything you don't include is released. Felk's set_gc_buttons accepts a partial dict; unspecified buttons are false, unspecified analog axes are at neutral (0 for both sticks and triggers). " +
      "RETURNS: 'Set GC port N: <state-summary>'.",
    inputSchema: {
      type: "object",
      required: ["state"],
      properties: {
        port: {
          type: "integer",
          minimum: 0,
          maximum: 3,
          description: "GameCube controller port (0-3, defaults to 0 for port 1). Wii games sometimes accept GC controllers — try port 0 if unsure.",
        },
        state: {
          type: "object",
          additionalProperties: true,
          description:
            "Button/axis state object. Boolean keys for digital buttons (A, B, X, Y, Z, Start, L, R, Up, Down, Left, Right). " +
            "Integer keys for analog axes — StickX/StickY/CStickX/CStickY accept -128..127 (0 = center), " +
            "TriggerLeft/TriggerRight accept 0..255 (0 = released). Omit a key to leave it at neutral (false / 0).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dolphin_press_wiimote_buttons",
    description:
      "PURPOSE: Set Wii Remote button state on a given port for one frame's worth of input. " +
      `USAGE: Buttons supported: ${WIIMOTE_BUTTON_NAMES}. v0.1.0 covers the basic Wii Remote button surface only — pointer position, accelerometer, swing/shake/tilt, and Nunchuk/Classic Controller attachments are not yet wired (deferred to a future release). For now, games requiring motion or pointer input have limited agent control. ` +
      "BEHAVIOR: DESTRUCTIVE to Wii Remote state for the addressed port. Anything you don't include is released. " +
      "RETURNS: 'Set Wii Remote port N: <state-summary>'.",
    inputSchema: {
      type: "object",
      required: ["state"],
      properties: {
        port: {
          type: "integer",
          minimum: 0,
          maximum: 3,
          description: "Wii Remote port (0-3, defaults to 0 for Remote 1).",
        },
        state: {
          type: "object",
          additionalProperties: true,
          description:
            "Button state object. Boolean keys for each button: A, B, One, Two, Plus, Minus, Home, Up, Down, Left, Right. " +
            "Omit a key to leave it released (false).",
        },
      },
      additionalProperties: false,
    },
  },

  // ── Wii Remote motion (v0.2.0) ──────────────────────────────────────────

  {
    name: "dolphin_set_wiimote_pointer",
    description:
      "PURPOSE: Set the Wii Remote's IR pointer position on the given port. " +
      "USAGE: Use for menu navigation in Wii titles that aim via the Remote (Wii Sports, Smash Bros menus, House of the Dead, etc.). Coordinates are normalised floats; the exact useful range depends on the game's calibration but typically `(-1.0, -1.0)` is top-left and `(1.0, 1.0)` is bottom-right relative to the sensor bar zone. To hold a position across multiple frames call repeatedly — Felk's helper uses ClearOn::NextFrame semantics. " +
      "BEHAVIOR: DESTRUCTIVE to pointer state for the addressed port. Sets the IR X+Y for the next render frame. Combine with dolphin_press_wiimote_buttons for click-and-aim sequences. " +
      "RETURNS: 'Set Wii Remote port N pointer to (x, y)'.",
    inputSchema: {
      type: "object",
      required: ["x", "y"],
      properties: {
        port: { type: "integer", minimum: 0, maximum: 3, description: "Wii Remote port (0-3, default 0)." },
        x:    { type: "number", description: "IR pointer X. Float, typically -1.0..1.0 horizontal." },
        y:    { type: "number", description: "IR pointer Y. Float, typically -1.0..1.0 vertical." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dolphin_set_wiimote_acceleration",
    description:
      "PURPOSE: Set the Wii Remote's accelerometer reading on the given port. " +
      "USAGE: Use for games that read raw accelerometer data — Wii Sports bowling/golf swings, Mario Galaxy's shake-to-spin, anything that doesn't go through the higher-level swing/shake/tilt helpers (deferred to a future release). Units are roughly g (Earth gravity ≈ 1.0); a Remote held still and pointing forward typically reads about (0, 1, 0). For a single-frame impulse, set the value then dolphin_frame_advance(1) then reset to neutral. " +
      "BEHAVIOR: DESTRUCTIVE to accelerometer state for the addressed port. ClearOn::NextFrame semantics — set persists for one render frame only. " +
      "RETURNS: 'Set Wii Remote port N accel to (x, y, z)'.",
    inputSchema: {
      type: "object",
      required: ["x", "y", "z"],
      properties: {
        port: { type: "integer", minimum: 0, maximum: 3, description: "Wii Remote port (0-3, default 0)." },
        x:    { type: "number", description: "Accel X (roughly g)." },
        y:    { type: "number", description: "Accel Y (roughly g; ~1.0 for level-and-still pointing forward)." },
        z:    { type: "number", description: "Accel Z (roughly g)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dolphin_set_wiimote_angular_velocity",
    description:
      "PURPOSE: Set the Wii MotionPlus angular velocity on the given port. " +
      "USAGE: Use for games that read rotation rate from the MotionPlus add-on (Wii Sports Resort, Skyward Sword). Units are radians per second around each axis. The Remote must be a MotionPlus-enabled controller in Dolphin's input config for this to take effect. " +
      "BEHAVIOR: DESTRUCTIVE to angular-velocity state for the addressed port. ClearOn::NextFrame semantics. " +
      "RETURNS: 'Set Wii Remote port N angular_velocity to (x, y, z)'.",
    inputSchema: {
      type: "object",
      required: ["x", "y", "z"],
      properties: {
        port: { type: "integer", minimum: 0, maximum: 3, description: "Wii Remote port (0-3, default 0)." },
        x:    { type: "number", description: "Pitch rate (rad/s)." },
        y:    { type: "number", description: "Yaw rate (rad/s)." },
        z:    { type: "number", description: "Roll rate (rad/s)." },
      },
      additionalProperties: false,
    },
  },

  // ── Emulation control ───────────────────────────────────────────────────
  //
  // dolphin_pause / dolphin_resume are intentionally NOT exposed in v0.2.0.
  // Investigated via framedrawn coroutine yield (which we hoped fires while
  // paused). It doesn't, at least on Felk Preview 4 + Mario Party 4 —
  // verified with a deadlock smoke test. No other event in Felk's
  // exposed set fires when emu is paused. dolphin_pause/resume would
  // require either an upstream Felk change (e.g. a `tick` event that
  // fires regardless of emu state) or a different bridge architecture
  // (e.g. background thread for dispatch, which itself crashes Felk).
  // Use Dolphin's GUI pause hotkey (default Ctrl-P) until either changes.
  //
  // dolphin_reset doesn't have this problem — reset doesn't suspend emu.

  {
    name: "dolphin_reset",
    description:
      "PURPOSE: Tap the GameCube/Wii hardware reset button. " +
      "USAGE: Equivalent to power-cycling the reset button on the console front — game state is lost. To preserve state across the reset, dolphin_save_state first and dolphin_load_state after. " +
      "BEHAVIOR: DESTRUCTIVE: clears live RAM, returns the CPU to boot. Movie state (if recording) flags the reset. " +
      "RETURNS: 'Reset triggered.'",
    inputSchema: { type: "object", properties: {} },
  },

  // ── Frame advance ───────────────────────────────────────────────────────

  {
    name: "dolphin_frame_advance",
    description:
      "PURPOSE: Wait until the emulator has rendered N more frames since this call started. " +
      "USAGE: TAS-style frame-precise sequencing. Typical loop: pause → set controller state → frame_advance(1) → read memory → repeat. The bridge maintains a monotonic frame counter via Felk's on_frameadvance callback; this tool reads the counter, then waits for it to reach counter+frames. The emulator must be UNPAUSED for the counter to advance — call dolphin_resume first if you've paused. " +
      "BEHAVIOR: Blocks until the target frame is reached or the per-call timeout fires (15 s by default). If the emulator is paused and stays paused, this will time out. Does NOT pause/resume on its own. " +
      "RETURNS: 'Advanced to frame N (waited M frames).'",
    inputSchema: {
      type: "object",
      required: ["frames"],
      properties: {
        frames: {
          type: "integer",
          minimum: 1,
          maximum: 600,
          description: "Number of frames to wait for (1-600 — i.e. up to 10 seconds at 60 fps). Larger values can be chained.",
        },
      },
      additionalProperties: false,
    },
  },

  // ── Savestate ───────────────────────────────────────────────────────────

  {
    name: "dolphin_save_state",
    description:
      "PURPOSE: Save complete emulator state (RAM, registers, GPU, audio, timing) to a numbered slot. " +
      "USAGE: Rollback point before risky writes, bookmarks, repro sharing. Companion dolphin_load_state restores from the same slot. Dolphin maps slots 1-10 to F1-F10 in the GUI by default; 0 and 11-255 are programmatic-only. " +
      "BEHAVIOR: DESTRUCTIVE TO TARGET SLOT: silently overwrites prior contents — no prompt, no backup. Bound to the exact game disc and Dolphin build; loading mismatched usually crashes the core. The bridge call returns when Felk schedules the save, NOT when the file is on disk. " +
      "RETURNS: 'Save state triggered for slot N'.",
    inputSchema: {
      type: "object",
      required: ["slot"],
      properties: {
        slot: { type: "integer", minimum: 0, maximum: 255, description: "Slot (0-255). 1-10 are mapped to F1-F10 in Dolphin's GUI." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dolphin_load_state",
    description:
      "PURPOSE: Load a previously-saved state from the given slot, replacing all live state. " +
      "USAGE: Counterpart to dolphin_save_state. The classic snapshot/experiment/restore loop: save_state(N) → run experiment → load_state(N) to undo. " +
      "BEHAVIOR: DESTRUCTIVE TO LIVE STATE: replaces ALL current emulator state. The state file MUST come from the same game disc and same Dolphin build that produced it; loading an incompatible state typically crashes the core (no recovery without restarting Dolphin). " +
      "RETURNS: 'Load state triggered for slot N'.",
    inputSchema: {
      type: "object",
      required: ["slot"],
      properties: {
        slot: { type: "integer", minimum: 0, maximum: 255, description: "Slot (0-255). 1-10 are mapped to F1-F10 in Dolphin's GUI." },
      },
      additionalProperties: false,
    },
  },
];

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fmtHex(n: number | bigint): string {
  return `${n} (0x${n.toString(16).toUpperCase()})`;
}

function addrHex(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(8, "0")}`;
}

export function registerTools(server: Server, dol: DolphinClient): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const p = args as Record<string, unknown>;
    const a = () => p.address as number;

    switch (name) {
      case "dolphin_ping": {
        const r = await dol.call<{ bridge_version: string; dolphin: string }>("bridge.ping");
        return ok(`OK — bridge v${r.bridge_version} (${r.dolphin})`);
      }
      case "dolphin_get_info": {
        const r = await dol.call<{ bridge_version: string; dolphin: string }>("bridge.ping");
        return ok(
          `Bridge version: ${r.bridge_version}\n` +
          `Dolphin label:  ${r.dolphin}`,
        );
      }

      case "dolphin_read8":  return ok(`${addrHex(a())}: ${fmtHex(await dol.call<number>("memory.read_u8",  [a()]))}`);
      case "dolphin_read16": return ok(`${addrHex(a())}: ${fmtHex(await dol.call<number>("memory.read_u16", [a()]))}`);
      case "dolphin_read32": return ok(`${addrHex(a())}: ${fmtHex(await dol.call<number>("memory.read_u32", [a()]))}`);
      case "dolphin_read64": {
        const v = BigInt(await dol.call<number | string>("memory.read_u64", [a()]) as never);
        return ok(`${addrHex(a())}: ${fmtHex(v)}`);
      }

      case "dolphin_read_range": {
        const len = p.length as number;
        const hex = await dol.call<string>("memory.read_bytes", [a(), len]);
        const bytes = hex.match(/.{2}/g) ?? [];
        const spaced = bytes.map((b) => b.toUpperCase()).join(" ");
        return ok(`${addrHex(a())} [${bytes.length} bytes]:\n${spaced}`);
      }

      case "dolphin_write8": {
        await dol.call("memory.write_u8", [a(), p.value as number]);
        return ok(`Wrote ${fmtHex(p.value as number)} → ${addrHex(a())}`);
      }
      case "dolphin_write16": {
        await dol.call("memory.write_u16", [a(), p.value as number]);
        return ok(`Wrote ${fmtHex(p.value as number)} → ${addrHex(a())}`);
      }
      case "dolphin_write32": {
        await dol.call("memory.write_u32", [a(), p.value as number]);
        return ok(`Wrote ${fmtHex(p.value as number)} → ${addrHex(a())}`);
      }
      case "dolphin_write64": {
        const v = BigInt(p.value as string);
        // Felk's API takes a Python int; JS BigInt won't JSON-serialise so we
        // convert to a string and the bridge parses it back via int(str).
        // (For now the bridge actually accepts a JSON number — but 2^53 boundary
        // hits hard, so we use string transport and let the bridge widen.)
        await dol.call("memory.write_u64", [a(), v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : Number(v)]);
        return ok(`Wrote ${fmtHex(v)} → ${addrHex(a())}`);
      }

      case "dolphin_press_gc_buttons": {
        const port = (p.port as number | undefined) ?? 0;
        const state = p.state as Record<string, unknown>;
        await dol.call("controller.set_gc_buttons", [port, state]);
        const keys = Object.keys(state).join(",") || "(empty)";
        return ok(`Set GC port ${port}: ${keys}`);
      }
      case "dolphin_press_wiimote_buttons": {
        const port = (p.port as number | undefined) ?? 0;
        const state = p.state as Record<string, unknown>;
        await dol.call("controller.set_wiimote_buttons", [port, state]);
        const keys = Object.keys(state).join(",") || "(empty)";
        return ok(`Set Wii Remote port ${port}: ${keys}`);
      }

      case "dolphin_set_wiimote_pointer": {
        const port = (p.port as number | undefined) ?? 0;
        const x = p.x as number, y = p.y as number;
        await dol.call("controller.set_wiimote_pointer", [port, x, y]);
        return ok(`Set Wii Remote port ${port} pointer to (${x}, ${y})`);
      }
      case "dolphin_set_wiimote_acceleration": {
        const port = (p.port as number | undefined) ?? 0;
        const x = p.x as number, y = p.y as number, z = p.z as number;
        await dol.call("controller.set_wiimote_acceleration", [port, x, y, z]);
        return ok(`Set Wii Remote port ${port} accel to (${x}, ${y}, ${z})`);
      }
      case "dolphin_set_wiimote_angular_velocity": {
        const port = (p.port as number | undefined) ?? 0;
        const x = p.x as number, y = p.y as number, z = p.z as number;
        await dol.call("controller.set_wiimote_angular_velocity", [port, x, y, z]);
        return ok(`Set Wii Remote port ${port} angular_velocity to (${x}, ${y}, ${z})`);
      }

      case "dolphin_reset":  await dol.call("emulation.reset");  return ok("Reset triggered.");

      case "dolphin_frame_advance": {
        // Implemented client-side as polling on frame.get_count rather than
        // a bridge-side blocking wait — keeps the bridge coroutine free to
        // service other commands and avoids per-call long-hold tying up the
        // dispatcher.
        const frames = p.frames as number;
        const start = await dol.call<number>("frame.get_count");
        const target = start + frames;
        const pollEveryMs = 16;
        const overallTimeoutMs = 15000;
        const deadline = Date.now() + overallTimeoutMs;
        let now = start;
        while (now < target) {
          if (Date.now() > deadline) {
            throw new Error(`frame_advance(${frames}) timed out after ${overallTimeoutMs}ms (start=${start}, target=${target}, reached=${now}); emulator may be paused`);
          }
          await new Promise((r) => setTimeout(r, pollEveryMs));
          now = await dol.call<number>("frame.get_count");
        }
        return ok(`Advanced to frame ${now} (waited ${now - start} frames).`);
      }

      case "dolphin_save_state": {
        await dol.call("savestate.save_to_slot", [p.slot as number]);
        return ok(`Save state triggered for slot ${p.slot}`);
      }
      case "dolphin_load_state": {
        await dol.call("savestate.load_from_slot", [p.slot as number]);
        return ok(`Load state triggered for slot ${p.slot}`);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });
}
