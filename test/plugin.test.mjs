import test from "node:test";
import assert from "node:assert/strict";
import { CodexRpc, CodexMcpRuntime, SessionStore, BRIDGE_NAME, settings, threadParams, readModelCatalog,
  modelChoices, changeModel, withSyncedSettings, readTranscript, transcriptItem, transcriptInline, transcriptBlocks,
  displayCommand, openedSession, SettingsDraft, apply } from "../plugin.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

// Exercise the registered view contract without adding a browser dependency.
function settingsView(f) {
  let registered, cursor = 0;
  const state = [], effects = [], cleanups = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useId: () => "settings-view",
    useEffect: (effect) => { effects.push(effect); },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useState: (initial) => {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (next) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
    },
  };
  const before = globalThis.localStorage;
  globalThis.localStorage = f.storage;
  try {
    apply({ react, host: f.host, agents: { ...f.agents, register: (value) => { registered = value; } },
      effect: (effect) => { cleanups.push(effect()); } });
  } finally {
    if (before === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = before;
  }
  const expand = (node) => {
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") return expand(node.type(node.props));
    return { ...node, children: node.children.map(expand) };
  };
  const all = (node) => !node || typeof node !== "object" ? [] : [node, ...node.children.flatMap(all)];
  return {
    tab: registered.tabs.find((tab) => tab.role === "settings"),
    render(props, create = false) {
      cursor = 0; effects.length = 0;
      return expand(react.createElement(create ? registered.Create : this.tab.component, props));
    },
    remount(props) { state.length = 0; return this.render(props); },
    retire(key) { return registered.retire(key); },
    models: (agent) => registered.models(agent),
    run: (delivery) => registered.run(delivery),
    runOnce: (turn) => registered.runOnce(turn),
    all,
    runEffects() { for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); } },
    async dispose() { for (const cleanup of cleanups.reverse()) await cleanup?.(); },
  };
}

function fixture({ complete = true, fail, finalSend = false, normalized = {}, resolved = {}, modelPages = [], turnPages = [], itemPages = {}, resumeTurns = [] } = {}) {
  const storage = new MemoryStorage();
  const calls = [], processes = [], bridges = [], replies = [], prompts = [], turns = [];
  const starts = new Map();
  let restores = 0, acknowledged = 0;
  const host = {
    resolveDirectory: async (path) => path.replace(/^~\//, "/home/test/"),
    readFile: async () => new Uint8Array([1]),
    serveMcp: async (handler) => {
      const closed = deferred();
      const bridge = { url: `http://127.0.0.1:${1000 + bridges.length}/mcp`,
        headers: [{ name: "Authorization", value: "Bearer bridge-secret" }],
        closed: closed.promise, handler, closeCount: 0,
        async close() { bridge.closeCount++; closed.resolve(); } };
      bridges.push(bridge);
      return bridge;
    },
    spawn: async (_id, options) => {
      const exit = deferred();
      let bridge = bridges.at(-1);
      let buffer = "";
      let modelPage = 0;
      let turnPage = 0;
      const itemOffsets = new Map();
      const send = (message) => {
        const text = JSON.stringify(message) + "\n";
        // Exercise split UTF-8-decoded stdout chunks and multiple frames.
        options.onStdout(text.slice(0, 7)); options.onStdout(text.slice(7));
      };
      const finish = async (text = "Result from Codex") => {
        if (finalSend) await bridge.handler({ id: 90, method: "tools/call",
          params: { name: "send", arguments: { content: "Sent through Buzz", final: true } } });
        send({ method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text } } });
        send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
      };
      const process = {
        exited: exit.promise, options, ended: false, send,
        async write(data) {
          buffer += data;
          while (buffer.includes("\n")) {
            const at = buffer.indexOf("\n");
            const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
            calls.push(message);
            if (!message.method || message.id == null) continue;
            if (message.method === fail) { send({ id: message.id, error: { message: "Fixture failure" } }); continue; }
            let result = {};
            if (message.method === "account/read") result = { account: { type: "chatgpt" } };
            if (message.method === "config/read") result = { config: normalized };
            if (message.method === "model/list") result = modelPages[modelPage++] ?? { data: [], nextCursor: null };
            if (message.method === "thread/turns/list") result = turnPages[turnPage++] ?? { data: [], nextCursor: null };
            if (message.method === "thread/items/list") {
              const turn = message.params.turnId, offset = itemOffsets.get(turn) ?? 0;
              result = typeof itemPages[turn] === "function" ? itemPages[turn](message.params)
                : itemPages[turn]?.[offset] ?? { data: [], nextCursor: null };
              itemOffsets.set(turn, offset + 1);
            }
            if (["thread/start", "thread/resume"].includes(message.method)) {
              const url = message.params.config?.mcp_servers?.[BRIDGE_NAME]?.url;
              bridge = bridges.find((candidate) => candidate.url === url);
              result = {
                thread: { id: "thread-1", turns: message.method === "thread/resume" && !message.params.excludeTurns ? resumeTurns : [] },
                model: message.params.model || normalized.model || "server-default-model",
                reasoningEffort: message.params.config?.model_reasoning_effort ?? normalized.model_reasoning_effort ?? null,
                ...resolved,
              };
            }
            if (message.method === "thread/unsubscribe") result = { status: "unsubscribed" };
            if (message.method === "turn/start") result = { turn: { id: "turn-1" } };
            if (message.method === "thread/backgroundTerminals/list") result = { data: [], nextCursor: null };
            send({ id: message.id, result });
            if (message.method === "turn/start") {
              turns.push({ finish, process, message });
              starts.get(turns.length)?.resolve();
              if (complete) queueMicrotask(() => void finish());
            }
          }
        },
        async end() { process.ended = true; exit.resolve(0); },
        async kill() { process.ended = true; exit.resolve(null); },
      };
      processes.push(process);
      return process;
    },
  };
  const kit = {
    conversation: async (delivery, scope) => delivery.ignore ? undefined : {
      key: delivery.conversation ?? "channel", channel: "channel", topLevel: true, scope,
    },
    systemPrompt: async (_delivery, options) => "Buzz prompt: " + options.instructions,
    standalonePrompt: (_agent, text) => "Standalone context\n" + text,
    turnPrompt: async (_delivery, _conversation, options) => {
      prompts.push(options);
      return { text: "User request", cursor: `cursor-${prompts.length}`, restore() { restores++; } };
    },
    tools: () => async () => ({ jsonrpc: "2.0", id: 90, result: { content: [], isError: false } }),
    reply: async (_agent, _conversation, text, options) => { replies.push({ text, options }); },
  };
  let snapshot = { status: "ready", running: [{ key: "agent" }] };
  const agentListeners = new Set();
  const agents = { harness: kit, snapshot: () => snapshot,
    subscribe(listener) { agentListeners.add(listener); return () => agentListeners.delete(listener); } };
  const updateAgents = (running, status = "ready") => {
    snapshot = { status, running };
    for (const listener of agentListeners) listener();
  };
  const runtime = new CodexMcpRuntime(host, kit, storage);
  const delivery = (overrides = {}) => ({
    agent: { key: "agent", name: "Tester", pubkey: "agent", owner: "owner", relay: "wss://example.org" },
    signal: new AbortController().signal, config: settings(),
    acknowledged() { acknowledged++; }, ...overrides,
  });
  const started = (count) => {
    if (turns.length >= count) return Promise.resolve();
    if (!starts.has(count)) starts.set(count, deferred());
    return starts.get(count).promise;
  };
  // Model the host's handover and working hold as separate promises. Most
  // tests wait for activity; handover/deadline tests call runtime.run directly.
  const run = async (delivery) => {
    let activity;
    await runtime.run({ ...delivery, workingUntil(pending) {
      activity = pending;
      delivery.workingUntil?.(pending);
    } });
    await activity;
  };
  return { runtime, host, kit, storage, calls, processes, bridges, replies, prompts, turns,
    delivery, started, run, agents, updateAgents, agentListeners, get restores() { return restores; }, get acknowledged() { return acknowledged; } };
}

test("thread configuration preserves transports, credentials, disabled servers and tool restrictions", () => {
  const servers = {
    local: { command: "node", args: ["server.mjs"], env: { TOKEN: "secret" }, enabled_tools: ["read"] },
    remote: { url: "https://example.org/mcp", bearer_token_env_var: "TOKEN", disabled_tools: ["delete"],
      default_tools_approval_mode: "prompt", tools: { update: { approval_mode: "prompt" } } },
    disabled: { command: "do-not-run", enabled: false },
  };
  const before = JSON.stringify(servers);
  const result = threadParams(settings(), "/workspace", "instructions", { mcp_servers: servers }, {
    url: "http://127.0.0.1/mcp", headers: [{ name: "Authorization", value: "Bearer local" }],
  });
  for (const [name, server] of Object.entries(servers)) assert.deepEqual(result.config.mcp_servers[name], server);
  assert.equal(JSON.stringify(servers), before);
  assert.equal(result.config.mcp_servers[BRIDGE_NAME].required, true);
  assert.equal(result.config.mcp_servers[BRIDGE_NAME].default_tools_approval_mode, "approve");
  assert.equal(result.config.mcp_servers[BRIDGE_NAME].tools, undefined);
  assert.equal(result.sandbox, "workspace-write");
  assert.equal(result.approvalPolicy, "never");
  assert.equal(result.config["features.plugins"], undefined);
  assert.throws(() => threadParams(settings(), "/", "", { mcp_servers: { [BRIDGE_NAME]: {} } }, { headers: [] }), /reserved/);
});

test("normalized unset fields are omitted while false, zero and empty tool allow lists survive", () => {
  const result = threadParams(settings(), "/", "", { mcp_servers: { fixture: {
    command: "node", tool_timeout_sec: null, enabled: false, startup_timeout_sec: 0,
    enabled_tools: [], env: { UNUSED: null, EMPTY: "" },
  } } }, { url: "http://127.0.0.1/mcp", headers: [] });
  assert.deepEqual(result.config.mcp_servers.fixture, {
    command: "node", enabled: false, startup_timeout_sec: 0, enabled_tools: [], env: { EMPTY: "" },
  });
});

