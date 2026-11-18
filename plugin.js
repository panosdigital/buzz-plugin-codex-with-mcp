// Self-contained Buzz 1.x plugin. No runtime imports or build step.
export const inject = ["react", "agents", "host"];
export const BRIDGE_NAME = "buzz_codex_mcp";
export const PLUGIN_VERSION = "0.1.0";
const SYNCED_SETTINGS_SCHEMA = { model: "string", effort: "string", scope: ["thread", "channel"] };
const STORAGE_PREFIX = "digital.panos.buzz-plugin-codex-with-mcp/session/";
const DEFAULT_WORKSPACE = "~/.buzz";
const MAX_FRAME = 4 * 1024 * 1024;
const TRANSCRIPT_TURNS = 20;
const IDLE_PROCESS_MS = 2 * 60_000;
const MAX_PROCESS_AGE_MS = 10 * 60_000;
const MAX_IDLE_PROCESSES = 4;

class FrameTooLarge extends Error {
  constructor() { super("Codex output exceeded the frame limit."); }
}

function asError(problem) {
  if (problem instanceof Error) return problem;
  return new Error(typeof problem === "string" ? problem
    : typeof problem?.message === "string" ? problem.message : "An unexpected host error occurred.");
}

export function settings(raw = {}) {
  const text = (key, fallback = "") =>
    typeof raw?.[key] === "string" ? raw[key] : fallback;
  return {
    workspace: text("workspace", DEFAULT_WORKSPACE),
    instructions: text("instructions"),
    model: text("model").trim(),
    effort: text("effort").trim(),
    scope: raw?.scope === "channel" ? "channel" : "thread",
    sandbox: ["read-only", "workspace-write", "danger-full-access"].includes(raw?.sandbox)
      ? raw.sandbox : "workspace-write",
  };
}

export function withSyncedSettings(config, synced) {
  // Buzz validates the synced artifact against this schema. Instructions have
  // their own artifact; workspace and access settings stay on this device.
  const defaults = settings();
  return { ...config, ...Object.fromEntries(Object.keys(SYNCED_SETTINGS_SCHEMA).map((key) =>
    [key, Object.hasOwn(synced, key) ? synced[key] : defaults[key]])) };
}

export function validate(config) {
  if (!/^(\/|~\/|[A-Za-z]:[\\/])/.test(config.workspace.trim()))
    throw new Error("Workspace must be an absolute path or start with ~/.");
  if (/[\x00-\x1f]/.test(config.workspace))
    throw new Error("Workspace cannot contain control characters.");
}

export function threadParams(config, cwd, systemPrompt, normalized, bridge) {
  // config/read emits null for unset options. JSON overrides turn null into
  // empty TOML strings, which are invalid for fields such as tool_timeout_sec.
  const withoutUnset = (value) => {
    if (Array.isArray(value)) return value.map(withoutUnset);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).filter(([, item]) => item != null).map(([key, item]) => [key, withoutUnset(item)]),
    );
    return value;
  };
  const servers = withoutUnset(normalized?.mcp_servers ?? {});
  if (Object.hasOwn(servers, BRIDGE_NAME))
    throw new Error(`Rename the configured ${BRIDGE_NAME} MCP server; this name is reserved for Buzz.`);
  return {
    cwd,
    ...(config.model || normalized?.model ? { model: config.model || normalized.model } : {}),
    developerInstructions: systemPrompt,
    // Unattended runs must not stall waiting for an invisible permission dialog.
    approvalPolicy: "never",
    sandbox: config.sandbox,
    config: {
      ...(config.effort ? { model_reasoning_effort: config.effort } : {}),
      mcp_servers: {
        ...servers,
        [BRIDGE_NAME]: {
          url: bridge.url,
          http_headers: Object.fromEntries(bridge.headers.map(({ name, value }) => [name, value])),
          enabled: true,
          required: true,
          // Buzz's host-bound catalog includes unannotated read and write tools.
          // Let the host enforce this agent's permissions; leave external MCP
          // approval policies exactly as configured above.
          default_tools_approval_mode: "approve",
        },
      },
    },
  };
}

function currentContext(system) {
  const text = "This is the current Buzz context. It replaces earlier Buzz agent instructions, team guidance and core memory, " +
    "including values that are now empty or absent.\n\n" + system;
  const chunks = [];
  let value = "", size = 0;
  for (const character of text) {
    const point = character.codePointAt(0);
    const bytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (size + bytes > 4000) { chunks.push(value); value = ""; size = 0; }
    value += character; size += bytes;
  }
  chunks.push(value);
  // Codex truncates an individual application-context value over 4,000 bytes.
  return Object.fromEntries(chunks.map((value, index) =>
    [`buzz.context.${String(index).padStart(4, "0")}`, { kind: "application", value }]));
}

