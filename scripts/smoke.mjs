// Real Codex + isolated MCP servers and a local model stub; no external model calls or downloads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRpc, CodexMcpRuntime, BRIDGE_NAME, settings, threadParams, turnParams, readModelCatalog, readTranscript, cleanTerminals } from "../plugin.js";
import { answer } from "./mcp-fixture.mjs";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "buzz-codex-mcp-smoke-"));
const fixturePath = fileURLToPath(new URL("./mcp-fixture.mjs", import.meta.url));
const disabledMarker = join(temporaryDirectory, "disabled-started");
const writeMarker = join(temporaryDirectory, "write-executed");
const startMarker = join(temporaryDirectory, "stdio-started");
const published = [], modelInputs = [];
let bridgeReads = 0;
let token = "local-smoke-token";
let session = "local-smoke-session";
let modelReady, releaseModel;
const waitingModel = new Promise((resolve) => { modelReady = resolve; });
const modelGate = new Promise((resolve) => { releaseModel = resolve; });
let runtimeHandler, runtimeRequests = 0, followUpReady, releaseFollowUp, silentRuntime = false;
let runtimeReady, releaseRuntime;
const runtimeStarted = new Promise((resolve) => { runtimeReady = resolve; });
const runtimeGate = new Promise((resolve) => { releaseRuntime = resolve; });
const followUpStarted = new Promise((resolve) => { followUpReady = resolve; });
const followUpGate = new Promise((resolve) => { releaseFollowUp = resolve; });
// Match the runtime's explicit host.serveMcp shared-session setting. The host
// binds every connection to the same handler, agent and conversation.
const sharedSession = true;
let claimed = false, stopped = false, initializations = 0, refusedInitializations = 0;
const server = createServer(async (request, response) => {
  if (request.url === "/model/responses") {
    let body = "";
    for await (const chunk of request) body += chunk;
    modelInputs.push(JSON.parse(body));
    const step = modelInputs.length;
    if (step === 1) { modelReady(); await modelGate; }
    const calls = silentRuntime ? [] : runtimeHandler ? [
      { namespace: `mcp__${BRIDGE_NAME}`, name: "send", arguments: JSON.stringify({ text: "runtime-final-ok", final: true }) },
    ] : [
      { namespace: `mcp__${BRIDGE_NAME}`, name: "agent_types", arguments: "{}" },
      { namespace: `mcp__${BRIDGE_NAME}`, name: "send", arguments: JSON.stringify({ text: "model-publish-ok" }) },
      { namespace: "mcp__local_fixture", name: "write_echo", arguments: JSON.stringify({ text: "must-not-run" }) },
    ];
    const callStep = runtimeHandler ? ++runtimeRequests : step;
    if (runtimeHandler && callStep === 1) { runtimeReady(); await runtimeGate; }
    if (runtimeHandler && callStep === 2) { followUpReady(); await followUpGate; }
    const item = callStep <= calls.length ? {
      id: `fc_${step}`, type: "function_call", call_id: `call_${step}`,
      ...calls[callStep - 1],
    } : {
      id: "msg_done", type: "message", role: "assistant", status: "completed",
      content: silentRuntime ? [] : [{ type: "output_text", text: "Local approval check complete.", annotations: [] }],
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [type, data] of [
      ["response.created", { response: { id: `r${step}`, object: "response", status: "in_progress", output: [] } }],
      ["response.output_item.added", { output_index: 0, item }],
      ["response.output_item.done", { output_index: 0, item }],
      ["response.completed", { response: { id: `r${step}`, object: "response", status: "completed", output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }],
    ]) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    response.end();
    return;
  }
  if (stopped || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(404); response.end(); return; }
  if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
  let body = "";
  for await (const chunk of request) body += chunk;
  const message = JSON.parse(body);
  const named = request.headers["mcp-session-id"];
  if (named !== session) {
    if (named || message.method !== "initialize") { response.writeHead(404); response.end(); return; }
    // Match Buzz admission: repeated initialization needs explicit shared mode.
    if (claimed && !sharedSession) {
      refusedInitializations++;
      stopped = true;
      response.writeHead(404); response.end(); return;
    }
    claimed = true;
    initializations++;
  }
  let result = answer(message);
  if (message.method === "tools/list") result.result.tools.push({
    // Buzz's real catalog currently omits tool approval annotations.
    name: "agent_types", description: "List fixture agent types.",
    inputSchema: { type: "object", properties: {} },
  }, {
    name: "send", description: "Record a local test message; no real publication.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, final: { type: "boolean" } }, required: ["text"] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  });
  if (message.method === "tools/call" && message.params?.name === "send") {
    published.push(message.params.arguments.text);
    result = runtimeHandler ? await runtimeHandler(message)
      : { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "Fixture message recorded." }] } };
  }
  if (message.method === "tools/call" && message.params?.name === "agent_types") {
    bridgeReads++;
    result = { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "codex-mcp" }] } };
  }
  response.writeHead(result ? 200 : 202, { "Content-Type": "application/json", "Mcp-Session-Id": session });
  response.end(result ? JSON.stringify(result) : "");
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const bridge = {
  url: `http://127.0.0.1:${server.address().port}/mcp`,
  headers: [{ name: "Authorization", value: `Bearer ${token}` }],
};
const configText = `
model = "gpt-5.4"
model_provider = "fixture"
model_reasoning_effort = "high"
[model_providers.fixture]
name = "Local model fixture"
base_url = ${JSON.stringify(`http://127.0.0.1:${server.address().port}/model`)}
wire_api = "responses"
requires_openai_auth = false
[mcp_servers.local_fixture]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(fixturePath)}]
enabled = true
required = true
env = { MCP_TEST_WRITE_MARKER = ${JSON.stringify(writeMarker)}, MCP_TEST_START_MARKER = ${JSON.stringify(startMarker)} }
[mcp_servers.local_fixture.tools.write_echo]
approval_mode = "prompt"
[mcp_servers.disabled_fixture]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(fixturePath)}, "--must-not-start", ${JSON.stringify(disabledMarker)}]
enabled = false
`;
await writeFile(join(temporaryDirectory, "config.toml"), configText);
let stderr = "";
let nativeSpawns = 0;
const nativeSpawn = async (_id, options) => {
  assert.equal(options.mcp, undefined, "The native shell bootstrap must not initialize the Buzz bridge");
  nativeSpawns++;
  const child = spawn(process.env.CODEX_MCP_TEST_BINARY || "codex", ["app-server"], {
    cwd: options.cwd,
    // CODEX_HOME selects an isolated test configuration using Codex's own option.
    // User MCP commands, credentials and plugins are never loaded by this check.
    env: { ...process.env, CODEX_HOME: temporaryDirectory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", options.onStdout);
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const exited = new Promise((resolveExit, reject) => {
    child.on("error", reject); child.on("exit", resolveExit);
  });
  return {
    write: (data) => new Promise((resolveWrite, reject) => child.stdin.write(data, (error) => error ? reject(error) : resolveWrite())),
    end: async () => { child.stdin.end(); },
    kill: async () => { child.kill("SIGKILL"); },
    exited,
  };
};
let rpc, runtime;
try {
  const catalog = await readModelCatalog({
    spawn: nativeSpawn,
    resolveDirectory: async (path, options) => { assert.equal(options.create, false); return path; },
  }, temporaryDirectory);
  assert.ok(catalog.models.length > 0);
  assert.equal(catalog.defaultModel, "gpt-5.4");
  assert.equal(catalog.defaultEffort, "high");
  await assert.rejects(access(startMarker), "model discovery must not start configured MCP programs");
  rpc = await new CodexRpc(nativeSpawn, { cwd: temporaryDirectory }).open();
  const { config: normalized } = await rpc.request("config/read", { cwd: temporaryDirectory });
  const params = threadParams(settings(), temporaryDirectory, "Local MCP integration fixture.", normalized, bridge);
  const opened = await rpc.request("thread/start", params);
  const { thread } = opened;
  const inventory = await rpc.request("mcpServerStatus/list", { threadId: thread.id });
  for (const name of ["local_fixture", BRIDGE_NAME]) {
    const found = inventory.data.find((entry) => entry.name === name);
    assert.ok(found, `${name} must appear in real Codex MCP discovery`);
    assert.ok(Object.keys(found.tools).some((key) => key.endsWith("echo")), `${name} must expose echo`);
    const reply = await rpc.request("mcpServer/tool/call", {
      threadId: thread.id, server: name, tool: "echo", arguments: { text: `ok:${name}` },
    });
    assert.ok(JSON.stringify(reply).includes(`ok:${name}`));
  }
  await access(startMarker);
  assert.ok(initializations >= 2, "real Codex discovery must exercise repeated initialization");
  assert.equal(refusedInitializations, 0);
  await assert.rejects(access(disabledMarker));
  // Model-driven calls exercise the approval gate; direct RPC calls above do not.
  let resolveTurn, rejectTurn;
  const completed = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  void completed.catch(() => {});
  const timer = setTimeout(() => rejectTurn(new Error("Local model fixture turn timed out.")), 20_000);
  const unsubscribe = rpc.subscribe(({ method, params: event }) => {
    if (method === "turn/completed" && event?.threadId === thread.id) {
      if (event.turn.status === "completed") resolveTurn();
      else rejectTurn(new Error(event.turn.error?.message || "Local model fixture turn failed."));
    }
    if (method === "connection/closed") rejectTurn(new Error(event.message));
  });
  try {
    await rpc.request("turn/start", turnParams(opened, "Run the local approval fixture."));
    await Promise.race([waitingModel, completed]);
    const live = await readTranscript({ spawn: nativeSpawn }, { threadId: thread.id, cwd: temporaryDirectory });
    assert.ok(live.turns.flatMap((turn) => turn.items).some((item) => item.text.includes("Run the local approval fixture.")));
    await rpc.request("thread/read", { threadId: thread.id, includeTurns: false });
    releaseModel();
    await completed;
  } finally { releaseModel(); clearTimeout(timer); unsubscribe(); }
  assert.equal(bridgeReads, 1, "the model must be able to invoke an unannotated Buzz read tool");
  assert.equal(opened.reasoningEffort, "high");
  assert.equal(modelInputs[0].model, opened.model);
  assert.equal(modelInputs[0].reasoning?.effort, opened.reasoningEffort);
  const userText = modelInputs[0].input.filter((item) => item.role === "user")
    .flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("\n");
  assert.ok(userText.includes(JSON.stringify({ model: opened.model, reasoning_effort: opened.reasoningEffort })),
    "the model's context must match its actual API request model and effort");
  assert.deepEqual(published, ["model-publish-ok"], "the model must be able to invoke the bridge send tool");
  assert.ok(JSON.stringify(modelInputs.at(-1)?.input).includes("MCP tool call requires approval, but approval policy is never"),
    "the unrelated server's write tool must still require approval");
  await assert.rejects(access(writeMarker));
  await rpc.close();
  await rm(startMarker);
  const initBeforeRead = initializations, requestsBeforeRead = modelInputs.length;
  const history = await readTranscript({ spawn: nativeSpawn }, { threadId: thread.id, cwd: temporaryDirectory });
  assert.equal(history.turns.at(-1)?.status, "completed");
  assert.ok(history.turns.flatMap((turn) => turn.items).some((item) => item.text.includes("Local approval check complete.")));
  assert.equal(modelInputs.length, requestsBeforeRead, "reading history must not call the model");
  assert.equal(initializations, initBeforeRead, "reading history must not reconnect the Buzz MCP bridge");
  await assert.rejects(access(startMarker), "reading history must not start configured MCP programs");
  // Grow only this isolated fixture's persisted history. A real resume that
  // hydrates all turns would now exceed the plugin's 4 MiB output frame bound.
  assert.ok(thread.path);
  assert.ok((await realpath(thread.path)).startsWith((await realpath(temporaryDirectory)) + "/"));
  const historyMarker = "Large saved conversation fixture.";
  let enlarged = false;
  const rollout = (await readFile(thread.path, "utf8")).trimEnd().split("\n").map((line) => {
    const event = JSON.parse(line);
    if (!enlarged && event.type === "response_item" && event.payload?.type === "message" && event.payload.role === "user") {
      event.payload.content = [{ type: "input_text", text: historyMarker + " ".repeat(4 * 1024 * 1024) }];
      enlarged = true;
    }
    return JSON.stringify(event);
  }).join("\n") + "\n";
  assert.equal(enlarged, true);
  await writeFile(thread.path, rollout);
  token = "rotated-smoke-token";
  session = "rotated-smoke-session";
  claimed = false;
  initializations = 0;
  bridge.headers = [{ name: "Authorization", value: `Bearer ${token}` }];
  rpc = await new CodexRpc(nativeSpawn, { cwd: temporaryDirectory }).open();
  const resumed = await rpc.request("thread/resume", {
    ...threadParams(settings({ sandbox: "danger-full-access" }), temporaryDirectory, "Local fixture", normalized, bridge),
    threadId: thread.id, excludeTurns: true,
  });
  assert.equal(resumed.thread.id, thread.id);
  assert.deepEqual(resumed.thread.turns, [], "resume must omit history from its response without discarding it");
  assert.equal(resumed.sandbox.type, "dangerFullAccess", "an explicit access change must take effect on the saved thread");
  const afterResume = await rpc.request("mcpServer/tool/call", {
    threadId: thread.id, server: BRIDGE_NAME, tool: "echo", arguments: { text: "resume-ok" },
  });
  assert.ok(JSON.stringify(afterResume).includes("resume-ok"));
  assert.ok(initializations >= 1);
  assert.equal(refusedInitializations, 0);
  await cleanTerminals(rpc, thread.id);
  await rpc.close();
  const values = new Map(), fallbacks = [], activity = [];
  let bridgeClosed = false;
  let runtimeBridges = 0;
  const instructionMarker = "Current instruction marker at the end.";
  let system = "Current instructions and team memory. " + "🐝".repeat(2500) + instructionMarker;
  runtime = new CodexMcpRuntime({
    spawn: nativeSpawn, resolveDirectory: async () => temporaryDirectory,
    serveMcp: async (handler, options) => {
      assert.equal(options.sharedSession, true);
      bridgeClosed = false;
      token = `runtime-token-${++runtimeBridges}`;
      session = `runtime-session-${runtimeBridges}`;
      claimed = false;
      runtimeHandler = handler;
      let close;
      const closed = new Promise((resolve) => { close = resolve; });
      const headers = [{ name: "Authorization", value: `Bearer ${token}` }];
      return { ...bridge, headers, closed, async close() { bridgeClosed = true; runtimeHandler = undefined; close(); } };
    },
  }, {
    conversation: async () => ({ key: "runtime-smoke", channel: "runtime-smoke", topLevel: true }),
    systemPrompt: async () => system,
    turnPrompt: async () => ({ text: "Publish a final reply through the local fixture.", cursor: "fixture" }),
    standalonePrompt: (_agent, text) => "Standalone context\n" + text,
    tools: () => async (message) => ({ jsonrpc: "2.0", id: message.id,
      result: { content: [{ type: "text", text: "Fixture message recorded." }] } }),
    reply: async (_agent, _conversation, text) => { fallbacks.push(text); },
  }, {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  });
  // The stub accepts arbitrary model names. Use a listed model for the composer
  // check so its available effort levels come from the installed Codex catalog.
  const model = catalog.models.find(({ efforts }) => efforts.includes("low") && efforts.includes("high"));
  assert.ok(model, "the real catalog must offer a model with Low and High");
  const agent = { key: "fixture", config: settings({ workspace: temporaryDirectory, model: model.value }) };
  const choices = await runtime.models(agent);
  assert.equal(choices.current, model.value);
  assert.equal(choices.models[0].effort, "high");
  const pick = choices.models[0].efforts.find(({ id }) => id === "low");
  assert.ok(pick, "the real catalog must offer the effort the owner can pick");
  runtime.store.write(runtime.store.key("fixture", "runtime-smoke"), {
    threadId: thread.id, cwd: temporaryDirectory, cursor: "fixture",
  });
  const beforeLargeResume = modelInputs.length;
  const deadline = new AbortController();
  const handed = runtime.run({ agent, config: agent.config, effort: pick.id,
    signal: deadline.signal, workingUntil: (pending) => { activity.push(pending); } });
  await runtimeStarted;
  assert.equal(modelInputs[beforeLargeResume].reasoning?.effort, "low", "the selected effort must reach the resumed model request");
  const resumedInputs = JSON.stringify(modelInputs[beforeLargeResume].input);
  assert.ok(resumedInputs.includes(historyMarker), "resumed execution must retain the saved conversation's history");
  assert.ok(resumedInputs.length > 4 * 1024 * 1024, "the real model request must include the oversized fixture history");
  const developerText = (body) => body.input.filter((item) => item.role === "developer")
    .flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("\n");
  assert.ok(developerText(modelInputs[beforeLargeResume]).includes(instructionMarker),
    "current developer context beyond the first chunk must reach the resumed model");
  const runtimeKey = runtime.store.key("fixture", "runtime-smoke");
  const live = await runtime.transcript({ key: runtimeKey, ...runtime.store.read(runtimeKey) });
  assert.equal(live.turns.at(-1)?.status, "inProgress", "runtime metadata must restore accurate live status on isolated reads");
  assert.equal(runtime.jobs.size, 1, "reading Activity must leave execution alive");
  assert.equal(bridgeClosed, false);
  deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
  await handed;
  assert.equal(published.includes("runtime-final-ok"), false, "the model is held before any final publication");
  assert.equal(runtime.jobs.size, 1, "accepted work survives the delivery deadline");
  assert.equal(bridgeClosed, false);
  releaseRuntime();
  await Promise.all(activity);
  await followUpStarted;
  assert.ok(published.includes("runtime-final-ok"));
  assert.equal(runtime.jobs.size, 1, "the post-reply turn stays tracked while its model response is held");
  assert.equal(bridgeClosed, false, "the final tool result must reach Codex before bridge teardown");
  const remaining = [...runtime.jobs][0].done;
  releaseFollowUp();
  await remaining;
  assert.equal(runtime.jobs.size, 0);
  assert.equal(bridgeClosed, true);
  assert.deepEqual(fallbacks, [], "a delivered final reply must not be posted twice");
  silentRuntime = true;
  system = "Updated instructions; earlier team memory is now absent.";
  await rm(startMarker, { force: true });
  const warmSpawns = nativeSpawns, beforeWarmInitializations = initializations;
  const beforeUpdate = modelInputs.length;
  const silentActivity = [];
  await runtime.run({ agent, config: agent.config,
    signal: AbortSignal.timeout(20_000), workingUntil: (pending) => { silentActivity.push(pending); } });
  await Promise.all(silentActivity);
  assert.equal(modelInputs[beforeUpdate].reasoning?.effort, "high", "an unpicked follow-up must use the local default again");
  assert.equal(nativeSpawns, warmSpawns, "a follow-up must reuse its Codex process");
  assert.equal(runtimeBridges, 2, "each turn must receive its own Buzz bridge");
  assert.ok(initializations > beforeWarmInitializations, "Codex must initialize its new Buzz bridge");
  await access(startMarker);
  assert.ok(developerText(modelInputs[beforeUpdate]).includes(system), "updated context must reach the same saved thread");
  const latestDeveloper = (body) => body.input.filter((item) => item.role === "developer").at(-1)
    .content.map((part) => part.text ?? "").join("\n");
  assert.ok(latestDeveloper(modelInputs[beforeUpdate]).includes("replaces earlier Buzz agent instructions"));
  assert.equal(latestDeveloper(modelInputs[beforeUpdate]).includes(instructionMarker), false,
    "current context must supersede the earlier, larger instructions retained in conversation history");
  assert.equal(runtime.jobs.size, 0);
  assert.equal(values.size, 1, "a silent completion must preserve the saved conversation");
  assert.deepEqual(fallbacks, [], "a real silent completion must not publish a false error");
  system = "";
  await rm(startMarker);
  await writeFile(join(temporaryDirectory, "config.toml"), configText.replace("enabled = true", "enabled = false"));
  const beforeClear = modelInputs.length, clearing = [];
  await runtime.run({ agent: { key: "fixture" }, config: settings({ workspace: temporaryDirectory }),
    signal: AbortSignal.timeout(20_000), workingUntil: (pending) => { clearing.push(pending); } });
  await Promise.all(clearing);
  assert.equal(nativeSpawns, warmSpawns, "a changed MCP setting can be applied in the reused process");
  await assert.rejects(access(startMarker), "the resumed thread must honor the newly disabled MCP server");
  assert.ok(latestDeveloper(modelInputs[beforeClear]).includes("including values that are now empty or absent"));
  assert.equal(latestDeveloper(modelInputs[beforeClear]).includes("Updated instructions"), false);
  const beforeOnce = modelInputs.length;
  assert.deepEqual(await runtime.runOnce({ delivery: { agent: { key: "fixture" }, config: settings({ workspace: temporaryDirectory }) },
    key: "standalone-smoke", signal: AbortSignal.timeout(20_000), prompt: async () => "Standalone smoke fixture." }), { ok: true });
  assert.ok(JSON.stringify(modelInputs[beforeOnce].input).includes("Standalone context\\nStandalone smoke fixture."));
  assert.equal(values.size, 1, "standalone execution must not create a saved conversation binding");
  assert.equal(runtime.jobs.size, 0);
  assert.equal(nativeSpawns, warmSpawns + 1, "standalone execution must own its process");
  assert.deepEqual(fallbacks, [], "a standalone turn has no implicit publication destination");
  console.log("PASS: real Codex reads and publishes, blocks an unrelated write, applies per-turn thinking then restores the default, reuses a conversation process with fresh bridges and MCP configuration, resumes oversized history with updated and cleared current developer context, isolates live/saved Activity reads, survives delivery expiry, releases final-reply activity before cleanup, accepts silent completion and executes standalone Attention without a saved binding or fallback destination.");
} catch (error) {
  console.error(error.message);
  // This environment contains only fixture servers, so stderr has no user configuration.
  if (stderr) console.error(stderr);
  process.exitCode = 1;
} finally {
  releaseRuntime();
  releaseFollowUp();
  await runtime?.dispose();
  await rpc?.close();
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
