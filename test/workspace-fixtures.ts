import { BUILTINS, Form, Message } from "@agentorg/cli/contract";

export const at = "2026-10-30T00:00:00.000Z";
export const message = (n: number, recipientID = "actor", senderID = "manager") =>
  Message.parse({
    messageID: `m${n}`,
    conversationID: `${senderID}:${recipientID}`,
    senderID,
    recipientID,
    text: `task ${n}`,
    createdAt: at,
    seq: n,
  });
export const form = (input: Pick<Form, "title" | "fields">, extra: Partial<Form> = {}): Form =>
  Form.parse({
    formID: "form",
    requesterID: "actor",
    links: [],
    approval: true,
    collect: false,
    createdAt: at,
    status: "open",
    responses: {},
    revision: 1,
    updatedAt: at,
    ...input,
    ...extra,
  });
/** One `attention` read: its items, oldest first, and the position after them. */
export const attention = (
  next: string,
  items: { kind: string; recordID: string; from?: string; title?: string }[] = [],
) =>
  BUILTINS.attention.response.parse({
    items: items.map(({ kind, recordID, from = "manager", title = recordID }) => ({
      kind,
      recordID,
      from: { actorID: from, name: from },
      title,
      at,
    })),
    changed: { actorIDs: [], workIDs: [], formIDs: [] },
    next,
  });