export function turnParams(opened, text, system) {
  const model = typeof opened.model === "string" && opened.model ? opened.model : null;
  const effort = typeof opened.reasoningEffort === "string" && opened.reasoningEffort
    ? opened.reasoningEffort : null;
  const context = `<buzz-runtime>\n${JSON.stringify({ model, reasoning_effort: effort })}\n` +
    "These are this turn's Codex settings. A null value means Codex did not report an explicit value; do not guess it.\n" +
    `</buzz-runtime>\n\n${text}`;
  return {
    threadId: opened.thread.id,
    input: [{ type: "text", text: context }],
    ...(system === undefined ? {} : { additionalContext: currentContext(system) }),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export class CodexRpc {
  constructor(spawn, options = {}, requestTimeoutMs = 45_000) {
    this.spawn = spawn;
    this.options = options;
    this.requestTimeoutMs = requestTimeoutMs;
    this.next = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = "";
    this.writes = Promise.resolve();
  }

  async open() {
    this.openedAt = Date.now();
    this.process = await this.spawn("codex", {
      ...this.options,
      onStdout: (chunk) => this.read(chunk),
      // stderr can contain server credentials. Do not retain it or publish it.
      onStderr: () => {},
    });
    void this.process.exited.then(
      (code) => this.fail(new Error(`Codex exited (${code ?? "signal"}). Check local Codex and MCP configuration.`)),
      () => this.fail(new Error("The Codex process failed.")),
    );
    if (this.closing) {
      await this.process.kill();
      throw this.failure;
    }
    await this.request("initialize", {
      clientInfo: { name: "buzz_codex_mcp", title: "Codex with MCP", version: PLUGIN_VERSION },
      capabilities: { experimentalApi: true },
    });
    await this.send({ method: "initialized" });
    return this;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  read(chunk) {
    if (this.failure) return;
    try {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        if (newline > MAX_FRAME) throw new FrameTooLarge();
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id != null && !message.method) {
          const waiter = this.pending.get(message.id);
          if (!waiter) continue;
          this.pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error) waiter.reject(new Error(message.error.message || "Codex request failed."));
          else waiter.resolve(message.result);
        } else if (message.id != null && message.method) {
          // Never approve an action on behalf of an absent human.
          const approval = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"];
          void this.send(approval.includes(message.method)
            ? { id: message.id, result: { decision: "decline" } }
            : { id: message.id, error: { code: -32601, message: "Interactive requests are unavailable in this Buzz plugin." } },
          ).catch((error) => this.fail(error));
        } else {
          for (const listener of this.listeners) listener(message);
        }
      }
      if (this.buffer.length > MAX_FRAME) throw new FrameTooLarge();
    } catch (error) {
      this.fail(error instanceof SyntaxError ? new Error("Codex returned invalid JSON.") : error);
      void this.close();
    }
  }

  send(message) {
    if (this.failure) return Promise.reject(this.failure);
    const data = `${JSON.stringify(message)}\n`;
    const write = this.writes.then(async () => {
      if (this.failure) throw this.failure;
      if (!this.process) throw new Error("Codex is not connected.");
      // Keep each native host write below its 1 MiB limit and never interleave frames.
      for (let start = 0; start < data.length;) {
        let end = Math.min(start + 64 * 1024, data.length);
        // Each native write encodes its string separately. Keep a UTF-16
        // surrogate pair together so an emoji is not replaced during encoding.
        const last = data.charCodeAt(end - 1);
        if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
        await this.process.write(data.slice(start, end));
        start = end;
      }
    });
    this.writes = write.catch(() => {});
    return write;
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.send({ id, method, params }).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  fail(problem) {
    if (this.failure) return;
    const error = asError(problem);
    this.failure = error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners)
      listener({ method: "connection/closed", params: { message: error.message } });
  }

  close() {
    if (this.closing) return this.closing;
    this.fail(new Error("Codex connection closed."));
    this.closing = (async () => {
      if (!this.process) return;
      const timer = setTimeout(() => void this.process.kill(), 1000);
      try {
        await this.process.end().catch(() => this.process.kill());
        await this.process.exited;
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.closing;
  }
}

export async function readModelCatalog(host, workspace, signal = new AbortController().signal) {
  let rpc;
  const stop = () => { void rpc?.close().catch(() => {}); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    validate(settings({ workspace }));
    signal.throwIfAborted();
    const cwd = await host.resolveDirectory(workspace.trim(), { create: false });
    signal.throwIfAborted();
    rpc = new CodexRpc(host.spawn.bind(host), { cwd });
    await rpc.open();
    const { config } = await rpc.request("config/read", { cwd });
    const models = new Map(), cursors = new Set();
    let cursor;
    do {
      signal.throwIfAborted();
      const page = await rpc.request("model/list", { cursor, limit: 100, includeHidden: false });
      for (const model of page.data ?? []) {
        if (model.hidden || typeof model.model !== "string" || !model.model) continue;
        models.set(model.model, {
          value: model.model, label: model.displayName || model.model,
          isDefault: model.isDefault === true,
          defaultEffort: model.defaultReasoningEffort,
          efforts: (model.supportedReasoningEfforts ?? []).map((item) => item.reasoningEffort)
            .filter((effort) => typeof effort === "string"),
        });
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Codex repeated a model catalog page.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!models.size) throw new Error("Codex returned no available models.");
    signal.throwIfAborted();
    const choices = [...models.values()];
    const defaultModel = config.model || choices.find((model) => model.isDefault)?.value || "";
    return {
      models: choices, defaultModel,
      configuredEffort: config.model_reasoning_effort || "",
      defaultEffort: config.model_reasoning_effort || models.get(defaultModel)?.defaultEffort || "",
    };
  } finally {
    signal.removeEventListener("abort", stop);
    await rpc?.close();
  }
}

const effortLabel = (value) => ({ none: "None", minimal: "Minimal", low: "Low", medium: "Medium",
  high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" })[value] || value;

export function modelChoices(catalog, config) {
  const current = catalog.models.find((model) => model.value === (config.model || catalog.defaultModel));
  const inherited = catalog.models.find((model) => model.value === catalog.defaultModel);
  const models = [{ value: "", label: inherited || catalog.defaultModel
    ? `${inherited?.label || catalog.defaultModel} · Default` : "Codex default" }, ...catalog.models];
  if (config.model && !models.some((model) => model.value === config.model))
    models.push({ value: config.model, label: `${config.model} · Saved` });
  const defaultEffort = catalog.configuredEffort || current?.defaultEffort || (!config.model ? catalog.defaultEffort : "");
  const unsupportedDefault = !!defaultEffort && !!current?.efforts.length && !current.efforts.includes(defaultEffort);
  const efforts = [{ value: "", label: defaultEffort
    ? `${effortLabel(defaultEffort)} · Default${unsupportedDefault ? " (unsupported)" : ""}` : "Model default",
    disabled: unsupportedDefault },
    ...(current?.efforts ?? []).map((value) => ({ value, label: effortLabel(value) }))];
  if (config.effort && !efforts.some((effort) => effort.value === config.effort))
    efforts.push({ value: config.effort, label: `${effortLabel(config.effort)} · Saved` });
  return { models, efforts };
}

export function changeModel(config, catalog, model) {
  const next = catalog.models.find((item) => item.value === (model || catalog.defaultModel));
  let effort = next?.efforts.includes(config.effort) ? config.effort : "";
  if (!effort && next && catalog.configuredEffort && !next.efforts.includes(catalog.configuredEffort))
    effort = next.defaultEffort || "";
  return { ...config, model, effort };
}

// Renamed and adapted from Buzz's shellCommand helper. Copyright 2026 Block, Inc.
// Apache-2.0. See README.md for the license and NOTICE.md for attribution. Display only.
export function displayCommand(command) {
  const quoted = command.match(/^\S*sh -lc (?:'([\s\S]*)'|"([\s\S]*)")$/);
  if (!quoted) return command;
  return quoted[1] !== undefined ? quoted[1].replaceAll(`'"'"'`, "'").replaceAll(`'\\''`, "'")
    : quoted[2].replace(/\\([\\"$`])/g, "$1");
}

// Small, bounded Markdown subset for the external plugin contract, which does
// not expose Buzz's internal Markdown component. All rendering uses text nodes.
export function transcriptInline(text) {
  if (text.length > 100_000 || /`{64}/.test(text)) return [{ type: "text", text }];
  const parts = [], pattern = /(`+)([^`\n]+)\1|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|(^|[\s(])((?:~\/|\.{1,2}\/|\/|[A-Za-z]:\\)[^\s<>`"'()]+)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) parts.push({ type: "text", text: text.slice(offset, match.index) });
    if (match[2]) parts.push({ type: "code", text: match[2] });
    else if (match[3] || match[4]) parts.push({ type: "strong", text: match[3] || match[4] });
    else if (match[5]) parts.push({ type: "em", text: match[5] });
    else {
      if (match[6]) parts.push({ type: "text", text: match[6] });
      const path = match[7].replace(/[.,;:!?]+$/, "");
      parts.push({ type: "code", text: path });
      if (path.length < match[7].length) parts.push({ type: "text", text: match[7].slice(path.length) });
    }
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push({ type: "text", text: text.slice(offset) });
  return parts;
}

export function transcriptBlocks(text) {
  if (text.length > 100_000) return [{ type: "plain", text }];
  const lines = text.replace(/\r\n/g, "\n").split("\n"), blocks = [];
  const fence = (line) => line.match(/^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
  const list = (line) => line.match(/^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/);
  const heading = (line) => line.match(/^(#{1,6})\s+(.+)$/);
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const opened = fence(lines[i]);
    if (opened) {
      const code = []; i++;
      while (i < lines.length) {
        const closed = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (closed && closed[1][0] === opened[1][0] && closed[1].length >= opened[1].length) break;
        code.push(lines[i++]);
      }
      if (i < lines.length) i++;
      blocks.push({ type: "code", text: code.join("\n"), language: opened[2] });
      continue;
    }
    const title = heading(lines[i]);
    if (title) { blocks.push({ type: "heading", level: title[1].length, text: title[2] }); i++; continue; }
    const first = list(lines[i]);
    if (first) {
      const ordered = /^\d/.test(first[1]), items = [];
      while (i < lines.length) {
        const next = list(lines[i]);
        if (!next || /^\d/.test(next[1]) !== ordered) break;
        items.push(next[2]); i++;
      }
      blocks.push({ type: "list", ordered, start: ordered ? parseInt(first[1], 10) : undefined, items });
      continue;
    }
    const prose = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !fence(lines[i]) && !heading(lines[i]) && !list(lines[i])) prose.push(lines[i++]);
    blocks.push({ type: "paragraph", text: prose.join("\n") });
  }
  return blocks;
}

export function transcriptItem(item) {
  const text = (value) => typeof value === "string" ? value : "";
  const display = (value) => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const result = { id: item.id, status: text(item.status), title: "Activity", text: "", detail: "", format: "markdown", detailFormat: "code" };
  switch (item.type) {
    case "userMessage": {
      const raw = (item.content ?? []).map((part) => text(part.text) || (part.type === "text" ? "" : `[${part.type}]`)).join("\n");
      const quoted = [...raw.matchAll(/^Request: (".*")$/gm)].at(-1)?.[1];
      let request = raw;
      try { if (quoted) request = JSON.parse(quoted); } catch { /* Keep the original prompt. */ }
      return { ...result, title: "Request", text: request, detail: request === raw ? "" : raw };
    }
    case "agentMessage": return text(item.text).trim() ? { ...result, title: "Response", text: text(item.text) } : undefined;
    case "reasoning": {
      const summary = (item.summary ?? []).map(text).filter((value) => value.trim()).join("\n\n");
      return summary ? { ...result, title: "Thinking", detail: summary, detailFormat: "markdown" } : undefined;
    }
    case "commandExecution": return { ...result, title: "Command", format: "code", text: displayCommand(text(item.command)), detail: text(item.aggregatedOutput) };
    case "fileChange": return { ...result, title: "File changes", detail: (item.changes ?? [])
      .map((change) => `${text(change.path)}\n${text(change.diff)}`).join("\n\n") };
    case "mcpToolCall":
    case "dynamicToolCall": return { ...result, title: [item.server || item.namespace, item.tool].filter(Boolean).join(" · ") || "Tool call",
      detail: [display(item.arguments), display(item.error ?? item.result ?? item.contentItems)].filter(Boolean).join("\n\n") };
    case "plan": return { ...result, title: "Plan", text: text(item.text) };
    case "webSearch": return { ...result, title: "Web search", detail: display(item.action ?? item.query) };
    case "contextCompaction": return { ...result, title: "Context compacted" };
    default: return { ...result, title: text(item.type).replace(/([a-z])([A-Z])/g, "$1 $2") || "Activity",
      text: "Details for this activity are unavailable in this viewer." };
  }
}

export async function readTranscript(host, saved, signal = new AbortController().signal) {
  let rpc;
  const stop = () => { void rpc?.close().catch(() => {}); };
  const open = async () => {
    signal.throwIfAborted();
    rpc = new CodexRpc(host.spawn.bind(host), { cwd: saved.cwd });
    await rpc.open();
    signal.throwIfAborted();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    await open();
    const turns = [], cursors = new Set();
    let cursor;
    do {
      signal.throwIfAborted();
      const page = await rpc.request("thread/turns/list", { threadId: saved.threadId,
        limit: TRANSCRIPT_TURNS - turns.length, sortDirection: "desc", itemsView: "notLoaded", ...(cursor ? { cursor } : {}) });
      turns.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("Codex repeated a transcript page.");
      if (cursor) cursors.add(cursor);
      if (!page.data.length) break;
    } while (cursor && turns.length < TRANSCRIPT_TURNS);
    let size = 10;
    for (const turn of turns) {
      const items = [], seen = new Set();
      let next;
      for (;;) {
        signal.throwIfAborted();
        let page;
        try {
          page = await rpc.request("thread/items/list", { threadId: saved.threadId, turnId: turn.id,
            limit: size, ...(next ? { cursor: next } : {}) });
        } catch (error) {
          if (!(error instanceof FrameTooLarge) || size === 1) throw error;
          size = Math.ceil(size / 2);
          await rpc.close();
          await open();
          continue;
        }
        items.push(...page.data.map(({ item }) => transcriptItem(item)).filter(Boolean));
        next = page.nextCursor;
        if (next && seen.has(next)) throw new Error("Codex repeated a transcript item page.");
        if (next) seen.add(next);
        if (!page.data.length || !next) break;
      }
      turn.items = items;
    }
    signal.throwIfAborted();
    return { turns: turns.reverse(), more: !!cursor };
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", stop);
    await rpc?.close();
  }
}

export async function cleanTerminals(rpc, threadId) {
  await rpc.request("thread/backgroundTerminals/clean", { threadId }, 5000);
  let cursor;
  do {
    const page = await rpc.request("thread/backgroundTerminals/list", { threadId, cursor, limit: 100 }, 5000);
    for (const terminal of page.data ?? [])
      await rpc.request("thread/backgroundTerminals/terminate", { threadId, processId: terminal.processId }, 5000);
    cursor = page.nextCursor;
  } while (cursor);
  const remaining = await rpc.request("thread/backgroundTerminals/list", { threadId, limit: 1 }, 5000);
  if (remaining.data?.length) throw new Error("Codex background commands could not be stopped.");
}

export class SessionStore {
  constructor(storage) { this.storage = storage; }
  key(agent, conversation) {
    return STORAGE_PREFIX + encodeURIComponent(agent) + "/" + encodeURIComponent(conversation);
  }
  read(key) {
    const raw = this.storage.getItem(key);
    if (raw == null) return undefined;
    let saved;
    try { saved = JSON.parse(raw); } catch { /* checked below */ }
    if (saved?.version !== 1 || typeof saved.threadId !== "string" || typeof saved.cwd !== "string" ||
        (saved.cursor !== undefined && typeof saved.cursor !== "string") ||
        (saved.label !== undefined && typeof saved.label !== "string") ||
        (saved.at !== undefined && !Number.isFinite(saved.at)))
      throw new Error("This conversation's saved Codex session is invalid. Use New session to reset it.");
    return saved;
  }
  write(key, saved) { this.storage.setItem(key, JSON.stringify({ version: 1, ...saved })); }
  remove(key) { this.storage.removeItem(key); }
  list(agent) {
    const prefix = this.key(agent, ""), rows = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(prefix)) continue;
      let place;
      try { place = decodeURIComponent(key.slice(prefix.length)); } catch { continue; }
      const [channelId, root] = place.split("/");
      if (!channelId) continue;
      try { rows.push({ key, channelId, ...(root ? { root } : {}), ...this.read(key) }); }
      catch { rows.push({ key, channelId, ...(root ? { root } : {}), problem: "Saved session is invalid. Use New session to reset it." }); }
    }
    return rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }
}

export function openedSession(rows, conversation) {
  if (!conversation) return rows[0];
  return rows.find((row) => row.channelId === conversation.channelId && row.root === conversation.rootId) ??
    rows.find((row) => row.channelId === conversation.channelId && !row.root);
}

export class CodexMcpRuntime {
  constructor(host, kit, storage) {
    this.host = host;
    this.kit = kit;
    this.store = new SessionStore(storage);
    this.lanes = new Map();
    this.jobs = new Set();
    this.listeners = new Set();
    this.connections = new Map();
    this.idle = new Map();
    this.disposed = false;
  }

  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  changed() { for (const listener of this.listeners) listener(); }
  sync(agents) {
    const present = new Set(agents.map((agent) => agent.key));
    for (const job of this.jobs)
      if (!present.has(job.agent)) job.controller.abort(new DOMException("Agent stopped.", "AbortError"));
    for (const [key, idle] of this.idle)
      if (!present.has(idle.agent)) void this.closeIdle(key).catch(() => {});
  }

  closeIdle(key) {
    const idle = this.idle.get(key);
    if (!idle) return;
    clearTimeout(idle.timer);
    idle.off();
    // Keep a closing process in the map so a follow-up waits for its exit
    // before resuming the same saved thread in a new process.
    idle.closing ??= idle.rpc.close().finally(() => this.idle.delete(key));
    return idle.closing;
  }

  async takeIdle(key, cwd, sandbox) {
    const idle = this.idle.get(key);
    if (!idle) return;
    if (idle.closing || idle.rpc.failure || idle.expiresAt <= Date.now() || idle.cwd !== cwd || idle.sandbox !== sandbox) {
      await this.closeIdle(key);
      return;
    }
    this.idle.delete(key);
    clearTimeout(idle.timer);
    idle.off();
    return idle.rpc;
  }

  keepIdle(key, agent, cwd, sandbox, rpc) {
    const now = Date.now();
    // Codex can cache its account internally. Cap reuse even in a busy conversation.
    const expiresAt = Math.min(now + IDLE_PROCESS_MS, rpc.openedAt + MAX_PROCESS_AGE_MS);
    if (this.disposed || rpc.failure || expiresAt <= now || this.idle.size >= MAX_IDLE_PROCESSES) return false;
    const close = () => { void this.closeIdle(key)?.catch(() => {}); };
    const timer = setTimeout(close, expiresAt - now);
    timer.unref?.();
    const off = rpc.subscribe(({ method }) => { if (method === "connection/closed") close(); });
    this.idle.set(key, { agent, cwd, sandbox, rpc, timer, off, expiresAt });
    return true;
  }
  async transcript(saved, signal) {
    const result = await readTranscript(this.host, saved, signal);
    // A disposable reader sees persisted state, which can label a running turn
    // interrupted. Overlay only the turn this runtime still owns after reading.
    const active = this.connections.get(saved.key);
    if (active?.threadId === saved.threadId && active.turnId) {
      const turn = result.turns.find((turn) => turn.id === active.turnId);
      if (turn) { turn.status = "inProgress"; turn.error = null; turn.completedAt = null; }
    }
    return result;
  }

  async run(delivery) {
    if (this.disposed) throw new Error("Codex with MCP is disabled.");
    if (delivery.agent.protection)
      throw new Error("Codex with MCP does not support protected agents. Use a compatible harness.");
    const config = settings(delivery.config);
    validate(config);
    const conversation = await this.kit.conversation(delivery, config.scope);
    if (!conversation) { delivery.ignored?.(); return; }
    delivery.signal.throwIfAborted();
    if (this.disposed) throw new Error("Codex with MCP is disabled.");
    const key = this.store.key(delivery.agent.key, conversation.key);
    const lane = this.lanes.get(key) ?? { tail: Promise.resolve() };
    this.lanes.set(key, lane);
    const controller = new AbortController();
    // Admission above uses the host's delivery deadline. Once handed to this
    // queue, work belongs to the runtime until completion, Stop or retirement.
    const signal = controller.signal;
    const job = { agent: delivery.agent.key, key, controller };
    this.jobs.add(job);
    let answered;
    const replyPublished = new Promise((resolve) => { answered = resolve; });
    const previous = lane.tail;
    const running = previous.catch(() => {}).then(() => {
      signal.throwIfAborted();
      if (delivery.current && !delivery.current()) { delivery.ignored?.(); return; }
      return this.turn(delivery, conversation, config, key, signal, controller, answered);
    });
    lane.tail = running;
    delivery.interruptible?.(async () => {
      controller.abort(new DOMException("Stopped by owner.", "AbortError"));
      await running.catch((error) => { if (error.cleanupFailure) throw error; });
    });
    this.changed();
    const settled = (async () => {
      try { await running; }
      catch (error) {
        if (error.cleanupFailure) {
          await this.kit.reply(delivery.agent, conversation,
            `Codex with MCP cleanup needs attention: ${error.message}`, { notifyOwner: true }).catch(() => {});
          throw error;
        }
        if (!signal.aborted || signal.reason?.name !== "AbortError") throw error;
      }
      finally {
        this.jobs.delete(job);
        if (lane.tail === running) this.lanes.delete(key);
        this.changed();
      }
    })();
    job.done = settled;
    // Codex may make another model call after its final tool result. Release
    // this request's activity, but keep its process and queue until turn end.
    const activity = Promise.race([settled, replyPublished]);
    delivery.workingUntil?.(activity);
    // Report asynchronous failures through the host's working hold. The
    // delivery returns after handover, independently of the Codex turn.
    void activity.catch(() => {});
  }

  async runOnce({ delivery, key, signal, prompt }) {
    try {
      if (this.disposed) throw new Error("Codex with MCP is disabled.");
      if (delivery.agent.protection) throw new Error("Codex with MCP does not support protected agents.");
      signal.throwIfAborted();
      if (delivery.current && !delivery.current()) return { ok: true };
      const config = settings(delivery.config);
      validate(config);
      const controller = new AbortController();
      const job = { agent: delivery.agent.key, key: `once:${key}`, controller };
      this.jobs.add(job);
      // Standalone turns retain the host's execution signal, including its
      // deadline, and remain tracked through completion even after a final send.
      job.done = this.turn(delivery, undefined, config, undefined,
        AbortSignal.any([signal, controller.signal]), controller, () => {}, prompt).finally(() => {
        this.jobs.delete(job);
        this.changed();
      });
      this.changed();
      await job.done;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: asError(error).message };
    }
  }

  async turn(delivery, conversation, config, key, signal, controller, answered, standalonePrompt) {
    let rpc, bridge, cwd, prompt, threadId, turnId, stopping;
    let accepted = false, finished = false, finalSent = false, finalSendFailed = false;
    let succeeded = false;
    let unsubscribe = () => {};
    const stop = () => {
      stopping ??= (async () => {
        try {
          if (threadId && turnId)
            await rpc.request("turn/interrupt", { threadId, turnId }, 5000).catch(() => {});
          if (threadId) await cleanTerminals(rpc, threadId);
        } finally { await rpc?.close(); }
      })();
      // Awaited again during final cleanup; observe an early rejection too.
      void stopping.catch(() => {});
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      signal.throwIfAborted();
      cwd = await this.host.resolveDirectory(config.workspace.trim());
      signal.throwIfAborted();
      const saved = conversation ? this.store.read(key) : undefined;
      if (saved && saved.cwd !== cwd)
        throw new Error("The workspace changed. Use New session before running in another workspace.");
      const tools = this.kit.tools(delivery.agent, conversation, {
        read: (path) => { signal.throwIfAborted(); return this.host.readFile(path, { cwd }); },
      });
      bridge = await this.host.serveMcp(async (message) => {
        signal.throwIfAborted();
        if (finished) throw new Error("This Buzz tool bridge's Codex turn ended.");
        const call = message?.params;
        const final = message?.method === "tools/call" && ["send", "reply_in_subthread"].includes(call?.name) &&
          call.arguments?.final === true;
        const result = await tools(message).catch((error) => {
          if (final) finalSendFailed = true;
          throw error;
        });
        if (final) {
          if (result?.result && !result.result.isError && !result.error) {
            finalSent = true;
            answered();
          } else finalSendFailed = true;
        }
        return result;
      }, { sharedSession: true });
      void bridge.closed.then(() => {
        if (!finished) controller.abort(new Error("The Buzz tool bridge closed."));
      });
      signal.throwIfAborted();
      // Codex connects through threadParams. Do not also start the native
      // shell helper: Buzz messaging is supplied through Codex's MCP client.
      if (conversation) rpc = await this.takeIdle(key, cwd, config.sandbox);
      signal.throwIfAborted();
      if (!rpc) {
        rpc = new CodexRpc(this.host.spawn.bind(this.host), { cwd });
        await rpc.open();
      }
      signal.throwIfAborted();
      const account = await rpc.request("account/read", { refreshToken: false });
      if (!account.account && account.requiresOpenaiAuth !== false)
        throw new Error("Sign into your local Codex CLI, then try this agent again.");
      const { config: normalized } = await rpc.request("config/read", { cwd });
      const system = await this.kit.systemPrompt(delivery, {
        scope: config.scope, cwd, instructions: config.instructions,
      });
      const runConfig = { ...config, model: delivery.model || config.model, effort: delivery.effort || config.effort };
      const params = threadParams(runConfig, cwd, system + (conversation ?
        "\nUse the Buzz MCP send tool with final:true for your final reply. " +
        "Use Buzz MCP tools for messaging rather than shell commands. " +
        "If you do not send a final reply with a tool, your final assistant text is posted automatically."
        : "\nThis is a standalone turn with no default Buzz destination. " +
        "Use Buzz MCP tools with an explicit destination if reporting is required. Final assistant text is not posted automatically."),
      normalized, bridge);
      if (!conversation) {
        const text = await standalonePrompt();
        signal.throwIfAborted();
        if (text === undefined || (delivery.current && !delivery.current())) return;
        prompt = { text: this.kit.standalonePrompt(delivery.agent, text) };
      }
      // Keep history in Codex; returning it here can exceed the RPC frame
      // limit. Activity reads it separately through the paginated endpoints.
      const opened = saved
        ? await rpc.request("thread/resume", { ...params, threadId: saved.threadId, excludeTurns: true })
        : await rpc.request("thread/start", { ...params, ...(!conversation ? { ephemeral: true } : {}) });
      signal.throwIfAborted();
      threadId = opened.thread?.id;
      if (!threadId) throw new Error("Codex did not return a conversation ID.");
      const live = { rpc, threadId };
      if (conversation) this.connections.set(key, live);
      prompt ??= await this.kit.turnPrompt(delivery, conversation, { cursor: saved?.cursor });
      signal.throwIfAborted();
      let finalText = "";
      let resolveTurn, rejectTurn;
      const completed = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
      // Observe failures even if turn/start itself fails before we await completion.
      void completed.catch(() => {});
      unsubscribe = rpc.subscribe(({ method, params: event }) => {
        if (method === "connection/closed") { rejectTurn(new Error(event.message)); return; }
        if (event?.threadId !== threadId) return;
        if (method === "turn/started") live.turnId = turnId = event.turn?.id;
        if (method === "item/completed") {
          if (event.item?.type === "agentMessage") {
            if (event.item.phase == null || event.item.phase === "final_answer") finalText = event.item.text ?? "";
          }
          else if (event.item?.type) delivery.step?.(event.item.type);
        }
        if (method === "turn/completed") {
          live.completed = true;
          live.turnId = undefined;
          if (event.turn?.status === "completed") resolveTurn();
          else rejectTurn(new Error(event.turn?.error?.message || `Codex turn ${event.turn?.status ?? "failed"}.`));
        }
      });
      if (delivery.current && !delivery.current()) { delivery.ignored?.(); return; }
      const started = await rpc.request("turn/start", turnParams(opened, prompt.text, system));
      turnId = started.turn?.id ?? turnId;
      if (!live.completed) live.turnId = turnId;
      accepted = true;
      if (conversation)
        this.store.write(key, { threadId, cwd, cursor: prompt.cursor, label: conversation.where, at: Date.now() });
      this.changed();
      delivery.acknowledged?.();
      await completed;
      signal.throwIfAborted();
      if (!finalSent) {
        if (conversation && finalText.trim()) await this.kit.reply(delivery.agent, conversation, finalText);
        else if (finalSendFailed) throw new Error("Buzz could not deliver the final reply. Try again.");
        // Codex can complete silently when there is nothing new to add.
      }
      succeeded = true;
    } catch (problem) {
      const error = asError(signal.aborted ? signal.reason : problem);
      if (conversation && (!signal.aborted || signal.reason?.name !== "AbortError")) {
        // Do not add process stderr, MCP configuration or authentication material.
        await this.kit.reply(delivery.agent, conversation,
          `Codex with MCP could not finish: ${error.message}`, { notifyOwner: true });
      }
      throw error;
    } finally {
      finished = true;
      if (conversation && this.connections.get(key)?.rpc === rpc) this.connections.delete(key);
      if (!accepted) prompt?.restore?.();
      unsubscribe();
      signal.removeEventListener("abort", stop);
      let released = false;
      try {
        if (stopping) await stopping;
        else if (threadId) await cleanTerminals(rpc, threadId);
        if (conversation && succeeded && !signal.aborted && !this.disposed) {
          // A loaded subscription can ignore resume overrides. Release it
          // before closing the old bridge and accepting a new delivery.
          const result = await rpc.request("thread/unsubscribe", { threadId }, 5000).catch(() => undefined);
          released = result?.status === "unsubscribed" || result?.status === "notLoaded";
        }
      } catch (problem) {
        const error = asError(problem);
        error.cleanupFailure = true;
        throw error;
      } finally {
        let kept = false;
        try {
          await bridge?.close();
          if (released && !signal.aborted)
            kept = this.keepIdle(key, delivery.agent.key, cwd, config.sandbox, rpc);
        } finally {
          if (!kept) await rpc?.close();
        }
      }
    }
  }

  sessionKey(agent, place) {
    return this.store.key(agent.key, place.root ? `${place.channelId}/${place.root}` : place.channelId);
  }
  state(agent, place) {
    const key = this.sessionKey(agent, place);
    return [...this.jobs].some((job) => job.key === key) ? "active" : "idle";
  }
  async control(agent, place, action) {
    const key = this.sessionKey(agent, place);
    const jobs = [...this.jobs].filter((job) => job.key === key);
    if (action === "interrupt") {
      for (const job of jobs) job.controller.abort(new DOMException("Stopped by owner.", "AbortError"));
      const results = await Promise.allSettled([...jobs.map((job) => job.done), this.closeIdle(key)]);
      const failure = results.find((result, index) => result.status === "rejected" &&
        (index >= jobs.length || result.reason.cleanupFailure));
      if (failure) throw failure.reason;
    } else if (action === "new") {
      if (jobs.length) throw new Error("Stop this conversation before starting a new session.");
      this.store.remove(key);
      await this.closeIdle(key);
    } else throw new Error("This plugin supports Stop and New session; Compact is not available.");
    this.changed();
  }
  async retire(agent) {
    const jobs = [...this.jobs].filter((job) => agent === undefined || job.agent === agent);
    for (const job of jobs) job.controller.abort(new DOMException("Agent stopped.", "AbortError"));
    const closing = [...this.idle].filter(([, idle]) => agent === undefined || idle.agent === agent)
      .map(([key]) => this.closeIdle(key));
    const results = await Promise.allSettled([...jobs.map((job) => job.done), ...closing]);
    const failure = results.find((result, index) => result.status === "rejected" &&
      (index >= jobs.length || result.reason.cleanupFailure));
    if (failure) throw failure.reason;
  }
  async dispose() {
    this.disposed = true;
    await this.retire();
    this.listeners.clear();
  }
}

export class SettingsDraft {
  constructor(config) {
    this.base = settings(config);
    this.source = JSON.stringify(this.base);
    this.value = { draft: this.base, busy: false, error: "" };
    this.listeners = new Set();
  }
  snapshot = () => this.value;
  subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  update(change) {
    this.value = { ...this.value, ...change };
    for (const listener of this.listeners) listener();
  }
  reconcile(config) {
    const base = settings(config), source = JSON.stringify(base);
    if (this.value.busy || source === this.source) return;
    const draft = { ...base };
    for (const key of Object.keys(base))
      if (this.value.draft[key] !== this.base[key]) draft[key] = this.value.draft[key];
    this.base = base;
    this.source = source;
    this.update({ draft });
  }
  reset(config) {
    if (this.value.busy) return;
    this.base = settings(config);
    this.source = JSON.stringify(this.base);
    this.update({ draft: this.base, error: "" });
  }
  async save(config, save) {
    if (this.value.busy) return;
    try {
      validate(this.value.draft);
      const next = { ...config, ...this.value.draft };
      this.update({ busy: true, error: "" });
      await save(next);
      this.base = settings(next);
      this.update({ draft: this.base });
    } catch (problem) { this.update({ error: asError(problem).message }); }
    finally { this.update({ busy: false }); }
  }
}

function components(React, host, runtime) {
  const h = React.createElement;
  // The host remounts the editor between Identity and Settings. Keep drafts
  // and in-flight saves in memory for this plugin lifetime, isolated by agent.
  const drafts = new Map();
  const button = (text, props = {}) => h("button", {
    type: "button", "data-buzz-ui": "", className: "buzz-button",
    "data-variant": "subtle", "data-size": "sm", ...props,
  }, h("span", { className: "buzz-button-label" }, text));
  function useCatalog(workspace, enabled) {
    const [path, setPath] = React.useState(workspace);
    const [revision, setRevision] = React.useState(0);
    const [catalog, setCatalog] = React.useState({ models: [], defaultModel: "", defaultEffort: "", loading: true, error: "" });
    React.useEffect(() => {
      if (!enabled) return;
      const controller = new AbortController();
      setCatalog((previous) => ({ ...previous, loading: true, error: "" }));
      void readModelCatalog(host, path, controller.signal).then((result) => {
        if (!controller.signal.aborted) setCatalog({ ...result, loading: false, error: "" });
      }, () => {
        if (!controller.signal.aborted) setCatalog((previous) => ({ ...previous, loading: false,
          error: "Could not load models. Check the workspace path and local Codex connection, then retry." }));
      });
      return () => controller.abort();
    }, [path, revision, enabled]);
    return { ...catalog, workspaceChanged: () => setPath(workspace.trim()), refresh: () => {
      setPath(workspace.trim()); setRevision((previous) => previous + 1);
    } };
  }
  function Fields({ config, onChange, disabled, harnessControl, section }) {
    const id = React.useId();
    const identity = section !== "runtime", execution = section !== "identity";
    const catalog = useCatalog(config.workspace, identity);
    const choices = modelChoices(catalog, config);
    const update = (name) => (event) => onChange({ ...config, [name]: event.target.value });
    const select = (name, title, options, extra = {}) => h("div", {
      className: "buzz-select", "data-variant": "compact", "data-appearance": "outlined",
      style: { minWidth: 0, maxWidth: "100%" },
    }, h("select", {
      id: `${id}-${name}`, "aria-label": title, role: "combobox", "data-buzz-ui": "",
      className: "buzz-button", "data-variant": "outline", "data-size": "sm",
      disabled, value: config[name], onChange: update(name),
      style: { appearance: "auto", minWidth: 0, maxWidth: "100%" }, ...extra,
    }, options.map(({ value, label, disabled }) => h("option", { key: value, value, disabled }, label))));
    const row = (name, title, control) => h("div", { key: name, "data-buzz-ui": "", className: "buzz-preference-row" },
      h("div", { className: "buzz-preference-row-content" },
        h("label", { htmlFor: `${id}-${name}`, className: "buzz-preference-row-label" }, title)),
      h("div", { className: "buzz-preference-row-trailing" }, control));
    const field = (name, title, control) => h("div", { className: "buzz-field" },
      h("label", { htmlFor: `${id}-${name}`, className: "buzz-field-label" }, title), control);
    const group = (...children) => h("div", { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": "rows" }, ...children);
    return h("div", { "data-buzz-ui": "", style: { display: "grid", minWidth: 0, gap: "var(--space-6)" } },
      identity && h("div", { style: { display: "grid", minWidth: 0, gap: "var(--space-2)" } },
        group(harnessControl,
          row("model", "Model", select("model", "Model", choices.models, {
            disabled: disabled || catalog.loading || !!catalog.error,
            onChange: (event) => onChange(changeModel(config, catalog, event.target.value)),
          })),
          row("effort", "Thinking", select("effort", "Thinking", choices.efforts, {
            disabled: disabled || catalog.loading || !!catalog.error,
          }))),
        h("div", { style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-2)" } },
          h("span", { role: catalog.error ? "alert" : "status", className: catalog.error ? "buzz-field-error" : "buzz-field-description",
            style: { flex: "1 1 12rem" } },
            catalog.error || (catalog.loading ? "Loading Codex models…" : "Defaults follow your local Codex settings.")),
          button(catalog.error ? "Retry" : "Refresh models", { disabled: disabled || catalog.loading, onClick: catalog.refresh,
            "aria-label": catalog.error ? "Retry loading Codex models" : "Refresh Codex models" }))),
      execution && field("workspace", "Workspace", h("input", {
        id: `${id}-workspace`, className: "buzz-input", "data-buzz-ui": "", type: "text",
        value: config.workspace, onChange: update("workspace"), onBlur: catalog.workspaceChanged,
        disabled, spellCheck: false, autoCapitalize: "none", autoCorrect: "off",
      })),
      execution && group(
        row("scope", "Sessions", select("scope", "Sessions", [
          { value: "thread", label: "One session per thread" }, { value: "channel", label: "One session per channel" },
        ]))),
      identity && field("instructions", "Instructions", h("textarea", {
        id: `${id}-instructions`, className: "buzz-textarea", "data-buzz-ui": "", "data-appearance": "outlined",
        value: config.instructions, onChange: update("instructions"), disabled, rows: 8,
      })),
      execution && group(
        row("sandbox", "Execution access", select("sandbox", "Execution access", [
          { value: "read-only", label: "Read only" }, { value: "workspace-write", label: "Workspace only" },
          { value: "danger-full-access", label: "Full host access" },
        ]))),
      execution && h("p", { className: "buzz-field-description", style: { margin: 0 } }, config.sandbox === "danger-full-access"
        ? "Commands can access files outside the workspace and use unrestricted networking, including local device services."
        : "Sandboxed commands may be blocked from starting local services. Full host access permits host commands and unrestricted networking."),
      execution && h("p", { className: "buzz-field-description", style: { margin: 0 } }, "MCP tools follow their configured permissions."));
  }
  function Create({ config, onChange, disabled }) {
    return h(Fields, { config: settings(config), onChange, disabled });
  }
  function Settings(props) {
    if (props.agent.configProblem) return h("div", {
      "data-buzz-ui": "", style: { display: "grid", gap: "var(--space-6)" },
    }, props.settingsSection !== "runtime" && props.settingsHost?.typeControl?.(false),
    h("p", { role: "status", className: "buzz-field-description" },
      "Buzz could not load this agent’s saved settings. Resolve the error above before editing instructions or other settings."),
    props.settingsSection !== "identity" && props.settingsContent);
    return h(SettingsEditor, props);
  }
  function SettingsEditor({ agent, save, settingsHost, settingsSection, settingsContent }) {
    let editor = drafts.get(agent.key);
    if (!editor) { editor = new SettingsDraft(agent.config); drafts.set(agent.key, editor); }
    const { draft, busy, error } = React.useSyncExternalStore(editor.subscribe, editor.snapshot);
    React.useEffect(() => { editor.reconcile(agent.config); }, [editor, agent.config, busy]);
    const dirty = JSON.stringify(draft) !== JSON.stringify(settings(agent.config));
    const submit = async (event) => {
      event.preventDefault();
      await editor.save(agent.config, (next) => settingsHost?.pendingSave ? settingsHost.pendingSave(next) : save(next));
    };
    return h("form", { "data-buzz-ui": "", onSubmit: submit, style: { display: "grid", minWidth: 0, gap: "var(--space-6)" } },
      h(Fields, { config: draft, onChange: (draft) => editor.update({ draft }), disabled: busy, section: settingsSection,
        harnessControl: settingsSection !== "runtime" ? settingsHost?.typeControl?.(dirty) : undefined }),
      error && h("p", { role: "alert", className: "buzz-field-error" }, error),
      h("div", { style: { display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: "var(--space-2)" } },
      (dirty || error) && button("Discard changes", { disabled: busy, onClick: () => editor.reset(agent.config) }),
      button(busy ? "Saving…" : "Save", {
        type: "submit", "data-variant": "prominent", "data-size": "md",
        disabled: busy || (!dirty && !settingsHost?.pendingSave),
      })),
      settingsSection !== "identity" && settingsContent);
  }
  const mono = { fontFamily: "var(--font-mono)", fontSize: "var(--text-mono)",
    lineHeight: "var(--text-mono--line-height)", letterSpacing: "var(--text-mono--letter-spacing)",
    fontWeight: "var(--text-mono--font-weight)" };
  function CodeBlock({ text, language }) {
    return h("div", { style: { minWidth: 0 } },
      language && h("div", { className: "text-caption text-subtle", style: { marginBottom: "var(--space-1)" } }, language),
      h("pre", { tabIndex: 0, "aria-label": language ? `${language} code` : "Code or output",
        style: { ...mono, maxHeight: "24rem", maxWidth: "100%", overflow: "auto", margin: 0,
          padding: "var(--space-3)", border: "1px solid var(--border-standard)", borderRadius: "var(--radius-row)",
          background: "var(--surface-inset)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, h("code", { style: { font: "inherit" } }, text)));
  }
  const inline = (text) => transcriptInline(text).map((part, index) => part.type === "text" ? part.text
    : h(part.type === "code" ? "code" : part.type, { key: index, style: part.type === "code" ? {
      ...mono, borderRadius: "var(--radius-chip)", background: "var(--affordance-subtle)",
      padding: "var(--space-half) var(--space-1h)", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
    } : undefined }, part.text));
  function TranscriptText({ text, format }) {
    if (format === "code") return h(CodeBlock, { text });
    return h("div", { className: "text-message", style: { display: "grid", gap: "var(--space-2)", minWidth: 0, overflowWrap: "anywhere" } },
      transcriptBlocks(text).map((block, index) => {
        if (block.type === "code") return h(CodeBlock, { key: index, text: block.text, language: block.language });
        if (block.type === "list") return h(block.ordered ? "ol" : "ul", { key: index, start: block.start,
          style: { margin: 0, paddingInlineStart: "var(--space-6)", listStyleType: block.ordered ? "decimal" : "disc" } },
        block.items.map((item, at) => h("li", { key: at, style: { marginBlock: "var(--space-1)" } }, inline(item))));
        const title = block.type === "heading";
        return h(title ? `h${block.level}` : "p", { key: index,
          className: title ? block.level === 1 ? "text-heading" : block.level === 2 ? "text-body-lg" : "text-label" : undefined,
          style: { margin: 0, whiteSpace: "pre-wrap", ...(title ? { fontWeight: "var(--type-weight-medium)" } : {}) } },
        block.type === "plain" ? block.text : inline(block.text));
      }));
  }
  function Activity({ agent, conversation, initialTranscript }) {
    const conversationId = React.useId();
    const [, setRevision] = React.useState(0);
    const [choice, setChoice] = React.useState();
    const [refresh, setRefresh] = React.useState(0);
    const [read, setRead] = React.useState();
    const opening = React.useRef();
    if (initialTranscript) opening.current = initialTranscript.opening;
    React.useEffect(() => runtime.subscribe(() => setRevision((value) => value + 1)), []);
    React.useEffect(() => {
      const visible = () => { if (!document.hidden) setRefresh((value) => value + 1); };
      globalThis.document?.addEventListener("visibilitychange", visible);
      return () => globalThis.document?.removeEventListener("visibilitychange", visible);
    }, []);
    const context = `${agent.key}/${conversation?.channelId ?? ""}/${conversation?.rootId ?? ""}`;
    const rows = runtime.store.list(agent.key);
    const here = openedSession(rows, conversation);
    const selected = choice?.context === context && choice.opening === opening.current
      ? rows.find((row) => row.key === choice.key) : here;
    const readKey = selected ? `${selected.key}/${selected.threadId ?? "invalid"}` : "";
    const working = !!selected && runtime.state(agent, selected) === "active";
    React.useEffect(() => { initialTranscript?.done(); }, [context, initialTranscript?.opening]);
    React.useEffect(() => {
      if (!selected || agent.protection) return;
      const controller = new AbortController();
      let timer;
      const load = async () => {
        if (controller.signal.aborted) return;
        if (!globalThis.document?.hidden) {
          setRead((previous) => ({ key: readKey, busy: true, data: previous?.key === readKey ? previous.data : undefined }));
          try {
            if (selected.problem) throw new Error(selected.problem);
            const data = await runtime.transcript(selected, controller.signal);
            if (!controller.signal.aborted) setRead({ key: readKey, data });
          } catch {
            if (!controller.signal.aborted) setRead((previous) => ({ ...previous, key: readKey, busy: false,
              error: selected.problem || "Could not read the Codex transcript. The local session may be unavailable; try refreshing." }));
          }
        }
        if (!controller.signal.aborted && working) timer = setTimeout(load, 2500);
      };
      void load();
      return () => { controller.abort(); clearTimeout(timer); };
    }, [readKey, working, refresh, !!agent.protection]);
    const shown = read?.key === readKey ? read : undefined;
    const paragraph = (content, props = {}) => h("p", { className: "buzz-field-description", style: { margin: 0 }, ...props }, content);
    const status = (value) => ({ inProgress: "Working", completed: "Completed", interrupted: "Stopped", failed: "Failed" })[value] || value;
    if (agent.protection) return paragraph("This plugin cannot read protected-agent transcripts.");
    return h("div", { "data-buzz-ui": "", style: { display: "grid", minWidth: 0, gap: "var(--space-6)" } },
      h("div", { className: "buzz-field" },
        h("label", { htmlFor: conversationId, className: "buzz-field-label" }, "Conversation"),
        h("div", { style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-2)" } },
        h("div", { "data-buzz-ui": "", className: "buzz-select", "data-variant": "compact", "data-appearance": "outlined",
          style: { position: "relative", flex: "1 1 12rem", minWidth: 0 } },
          h("select", { id: conversationId, "data-buzz-ui": "", className: "buzz-button buzz-select-trigger",
            "data-variant": "outline", "data-size": "sm", value: selected?.key ?? "", disabled: !rows.length, "aria-label": "Transcript conversation",
            style: { appearance: "none", display: "block", width: "100%", minWidth: 0, textOverflow: "ellipsis", paddingInlineEnd: "var(--space-8)" },
            onChange: (event) => setChoice({ context, opening: opening.current, key: event.target.value }) },
          !here && conversation && h("option", { value: "" }, "This conversation · No session yet"),
          rows.map((row) => h("option", { key: row.key, value: row.key }, row.key === here?.key && conversation
            ? "This conversation" : `${row.label || `Channel ${row.channelId.slice(0, 8)}`}${row.root ? ` · Thread ${row.root.slice(0, 8)}` : ""}`))),
          h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2,
            "aria-hidden": true, focusable: false, style: { position: "absolute", insetInlineEnd: "var(--space-3)", top: "50%",
              transform: "translateY(-50%)", width: "var(--space-4)", height: "var(--space-4)", pointerEvents: "none", color: "var(--text-subtle)" } },
          h("path", { d: "m6 9 6 6 6-6", strokeLinecap: "round", strokeLinejoin: "round" }))),
        button("Refresh", { "aria-label": "Refresh transcript", "data-variant": "outline", disabled: !selected || shown?.busy,
          onClick: () => setRefresh((value) => value + 1) }))),
      !selected && paragraph("No Codex session is saved for this conversation yet. Send the agent a message to start one.", { role: "status" }),
      selected && !shown?.data && !shown?.error && paragraph("Reading the Codex transcript…", { role: "status" }),
      shown?.error && paragraph(shown.error, { role: "alert", className: "buzz-field-error" }),
      selected && paragraph(working ? "Working · Transcript updates automatically." : "Saved Codex transcript", { role: "status" }),
      shown?.data?.more && paragraph(`Showing the latest ${TRANSCRIPT_TURNS} turns. Earlier turns remain in Codex’s session history.`),
      shown?.data && !shown.data.turns.length && paragraph("This Codex session has no recorded turns yet."),
      shown?.data?.turns.map((turn) => h("section", { key: turn.id, "aria-label": `Turn ${status(turn.status)}`,
        style: { display: "grid", minWidth: 0, gap: "var(--space-3)", borderTop: "1px solid var(--border-standard)", paddingTop: "var(--space-4)" } },
        paragraph([turn.startedAt ? new Date(turn.startedAt * 1000).toLocaleString() : "Turn", status(turn.status)].filter(Boolean).join(" · ")),
        turn.error?.message && paragraph(turn.error.message, { role: "alert", className: "buzz-field-error" }),
        turn.items.map((item, index) => h("div", { key: item.id || index, style: { display: "grid", minWidth: 0, gap: "var(--space-2)" } },
          h("div", { className: "text-label-sm text-secondary" }, [item.title, status(item.status)].filter(Boolean).join(" · ")),
          item.text && h(TranscriptText, { text: item.text, format: item.format }),
          item.detail && h("details", null, h("summary", { className: "text-body-sm text-subtle", style: { cursor: "pointer" } },
            item.title === "Request" ? "Context" : item.title === "Command" ? "Output" : "Details"),
            h("div", { style: { marginTop: "var(--space-2)", minWidth: 0 } }, h(TranscriptText, { text: item.detail, format: item.detailFormat }))))))));
  }
  // Preserve the bundled icon.svg paths and let the
  // host choose the monochrome color for light, dark and selected states.
  function HarnessIcon({ size = "1em", "aria-hidden": hidden = true, ...props }) {
    const dimension = typeof size === "number" ? `${size / 16}rem` : size;
    return h("svg", {
      width: dimension, height: dimension, viewBox: "0 0 24 24",
      fill: "currentColor", "aria-hidden": hidden, focusable: "false", ...props,
    },
      h("path", { d: "M10.6815 1C8.11345 1 6.05273 3.0394 6.05273 5.52942V11.0577C6.05273 11.4124 6.24035 11.7405 6.54595 11.9205C7.21335 12.3134 8.05503 11.8321 8.05497 11.0577L8.05464 6.39572C8.05461 6.16264 8.17996 5.94757 8.38276 5.83269L14.0939 2.59738C14.1335 2.57502 14.1427 2.52176 14.1118 2.48842C13.2658 1.57505 12.0436 1 10.6815 1Z" }),
      h("path", { d: "M21.3275 9.069C21.3782 9.09769 21.4429 9.07421 21.461 9.01879C21.8419 7.8477 21.7372 6.53125 21.0619 5.38355C19.787 3.21695 16.9526 2.46555 14.7317 3.72367L9.82462 6.50345C9.53046 6.67008 9.34865 6.98205 9.34867 7.32014C9.34873 8.03227 10.1108 8.48491 10.7361 8.14428L14.9878 5.82846C15.1841 5.72151 15.4218 5.7235 15.6163 5.83369L21.3275 9.069Z" }),
      h("path", { d: "M10.0211 10.0093C9.60659 10.2351 9.34865 10.6693 9.34869 11.1413L9.34881 12.8363C9.34885 13.2929 9.59039 13.7153 9.98381 13.9469L11.3173 14.732C11.7076 14.9618 12.1899 14.9698 12.5877 14.7532L14.0579 13.9523C14.4654 13.7304 14.7222 13.3065 14.7301 12.8426L14.7574 11.2533C14.7654 10.7889 14.5228 10.3562 14.1226 10.1205L12.6825 9.27276C12.2922 9.04297 11.8099 9.03494 11.4121 9.2516L10.0211 10.0093Z" }),
      h("path", { d: "M14.8337 7.38608C14.1933 7.7349 14.1781 8.64894 14.8065 9.01892L18.9235 11.4426C19.121 11.5588 19.2423 11.7709 19.2423 12.0002V18.4708C19.2423 18.5187 19.2856 18.5553 19.3325 18.5455C20.5757 18.2868 21.7013 17.532 22.3822 16.3749C23.6528 14.2157 22.9039 11.449 20.6899 10.1948L15.7452 7.39368C15.4631 7.23387 15.1185 7.231 14.8337 7.38608Z" }),
      h("path", { d: "M17.4742 12.0909C16.8391 11.717 16.0368 12.1667 16.0242 12.9035L15.9433 17.6147C15.9395 17.8439 15.8147 18.0537 15.6154 18.1667L9.90417 21.402C9.86544 21.424 9.85637 21.4761 9.88659 21.5088C10.7326 22.4238 11.956 23 13.3195 23C15.8875 23 17.9482 20.9607 17.9482 18.4706V12.92C17.9482 12.5792 17.7679 12.2638 17.4742 12.0909Z" }),
      h("path", { d: "M14.6646 16.6883C14.6769 15.97 13.9099 15.5054 13.279 15.8491L9.01217 18.1732C8.81584 18.2802 8.5782 18.2781 8.38368 18.1679L2.67247 14.9327C2.62064 14.9033 2.55436 14.9273 2.53596 14.984C2.15577 16.1545 2.26079 17.4701 2.93571 18.617C4.2106 20.7836 7.04497 21.535 9.26591 20.2769L14.1894 17.4878C14.4782 17.3242 14.6589 17.0201 14.6646 16.6883Z" }),
      h("path", { d: "M9.16667 16.611C9.80728 16.2621 9.82252 15.3478 9.1939 14.9778L8.39596 14.508C8.38138 14.5001 8.36713 14.4918 8.35326 14.4829L5.07726 12.5542C4.87973 12.438 4.75846 12.2259 4.75846 11.9966V5.52604C4.75846 5.47828 4.71525 5.44181 4.66849 5.45153C3.42497 5.71006 2.29906 6.46491 1.61801 7.62233C0.347477 9.78151 1.09635 12.5482 3.31033 13.8024L8.25503 16.6034C8.5372 16.7633 8.88188 16.7661 9.16667 16.611Z" }));
  }
  const clearDraft = (key) => { if (key === undefined) drafts.clear(); else drafts.delete(key); };
  return { Create, Settings, Activity, HarnessIcon, clearDraft };
}

export function apply(ctx) {
  const kit = ctx.agents?.harness;
  if (!kit?.conversation || !kit?.systemPrompt || !kit?.turnPrompt || !kit?.tools || !kit?.reply ||
      !ctx.agents.snapshot || !ctx.agents.subscribe ||
      !ctx.host?.spawn || !ctx.host?.serveMcp || !ctx.host?.resolveDirectory || !ctx.host?.readFile)
    throw new Error("Codex with MCP requires the Buzz 1.x desktop plugin API and approved process, MCP and file access. Buzz 0.5 is unsupported.");
  const runtime = new CodexMcpRuntime(ctx.host, kit, globalThis.localStorage);
  const { Create, Settings, Activity, HarnessIcon, clearDraft } = components(ctx.react, ctx.host, runtime);
  ctx.agents.register({
    id: "codex-mcp",
    title: "Codex with MCP",
    icon: HarnessIcon,
    description: "Local Codex with your enabled MCP servers. Requires an installed, signed-in Codex CLI.",
    defaults: () => ({ config: settings() }),
    syncedSettings: { schema: SYNCED_SETTINGS_SCHEMA, withSynced: withSyncedSettings },
    carry: (config) => {
      const { instructions, workspace } = settings(config);
      return {
        ...(instructions.trim() && { instructions }),
        ...(workspace !== DEFAULT_WORKSPACE && { workspace }),
      };
    },
    adopt: (carry, config) => settings({ ...config,
      instructions: carry.instructions ?? config.instructions,
      workspace: carry.workspace ?? config.workspace,
    }),
    describeMigration: (config) => {
      const { model, effort, scope } = settings(config);
      return [
        { id: "model", label: "Model", isOverride: Boolean(model) },
        { id: "thinking", label: "Thinking", isOverride: Boolean(effort) },
        { id: "sessions", label: "Sessions", isOverride: scope !== settings().scope,
          unchangedKey: scope },
      ];
    },
    migrationWarning: "The new provider uses separate sessions. Review its model and permission settings.",
    summary: (agent) => settings(agent.config).model || "Codex default · MCP enabled",
    Create,
    tabs: [{ id: "settings", role: "settings", splitSettings: true, title: "Settings", component: Settings },
      { id: "activity", role: "activity", title: "Activity", component: Activity }],
    sessions: {
      list: (agent) => runtime.store.list(agent).map((row) => ({ channelId: row.channelId,
        ...(row.root ? { root: row.root } : {}), ...(row.at ? { at: row.at } : {}),
        status: runtime.state({ key: agent }, row) === "active" ? "Working" : "Idle" })),
      subscribe: runtime.subscribe,
    },
    // This bounds admission/handover only; accepted turns have no wall-clock cap.
    timeoutMs: 30 * 60_000,
    resumes: true,
    protectionUnavailable: "This plugin does not implement protected-agent containment.",
    run: (delivery) => runtime.run(delivery),
    runOnce: (turn) => runtime.runOnce(turn),
    retire: async (key) => { await runtime.retire(key); clearDraft(key); },
    readFile: (agent, path, signal) => {
      signal.throwIfAborted();
      if (agent.protection) throw new Error("Protected agents are unsupported.");
      return ctx.host.readFile(path, { cwd: settings(agent.config).workspace });
    },
    sessionControls: {
      scope: (agent) => settings(agent.config).scope,
      state: (agent, place) => runtime.state(agent, place),
      run: (agent, place, action) => runtime.control(agent, place, action),
      subscribe: runtime.subscribe,
    },
  });
  const sync = () => {
    const snapshot = ctx.agents.snapshot();
    if (snapshot.status !== "loading") runtime.sync(snapshot.running);
  };
  ctx.effect(() => {
    const offAgents = ctx.agents.subscribe(sync);
    sync();
    return () => {
      offAgents();
      return runtime.dispose().finally(() => clearDraft());
    };
  });
}
