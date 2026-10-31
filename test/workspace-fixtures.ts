import { Actor, Form, Message } from "@agentorg/cli/contract";

export const at = "2026-10-30T00:00:00.000Z";
export const position = (id = "actor", manager: string | null = "manager") =>
  Actor.parse({
    id,
    manager,
    name: id,
    path: id,
    purpose: "Owned fixture",
    online: true,
    created_at: at,
    closed_at: null,
  });
export const team = () => ({ root: "root", positions: [position()] });
export const message = (n: number, recipientID = "actor") =>
  Message.parse({
    messageID: `m${n}`,
    senderID: "manager",
    recipientID,
    text: `task ${n}`,
    createdAt: at,
    cursor: n,
    revision: 1,
    history: [],
  });
export const form = (
  input: Pick<Form, "fields" | "respondentIDs">,
  extra: Partial<Form> = {},
): Form =>
  Form.parse({
    formID: "form",
    requesterID: "actor",
    createdAt: at,
    status: "open",
    responses: {},
    cursor: 1,
    revision: 1,
    history: [],
    ...input,
    ...extra,
  });