test("model discovery paginates, returns only picker metadata and closes Codex without starting a turn", async () => {
  const f = fixture({ normalized: { model: "sol", model_reasoning_effort: "high",
    mcp_servers: { private: { env: { TOKEN: "catalog-secret" } } } }, modelPages: [
    { data: [{ model: "sol", displayName: "Sol", defaultReasoningEffort: "medium", isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }], nextCursor: "next" },
    { data: [{ model: "hidden", hidden: true }, { model: "fast", displayName: "Fast",
      defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: null },
  ] });
  const resolve = f.host.resolveDirectory;
  f.host.resolveDirectory = (path, options) => { assert.deepEqual(options, { create: false }); return resolve(path); };
  const catalog = await readModelCatalog(f.host, "~/.buzz");
  assert.deepEqual(catalog.models.map((model) => model.value), ["sol", "fast"]);
  assert.equal(catalog.defaultModel, "sol");
  assert.equal(catalog.defaultEffort, "high");
  assert.equal(catalog.configuredEffort, "high");
  assert.deepEqual(catalog.models[0].efforts, ["low", "high"]);
  assert.equal(JSON.stringify(catalog).includes("catalog-secret"), false);
  assert.equal(f.calls.filter((call) => call.method === "model/list")[1].params.cursor, "next");
  assert.equal(f.calls.some((call) => call.method.startsWith("thread/") || call.method === "turn/start"), false);
  assert.equal(f.bridges.length, 0);
  assert.equal(f.processes[0].ended, true);
});

test("model discovery releases its process on failure and does not start after cancellation", async () => {
  const f = fixture({ fail: "model/list" });
  await assert.rejects(readModelCatalog(f.host, "~/.buzz"), /Fixture failure/);
  assert.equal(f.processes[0].ended, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readModelCatalog(f.host, "~/.buzz", controller.signal), /abort/i);
  assert.equal(f.processes.length, 1);
});

test("the registered composer slider offers the current model's efforts and preserves implicit defaults", async (t) => {
  const f = fixture({ normalized: { model: "sol", model_reasoning_effort: "high" }, modelPages: [{ data: [
    { model: "sol", displayName: "Sol", isDefault: true, defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] },
    { model: "fast", displayName: "Fast", defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] },
  ], nextCursor: null }] });
  const view = settingsView(f);
  t.after(() => view.dispose());
  const [inherited, configured] = await Promise.all([
    view.models({ config: {} }),
    view.models({ config: { workspace: " ~/.buzz ", model: "fast", effort: "medium" } }),
  ]);
  assert.deepEqual(inherited, { current: "sol", models: [{
    id: "sol", label: "Sol", effort: "high", efforts: [
      { id: "low", label: "Low" }, { id: "high", label: "High" }, { id: "xhigh", label: "Extra high" },
    ],
  }] });
  assert.deepEqual(configured, { current: "fast", models: [{
    id: "fast", label: "Fast", effort: "medium", efforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }],
  }] });
  assert.equal((await view.models({ config: { model: "fast" } })).models[0].effort, undefined);
  assert.deepEqual(await view.models({ config: { model: "custom" } }), {
    current: "custom", models: [{ id: "custom", label: "custom", efforts: [] }],
  });
  assert.equal(f.processes.length, 1, "agents in the same workspace share discovery and immediate revalidation");
  assert.equal(f.processes[0].ended, true);
  assert.equal(f.bridges.length, 0);
  assert.ok(!f.calls.some((call) => call.method.startsWith("thread/") || call.method.startsWith("turn/")));
});

test("composer discovery retries a failed catalog and skips unavailable agents", async (t) => {
  const f = fixture({ modelPages: [{ data: [{ model: "sol", isDefault: true, defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }], nextCursor: null }] });
  const resolve = f.host.resolveDirectory;
  let attempts = 0;
  f.host.resolveDirectory = async (...args) => {
    if (++attempts === 1) throw new Error("Workspace missing");
    return resolve(...args);
  };
  const view = settingsView(f);
  t.after(() => view.dispose());
  assert.deepEqual(await view.models({ configProblem: "unavailable" }), { current: "", models: [] });
  assert.deepEqual(await view.models({ protection: {} }), { current: "", models: [] });
  assert.equal(attempts, 0);
  await assert.rejects(view.models({ config: {} }), /Workspace missing/);
  assert.equal((await view.models({ config: {} })).models[0].effort, "low");
  assert.equal(attempts, 2);
});

test("disabling the plugin drains a composer catalog that is still opening", async () => {
  const f = fixture();
  const spawn = f.host.spawn;
  const spawned = deferred(), continueOpening = deferred();
  f.host.spawn = async (...args) => {
    const process = await spawn(...args);
    spawned.resolve(process);
    await continueOpening.promise;
    return process;
  };
  const view = settingsView(f);
  const rejected = assert.rejects(view.models({ config: {} }), /connection closed|abort/i);
  const process = await spawned.promise;
  const disposed = view.dispose();
  continueOpening.resolve();
  await Promise.all([rejected, disposed]);
  assert.equal(process.ended, true);
});

test("model dropdown defaults and supported efforts follow the selected model", () => {
  const catalog = { defaultModel: "sol", defaultEffort: "high", configuredEffort: "high", models: [
    { value: "sol", label: "Sol", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
    { value: "fast", label: "Fast", defaultEffort: "low", efforts: ["low", "medium"] },
  ] };
  const inherited = modelChoices(catalog, settings());
  assert.equal(inherited.models[0].value, "");
  assert.equal(inherited.models[0].label, "Sol · Default");
  assert.equal(inherited.efforts[0].label, "High · Default");
  assert.deepEqual(modelChoices(catalog, settings({ model: "fast" })).efforts.map((effort) => effort.value), ["", "low", "medium"]);
  assert.equal(changeModel(settings({ model: "sol", effort: "xhigh" }), catalog, "fast").effort, "low");
  assert.equal(changeModel(settings({ model: "sol", effort: "low" }), catalog, "fast").effort, "low");
  assert.equal(modelChoices(catalog, settings({ model: "fast" })).efforts[0].label, "High · Default (unsupported)");
  assert.equal(modelChoices(catalog, settings({ model: "fast" })).efforts[0].disabled, true);
  const modelDefaults = { ...catalog, configuredEffort: "" };
  assert.equal(modelChoices(modelDefaults, settings({ model: "fast" })).efforts[0].label, "Low · Default");
  assert.equal(changeModel(settings({ effort: "xhigh" }), modelDefaults, "fast").effort, "");
});

test("saved custom model and effort values stay visible until the owner changes them", () => {
  const config = settings({ model: "custom-model", effort: "future-effort" });
  const choices = modelChoices({ models: [], defaultModel: "", defaultEffort: "" }, config);
  assert.deepEqual(choices.models.at(-1), { value: "custom-model", label: "custom-model · Saved" });
  assert.deepEqual(choices.efforts.at(-1), { value: "future-effort", label: "future-effort · Saved" });
  assert.equal(config.model, "custom-model");
  assert.equal(config.effort, "future-effort");
});

test("expiry before admission does not launch or track work", async () => {
  const f = fixture(), gate = deferred(), entered = deferred(), deadline = new AbortController();
  const conversation = f.kit.conversation;
  f.kit.conversation = async (...args) => { entered.resolve(); await gate.promise; return conversation(...args); };
  const handed = f.runtime.run(f.delivery({ signal: deadline.signal }));
  const rejected = assert.rejects(handed, { name: "TimeoutError" });
  await entered.promise;
  deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
  gate.resolve();
  await rejected;
  assert.equal(f.runtime.jobs.size, 0);
  assert.equal(f.processes.length, 0);
  assert.equal(f.bridges.length, 0);
});

test("accepted work and its working hold outlive the delivery deadline", async (t) => {
  const f = fixture({ complete: false }), deadline = new AbortController();
  t.after(() => f.runtime.dispose());
  let activity, finished = false;
  const handed = f.runtime.run(f.delivery({ signal: deadline.signal,
    workingUntil(pending) { activity = pending; void pending.then(() => { finished = true; }, () => {}); } }));
  const accepted = assert.doesNotReject(handed);
  await f.started(1);
  deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
  await accepted;
  assert.equal(finished, false);
  assert.equal(f.runtime.jobs.size, 1);
  assert.equal(f.processes[0].ended, false);
  assert.equal(f.bridges[0].closeCount, 0);
  await f.bridges[0].handler({ method: "tools/list" });
  await f.turns[0].finish();
  await activity;
  assert.equal(finished, true);
  assert.equal(f.replies[0].text, "Result from Codex");
  assert.equal(f.runtime.jobs.size, 0);
  assert.equal(f.bridges[0].closeCount, 1);
});

test("accepted queued deliveries return promptly and survive expiry without overlapping turns", { timeout: 2000 }, async (t) => {
  const f = fixture({ complete: false }), deadline = new AbortController(), activity = [];
  t.after(() => f.runtime.dispose());
  const delivery = (overrides) => f.delivery({ signal: deadline.signal,
    workingUntil: (pending) => { activity.push(pending); }, ...overrides });
  await f.runtime.run(delivery());
  await f.started(1);
  await f.runtime.run(delivery());
  assert.equal(f.runtime.jobs.size, 2);
  assert.equal(f.turns.length, 1);
  deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
  await f.runtime.run(delivery({ signal: new AbortController().signal, conversation: "other" }));
  await f.started(2);
  assert.equal(f.turns.length, 2, "a separate conversation can proceed while this queue waits");
  await f.turns[0].finish();
  await f.started(3);
  assert.equal(f.calls.filter((call) => call.method === "thread/resume").length, 1);
  await f.turns[1].finish();
  await f.turns[2].finish();
  await Promise.all(activity);
  assert.equal(f.runtime.jobs.size, 0);
  assert.equal(f.replies.length, 3);
});

for (const action of ["Stop", "retire", "dispose"]) {
  test(`${action} still stops accepted work after its delivery expires`, async () => {
    const f = fixture({ complete: false }), deadline = new AbortController();
    let stop, activity;
    await f.runtime.run(f.delivery({ signal: deadline.signal,
      interruptible: (callback) => { stop = callback; }, workingUntil: (pending) => { activity = pending; } }));
    await f.started(1);
    deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
    if (action === "Stop") await stop();
    else if (action === "retire") await f.runtime.retire("agent");
    else await f.runtime.dispose();
    await activity;
    assert.equal(f.calls.filter((call) => call.method === "turn/interrupt").length, 1);
    assert.equal(f.calls.filter((call) => call.method === "thread/backgroundTerminals/clean").length, 1);
    assert.equal(f.processes[0].ended, true);
    assert.equal(f.bridges[0].closeCount, 1);
    assert.equal(f.runtime.jobs.size, 0);
    assert.equal(f.replies.length, 0);
  });
}

test("agent lifecycle subscription cancels handed-off work after expiry and unsubscribes on disposal", async () => {
  const f = fixture({ complete: false }), deadline = new AbortController(), view = settingsView(f);
  let activity;
  try {
    await view.run(f.delivery({ signal: deadline.signal, workingUntil: (pending) => { activity = pending; } }));
    await f.started(1);
    deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
    f.updateAgents([], "loading");
    await f.bridges[0].handler({ method: "tools/list" });
    assert.equal(f.processes[0].ended, false, "a loading snapshot cannot retire an agent");
    f.updateAgents([{ key: "agent" }]);
    await f.bridges[0].handler({ method: "tools/list" });
    f.updateAgents([]);
    await activity;
    assert.equal(f.processes[0].ended, true);
    assert.equal(f.bridges[0].closeCount, 1);
    assert.equal(f.replies.length, 0);
  } finally { await view.dispose(); }
  assert.equal(f.agentListeners.size, 0);
});

test("a failure after handover fails the working hold and reports the error", async () => {
  const f = fixture({ complete: false });
  let activity;
  await f.runtime.run(f.delivery({ workingUntil: (pending) => { activity = pending; } }));
  const failed = assert.rejects(activity, /Provider failed/);
  await f.started(1);
  f.turns[0].process.send({ method: "turn/completed", params: { threadId: "thread-1",
    turn: { id: "turn-1", status: "failed", error: { message: "Provider failed" } } } });
  await failed;
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].options.notifyOwner, true);
  assert.equal(f.processes[0].ended, true);
  assert.equal(f.bridges[0].closeCount, 1);
});

