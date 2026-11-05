import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { basename } from "node:path";
import WebSocket from "ws";
import { type BackendConfig, Fault } from "../management/schema.js";
import type { RuntimeStore } from "../runtime/index.js";

export type Frame = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
};
export type NativeEvent = { method: string; params: any; id?: number | string };
export interface CodexAdapter {
  create(input: {
    cwd: string;
    model?: string;
    bridgeUrl: string;
    bridgeToken: string;
    /** The session's title in Codex Desktop. */
    name?: string;
  }): Promise<string>;
  resume(
    threadId: string,
    binding?: { bridgeUrl: string; bridgeToken: string; initial?: boolean },
  ): Promise<any>;
  bridgeReady(threadId: string): Promise<boolean>;
  read(threadId: string): Promise<any>;
  start(threadId: string, text: string, inputId: string): Promise<string>;
  steer(threadId: string, turnId: string, text: string, inputId: string): Promise<string>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  terminals(threadId: string): Promise<any[]>;
  terminate(threadId: string, processId: string): Promise<boolean>;
  answer(id: string | number, result: unknown): void;
  reject(id: string | number): void;
  watch(listener: (event: NativeEvent) => void): () => void;
}

/** Native app-server framing omits jsonrpc. Transport errors never expose native payloads. */
export class NativeProtocol extends EventEmitter {
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve(value: any): void;
      reject(error: unknown): void;
      timer: NodeJS.Timeout;
      method: string;
      threadId?: string;
      unmaterializedHistoryError?: string;
    }
  >();
  connected = false;
  constructor(readonly ws: WebSocket) {
    super();
    ws.on("message", (raw) => {
      let frame: Frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame.method) {
        this.emit("event", {
          method: frame.method,
          params: frame.params ?? {},
          ...(frame.id === undefined ? {} : { id: frame.id }),
        });
        return;
      }
      if (typeof frame.id !== "number") return;
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) {
        const fault =
          frame.error.code === -32600 &&
          pending.unmaterializedHistoryError !== undefined &&
          frame.error.message === pending.unmaterializedHistoryError
            ? new Fault(
                "NATIVE_HISTORY_UNMATERIALIZED",
                "This native session has no first user message yet.",
                422,
              )
            : new Fault("NATIVE_REJECTED", "Codex rejected the operation.", 422);
        fault.native = {
          method: pending.method,
          code: typeof frame.error.code === "number" ? frame.error.code : -32000,
          ...(pending.threadId &&
          frame.error.message === `no rollout found for thread id ${pending.threadId}`
            ? { reason: "missing-rollout" as const }
            : {}),
        };
        pending.reject(fault);
      } else pending.resolve(frame.result);
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      this.connected = false;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          new Fault("NATIVE_UNKNOWN", "The Codex response was lost. Reconcile before retrying."),
        );
      }
      this.pending.clear();
      this.emit("event", { method: "connection/closed", params: {} });
    });
  }
  async initialize(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.close();
        reject(new Fault("BACKEND_UNREACHABLE", "The Codex backend could not be reached.", 503));
      }, 12_000);
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", () => {
        clearTimeout(timer);
        reject(new Fault("BACKEND_UNREACHABLE", "The Codex backend could not be reached.", 503));
      });
    });
    this.connected = true;
    await this.request("initialize", {
      clientInfo: { name: "agentorg-codex", title: "OrgActor-Codex", version: "0.0.2" },
      capabilities: { experimentalApi: true },
    });
    this.ws.send(JSON.stringify({ method: "initialized", params: {} }));
  }
  request(method: string, params: object = {}, timeoutMs = 30_000): Promise<any> {
    if (!this.connected)
      return Promise.reject(
        new Fault("BACKEND_UNREACHABLE", "The Codex connection is unavailable.", 503),
      );
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Fault("NATIVE_UNKNOWN", "The Codex outcome is unknown. Reconcile before retrying."),
        );
      }, timeoutMs);
      const history = params as { threadId?: unknown; includeTurns?: unknown };
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        method,
        ...(typeof history.threadId === "string" ? { threadId: history.threadId } : {}),
        ...(method === "thread/read" &&
        history.includeTurns === true &&
        typeof history.threadId === "string"
          ? {
              unmaterializedHistoryError: `thread ${history.threadId} is not materialized yet; includeTurns is unavailable before first user message`,
            }
          : {}),
      });
      this.ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Fault("NATIVE_UNKNOWN", "The Codex response was lost."));
        }
      });
    });
  }
  answer(id: string | number, result: unknown): void {
    if (!this.connected)
      throw new Fault("BACKEND_UNREACHABLE", "The Codex connection is unavailable.");
    this.ws.send(JSON.stringify({ id, result }));
  }
  watch(listener: (event: NativeEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
  reject(id: string | number): void {
    if (this.connected)
      this.ws.send(
        JSON.stringify({
          id,
          error: {
            code: -32601,
            message: "This request is not supported by the configured Hub approval owner.",
          },
        }),
      );
  }
  close(): void {
    this.ws.close();
  }
}

/**
 * What an Actor's session may do on this Mac, without asking: full access, network included. Codex
 * never prompts, so no turn waits on a person; permission gating comes back through the Hub.
 */
const ACCESS = {
  approvalPolicy: "never",
  sandbox: "danger-full-access",
  sandboxPolicy: { type: "dangerFullAccess" },
} as const;

/** The session's own `org` MCP server: this Actor's bridge. Its Tools are pre-approved. */
const orgServer = (binding: { bridgeUrl: string; bridgeToken: string }) => ({
  url: binding.bridgeUrl,
  http_headers: { Authorization: `Bearer ${binding.bridgeToken}` },
  required: false,
  enabled: true,
  tool_timeout_sec: 660,
  default_tools_approval_mode: "approve",
});

const sessionStart = (
  input: { cwd: string; model?: string; bridgeUrl: string; bridgeToken: string },
  ephemeral: boolean,
) => ({
  cwd: input.cwd,
  ...(input.model ? { model: input.model } : {}),
  approvalPolicy: ACCESS.approvalPolicy,
  sandbox: ACCESS.sandbox,
  ephemeral,
  historyMode: "legacy",
  modelProvider: "openai",
  allowProviderModelFallback: false,
  serviceName: "orgactor-codex",
  config: {
    forced_login_method: "chatgpt",
    "mcp_servers.org": orgServer(input),
  },
});

export class AppServerAdapter implements CodexAdapter {
  private created = new Map<string, { bridgeUrl: string; bridgeToken: string }>();
  constructor(readonly protocol: NativeProtocol) {}
  async create(input: {
    cwd: string;
    model?: string;
    bridgeUrl: string;
    bridgeToken: string;
    name?: string;
  }): Promise<string> {
    const result = await this.protocol.request("thread/start", sessionStart(input, false));
    if (typeof result.thread?.id !== "string")
      throw new Fault("NATIVE_UNKNOWN", "Codex did not return a session identity.");
    const threadId: string = result.thread.id;
    this.created.set(threadId, {
      bridgeUrl: input.bridgeUrl,
      bridgeToken: input.bridgeToken,
    });
    await this.place(threadId, input.cwd, input.name);
    return threadId;
  }
  /**
   * Save a new session and file it under the project holding its folder. Codex saves a session at
   * its first message; naming it saves it at once, so it can be opened and assigned. Neither is
   * needed for the session to work, so a refusal leaves it as it is.
   */
  async place(threadId: string, cwd: string, name?: string): Promise<void> {
    if (name)
      await this.protocol.request("thread/name/set", { threadId, name }).catch(() => undefined);
    const project = await this.fileProject(cwd).catch(() => undefined);
    if (project)
      await this.protocol
        .request("thread/metadata/update", { threadId, projectId: project.id })
        .catch(() => undefined);
  }
  /** The folder's project, created when it has none, so the sessions there are listed under it. */
  async fileProject(cwd: string): Promise<{ id: string; name: string }> {
    const found = await this.projectOf(cwd);
    if (found) return found;
    const { project } = await this.protocol.request("project/create", {
      idempotencyKey: `agentorg:${cwd}`,
      name: basename(cwd),
      roots: [{ path: cwd }],
    });
    return { id: project.id, name: project.name };
  }
  /** The project whose roots include the folder: the Desktop project it is open in. */
  async projectOf(cwd: string): Promise<{ id: string; name: string } | undefined> {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const projects = await this.protocol.request("project/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const found = projects.data?.find((p: any) =>
        p.roots?.some((r: any) => (typeof r === "string" ? r : r.path) === cwd),
      );
      if (found) return { id: found.id, name: found.name };
      cursor = projects.nextCursor ?? undefined;
      if (!cursor) return undefined;
    }
    return undefined;
  }
  /** Start and drop an ephemeral session with an Actor's settings: whether Codex accepts them. */
  async preflight(input: { cwd: string; bridgeUrl: string; bridgeToken: string }): Promise<void> {
    const result = await this.protocol.request("thread/start", sessionStart(input, true));
    if (typeof result.thread?.id === "string")
      await this.protocol
        .request("thread/unsubscribe", { threadId: result.thread.id })
        .catch(() => undefined);
  }
  async resume(
    threadId: string,
    binding?: { bridgeUrl: string; bridgeToken: string; initial?: boolean },
  ): Promise<any> {
    const created = this.created.get(threadId);
    if (binding?.initial && created) {
      if (created.bridgeUrl !== binding.bridgeUrl || created.bridgeToken !== binding.bridgeToken)
        throw new Fault(
          "NATIVE_BINDING_MISMATCH",
          "The native session has a different bridge binding.",
        );
      const read = await this.read(threadId);
      const thread = read.thread;
      if (
        thread?.id !== threadId ||
        thread.historyMode !== "legacy" ||
        thread.status?.type !== "idle" ||
        thread.preview !== "" ||
        !Array.isArray(thread.turns) ||
        thread.turns.length
      )
        throw new Fault(
          "NATIVE_INITIAL_STATE_MISMATCH",
          "The created native session no longer has its initial empty state.",
        );
      return read;
    }
    const resumed = await this.protocol.request("thread/resume", {
      threadId,
      excludeTurns: true,
      modelProvider: "openai",
      ...(binding
        ? {
            config: {
              forced_login_method: "chatgpt",
              "mcp_servers.org": orgServer(binding),
            },
          }
        : {}),
    });
    // A session another connection already loaded keeps its settings through a resume, so the
    // access is applied to the loaded session itself.
    await this.protocol.request("thread/settings/update", {
      threadId,
      approvalPolicy: ACCESS.approvalPolicy,
      sandboxPolicy: ACCESS.sandboxPolicy,
    });
    return resumed;
  }
  async bridgeReady(threadId: string): Promise<boolean> {
    const r = await this.protocol.request("mcpServerStatus/list", {
      threadId,
      serverName: "org",
      detail: "toolsAndAuthOnly",
    });
    const org = r.data?.find((s: any) => s.name === "org");
    return !!org && !org.toolsError && Object.keys(org.tools ?? {}).length > 0;
  }
  async read(threadId: string): Promise<any> {
    try {
      return await this.protocol.request("thread/read", { threadId, includeTurns: true });
    } catch (error) {
      if (!(error instanceof Fault) || error.code !== "NATIVE_HISTORY_UNMATERIALIZED") throw error;
      const metadata = await this.protocol.request("thread/read", {
        threadId,
        includeTurns: false,
      });
      const thread = metadata.thread;
      if (
        thread?.id !== threadId ||
        thread.historyMode !== "legacy" ||
        thread.status?.type !== "idle" ||
        thread.preview !== ""
      )
        throw error;
      return { ...metadata, thread: { ...thread, turns: [] } };
    }
  }
  async start(threadId: string, text: string, inputId: string): Promise<string> {
    this.created.delete(threadId);
    const r = await this.protocol.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      clientUserMessageId: inputId,
    });
    return r.turn.id;
  }
  async steer(threadId: string, turnId: string, text: string, inputId: string): Promise<string> {
    this.created.delete(threadId);
    const r = await this.protocol.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text }],
      clientUserMessageId: inputId,
    });
    return r.turnId;
  }
  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.protocol.request("turn/interrupt", { threadId, turnId });
  }
  async terminals(threadId: string): Promise<any[]> {
    const all: any[] = [];
    let cursor: string | undefined;
    do {
      const p = await this.protocol.request("thread/backgroundTerminals/list", {
        threadId,
        ...(cursor ? { cursor } : {}),
      });
      all.push(...p.data);
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    return all;
  }
  async terminate(threadId: string, processId: string): Promise<boolean> {
    const owned = await this.terminals(threadId);
    if (!owned.some((t) => t.processId === processId))
      throw new Fault(
        "TERMINAL_NOT_FOUND",
        "This session has no matching background terminal.",
        404,
      );
    const r = await this.protocol.request("thread/backgroundTerminals/terminate", {
      threadId,
      processId,
    });
    return r.terminated === true;
  }
  answer(id: string | number, result: unknown): void {
    this.protocol.answer(id, result);
  }
  reject(id: string | number): void {
    this.protocol.reject(id);
  }
  watch(listener: (event: NativeEvent) => void): () => void {
    return this.protocol.watch(listener);
  }
}
/** A shared configured connection; SetupService owns configuration and explicit authentication. */
export class CodexBackend {
  private current?: AppServerAdapter;
  private opening?: Promise<AppServerAdapter>;
  private pending?: NativeProtocol;
  /** Runs before each connect, as starting the app server it connects to. */
  prepare?: () => Promise<void>;
  constructor(private store: Pick<RuntimeStore, "data">) {}
  async get(): Promise<AppServerAdapter> {
    if (this.current?.protocol.connected) return this.current;
    if (this.opening) return this.opening;
    const opening = this.open().finally(() => {
      if (this.opening === opening) this.opening = undefined;
    });
    this.opening = opening;
    return opening;
  }
  private async open(): Promise<AppServerAdapter> {
    const config = this.store.data.settings.backend;
    if (!config) throw new Fault("BACKEND_UNCONFIGURED", "Configure a Codex backend first.", 422);
    await this.prepare?.();
    const protocol = new NativeProtocol(this.transport(config));
    this.pending = protocol;
    try {
      await protocol.initialize();
      if (this.pending !== protocol)
        throw new Fault(
          "BACKEND_UNREACHABLE",
          "The backend configuration changed while connecting.",
          503,
        );
      this.current = new AppServerAdapter(protocol);
      return this.current;
    } catch (error) {
      if (this.pending === protocol) protocol.close();
      throw error;
    } finally {
      if (this.pending === protocol) this.pending = undefined;
    }
  }
  /** A local socket, resolved on each connect so a restarted app server's new path is used. */
  private transport(config: BackendConfig): WebSocket {
    if (config.endpoint.startsWith("unix://"))
      return new WebSocket("ws://codex-app-server/rpc", {
        createConnection: () => connect(realpathSync(decodeURIComponent(config.endpoint.slice(7)))),
        perMessageDeflate: false,
      });
    const url = new URL(config.endpoint);
    if (
      url.username ||
      url.password ||
      (url.protocol === "ws:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
      throw new Fault(
        "INSECURE_BACKEND",
        "Use a local socket, loopback WebSocket, or TLS endpoint.",
        422,
      );
    return new WebSocket(config.endpoint, { perMessageDeflate: false });
  }
  close(): void {
    const pending = this.pending;
    this.pending = undefined;
    this.opening = undefined;
    this.current?.protocol.close();
    this.current = undefined;
    pending?.close();
  }
}
export function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(OPENAI_API_KEY|CODEX_API_KEY|AZURE_OPENAI_API_KEY)$/.test(k),
    ),
  );
}
