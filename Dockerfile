# Dockerfile — primarily for the Glama MCP registry (https://glama.ai/mcp/servers).
#
# Builds the MCP server and runs it over stdio. The server starts cleanly
# WITHOUT Dolphin present: it logs a warning that the bridge is unreachable
# but still serves tools/list over stdio. That's exactly what Glama's
# "start + respond to introspection" check needs.
#
# For actual use you don't need Docker — `npm install -g mcp-dolphin`, then
# install Felk's Dolphin fork and load bridge/mcp_bridge.py via Felk's
# Scripting panel (View → Scripting). See README.md.

FROM node:22-trixie-slim@sha256:8cd0ffd483b64585c6d135364bea5f937ff40cd3da431789af011f9ee8d55af0
WORKDIR /app

# Install dependencies. --ignore-scripts skips the `prepare` hook; we run
# the build explicitly below so layer caching is predictable.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Compile TypeScript -> dist/
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Ship the Python bridge alongside (not used by the Node server itself —
# it's loaded into Felk's Dolphin fork — but `mcp-dolphin --print-bridge`
# reads it from here, so it has to be present in the image).
COPY bridge/ ./bridge/

# The MCP server speaks JSON-RPC over stdio.
ENTRYPOINT ["node", "dist/index.js"]