test("a complete turn keeps Codex warm and resumes with a fresh Buzz bridge and configuration", async (t) => {
  const normalized = { mcp_servers: { local: { command: "fixture", enabled: true } } };
  const f = fixture({ normalized });
  t.after(() => f.runtime.dispose());
  await f.run(f.delivery());
  assert.equal(f.replies[0].text, "Result from Codex");
  assert.equal(f.acknowledged, 1);
  assert.equal(f.processes[0].ended, false);
  assert.equal(f.bridges[0].closeCount, 1);
  const saved = [...f.storage.values.values()][0];
  assert.equal(saved.includes("bridge-secret"), false);
  const { at, ...binding } = JSON.parse(saved);
  assert.ok(Number.isFinite(at));
  assert.deepEqual(binding, { version: 1, threadId: "thread-1", cwd: "/home/test/.buzz", cursor: "cursor-1" });
  normalized.mcp_servers.local.enabled = false;
  await f.run(f.delivery());
  assert.equal(f.processes.length, 1);
  assert.equal(f.calls.filter((x) => x.method === "thread/resume").length, 1);
  assert.equal(f.calls.filter((x) => x.method === "thread/unsubscribe").length, 2);
  assert.equal(f.calls.filter((x) => x.method === "config/read").length, 2);
  assert.equal(f.prompts[1].cursor, "cursor-1");
  const servers = f.calls.find((x) => x.method === "thread/resume").params.config.mcp_servers;
  assert.equal(servers[BRIDGE_NAME].url, f.bridges[1].url);
  assert.equal(servers.local.enabled, false);
  assert.equal(f.bridges[1].closeCount, 1);
  await assert.rejects(f.bridges[0].handler({ method: "tools/list" }), /turn ended/);
});

test("an unsupported thread release falls back to a fresh process on the next turn", async () => {
  const f = fixture({ fail: "thread/unsubscribe" });
  await f.run(f.delivery());
  await f.run(f.delivery());
  assert.equal(f.processes.length, 2);
  assert.ok(f.processes.every((process) => process.ended));
  assert.ok(f.bridges.every((bridge) => bridge.closeCount === 1));
  assert.equal(f.replies.length, 2);
  assert.equal(f.calls.find((call) => call.method === "thread/resume").params.threadId, "thread-1");
});

test("idle processes are bounded and expire without clearing saved sessions", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const f = fixture();
  t.after(() => f.runtime.dispose());
  for (let index = 0; index < 5; index++) await f.run(f.delivery({ conversation: `channel-${index}` }));
  assert.equal(f.processes.filter((process) => !process.ended).length, 4);
  assert.ok(f.bridges.every((bridge) => bridge.closeCount === 1));
  t.mock.timers.tick(2 * 60_000);
  await Promise.all(f.processes.map((process) => process.exited));
  assert.equal(f.storage.values.size, 5);
  await f.run(f.delivery({ conversation: "channel-0" }));
  assert.equal(f.processes.length, 6);
  assert.equal(f.calls.find((call) => call.method === "thread/resume").params.threadId, "thread-1");
});

test("frequent turns still rotate a process after ten minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const f = fixture();
  t.after(() => f.runtime.dispose());
  for (let minute = 0; minute < 10; minute++) {
    await f.run(f.delivery());
    assert.equal(f.processes.length, 1);
    t.mock.timers.tick(60_000);
  }
  await f.run(f.delivery());
  assert.equal(f.processes[0].ended, true);
  assert.equal(f.processes.length, 2);
});

test("an idle process exit is recovered by resuming the saved conversation in a fresh process", async (t) => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.run(f.delivery());
  await f.processes[0].kill();
  await f.run(f.delivery());
  assert.equal(f.processes.length, 2);
  assert.equal(f.calls.find((call) => call.method === "thread/resume").params.threadId, "thread-1");
  assert.equal(f.replies.length, 2);
});

test("retirement closes only that agent's idle process and disposal closes the rest", async () => {
  const f = fixture();
  await f.run(f.delivery());
  await f.run(f.delivery({ agent: { key: "other-agent" } }));
  await f.runtime.retire("agent");
  assert.deepEqual(f.processes.map((process) => process.ended), [true, false]);
  await f.runtime.dispose();
  assert.deepEqual(f.processes.map((process) => process.ended), [true, true]);
});

test("an existing binding resumes under the shared development and public identity without starting a new thread", async () => {
  const f = fixture();
  const key = "digital.panos.buzz-plugin-codex-with-mcp/session/agent/channel";
  f.storage.setItem(key, JSON.stringify({ version: 1, threadId: "thread-1", cwd: "/home/test/.buzz", cursor: "saved-cursor" }));
  await f.run(f.delivery());
  assert.equal(f.calls.some((call) => call.method === "thread/start"), false);
  assert.equal(f.calls.find((call) => call.method === "thread/resume").params.threadId, "thread-1");
  assert.equal(f.prompts[0].cursor, "saved-cursor");
  assert.equal(f.storage.values.size, 1);
  assert.equal(f.runtime.store.read(key).threadId, "thread-1");
});

test("a saved conversation with history over the frame limit resumes without returning its turns", async () => {
  const f = fixture({ resumeTurns: [{ id: "old-turn", status: "completed", items: [
    { type: "userMessage", content: [{ type: "text", text: "x".repeat(4 * 1024 * 1024) }] },
  ] }] });
  const key = f.runtime.store.key("agent", "channel");
  f.runtime.store.write(key, { threadId: "thread-1", cwd: "/home/test/.buzz", cursor: "saved-cursor" });
  try {
    await f.run(f.delivery());
    assert.equal(f.calls.some((call) => call.method === "thread/start"), false);
    assert.equal(f.calls.find((call) => call.method === "thread/resume").params.excludeTurns, true);
    assert.equal(f.prompts[0].cursor, "saved-cursor");
    assert.equal(f.runtime.store.read(key).threadId, "thread-1");
    assert.equal(f.replies[0].text, "Result from Codex");
    assert.equal(f.bridges[0].closeCount, 1);
  } finally { await f.runtime.dispose(); }
});

test("standalone Attention executes through the registered handler without a saved session or default destination", async () => {
  const f = fixture(), view = settingsView(f);
  const existing = f.runtime.store.key("agent", "channel");
  f.runtime.store.write(existing, { threadId: "existing", cwd: "/workspace" });
  const before = f.storage.getItem(existing);
  let promptCalls = 0, toolConversation = "unset";
  const tools = f.kit.tools;
  f.kit.tools = (_agent, conversation, options) => { toolConversation = conversation; return tools(_agent, conversation, options); };
  const result = await view.runOnce({ delivery: f.delivery(), key: "timer", signal: new AbortController().signal,
    prompt: async () => { promptCalls++; return "Inspect the fixture; use an explicit destination if reporting."; } });
  assert.deepEqual(result, { ok: true });
  assert.equal(promptCalls, 1);
  assert.equal(toolConversation, undefined);
  assert.equal(f.calls.find((call) => call.method === "thread/start").params.ephemeral, true);
  assert.match(f.calls.find((call) => call.method === "thread/start").params.developerInstructions, /no default Buzz destination/);
  assert.equal(f.calls.some((call) => call.method === "thread/resume"), false);
  assert.ok(f.turns[0].message.params.input[0].text.includes("Standalone context\nInspect the fixture"));
  assert.equal(f.storage.values.size, 1);
  assert.equal(f.storage.getItem(existing), before);
  assert.equal(f.replies.length, 0);
  assert.equal(f.processes[0].ended, true);
  assert.equal(f.bridges[0].closeCount, 1);
  await view.dispose();
});

test("a standalone turn waits for actual completion after a final send and ignores the delivery deadline", async () => {
  const f = fixture({ complete: false }), deadline = new AbortController();
  deadline.abort(new DOMException("Delivery expired", "TimeoutError"));
  let settled = false;
  const running = f.runtime.runOnce({ delivery: f.delivery({ signal: deadline.signal }), key: "watch",
    signal: new AbortController().signal, prompt: async () => "Standalone fixture" });
  void running.then(() => { settled = true; });
  await f.started(1);
  await f.bridges[0].handler({ method: "tools/call", params: { name: "send", arguments: { final: true, channel: "explicit" } } });
  assert.equal(settled, false);
  assert.equal(f.runtime.jobs.size, 1);
  await f.turns[0].finish();
  assert.deepEqual(await running, { ok: true });
  assert.equal(f.runtime.jobs.size, 0);
  assert.equal(f.storage.values.size, 0);
  assert.equal(f.replies.length, 0);
});

