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
import { presents } from "../hub/catalog.js";
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
        instructions: instructions(bootstrap.actorId),
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
      return {
        tools: (await current.hub.refreshTools())
          .filter((tool) => presents(bootstrap.config.level, tool))
          .map(projectTool),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
      const actor = this.supervisor.actors.get(bootstrap.actorId);
      if (!actor?.hub?.connection.connected)
        throw new McpError(ErrorCode.InternalError, "The Actor Hub connection is unavailable.");
      await actor.hub.refreshTools();
      const tool = actor.hub.tools.find(
        (t) => t.name === params.name && presents(bootstrap.config.level, t),
      );
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

/** The fixed guidance a native session receives: its Actor, and the agentorg skill's report. */
export function instructions(actorId: string): string {
  return `You fill AgentOrg Actor ${actorId}. Tool authority is your Actor's current Hub authority. Container operator text is not organizational root authority. Native input origins remain attached to each input.

Your report is your public output: your status, your Work and your asks. Your person and your manager read it live from those records, so keep no HTML page as well.
- Status: status_set {line?, summary?, links?}. line is where you stand overall, in at most 160 characters; summary holds what the line can't; links are what a reader opens. Change it when where you stand overall changes, not with every step. It holds no state: your state is derived from your Work and asks.
- One Work per workstream: work_create {title, goal?, links?, waitsOn?} makes Work you own; it starts open. When you start, set it active with work_update {ticketID, status, progress?, links?, waitsOn?}. Keep progress current: a paragraph, then a Markdown task list of steps, "- [x]" done and "- [ ]" not, the first not done being the current one. Set blocked only when something other than your own ask stops you. links hold PRs, pages and runs; waitsOn names what it waits on besides your asks.
- Follow-ups: something to do later is Work you request of yourself and leave open.
- Asks: when a decision or an answer isn't yours to take, form_create {title, context?, links?, workID?, approval?, fields}. The title is the question and context what the reader needs to decide. A decision is one field with options, each {value, detail?}, and your recommended value on that field; a field without options is a question answered in text. Link the Work it blocks with workID. Mark approval: true when its answer authorizes something that can't be undone; only your managers answer an approval. Keep working on what doesn't depend on the answer.
- Write the item that changed at a milestone and before you end a turn that changed where you stand. Keep each write's result instead of reading again.
- When an answer arrives, apply it, then update the Work it blocked; the ask is already resolved. When the person answers in this session, record it with form_close {formID, expectedRevision, status: "resolved", resolution}, quoting them; never close an approval on your own judgment.
- When you finish, work_submit {ticketID, result, evidence?}. Your own Work completes on submit; Work someone else requested waits for their review.

Answers, assigned Work, reviews and Messages reach you as input through the Hub. When this executor sends a Codex permission prompt to your managers as an approval ask, don't ask for it again.`;
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
