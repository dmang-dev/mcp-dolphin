#!/usr/bin/env node
// mcp-dolphin entrypoint
// ──────────────────────
//
// Two modes:
//   1) Standard MCP server (default) — talks stdio MCP, connects to the
//      Python bridge running inside Dolphin (Felk's fork).
//   2) `--print-bridge` — emits the Python bridge script to stdout. Use:
//        npx mcp-dolphin --print-bridge > mcp_bridge.py
//      then load that file in Dolphin via Scripting → Add New Script.
//
// Env vars:
//   DOLPHIN_BRIDGE_HOST   default 127.0.0.1
//   DOLPHIN_BRIDGE_PORT   default 55355  (must match LISTEN_PORT in bridge)
//   DOLPHIN_TIMEOUT_MS    default 10000  (per-call timeout)
//   MCP_DOLPHIN_DEBUG=1   trace every TX message to stderr

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DolphinClient } from "./dolphin.js";
import { registerTools } from "./tools.js";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

function printBridge(): void {
  // dist/index.js sits at <pkg>/dist/index.js; bridge lives at <pkg>/bridge/.
  const here = dirname(fileURLToPath(import.meta.url));
  const bridgePath = resolve(here, "..", "bridge", "mcp_bridge.py");
  const content = readFileSync(bridgePath, "utf8");
  process.stdout.write(content);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--print-bridge")) {
    printBridge();
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      `mcp-dolphin — MCP server for Dolphin (GameCube + Wii) via Felk's Python-scripting fork.\n\n` +
      `Usage:\n` +
      `  mcp-dolphin                   Start the MCP stdio server (default)\n` +
      `  mcp-dolphin --print-bridge    Print the Python bridge script (pipe to a file)\n\n` +
      `One-time setup:\n` +
      `  1) Install Felk's Dolphin fork from https://github.com/Felk/dolphin (Releases).\n` +
      `  2) npx mcp-dolphin --print-bridge > mcp_bridge.py\n` +
      `  3) Open Dolphin, go to Scripting → Add New Script → pick mcp_bridge.py.\n` +
      `  4) Register mcp-dolphin in your MCP client (see README).\n\n` +
      `Env vars:\n` +
      `  DOLPHIN_BRIDGE_HOST   default 127.0.0.1\n` +
      `  DOLPHIN_BRIDGE_PORT   default 55355\n` +
      `  DOLPHIN_TIMEOUT_MS    default 10000\n` +
      `  MCP_DOLPHIN_DEBUG=1   trace TX messages\n`,
    );
    return;
  }

  const HOST = process.env.DOLPHIN_BRIDGE_HOST ?? "127.0.0.1";
  const PORT = parseInt(process.env.DOLPHIN_BRIDGE_PORT ?? "55355", 10);
  const TIMEOUT_MS = parseInt(process.env.DOLPHIN_TIMEOUT_MS ?? "10000", 10);

  const dol = new DolphinClient({ host: HOST, port: PORT, timeoutMs: TIMEOUT_MS });

  // Try connecting eagerly so the user sees a clear startup line either way,
  // but don't fail server boot — connection is re-attempted on every call.
  try {
    await dol.start();
  } catch (err) {
    process.stderr.write(
      `[mcp-dolphin] WARNING: could not connect to bridge (${dol.describeTarget()}): ${err}\n` +
      `           Start Dolphin (Felk's fork) and load mcp_bridge.py via Scripting → Add New Script.\n` +
      `           Print the bridge with: npx mcp-dolphin --print-bridge > mcp_bridge.py\n`,
    );
  }

  const server = new Server(
    { name: "mcp-dolphin", version: "0.1.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, dol);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-dolphin] MCP server ready (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`[mcp-dolphin] fatal: ${err}\n`);
  process.exit(1);
});