for (const action of ["signal", "retire", "dispose"]) {
  test(`standalone execution is cancelled by ${action} and drains process and bridge cleanup`, async () => {
    const f = fixture({ complete: false }), signal = new AbortController();
    const running = f.runtime.runOnce({ delivery: f.delivery(), key: "watch", signal: signal.signal, prompt: async () => "Standalone fixture" });
    await f.started(1);
    if (action === "signal") signal.abort(new DOMException("Standalone expired", "TimeoutError"));
    else if (action === "retire") await f.runtime.retire("agent");
    else await f.runtime.dispose();
    assert.equal((await running).ok, false);
    assert.ok(f.calls.some((call) => call.method === "turn/interrupt"));
    assert.equal(f.runtime.jobs.size, 0);
    assert.equal(f.processes[0].ended, true);
    assert.equal(f.bridges[0].closeCount, 1);
    assert.equal(f.replies.length, 0);
  });
}

test("an unwanted standalone prompt starts no thread or model, and standalone errors have no implicit publication", async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.runOnce({ delivery: f.delivery(), key: "timer", signal: new AbortController().signal,
    prompt: async () => undefined }), { ok: true });
  assert.equal(f.calls.some((call) => ["thread/start", "turn/start"].includes(call.method)), false);
  assert.equal(f.processes[0].ended, true);
  const failed = fixture({ fail: "turn/start" });
  assert.deepEqual(await failed.runtime.runOnce({ delivery: failed.delivery(), key: "timer", signal: new AbortController().signal,
    prompt: async () => "Fixture" }), { ok: false, error: "Fixture failure" });
  assert.equal(failed.replies.length, 0);
  assert.equal(failed.storage.values.size, 0);
  assert.equal(failed.processes[0].ended, true);
});

test("standalone execution refuses protected, disposed and pre-aborted work without launching processes", async () => {
  const f = fixture(), aborted = new AbortController();
  aborted.abort();
  const turn = { delivery: f.delivery(), key: "timer", signal: new AbortController().signal, prompt: async () => "Fixture" };
  assert.equal((await f.runtime.runOnce({ ...turn, delivery: f.delivery({ agent: { key: "agent", protection: {} } }) })).ok, false);
  assert.equal((await f.runtime.runOnce({ ...turn, signal: aborted.signal })).ok, false);
  await f.runtime.dispose();
  assert.equal((await f.runtime.runOnce(turn)).ok, false);
  assert.equal(f.processes.length, 0);
});

test("standalone eligibility is rechecked after prompt readiness and cleanup failures fail the result", async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  let current = true;
  const running = f.runtime.runOnce({ delivery: f.delivery({ current: () => current }), key: "timer", signal: new AbortController().signal,
    prompt: async () => { entered.resolve(); await gate.promise; return "Fixture"; } });
  await entered.promise;
  current = false; gate.resolve();
  assert.deepEqual(await running, { ok: true });
  assert.equal(f.calls.some((call) => call.method === "thread/start"), false);
  const failed = fixture({ fail: "thread/backgroundTerminals/clean" });
  assert.deepEqual(await failed.runtime.runOnce({ delivery: failed.delivery(), key: "timer", signal: new AbortController().signal,
    prompt: async () => "Fixture" }), { ok: false, error: "Fixture failure" });
  assert.equal(failed.processes[0].ended, true);
  assert.equal(failed.bridges[0].closeCount, 1);
  assert.equal(failed.replies.length, 0);
});

test("each turn receives the model and effort resolved by Codex instead of a configured alias", async () => {
  const f = fixture({ normalized: { model: "configured-alias" },
    resolved: { model: "resolved-model", reasoningEffort: "high" } });
  await f.run(f.delivery());
  const turn = f.turns[0].message.params;
  assert.equal(turn.model, "resolved-model");
  assert.equal(turn.effort, "high");
  assert.ok(turn.input[0].text.includes(JSON.stringify({ model: "resolved-model", reasoning_effort: "high" })));
  assert.ok(turn.input[0].text.endsWith("User request"));
});

test("resumed turns receive complete current developer context, including updates and removals", async () => {
  const f = fixture();
  const first = "Original instruction and team memory. " + "🐝".repeat(2500);
  await f.run(f.delivery({ config: settings({ instructions: first }) }));
  await f.run(f.delivery({ config: settings({ instructions: "Updated instructions without team memory." }) }));
  await f.run(f.delivery({ config: settings({ instructions: "" }) }));
  const context = (index) => Object.values(f.turns[index].message.params.additionalContext ?? {}).map((entry) => {
    assert.equal(entry.kind, "application");
    assert.ok(Buffer.byteLength(entry.value) <= 4000, "Codex truncates larger context values");
    return entry.value;
  }).join("");
  assert.ok(context(0).includes(first));
  assert.ok(context(1).includes("Updated instructions without team memory."));
  assert.equal(context(1).includes(first), false);
  assert.ok(context(2).includes("Buzz prompt: "));
  assert.equal(context(2).includes("Updated instructions"), false);
  assert.equal(f.calls.filter((call) => call.method === "thread/start").length, 1);
  assert.equal(f.calls.filter((call) => call.method === "thread/resume").length, 2);
});

for (const stage of ["systemPrompt", "turnPrompt"]) {
  test(`a request invalidated during ${stage} starts no model turn and restores unused notes`, async () => {
    const f = fixture(), gate = deferred(), entered = deferred();
    let current = true, ignored = 0;
    const prepare = f.kit[stage];
    f.kit[stage] = async (...args) => { entered.resolve(); await gate.promise; return prepare(...args); };
    const running = f.run(f.delivery({ current: () => current, ignored() { ignored++; } }));
    await entered.promise;
    current = false; gate.resolve();
    await running;
    assert.equal(f.turns.length, 0);
    assert.equal(ignored, 1);
    assert.equal(f.restores, 1);
    assert.equal(f.storage.values.size, 0);
    assert.equal(f.processes[0].ended, true);
    assert.equal(f.bridges[0].closeCount, 1);
  });
}

for (const phase of ["commentary", "final_answer"]) {
  test(`${phase} text is ${phase === "commentary" ? "not " : ""}used as the final fallback`, async () => {
    const f = fixture({ complete: false });
    const running = f.run(f.delivery());
    await f.started(1);
    f.processes[0].send({ method: "item/completed", params: { threadId: "thread-1",
      item: { type: "agentMessage", phase, text: "Phase-specific message" } } });
    f.processes[0].send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await running;
    assert.deepEqual(f.replies.map((reply) => reply.text), phase === "commentary" ? [] : ["Phase-specific message"]);
  });
}

test("later commentary does not replace a final answer or hide a failed final send", async () => {
  for (const failedSend of [false, true]) {
    const f = fixture({ complete: false });
    if (failedSend) f.kit.tools = () => async () => ({ result: { isError: true, content: [] } });
    const running = f.run(f.delivery());
    const result = failedSend ? assert.rejects(running, /could not deliver/) : running;
    await f.started(1);
    if (failedSend) await f.bridges[0].handler({ method: "tools/call", params: { name: "send", arguments: { final: true } } });
    else f.processes[0].send({ method: "item/completed", params: { threadId: "thread-1",
      item: { type: "agentMessage", phase: "final_answer", text: "Final answer" } } });
    f.processes[0].send({ method: "item/completed", params: { threadId: "thread-1",
      item: { type: "agentMessage", phase: "commentary", text: "Progress text" } } });
    f.processes[0].send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    await result;
    assert.equal(f.replies.some((reply) => reply.text === "Progress text"), false);
    if (!failedSend) assert.equal(f.replies[0].text, "Final answer");
  }
});

test("an execution access change closes the idle process before resuming", async (t) => {
  const f = fixture();
  t.after(() => f.runtime.dispose());
  await f.run(f.delivery());
  await f.run(f.delivery({ config: settings({ sandbox: "danger-full-access" }) }));
  assert.equal(f.processes.length, 2);
  assert.equal(f.processes[0].ended, true);
  const start = f.calls.find((call) => call.method === "thread/start");
  const resume = f.calls.find((call) => call.method === "thread/resume");
  assert.equal(start.params.sandbox, "workspace-write");
  assert.equal(resume.params.sandbox, "danger-full-access");
  assert.equal(resume.params.threadId, "thread-1");
  assert.equal(resume.params.approvalPolicy, "never");
  assert.equal(settings().sandbox, "workspace-write");
});

test("message picks override agent defaults and fresh agent settings are used on resume", async () => {
  const f = fixture({ normalized: { model: "global-model", model_reasoning_effort: "low" } });
  const config = settings({ model: "agent-model", effort: "medium" });
  await f.run(f.delivery({ config, model: "message-model", effort: "xhigh" }));
  await f.run(f.delivery({ config }));
  const starts = f.calls.filter((call) => ["thread/start", "thread/resume"].includes(call.method));
  for (const [index, model, effort] of [[0, "message-model", "xhigh"], [1, "agent-model", "medium"]]) {
    assert.equal(starts[index].params.model, model);
    assert.equal(starts[index].params.config.model_reasoning_effort, effort);
    assert.equal(f.turns[index].message.params.model, model);
    assert.equal(f.turns[index].message.params.effort, effort);
    assert.ok(f.turns[index].message.params.input[0].text.includes(JSON.stringify({ model, reasoning_effort: effort })));
  }
});

test("an unreported effort is represented explicitly rather than guessed", async () => {
  const f = fixture({ resolved: { model: "default-model", reasoningEffort: null } });
  await f.run(f.delivery());
  const turn = f.turns[0].message.params;
  assert.equal(turn.effort, undefined);
  assert.ok(turn.input[0].text.includes(JSON.stringify({ model: "default-model", reasoning_effort: null })));
  assert.match(turn.input[0].text, /did not report an explicit/);
});

