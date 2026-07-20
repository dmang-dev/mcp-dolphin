# src/

TypeScript source for the `mcp-dolphin` MCP server (Node.js). Compiled into
`../dist/` by `tsc` — that's what the published `mcp-dolphin` bin runs.

## Files

- **`index.ts`** — stdio MCP entrypoint. Reads `DOLPHIN_BRIDGE_HOST` /
  `DOLPHIN_BRIDGE_PORT` / `DOLPHIN_TIMEOUT_MS` / `MCP_DOLPHIN_DEBUG`.
  Also implements `--print-bridge` which emits `../bridge/mcp_bridge.py` to
  stdout so end-users can write it to disk without cloning.
- **`dolphin.ts`** — TCP client to the Python bridge running inside Felk's
  Dolphin fork. Newline-delimited JSON; handles PowerPC big-endian byte-swap
  on read/write so callers work with the logical value the game sees.
- **`tools.ts`** — registers every MCP tool against the SDK server.
  GameCube vs. Wii Remote inputs namespaced to keep the two surfaces clear
  (`dolphin_press_gc_buttons` vs. `dolphin_press_wiimote_buttons`).

## Build

```bash
npm run dev      # tsc --watch
npm run build    # one-shot
```

Output goes to `../dist/index.js`.
