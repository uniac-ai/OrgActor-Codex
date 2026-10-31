import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type CallToolResult,
  type JSONRPCMessage,
  JSONRPCMessageSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Fault } from "../management/schema.js";
import { catalogOf } from "./catalog.js";
import { HubConnection } from "./connection.js";

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
export class ActorHubSession {
  readonly client = new Client({ name: "orgactor-codex", version: "0.0.1" });
  readonly connection: HubConnection;
  tools: Tool[] = [];
  constructor(url: string) {
    this.connection = new HubConnection(url);
  }
  async open(actorId: string, credential?: string): Promise<void> {
    await this.connection.admit({ actorId, ...(credential === undefined ? {} : { credential }) });
    const client = new Direction(this.connection);
    this.connection.listen((text) => {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return;
      }
      const parsed = JSONRPCMessageSchema.safeParse(value);
      if (!parsed.success) return;
      client.receive(parsed.data);
    });
    this.connection.once("closed", () => {
      void client.close();
    });
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
    await this.client.close();
  }
}
