# bridge/

Emulator-side Python bridge that runs **inside Felk's Dolphin fork** via
View → Scripting → Add New Script.

## Files

- **`mcp_bridge.py`** — non-blocking TCP server on `127.0.0.1:55355`, polled
  from the main coroutine on Dolphin's emu thread. Dispatches newline-
  delimited JSON commands from the `mcp-dolphin` Node process against Felk's
  Python modules (memory, controllers, savestates, frame loop).

## Why not threads

Felk Preview 4 segfaults on `threading.Thread(...).start()` — embedded Python
plus native threads plus Felk's GIL handling doesn't survive in this release.
The bridge polls a non-blocking socket from the main coroutine so every
Dolphin API call lands on the emu thread (where they're safe). Latency:
bounded by one frame (~16.7 ms at 60 fps).

## Mainline Dolphin won't work

Mainline Dolphin has no Python scripting. The Python PRs
([dolphin-emu/dolphin#7064](https://github.com/dolphin-emu/dolphin/pull/7064))
have been stuck since 2022; Lua forks (dolphinWatch, Dolphin-Lua-Core) are
dead. Use **Felk's fork** (see `../artifacts/`).

## Loading

In Felk's Dolphin: **View → Scripting → Add New Script** → point at this file
(or a copy emitted by `npx mcp-dolphin --print-bridge`). Verify in the Log
window:

```
[mcp-bridge] listening on 127.0.0.1:55355 (bridge v0.1.0)
```

If you see errors, enable the Scripting log type: View → Show Log Configuration
→ check Scripting (verbosity Info or Error).
