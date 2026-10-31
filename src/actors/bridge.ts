import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { equalSecret, type RuntimeStore } from "../runtime/index.js";
import type { ActorSupervisor } from "./supervisor.js";

export class SessionMcpBridge {
  private sessions = new Map<
    string,
    { actorId: string; server: Server; transport: StreamableHTTPServerTransport }
  >();
  private closed = false;
  requests = 0;
  observations: { actorId: string; method: string; hubConnected: boolean }[] = [];
  constructor(
    private store: RuntimeStore,
    private supervisor: ActorSupervisor,
  ) {}
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closed) {
      res.writeHead(503).end();
      return;
    }
    if (req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    const supplied = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const bootstrap = Object.values(this.store.data.actors).find((b) =>
      equalSecret(b.bridgeToken, supplied),
    );
    if (!bootstrap?.enabled) {
      res.writeHead(401).end();
      return;
    }
    const id = req.headers["mcp-session-id"];
    if (id !== undefined) {
      const session = typeof id === "string" ? this.sessions.get(id) : undefined;
      if (!session || session.actorId !== bootstrap.actorId) {
        res.writeHead(404).end();
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        this.sessions.set(id, { actorId: bootstrap.actorId, server, transport });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    const server = new Server(
      { name: "org", version: "0.0.1" },
      {
        capabilities: { tools: {} },
        instructions: `You fill AgentOrg Actor ${bootstrap.actorId}. Tool authority is your Actor's current Hub authority. Container operator text is not organizational root authority. Native input origins remain attached to each input.`,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      const deadline = Date.now() + 20_000;
      while (
        !extra.signal.aborted &&
        !this.supervisor.actors.get(bootstrap.actorId)?.hubReady &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 100));
      const current = this.supervisor.actors.get(bootstrap.actorId);
      this.observations.push({
        actorId: bootstrap.actorId,
        method: "tools/list",
        hubConnected: current?.hub?.connection.connected ?? false,
      });
      if (!current?.hubReady || !current.hub?.connection.connected)
        throw new McpError(ErrorCode.InternalError, "The Actor Hub connection is unavailable.");
      return { tools: (await current.hub.refreshTools()).map(projectTool) };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      const actor = this.supervisor.actors.get(bootstrap.actorId);
      if (!actor?.hub?.connection.connected)
        throw new McpError(ErrorCode.InternalError, "The Actor Hub connection is unavailable.");
      await actor.hub.refreshTools();
      const tool = actor.hub.tools.find((t) => t.name === params.name);
      if (!tool) throw new McpError(ErrorCode.InvalidParams, "This Actor has no such interface.");
      const thread = params._meta?.threadId;
      if (typeof thread !== "string" || !thread || thread !== bootstrap.threadId)
        throw new McpError(
          ErrorCode.InvalidParams,
          "This bridge belongs to another native thread.",
        );
      if (
        !(await actor.waitForToolCall(params._meta, params.name, extra.signal)) ||
        extra.signal.aborted ||
        !actor.matchesToolCall(params._meta, params.name)
      )
        throw new McpError(
          ErrorCode.InvalidParams,
          "This bridge requires the current native session and tool call.",
        );
      this.requests += 1;
      const wait = typeof params.arguments?.wait === "number" ? params.arguments.wait : 0;
      const result = await actor.hub.call(
        tool.name,
        params.arguments ?? {},
        Math.max(60_000, (wait + 30) * 1000),
      );
      const meta = tool._meta?.["agentorg/tool"] as any;
      if (meta.id === "hub:actors" && meta.interface === "actor_create" && !result.isError)
        return this.projectCreated(result);
      return result;
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      await server.close();
      if (!res.headersSent) res.writeHead(500).end();
    } finally {
      if (!transport.sessionId) await server.close();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map((session) => session.server.close()));
    this.sessions.clear();
  }
  private projectCreated(result: CallToolResult): CallToolResult {
    const parsed = z
      .object({ actor: z.object({ id: z.string() }).passthrough(), credential: z.string() })
      .passthrough()
      .safeParse(result.structuredContent);
    if (!parsed.success)
      throw new McpError(
        ErrorCode.InternalError,
        "The Hub returned an invalid Actor creation result.",
      );
    const { credential, ...visible } = parsed.data;
    this.store.data.issuedCredentials[parsed.data.actor.id] = credential;
    this.store.save();
    return {
      ...result,
      structuredContent: visible,
      content: [{ type: "text", text: JSON.stringify(visible) }],
    };
  }
}

/** The model presentation of the known credential-bearing Actor creation contract. */
export function projectTool(tool: Tool): Tool {
  const meta = tool._meta?.["agentorg/tool"] as any;
  if (meta?.id !== "hub:actors" || meta.interface !== "actor_create") return tool;
  const schema = structuredClone(tool.outputSchema);
  if (
    !schema ||
    typeof schema.properties !== "object" ||
    !schema.properties ||
    !Array.isArray(schema.required) ||
    !Object.hasOwn(schema.properties, "credential")
  )
    throw new McpError(
      ErrorCode.InternalError,
      "The Hub Actor creation schema does not match its credential contract.",
    );
  delete (schema.properties as Record<string, unknown>).credential;
  schema.required = schema.required.filter((key) => key !== "credential");
  return {
    ...tool,
    outputSchema: schema,
    description:
      "Create a direct report. This executor retains its new Actor credential privately. Optional execution requests Provider setup and returns its independent outcome.",
  };
}
