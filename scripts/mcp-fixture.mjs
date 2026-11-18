// Local stdio MCP fixture. Node standard library only; never downloads anything.
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

if (process.argv[2] === "--must-not-start") {
  writeFileSync(process.argv[3], "disabled server started");
  process.exit(1);
}
export function answer(message) {
  if (message.id == null) return undefined;
  let result;
  if (message.method === "initialize") result = {
    protocolVersion: message.params?.protocolVersion || "2025-06-18",
    capabilities: { tools: {} }, serverInfo: { name: "buzz-codex-mcp-fixture", version: "1.0.0" },
  };
  else if (message.method === "tools/list") result = { tools: [{
    name: "echo", description: "Return the supplied text for a local integration check.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  }, {
    name: "write_echo", description: "Write a temporary marker for an approval-policy check.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }] };
  else if (message.method === "tools/call" && message.params?.name === "echo")
    result = { content: [{ type: "text", text: message.params.arguments.text }] };
  else if (message.method === "tools/call" && message.params?.name === "write_echo") {
    if (process.env.MCP_TEST_WRITE_MARKER) writeFileSync(process.env.MCP_TEST_WRITE_MARKER, "write executed");
    result = { content: [{ type: "text", text: message.params.arguments.text }] };
  }
  else if (message.method === "ping") result = {};
  else return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown fixture method" } };
  return { jsonrpc: "2.0", id: message.id, result };
}

// The same responder is imported by the HTTP fixture; do not read stdin then.
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  if (process.env.MCP_TEST_START_MARKER) writeFileSync(process.env.MCP_TEST_START_MARKER, "stdio server started");
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    try {
      const response = answer(JSON.parse(line));
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    } catch { process.exitCode = 1; lines.close(); }
  }
}
