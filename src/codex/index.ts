import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { Duplex } from "node:stream";
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
  }): Promise<string>;
  resume(threadId: string, binding?: { bridgeUrl: string; bridgeToken: string }): Promise<any>;
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
      unmaterializedHistoryError?: string;
    }
  >();
  connected = false;
  constructor(
    readonly ws: WebSocket,
    readonly process?: ChildProcessWithoutNullStreams,
  ) {
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
      if (frame.error)
        pending.reject(
          frame.error.code === -32600 &&
            pending.unmaterializedHistoryError !== undefined &&
            frame.error.message === pending.unmaterializedHistoryError
            ? new Fault(
                "NATIVE_HISTORY_UNMATERIALIZED",
                "This native session has no first user message yet.",
                422,
              )
            : new Fault("NATIVE_REJECTED", "Codex rejected the operation.", 422),
        );
      else pending.resolve(frame.result);
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
      clientInfo: { name: "agentorg-codex", title: "OrgActor-Codex", version: "0.0.1" },
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
    this.process?.kill("SIGTERM");
  }
}

export class AppServerAdapter implements CodexAdapter {
  constructor(readonly protocol: NativeProtocol) {}
  async create(input: {
    cwd: string;
    model?: string;
    bridgeUrl: string;
    bridgeToken: string;
  }): Promise<string> {
    const result = await this.protocol.request("thread/start", {
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      approvalPolicy: "on-request",
      sandbox: "read-only",
      ephemeral: false,
      historyMode: "legacy",
      modelProvider: "openai",
      allowProviderModelFallback: false,
      serviceName: "orgactor-codex",
      config: {
        forced_login_method: "chatgpt",
        "mcp_servers.org": {
          url: input.bridgeUrl,
          http_headers: { Authorization: `Bearer ${input.bridgeToken}` },
          required: false,
          enabled: true,
          tool_timeout_sec: 660,
        },
      },
    });
    if (typeof result.thread?.id !== "string")
      throw new Fault("NATIVE_UNKNOWN", "Codex did not return a session identity.");
    return result.thread.id;
  }
  resume(threadId: string, binding?: { bridgeUrl: string; bridgeToken: string }): Promise<any> {
    return this.protocol.request("thread/resume", {
      threadId,
      excludeTurns: true,
      modelProvider: "openai",
      ...(binding
        ? {
            config: {
              forced_login_method: "chatgpt",
              "mcp_servers.org": {
                url: binding.bridgeUrl,
                http_headers: { Authorization: `Bearer ${binding.bridgeToken}` },
                required: false,
                enabled: true,
                tool_timeout_sec: 660,
              },
            },
          }
        : {}),
    });
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
    const r = await this.protocol.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      clientUserMessageId: inputId,
    });
    return r.turn.id;
  }
  async steer(threadId: string, turnId: string, text: string, inputId: string): Promise<string> {
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
export class SshAdapter extends AppServerAdapter {}

/** A shared configured connection; SetupService owns configuration and explicit authentication. */
export class CodexBackend {
  private current?: AppServerAdapter;
  private opening?: Promise<AppServerAdapter>;
  private pending?: NativeProtocol;
  constructor(private store: RuntimeStore) {}
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
    const { ws, process: child } = this.transport(config);
    const protocol = new NativeProtocol(ws, child);
    this.pending = protocol;
    try {
      await protocol.initialize();
      if (this.pending !== protocol)
        throw new Fault(
          "BACKEND_UNREACHABLE",
          "The backend configuration changed while connecting.",
          503,
        );
      this.current =
        config.kind === "ssh" ? new SshAdapter(protocol) : new AppServerAdapter(protocol);
      return this.current;
    } catch (error) {
      if (this.pending === protocol) protocol.close();
      throw error;
    } finally {
      if (this.pending === protocol) this.pending = undefined;
    }
  }
  private transport(config: BackendConfig): {
    ws: WebSocket;
    process?: ChildProcessWithoutNullStreams;
  } {
    if (config.kind === "ssh") {
      if (!config.privateKey || !config.knownHosts)
        throw new Fault(
          "SSH_UNCONFIGURED",
          "Add an SSH private key and verified known-host entry.",
          422,
        );
      const key = this.store.privateFile("ssh-key", config.privateKey);
      const hosts = this.store.privateFile("known-hosts", config.knownHosts);
      const child = spawn(
        "ssh",
        [
          "-T",
          "-F",
          "/dev/null",
          "-oBatchMode=yes",
          "-oStrictHostKeyChecking=yes",
          "-oIdentitiesOnly=yes",
          "-oConnectTimeout=10",
          `-oUserKnownHostsFile=${hosts}`,
          "-i",
          key,
          "-p",
          String(config.port),
          `${config.user}@${config.host}`,
          "exec codex app-server proxy",
        ],
        { stdio: ["pipe", "pipe", "pipe"], env: cleanEnvironment() },
      );
      child.stderr.on("data", () => {});
      child.on("error", () => {});
      const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
      return {
        ws: new WebSocket("ws://codex-app-server/rpc", {
          createConnection: () => stream,
          perMessageDeflate: false,
        }),
        process: child,
      };
    }
    if (config.endpoint.startsWith("unix://"))
      return {
        ws: new WebSocket("ws://codex-app-server/rpc", {
          createConnection: () =>
            connect(realpathSync(decodeURIComponent(config.endpoint.slice(7)))),
          perMessageDeflate: false,
        }),
      };
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
    return { ws: new WebSocket(config.endpoint, { perMessageDeflate: false }) };
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