test("Codex discovery connections share the turn's bridge without a native shell bootstrap", async () => {
  const f = fixture();
  const serve = f.host.serveMcp;
  let initializations = 0;
  f.host.serveMcp = (handler, options) => {
    assert.deepEqual(options, { sharedSession: true });
    return serve(async (message) => {
      if (message.method === "initialize" && ++initializations > 1 && !options.sharedSession) {
        // Match host_mcp.rs: repeated initialization needs explicit shared mode.
        await f.bridges[0].close();
        throw new Error("A second client claimed the Buzz bridge.");
      }
      return handler(message);
    });
  };
  const spawn = f.host.spawn;
  f.host.spawn = async (id, options) => {
    const initialize = () => f.bridges[0].handler({ id: 1, method: "initialize" });
    if (options.mcp) await initialize(); // Native command helper's bootstrap.
    const process = await spawn(id, options);
    const write = process.write;
    process.write = async (data) => {
      if (data.includes('"method":"thread/start"')) {
        await initialize();
        await initialize(); // Codex discovery also initializes a client.
      }
      return write(data);
    };
    return process;
  };
  await f.run(f.delivery());
  assert.equal(initializations, 2);
  assert.equal(f.processes[0].options.mcp, undefined);
  assert.equal(f.calls.find((call) => call.method === "thread/start").params.config.mcp_servers[BRIDGE_NAME].url,
    f.bridges[0].url);
  assert.equal(f.acknowledged, 1);
  assert.equal(f.replies[0].text, "Result from Codex");
});

test("native string rejections produce a readable error and release the bridge", async () => {
  const f = fixture();
  f.host.spawn = async () => { throw "Native process launch rejected."; };
  await assert.rejects(f.run(f.delivery()), (error) =>
    error instanceof Error && error.message === "Native process launch rejected.");
  assert.equal(f.replies[0].text, "Codex with MCP could not finish: Native process launch rejected.");
  assert.equal(f.replies[0].options.notifyOwner, true);
  assert.equal(f.bridges[0].closeCount, 1);
  assert.equal(f.storage.values.size, 0);
});

test("a successful final Buzz send suppresses the fallback message", async () => {
  const f = fixture({ finalSend: true });
  await f.run(f.delivery());
  assert.equal(f.replies.length, 0);
});

