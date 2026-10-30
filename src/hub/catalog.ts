import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Fault } from "../management/schema.js";

const Metadata = z.strictObject({
  id: z.string().trim().min(1).max(64),
  name: z.string().min(1),
  interface: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  routed: z.boolean(),
  one_way: z.boolean(),
  long_running: z.boolean(),
});
export interface SemanticTool {
  id: string;
  name: string;
  interfaces: {
    call: string;
    interface: {
      name: string;
      input: Tool["inputSchema"];
      output?: Tool["outputSchema"];
      one_way: boolean;
      long_running: boolean;
    };
    routed: boolean;
  }[];
}
export function catalogOf(tools: Tool[]): SemanticTool[] {
  const catalog = new Map<string, SemanticTool>();
  const aliases = new Set<string>();
  for (const tool of tools) {
    const parsed = Metadata.safeParse(tool._meta?.["agentorg/tool"]);
    if (!parsed.success)
      throw new Fault("HUB_CATALOG_INVALID", "The Hub returned invalid Tool metadata.", 502);
    const meta = parsed.data;
    const group = catalog.get(meta.id) ?? { id: meta.id, name: meta.name, interfaces: [] };
    if (
      group.name !== meta.name ||
      aliases.has(tool.name) ||
      group.interfaces.some((i) => i.interface.name === meta.interface)
    )
      throw new Fault("HUB_CATALOG_INVALID", "The Hub returned inconsistent Tool metadata.", 502);
    group.interfaces.push({
      call: tool.name,
      interface: {
        name: meta.interface,
        input: tool.inputSchema,
        ...(tool.outputSchema ? { output: tool.outputSchema } : {}),
        one_way: meta.one_way,
        long_running: meta.long_running,
      },
      routed: meta.routed,
    });
    aliases.add(tool.name);
    catalog.set(meta.id, group);
  }
  return [...catalog.values()];
}
