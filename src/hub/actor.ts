import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  type JSONRPCMessage,
  JSONRPCMessageSchema,
  ListToolsRequestSchema,
  type Task,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Fault } from "../management/schema.js";
import { catalogOf } from "./catalog.js";
import { HubConnection } from "./connection.js";

export interface Incoming {
  id: string;
  from: string;
  cause: string | null;
  signal: AbortSignal;
}
export interface Exposure {
  tool: Tool;
  handle(input: Record<string, unknown>, call: Incoming): Promise<Record<string, unknown>>;
}
class Direction implements Transport {
  onclose?: () => void;
  onerror?: (e: Error) => void;
  onmessage?: (m: JSONRPCMessage) => void;
  private pending: JSONRPCMessage[] | undefined = [];
  constructor(private connection: HubConnection) {}
  async start(): Promise<void> {
    const pending = this.pending ?? [];
    this.pending = undefined;
    for (const m of pending) this.onmessage?.(m);
  }
  receive(message: JSONRPCMessage): void {
    if (this.pending) this.pending.push(message);
    else this.onmessage?.(message);
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.connection.send(message);
  }
  async close(): Promise<void> {
    this.onclose?.();
  }
}
class Tasks extends InMemoryTaskStore {
  controllers = new Map<string, AbortController>();
  override async updateTaskStatus(
    id: string,
    status: Task["status"],
    message?: string,
    sessionId?: string,
  ): Promise<void> {
    await super.updateTaskStatus(id, status, message, sessionId);
    if (status === "cancelled") this.controllers.get(id)?.abort();
  }
}
export class ActorHubSession {
  readonly client = new Client({ name: "orgactor-codex", version: "0.0.1" });
  readonly server: Server;
  readonly connection: HubConnection;
  tools: Tool[] = [];
  constructor(
    url: string,
    private exposure: Exposure[],
  ) {
    this.connection = new HubConnection(url);
    const tasks = new Tasks();
    this.server = new Server(
      { name: "orgactor-codex", version: "0.0.1" },
      {
        capabilities: {
          tools: { listChanged: true },
          tasks: { requests: { tools: { call: {} } }, cancel: {} },
        },
        taskStore: tasks,
      },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: exposure.map((e) => e.tool),
    }));
    this.server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      const entry = this.exposure.find((e) => e.tool.name === params.name);
      if (!entry) throw new Fault("INTERFACE_NOT_FOUND", "The interface is not advertised.");
      const meta = params._meta?.["agentorg/call"] as
        | { id?: string; from?: string; cause?: string | null }
        | undefined;
      if (
        !meta ||
        typeof meta.id !== "string" ||
        !meta.id ||
        typeof meta.from !== "string" ||
        !meta.from
      )
        throw new Fault(
          "CALL_PROVENANCE_REQUIRED",
          "The Hub must supply authenticated call provenance.",
        );
      const run = async (signal: AbortSignal): Promise<CallToolResult> => {
        try {
          const value = await entry.handle(params.arguments ?? {}, {
            id: meta.id as string,
            from: meta.from as string,
            cause: meta.cause ?? null,
            signal,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
          };
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text:
                  e instanceof Fault
                    ? `${e.code}: ${e.message}`
                    : "EXECUTION_FAILED: The execution could not complete.",
              },
            ],
            isError: true,
          };
        }
      };
      if (!params.task || !extra.taskStore) return run(extra.signal);
      const task = await extra.taskStore.createTask({ pollInterval: 500 });
      const controller = new AbortController();
      tasks.controllers.set(task.taskId, controller);
      void run(controller.signal)
        .then(async (result) => {
          tasks.controllers.delete(task.taskId);
          if (!controller.signal.aborted)
            await extra.taskStore?.storeTaskResult(
              task.taskId,
              result.isError ? "failed" : "completed",
              result,
            );
        })
        .catch(() => {});
      return { task };
    });
  }
  async open(actorId: string, credential?: string): Promise<void> {
    await this.connection.admit({ actorId, ...(credential === undefined ? {} : { credential }) });
    const client = new Direction(this.connection);
    const server = new Direction(this.connection);
    this.connection.listen((text) => {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return;
      }
      const parsed = JSONRPCMessageSchema.safeParse(value);
      if (!parsed.success) return;
      const m = parsed.data;
      if (!("method" in m)) client.receive(m);
      else if (
        "id" in m ||
        m.method === "notifications/initialized" ||
        m.method === "notifications/cancelled"
      )
        server.receive(m);
      else client.receive(m);
    });
    this.connection.once("closed", () => {
      void client.close();
      void server.close();
    });
    await this.server.connect(server);
    await this.client.connect(client);
    await this.refreshTools();
  }
  async refreshTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    catalogOf(tools);
    this.tools = tools;
    return tools;
  }
  async call(
    name: string,
    input: Record<string, unknown>,
    cause?: string | null,
    timeout = 60_000,
  ): Promise<CallToolResult> {
    return this.client.callTool(
      { name, arguments: input, ...(cause ? { _meta: { "agentorg/cause": cause } } : {}) },
      undefined,
      { timeout },
    ) as Promise<CallToolResult>;
  }
  alias(toolId: string, name: string): string {
    const group = catalogOf(this.tools).find((t) => t.id === toolId);
    const alias = group?.interfaces.find((i) => i.interface.name === name)?.call;
    if (!alias)
      throw new Fault(
        "HUB_INTERFACE_UNAVAILABLE",
        "The required Hub interface is not available to this Actor.",
      );
    return alias;
  }
  async close(): Promise<void> {
    this.connection.close();
    await Promise.allSettled([this.client.close(), this.server.close()]);
  }
}