for (const message of [undefined, "   "]) {
  test(`a completed silent turn succeeds with ${message === undefined ? "no assistant message" : "blank text"} and keeps its saved session`, async (t) => {
    const f = fixture({ complete: false });
    t.after(() => f.runtime.dispose());
    const running = f.run(f.delivery());
    const outcome = assert.doesNotReject(running);
    await f.started(1);
    if (message === undefined) f.turns[0].process.send({ method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    else await f.turns[0].finish(message);
    await outcome;
    assert.equal(f.replies.length, 0);
    assert.equal(f.storage.values.size, 1);
    assert.equal(f.bridges[0].closeCount, 1);
    assert.equal(f.runtime.jobs.size, 0);
  });
}

test("a successful non-final send followed by silence does not create a false failure", async () => {
  const f = fixture({ complete: false });
  const running = f.run(f.delivery());
  const outcome = assert.doesNotReject(running);
  await f.started(1);
  await f.bridges[0].handler({ id: 90, method: "tools/call",
    params: { name: "send", arguments: { text: "Posted result", final: false } } });
  await f.turns[0].finish("");
  await outcome;
  assert.equal(f.replies.length, 0);
});

for (const throwing of [false, true]) {
  test(`a ${throwing ? "throwing" : "rejected"} final send followed by silence still reports delivery failure`, async () => {
    const f = fixture({ complete: false });
    f.kit.tools = () => async () => { if (throwing) throw new Error("Delivery refused"); return { result: { isError: true } }; };
    const running = f.run(f.delivery());
    const outcome = assert.rejects(running, /Buzz could not deliver the final reply/);
    await f.started(1);
    const sent = f.bridges[0].handler({ id: 90, method: "tools/call",
      params: { name: "send", arguments: { text: "Rejected", final: true } } });
    if (throwing) await assert.rejects(sent, /Delivery refused/);
    else await sent;
    await f.turns[0].finish("");
    await outcome;
    assert.equal(f.replies.length, 1);
    assert.equal(f.replies[0].options.notifyOwner, true);
  });
}

test("a failed Codex turn with no reply remains an error", async () => {
  const f = fixture({ complete: false });
  const running = f.run(f.delivery());
  const outcome = assert.rejects(running, /Provider failed/);
  await f.started(1);
  f.turns[0].process.send({ method: "turn/completed", params: { threadId: "thread-1",
    turn: { id: "turn-1", status: "failed", error: { message: "Provider failed" } } } });
  await outcome;
  assert.match(f.replies[0].text, /Provider failed/);
});

test("a published final reply releases the request while Codex completion and its queue remain tracked", { timeout: 2000 }, async (t) => {
  const f = fixture({ complete: false });
  const first = f.run(f.delivery());
  await f.started(1);
  t.after(async () => { await f.turns[0].finish(); await f.runtime.retire(); });
  await f.bridges[0].handler({ id: 90, method: "tools/call",
    params: { name: "send", arguments: { text: "Final reply", final: true } } });
  await first;
  assert.equal(f.processes[0].ended, false, "the tool response must reach Codex before cleanup");
  assert.equal(f.runtime.jobs.size, 1, "the remaining turn must stay interruptible and retireable");
  assert.equal(f.bridges[0].closeCount, 0);
  const second = f.run(f.delivery());
  assert.equal(f.turns.length, 1);
  await f.turns[0].finish();
  await f.started(2);
  await f.turns[1].finish();
  await second;
  assert.equal(f.calls.filter((call) => call.method === "thread/resume").length, 1);
  assert.equal(f.replies.length, 1, "only the second turn needs a fallback reply");
  assert.equal(f.runtime.jobs.size, 0);
});

test("failed Buzz sends do not suppress the fallback", async () => {
  const f = fixture({ finalSend: true });
  f.kit.tools = () => async () => ({ result: { isError: true } });
  await f.run(f.delivery());
  assert.equal(f.replies.length, 1);
});

test("a failed final send keeps activity pending until Codex finishes and fallback publishes", async () => {
  const f = fixture({ complete: false });
  f.kit.tools = () => async () => ({ result: { isError: true } });
  let finished = false;
  const running = f.run(f.delivery({ workingUntil: (activity) => { void activity.then(() => { finished = true; }); } }));
  await f.started(1);
  await f.bridges[0].handler({ id: 90, method: "tools/call",
    params: { name: "send", arguments: { text: "Rejected", final: true } } });
  // Another conversation completing is a lifecycle barrier; this one is held.
  const other = f.run(f.delivery({ conversation: "other" }));
  await f.started(2);
  await f.turns[1].finish();
  await other;
  assert.equal(finished, false);
  await f.turns[0].finish();
  await running;
  assert.equal(finished, true);
  assert.equal(f.replies.length, 2);
});

for (const action of ["interrupt", "retire"]) {
  for (const fail of [undefined, "thread/backgroundTerminals/clean"]) {
    test(`${action} after a final reply still drains cleanup${fail ? " and reports failure" : ""}`, async () => {
      const f = fixture({ complete: false, fail });
      const deadline = new AbortController();
      const running = f.run(f.delivery({ signal: deadline.signal }));
      await f.started(1);
      await f.bridges[0].handler({ id: 90, method: "tools/call",
        params: { name: "reply_in_subthread", arguments: { text: "Final reply", final: true } } });
      await running;
      deadline.abort(new DOMException("The operation timed out.", "TimeoutError"));
      assert.equal(f.processes[0].ended, false, "the delivery deadline cannot stop post-reply cleanup");
      const stopped = action === "retire" ? f.runtime.retire("agent")
        : f.runtime.control({ key: "agent" }, { channelId: "channel" }, "interrupt");
      if (fail) await assert.rejects(stopped, /Fixture failure/);
      else await stopped;
      assert.equal(f.processes[0].ended, true);
      assert.equal(f.bridges[0].closeCount, 1);
      assert.equal(f.runtime.jobs.size, 0);
      assert.equal(f.replies.length, fail ? 1 : 0);
      if (fail) assert.match(f.replies[0].text, /cleanup needs attention/);
    });
  }
}

test("turn failure restores unsent prompt notes, reports a blocker and releases resources", async () => {
  const f = fixture({ fail: "turn/start" });
  await assert.rejects(f.run(f.delivery()), /Fixture failure/);
  assert.equal(f.restores, 1);
  assert.equal(f.acknowledged, 0);
  assert.equal(f.storage.values.size, 0, "a rejected first turn must not save an unpersisted empty thread");
  assert.equal(f.replies[0].options.notifyOwner, true);
  assert.equal(f.processes[0].ended, true);
  assert.equal(f.bridges[0].closeCount, 1);
});

test("same-conversation requests serialize while another conversation can run", async () => {
  const f = fixture({ complete: false });
  const first = f.run(f.delivery());
  await f.started(1);
  const second = f.run(f.delivery());
  const other = f.run(f.delivery({ conversation: "other" }));
  await f.started(2);
  assert.equal(f.turns.length, 2);
  await f.turns[0].finish(); await first;
  await f.started(3);
  await f.turns[1].finish(); await other;
  await f.turns[2].finish(); await second;
  assert.equal(f.calls.filter((x) => x.method === "thread/resume").length, 1);
});

test("owner interruption stops the process, finishes the run, and does not post an error", async () => {
  const f = fixture({ complete: false });
  let stop;
  const running = f.run(f.delivery({ interruptible: (callback) => { stop = callback; } }));
  await f.started(1);
  assert.equal(f.runtime.state({ key: "agent" }, { channelId: "channel" }), "active");
  await stop(); await running;
  assert.equal(f.processes[0].ended, true);
  assert.equal(f.replies.length, 0);
  assert.equal(f.calls.filter((x) => x.method === "turn/interrupt").length, 1);
  assert.equal(f.calls.filter((x) => x.method === "thread/backgroundTerminals/clean").length, 1);
  assert.equal(f.runtime.state({ key: "agent" }, { channelId: "channel" }), "idle");
});

test("interruption reports cleanup failure rather than claiming all commands stopped", async () => {
  const f = fixture({ complete: false, fail: "thread/backgroundTerminals/clean" });
  let stop;
  const running = f.run(f.delivery({ interruptible: (callback) => { stop = callback; } }));
  const rejected = assert.rejects(running, /Fixture failure/);
  await f.started(1);
  await assert.rejects(stop(), /Fixture failure/);
  await rejected;
  assert.equal(f.processes[0].ended, true);
  assert.match(f.replies[0].text, /cleanup needs attention/);
});

test("queued work is rechecked for eligibility before starting", async () => {
  const f = fixture({ complete: false });
  const first = f.run(f.delivery());
  await f.started(1);
  let eligible = true, ignored = false;
  const second = f.run(f.delivery({ current: () => eligible, ignored: () => { ignored = true; } }));
  eligible = false;
  await f.turns[0].finish(); await first; await second;
  assert.equal(f.processes.length, 1);
  assert.equal(ignored, true);
});

test("retiring an agent cancels active and queued work and revokes the bridge", async () => {
  const f = fixture({ complete: false });
  const first = f.run(f.delivery());
  await f.started(1);
  const second = f.run(f.delivery());
  // Admission is asynchronous; let it register the queued job before retiring.
  await Promise.resolve(); await Promise.resolve();
  await f.runtime.retire("agent");
  await Promise.all([first, second]);
  assert.equal(f.turns.length, 1);
  await assert.rejects(f.bridges[0].handler({ method: "tools/list" }), /stopped/);
});

test("New session clears a saved binding; a workspace change cannot silently reuse it", async () => {
  const f = fixture();
  await f.run(f.delivery());
  await assert.rejects(f.run(f.delivery({ config: settings({ workspace: "/other" }) })), /workspace changed/);
  await f.runtime.control({ key: "agent" }, { channelId: "channel" }, "new");
  assert.equal(f.processes[0].ended, true);
  await f.run(f.delivery({ config: settings({ workspace: "/other" }) }));
  assert.equal(f.calls.filter((x) => x.method === "thread/start").length, 2);
});

test("unadmitted requests and protected agents cannot launch Codex", async () => {
  const f = fixture(); let ignored = false;
  await f.run(f.delivery({ ignore: true, ignored() { ignored = true; } }));
  assert.equal(ignored, true);
  await assert.rejects(f.run(f.delivery({ agent: { key: "protected", protection: {} } })), /protected agents/);
  assert.equal(f.processes.length, 0);
});

test("bridge loss fails the run instead of silently reporting success", async () => {
  const f = fixture({ complete: false });
  const running = f.run(f.delivery());
  await f.started(1);
  await f.bridges[0].close();
  await assert.rejects(running, /The Buzz tool bridge closed/);
  assert.match(f.replies[0].text, /The Buzz tool bridge closed/);
  assert.equal(f.replies[0].options.notifyOwner, true);
});

test("a process crash fails the active turn, reports it and closes the bridge", async () => {
  const f = fixture({ complete: false });
  const running = f.run(f.delivery());
  const rejected = assert.rejects(running, /Codex exited/);
  await f.started(1);
  await f.processes[0].end();
  await rejected;
  assert.equal(f.replies[0].options.notifyOwner, true);
  assert.match(f.replies[0].text, /Codex exited/);
  assert.equal(f.bridges[0].closeCount, 1);
  assert.equal(f.runtime.state({ key: "agent" }, { channelId: "channel" }), "idle");
});

test("Stop while the native process is starting kills it before starting a thread", async () => {
  const f = fixture();
  const entered = deferred(), release = deferred();
  const spawn = f.host.spawn;
  f.host.spawn = async (...args) => {
    const process = await spawn(...args);
    entered.resolve();
    await release.promise;
    return process;
  };
  let stop;
  const running = f.run(f.delivery({ interruptible: (callback) => { stop = callback; } }));
  await entered.promise;
  const stopped = stop();
  release.resolve();
  await stopped;
  await running;
  assert.equal(f.processes[0].ended, true);
  assert.equal(f.calls.some((call) => call.method === "thread/start"), false);
  assert.equal(f.replies.length, 0);
  assert.equal(f.bridges[0].closeCount, 1);
});

test("corrupt session data requires explicit recovery rather than losing conversation state", () => {
  const storage = new MemoryStorage();
  const store = new SessionStore(storage);
  const key = store.key("agent/a", "channel/b");
  assert.notEqual(key, store.key("agent", "a/channel/b"));
  storage.setItem(key, "invalid");
  assert.throws(() => store.read(key), /New session/);
});

test("synced settings replace only shared preferences and preserve local instructions and access", () => {
  const local = { ...settings({ instructions: "Saved instructions", workspace: "/local/workspace",
    sandbox: "read-only", model: "old-model", effort: "high", scope: "channel" }), localExtension: true };
  const merged = withSyncedSettings(local, { model: "synced-model", scope: "thread",
    instructions: "Do not import this", workspace: "/another-device", sandbox: "danger-full-access" });
  assert.deepEqual(merged, { ...local, model: "synced-model", effort: "", scope: "thread" });
  assert.deepEqual(withSyncedSettings(local, {}), { ...local, model: "", effort: "", scope: "thread" });
  assert.equal(local.model, "old-model");
});

test("transcript reads page turns and items in order without resuming a session or launching MCP", async () => {
  const f = fixture({ turnPages: [
    { data: [{ id: "new", status: "inProgress" }], nextCursor: "older" },
    { data: [{ id: "old", status: "completed" }], nextCursor: null },
  ], itemPages: {
    old: [{ data: [{ item: { id: "request", type: "userMessage", content: [{ type: "text", text: 'Framing\nRequest: "Show the result"' }] } }], nextCursor: null }],
    new: [
      { data: [{ item: { id: "command", type: "commandExecution", command: "pwd", status: "inProgress", aggregatedOutput: "/workspace" } }], nextCursor: "items2" },
      { data: [{ item: { id: "reply", type: "agentMessage", text: "Done" } }], nextCursor: null },
    ],
  } });
  const result = await readTranscript(f.host, { threadId: "saved-thread", cwd: "/workspace" });
  assert.deepEqual(result.turns.map((turn) => turn.id), ["old", "new"]);
  assert.deepEqual(result.turns[1].items.map((item) => item.id), ["command", "reply"]);
  assert.equal(result.turns[0].items[0].text, "Show the result");
  assert.match(result.turns[0].items[0].detail, /Framing/);
  assert.equal(result.turns[1].status, "inProgress");
  assert.equal(result.more, false);
  assert.equal(f.calls.find((call) => call.params?.cursor === "older").params.threadId, "saved-thread");
  assert.equal(f.calls.find((call) => call.params?.cursor === "items2").params.turnId, "new");
  assert.ok(f.calls.every((call) => ["initialize", "initialized", "thread/turns/list", "thread/items/list"].includes(call.method)));
  assert.equal(f.bridges.length, 0);
  assert.equal(f.processes[0].options.cwd, "/workspace");
  assert.equal(f.processes[0].ended, true);
});

test("transcript reads close on errors and cancellation and reject a repeated page", async () => {
  const failed = fixture({ fail: "thread/items/list", turnPages: [{ data: [{ id: "turn" }], nextCursor: null }] });
  await assert.rejects(readTranscript(failed.host, { threadId: "saved", cwd: "/workspace" }), /Fixture failure/);
  assert.equal(failed.processes[0].ended, true);
  const repeat = fixture({ turnPages: [
    { data: [{ id: "one" }], nextCursor: "same" }, { data: [{ id: "two" }], nextCursor: "same" },
  ] });
  await assert.rejects(readTranscript(repeat.host, { threadId: "saved", cwd: "/workspace" }), /repeated/);
  assert.equal(repeat.processes[0].ended, true);
  const controller = new AbortController(); controller.abort();
  const cancelled = fixture();
  await assert.rejects(readTranscript(cancelled.host, { threadId: "saved", cwd: "/workspace" }, controller.signal), /abort/i);
  assert.equal(cancelled.processes.length, 0);
});

test("transcript discovery stays within one agent and prefers the opened thread over channel fallback", () => {
  const storage = new MemoryStorage(), store = new SessionStore(storage);
  store.write(store.key("agent", "channel"), { threadId: "channel-session", cwd: "/workspace" });
  store.write(store.key("agent", "channel/root"), { threadId: "thread-session", cwd: "/workspace", label: "#channel", at: 10 });
  store.write(store.key("agent-other", "channel/root"), { threadId: "private-other", cwd: "/other" });
  storage.setItem(store.key("agent", "broken"), "invalid");
  const rows = store.list("agent");
  assert.equal(rows.length, 3);
  assert.equal(rows.some((row) => row.threadId === "private-other"), false);
  assert.equal(openedSession(rows, { channelId: "channel", rootId: "root" }).threadId, "thread-session");
  assert.equal(openedSession(rows, { channelId: "channel", rootId: "another" }).threadId, "channel-session");
  assert.equal(openedSession(rows, { channelId: "unrelated" }), undefined);
  assert.match(rows.find((row) => row.channelId === "broken").problem, /New session/);
});

test("an accepted live session notifies the transcript before its turn finishes", async () => {
  const f = fixture({ complete: false }), accepted = deferred();
  const snapshots = [];
  const unsubscribe = f.runtime.subscribe(() => snapshots.push(f.runtime.store.list("agent")));
  const running = f.run(f.delivery({ acknowledged: () => accepted.resolve() }));
  await accepted.promise;
  assert.ok(snapshots.some((rows) => rows.some((row) => row.threadId === "thread-1")));
  assert.equal(f.runtime.state({ key: "agent" }, { channelId: "channel" }), "active");
  await f.turns[0].finish(); await running; unsubscribe();
  assert.equal(f.runtime.state({ key: "agent" }, { channelId: "channel" }), "idle");
});

test("live and completed transcript reads are disposable and closing one does not stop its agent", async () => {
  const page = { data: [{ id: "turn-1", status: "interrupted" }], nextCursor: null };
  const f = fixture({ complete: false, turnPages: [page, page] }), accepted = deferred();
  const running = f.run(f.delivery({ acknowledged: () => accepted.resolve() }));
  await accepted.promise;
  const saved = f.runtime.store.list("agent")[0], controller = new AbortController();
  const cancelled = f.runtime.transcript(saved, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /abort/i);
  const live = await f.runtime.transcript(saved);
  assert.equal(live.turns[0].status, "inProgress");
  assert.equal(f.processes.length, 3);
  assert.equal(f.processes[0].ended, false);
  assert.ok(f.processes.slice(1).every((process) => process.ended));
  await f.turns[0].finish(); await running;
  await f.runtime.transcript(saved);
  assert.equal(f.processes.length, 4);
  assert.equal(f.processes[3].ended, true);
  assert.equal(f.bridges.length, 1);
});

test("oversized Activity pages retry from their cursor without closing the execution connection", async () => {
  const entries = Array.from({ length: 12 }, (_,index) => ({ item: {
    id: `item-${index}`, type: "agentMessage", text: "x".repeat(450000),
  } }));
  const f = fixture({ complete: false,
    turnPages: [{ data: [{ id: "turn-1", status: "interrupted", error: { message: "Persisted state" }, completedAt: 123 }], nextCursor: null }],
    itemPages: { "turn-1": ({ cursor, limit }) => {
      const offset = Number(cursor ?? 0), end = Math.min(offset + limit, entries.length);
      return { data: entries.slice(offset, end), nextCursor: end < entries.length ? String(end) : null };
    } },
  });
  const running = f.run(f.delivery());
  await f.started(1);
  const saved = f.runtime.store.list("agent")[0];
  const result = await f.runtime.transcript(saved);
  assert.deepEqual(result.turns[0].items.map((item) => item.id), entries.map(({ item }) => item.id));
  assert.equal(result.turns[0].status, "inProgress");
  assert.equal(result.turns[0].error, null);
  assert.equal(result.turns[0].completedAt, null);
  assert.deepEqual(f.calls.filter((call) => call.method === "thread/items/list").map((call) => call.params.limit), [10, 5, 5, 5]);
  assert.equal(f.processes[0].ended, false);
  assert.ok(f.processes.slice(1).every((process) => process.ended));
  assert.equal(f.replies.length, 0);
  await f.turns[0].finish(); await running;
});

test("an oversized single history item reports an Activity error and leaves the running turn alive", async () => {
  const f = fixture({ complete: false, turnPages: [{ data: [{ id: "turn-1" }], nextCursor: null }],
    itemPages: { "turn-1": () => ({ data: [{ item: { type: "agentMessage", text: "x".repeat(4 * 1024 * 1024) } }], nextCursor: null }) },
  });
  const running = f.run(f.delivery());
  await f.started(1);
  await assert.rejects(f.runtime.transcript(f.runtime.store.list("agent")[0]), /frame limit/);
  assert.equal(f.processes[0].ended, false);
  assert.equal(f.replies.length, 0);
  assert.deepEqual(f.calls.filter((call) => call.method === "thread/items/list").map((call) => call.params.limit), [10, 5, 3, 2, 1]);
  assert.ok(f.processes.slice(1).every((process) => process.ended));
  await f.turns[0].finish(); await running;
});

test("history retries retain a noninitial cursor and cancellation during recovery opens no replacement", async () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({ item: { id: `bulk-${index}`, type: "agentMessage", text: "x".repeat(450000) } }));
  const pages = { "turn-1": ({ cursor, limit }) => !cursor
    ? { data: [{ item: { id: "first", type: "agentMessage", text: "First page" } }], nextCursor: "0" }
    : { data: entries.slice(Number(cursor), Number(cursor) + limit), nextCursor: Number(cursor) + limit < entries.length ? String(Number(cursor) + limit) : null } };
  const options = { turnPages: [{ data: [{ id: "turn-1" }], nextCursor: null }], itemPages: pages };
  const f = fixture(options);
  const result = await readTranscript(f.host, { threadId: "saved", cwd: "/workspace" });
  assert.deepEqual(result.turns[0].items.map((item) => item.id), ["first", ...entries.map(({ item }) => item.id)]);
  assert.deepEqual(f.calls.filter((call) => call.method === "thread/items/list").map((call) => call.params.cursor), [undefined, "0", "0", "5"]);

  const cancelled = fixture(options), controller = new AbortController(), closing = deferred(), release = deferred();
  const spawn = cancelled.host.spawn;
  cancelled.host.spawn = async (...args) => {
    const process = await spawn(...args), end = process.end;
    process.end = async () => { closing.resolve(); await release.promise; await end(); };
    return process;
  };
  const reading = readTranscript(cancelled.host, { threadId: "saved", cwd: "/workspace" }, controller.signal);
  const rejected = assert.rejects(reading, /abort/i);
  await closing.promise;
  controller.abort(); release.resolve();
  await rejected;
  assert.equal(cancelled.processes.length, 1);
});

