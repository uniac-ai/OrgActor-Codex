import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Fault } from "../management/schema.js";

const Metadata = z.strictObject({
  id: z.string().trim().min(1).max(64),
  name: z.string().min(1),
  interface: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  one_way: z.boolean(),
  long_running: z.boolean(),
});

/** Validated Tool/local-interface aliases; the MCP schemas pass through unchanged. */
export function catalogOf(tools: Tool[]) {
  const catalog = new Map<string, { name: string; interfaces: Map<string, string> }>();
  const aliases = new Set<string>();
  for (const tool of tools) {
    const parsed = Metadata.safeParse(tool._meta?.["agentorg/tool"]);
    if (!parsed.success)
      throw new Fault("HUB_CATALOG_INVALID", "The Hub returned invalid Tool metadata.", 502);
    const meta = parsed.data;
    const group = catalog.get(meta.id) ?? {
      name: meta.name,
      interfaces: new Map<string, string>(),
    };
    if (group.name !== meta.name || aliases.has(tool.name) || group.interfaces.has(meta.interface))
      throw new Fault("HUB_CATALOG_INVALID", "The Hub returned inconsistent Tool metadata.", 502);
    group.interfaces.set(meta.interface, tool.name);
    aliases.add(tool.name);
    catalog.set(meta.id, group);
  }
  return catalog;
}