test("transcript formatting keeps tool outcomes and only explicit thinking summaries", () => {
  const thinking = transcriptItem({ type: "reasoning", summary: ["A short summary"], content: ["Raw reasoning must stay out"] });
  assert.equal(thinking.detail, "A short summary");
  assert.equal(JSON.stringify(thinking).includes("Raw reasoning"), false);
  assert.equal(transcriptItem({ type: "reasoning", summary: [], content: ["Raw reasoning"] }), undefined);
  assert.equal(transcriptItem({ type: "agentMessage", text: "  " }), undefined);
  const tool = transcriptItem({ type: "mcpToolCall", server: "fixture", tool: "read", status: "failed", arguments: { path: "/file" }, error: "Unavailable" });
  assert.equal(tool.title, "fixture · read");
  assert.equal(tool.status, "failed");
  assert.match(tool.detail, /Unavailable/);
  assert.equal(transcriptItem({ type: "newEvent" }).text, "Details for this activity are unavailable in this viewer.");
});

test("command presentation removes shell framing without changing the displayed command's quoting", () => {
  assert.equal(displayCommand("/bin/zsh -lc 'cat /workspace/file.txt'"), "cat /workspace/file.txt");
  assert.equal(displayCommand('/bin/zsh -lc "printf \\"hello\\" \\$VALUE"'), 'printf "hello" $VALUE');
  assert.equal(displayCommand("cat '/workspace/My File.txt'"), "cat '/workspace/My File.txt'");
  assert.equal(transcriptItem({ type: "commandExecution", command: "/bin/zsh -lc 'pwd'" }).format, "code");
});

test("transcript block formatting preserves fenced code and leaves HTML literal", () => {
  const source = '# Result\n\n- Open `/workspace/file.js`\n- **Check** the result\n\n```html\n<script>alert("literal")</script>\n```';
  const blocks = transcriptBlocks(source);
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "list", "code"]);
  assert.equal(blocks[1].items.length, 2);
  assert.equal(blocks[2].language, "html");
  assert.equal(blocks[2].text, '<script>alert("literal")</script>');
  assert.equal(transcriptBlocks("<img src=x onerror=alert(1)>")[0].text, "<img src=x onerror=alert(1)>");
  assert.equal(transcriptBlocks('~~~js\nconst live = "unfinished";')[0].text, 'const live = "unfinished";');
});

test("inline formatting distinguishes code and paths from URLs and bounds unusually large markup", () => {
  const parts = transcriptInline('Use `x < y` in /workspace/file.js, then **check** ~/notes. See https://example.org/docs.');
  assert.deepEqual(parts.filter((part) => part.type === "code").map((part) => part.text), ["x < y", "/workspace/file.js", "~/notes"]);
  assert.equal(parts.find((part) => part.type === "strong").text, "check");
  assert.ok(parts.some((part) => part.type === "text" && part.text.includes("https://example.org/docs.")));
  const hostile = '[link](javascript:alert(1)) <img src="https://example.org/image" onerror="alert(1)">';
  assert.deepEqual(transcriptInline(hostile), [{ type: "text", text: hostile }]);
  const long = "`".repeat(100_001);
  assert.deepEqual(transcriptInline(long), [{ type: "text", text: long }]);
  assert.deepEqual(transcriptBlocks(long), [{ type: "plain", text: long }]);
});

test("the registered Settings tab exposes runtime fields and host management without identity fields", async () => {
  const f = fixture(), view = settingsView(f);
  try {
    assert.equal(view.tab.splitSettings, true, "Buzz otherwise puts the plugin form only in Identity");
    const tree = view.render({ agent: { config: settings() }, save: async () => {}, settingsSection: "runtime",
      settingsContent: { type: "aside", props: { id: "host-management" }, children: [] } });
    const controls = view.all(tree).filter((node) => ["input", "select", "textarea"].includes(node.type));
    assert.deepEqual(controls.map((node) => node.props.id), ["settings-view-workspace", "settings-view-scope", "settings-view-sandbox"]);
    const sessions = controls.find((node) => node.props["aria-label"] === "Sessions");
    assert.deepEqual(sessions.children.map((node) => node.props.value), ["thread", "channel"]);
    assert.ok(view.all(tree).some((node) => node.props.id === "host-management"));
    view.runEffects();
    assert.equal(f.processes.length, 0, "opening runtime settings must not query the model catalog");
  } finally { await view.dispose(); }
});

test("Identity and creation retain their fields, and saving runtime scope preserves hidden settings", async () => {
  const f = fixture();
  const config = { ...settings({ instructions: "Saved instructions", model: "saved-model", effort: "high", sandbox: "read-only" }), extension: true };
  let saved;
  const identity = settingsView(f);
  try {
    const tree = identity.render({ agent: { config }, save: async () => {}, settingsSection: "identity" });
    assert.deepEqual(identity.all(tree).filter((node) => ["input", "select", "textarea"].includes(node.type)).map((node) => node.props.id),
      ["settings-view-model", "settings-view-effort", "settings-view-instructions"]);
  } finally { await identity.dispose(); }
  const creation = settingsView(f);
  try {
    const tree = creation.render({ config, onChange() {}, disabled: false }, true);
    assert.equal(creation.all(tree).filter((node) => ["input", "select", "textarea"].includes(node.type)).length, 6);
  } finally { await creation.dispose(); }
  const runtime = settingsView(f);
  try {
    const props = { agent: { config }, save: async (value) => { saved = value; }, settingsSection: "runtime" };
    let tree = runtime.render(props);
    runtime.all(tree).find((node) => node.props["aria-label"] === "Sessions").props.onChange({ target: { value: "channel" } });
    tree = runtime.render(props);
    await runtime.all(tree).find((node) => node.type === "form").props.onSubmit({ preventDefault() {} });
    assert.deepEqual(saved, { ...config, scope: "channel" });
  } finally { await runtime.dispose(); }
});

test("an unsaved Sessions choice survives Identity/Settings remounts and stays isolated until discarded", async () => {
  const f = fixture(), view = settingsView(f);
  const config = settings();
  const props = { agent: { key: "first", config }, save: async () => {}, settingsSection: "runtime" };
  const sessions = (tree) => view.all(tree).find((node) => node.props["aria-label"] === "Sessions");
  try {
    sessions(view.render(props)).props.onChange({ target: { value: "channel" } });
    view.remount({ ...props, settingsSection: "identity" });
    assert.equal(sessions(view.remount(props)).props.value, "channel");
    assert.equal(sessions(view.remount({ ...props, agent: { key: "other", config } })).props.value, "thread");
    let tree = view.remount(props);
    assert.equal(sessions(tree).props.value, "channel");
    view.all(tree).find((node) => node.type === "button" && node.children[0]?.children?.[0] === "Discard changes").props.onClick();
    tree = view.render(props);
    assert.equal(sessions(tree).props.value, "thread");
  } finally { await view.dispose(); }
});

test("harness retirement forgets only that agent's draft before re-entry and Save", async () => {
  const f = fixture(), view = settingsView(f);
  const config = settings({ instructions: "Original" });
  let saved;
  const props = { agent: { key: "first", config }, save: async (value) => { saved = value; }, settingsSection: "identity" };
  try {
    let tree = view.render(props);
    view.all(tree).find((node) => node.type === "textarea").props.onChange({ target: { value: "Discarded edit" } });
    const other = { ...props, agent: { key: "other", config }, settingsSection: "runtime" };
    tree = view.remount(other);
    view.all(tree).find((node) => node.props["aria-label"] === "Sessions").props.onChange({ target: { value: "channel" } });
    await view.retire("first");
    tree = view.remount(other);
    assert.equal(view.all(tree).find((node) => node.props["aria-label"] === "Sessions").props.value, "channel");
    const adopted = { ...config, instructions: "Current adopted instructions", model: "new-model" };
    tree = view.remount({ ...props, agent: { key: "first", config: adopted } });
    assert.equal(view.all(tree).find((node) => node.type === "textarea").props.value, adopted.instructions);
    await view.all(tree).find((node) => node.type === "form").props.onSubmit({ preventDefault() {} });
    assert.deepEqual(saved, adopted);
  } finally { await view.dispose(); }
});

test("saving state, duplicate-save protection and errors survive a section remount", async () => {
  const f = fixture(), view = settingsView(f), gate = deferred();
  let calls = 0;
  const config = settings();
  const props = { agent: { key: "first", config }, settingsSection: "runtime",
    save: async () => { calls++; if (calls === 1) await gate.promise; } };
  const form = (tree) => view.all(tree).find((node) => node.type === "form");
  try {
    let tree = view.render(props);
    view.all(tree).find((node) => node.props["aria-label"] === "Sessions").props.onChange({ target: { value: "channel" } });
    const pending = form(view.render(props)).props.onSubmit({ preventDefault() {} });
    tree = view.remount({ ...props, settingsSection: "identity" });
    assert.equal(view.all(tree).find((node) => node.type === "textarea").props.disabled, true);
    tree = view.remount(props);
    await form(tree).props.onSubmit({ preventDefault() {} });
    assert.equal(calls, 1);
    gate.reject(new Error("Write refused"));
    await pending;
    tree = view.remount(props);
    assert.equal(view.all(tree).find((node) => node.props.role === "alert").children[0], "Write refused");
    assert.equal(view.all(tree).find((node) => node.props["aria-label"] === "Sessions").props.value, "channel");
    await form(tree).props.onSubmit({ preventDefault() {} });
    assert.equal(calls, 2);
    assert.equal(view.all(view.render(props)).some((node) => node.props.role === "alert"), false);
  } finally { gate.resolve(); await view.dispose(); }
});

test("incoming settings update untouched fields without overwriting local edits", () => {
  const initial = settings({ instructions: "Before" });
  const editor = new SettingsDraft(initial);
  editor.update({ draft: { ...initial, scope: "channel" } });
  editor.reconcile({ ...initial, instructions: "Updated remotely", sandbox: "read-only" });
  assert.deepEqual(editor.snapshot().draft, { ...initial, scope: "channel", instructions: "Updated remotely", sandbox: "read-only" });
});

test("a successful save is not reverted when a remounted editor still receives the previous config", async () => {
  const initial = settings();
  const editor = new SettingsDraft(initial);
  editor.update({ draft: { ...initial, scope: "channel" } });
  let saved;
  await editor.save({ ...initial, extension: true }, async (value) => { saved = value; });
  editor.reconcile(initial);
  assert.equal(editor.snapshot().draft.scope, "channel");
  assert.equal(saved.extension, true);
  editor.reconcile(saved);
  assert.deepEqual(editor.snapshot().draft, settings(saved));
});

test("plugin activation registers a 1.x harness without launching a process", async () => {
  const f = fixture(); const registrations = [], cleanups = [];
  const before = globalThis.localStorage;
  globalThis.localStorage = f.storage;
  try {
    apply({ react: { createElement: (type, props, ...children) => ({ type, props, children }),
      useState: () => { throw new Error("Unavailable settings must not initialize a blank draft"); } },
      host: f.host, agents: { ...f.agents, register: (value) => registrations.push(value) },
      effect: (effect) => { cleanups.push(effect()); } });
    assert.equal(registrations[0].id, "codex-mcp");
    assert.equal(registrations[0].protection, undefined);
    assert.deepEqual(registrations[0].syncedSettings?.schema, {
      model: "string", effort: "string", scope: ["thread", "channel"],
    });
    // Buzz matches these IDs with native harness settings to distinguish a
    // reset from an unsupported setting, and recognize unchanged session scope.
    assert.deepEqual(registrations[0].describeMigration(registrations[0].defaults().config), [
      { id: "model", label: "Model", isOverride: false },
      { id: "thinking", label: "Thinking", isOverride: false },
      { id: "sessions", label: "Sessions", isOverride: false, unchangedKey: "thread" },
    ]);
    assert.deepEqual(registrations[0].describeMigration({ model: "sol", effort: "high", scope: "channel" }), [
      { id: "model", label: "Model", isOverride: true },
      { id: "thinking", label: "Thinking", isOverride: true },
      { id: "sessions", label: "Sessions", isOverride: true, unchangedKey: "channel" },
    ]);
    assert.deepEqual(registrations[0].describeMigration({ model: "  ", effort: "  ", scope: "invalid" }),
      registrations[0].describeMigration(registrations[0].defaults().config));
    assert.deepEqual(registrations[0].carry(registrations[0].defaults().config), {});
    assert.deepEqual(registrations[0].carry({ instructions: "Keep these instructions" }), {
      instructions: "Keep these instructions",
    });
    assert.deepEqual(registrations[0].carry(settings({ instructions: "  ", workspace: "/existing-workspace" })), {
      workspace: "/existing-workspace",
    });
    const adopted = registrations[0].adopt({ instructions: undefined, workspace: undefined },
      settings({ instructions: "Keep these instructions", workspace: "/existing-workspace" }));
    assert.equal(adopted.instructions, "Keep these instructions");
    assert.equal(adopted.workspace, "/existing-workspace");
    const carried = registrations[0].adopt({ instructions: "Imported instructions", workspace: "/imported-workspace" }, adopted);
    assert.equal(carried.instructions, "Imported instructions");
    assert.equal(carried.workspace, "/imported-workspace");
    assert.equal(registrations[0].adopt({ instructions: "" }, adopted).instructions, "");
    assert.equal(registrations[0].syncedSettings.withSynced, withSyncedSettings);
    const settingsTab = registrations[0].tabs.find((tab) => tab.role === "settings");
    // Buzz's Agents view otherwise puts the whole provider form in Identity
    // and renders only management content under Settings.
    assert.equal(settingsTab.splitSettings, true);
    const management = { type: "host-management" };
    const editor = settingsTab.component({ agent: { config: settings() },
      settingsSection: "runtime", settingsContent: management });
    assert.equal(editor.props.settingsSection, "runtime");
    assert.equal(editor.props.settingsContent, management);
    assert.equal(registrations[0].tabs.find((tab) => tab.role === "activity").title, "Activity");
    assert.deepEqual(registrations[0].sessions.list("agent"), []);
    const blocked = registrations[0].tabs[0].component({ agent: { config: {}, configProblem: "unavailable" } });
    assert.equal(blocked.type, "div");
    assert.equal(blocked.children[1].props.role, "status");
    assert.match(blocked.children[1].children[0], /before editing instructions/);
    assert.equal(f.processes.length, 0);
    await cleanups[0]();
    assert.throws(() => apply({ agents: {}, host: {} }), /Buzz 0.5 is unsupported/);
  } finally {
    if (before === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = before;
  }
});

test("RPC rejects malformed output and fails pending requests when the process exits", async () => {
  const f = fixture();
  const rpc = await new CodexRpc(f.host.spawn).open();
  f.processes[0].options.onStdout("not-json\n");
  await assert.rejects(rpc.request("anything"), /invalid JSON/);
  await rpc.close();
});

test("RPC declines interactive approvals and rejects unsupported elicitation", async () => {
  const f = fixture();
  const rpc = await new CodexRpc(f.host.spawn).open();
  f.processes[0].send({ id: "approve", method: "item/commandExecution/requestApproval", params: {} });
  f.processes[0].send({ id: "elicit", method: "mcpServer/elicitation/request", params: {} });
  await rpc.writes;
  assert.equal(f.calls.find((x) => x.id === "approve").result.decision, "decline");
  assert.equal(f.calls.find((x) => x.id === "elicit").error.code, -32601);
  await rpc.close();
});

test("RPC preserves emoji across native UTF-8 write boundaries and serializes long frames", async () => {
  const writes = [];
  const rpc = new CodexRpc();
  rpc.process = {
    async write(data) {
      // The native host receives a separately UTF-8-encoded string per call.
      writes.push(Buffer.from(data, "utf8").toString("utf8"));
      await Promise.resolve();
    },
  };
  const prefix = JSON.stringify({ method: "long", params: { text: "" } }).indexOf('"text":"') + 8;
  const text = "a".repeat(64 * 1024 - prefix - 1) + "🐝" + "b".repeat(70_000);
  const messages = [{ method: "long", params: { text } }, { method: "next", params: { text: "Follow-up 🐝" } }];
  await Promise.all(messages.map((message) => rpc.send(message)));
  assert.ok(writes.length > messages.length, "the prompt must cross a native write boundary");
  assert.ok(writes.every((data) => Buffer.byteLength(data) < 1024 * 1024));
  assert.deepEqual(writes.join("").trimEnd().split("\n").map((line) => JSON.parse(line)), messages);
});
