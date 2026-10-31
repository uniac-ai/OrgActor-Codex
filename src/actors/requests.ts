import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { z } from "zod";
import { Fault } from "../management/schema.js";

export const supportedRequests = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);
export function requestedPermissions(params: any): object {
  return {
    ...(params.permissions?.network ? { network: params.permissions.network } : {}),
    ...(params.permissions?.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}),
  };
}
export function requestReview(method: string, params: any): string {
  const reason = typeof params.reason === "string" ? `\nReason: ${params.reason}` : "";
  if (method === "item/permissions/requestApproval")
    return `Codex requests permissions for this turn.\nRequested scope: ${JSON.stringify(requestedPermissions(params))}${reason}`;
  if (method === "item/commandExecution/requestApproval")
    return `Codex requests command approval.\nCommand: ${typeof params.command === "string" ? params.command : "See the native item"}${reason}`;
  if (method === "item/fileChange/requestApproval")
    return `Codex requests file-change approval.\nGrant root: ${params.grantRoot ?? "the current workspace"}${reason}`;
  return params.message ?? "Codex requests input.";
}
/** The designated Hub answer can grant only the native request's own requested permissions. */
export function responseFor(method: string, params: any, choice: string, content: unknown): object {
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method))
    return { decision: z.enum(["accept", "decline", "cancel"]).parse(choice) };
  if (method === "item/permissions/requestApproval")
    return {
      permissions: choice === "accept" ? requestedPermissions(params) : {},
      scope: "turn",
    };
  if (method === "item/tool/requestUserInput") {
    if (choice !== "accept")
      return {
        answers: Object.fromEntries(
          (params.questions ?? []).map((q: any) => [q.id, { answers: [] }]),
        ),
      };
    const response = z
      .strictObject({
        answers: z.record(z.string(), z.strictObject({ answers: z.array(z.string()) })),
      })
      .parse(content);
    const ids = (params.questions ?? []).map((q: any) => q.id);
    if (
      Object.keys(response.answers).some((id) => !ids.includes(id)) ||
      ids.some((id: string) => !Object.hasOwn(response.answers, id))
    )
      throw new Fault("ANSWER_INVALID", "Answer exactly the native questions.");
    return response;
  }
  if (method === "mcpServer/elicitation/request") {
    if (choice !== "accept")
      return { action: choice === "decline" ? "decline" : "cancel", content: null, _meta: null };
    if (params.mode === "url") return { action: "accept", content: null, _meta: null };
    if (
      params.requestedSchema &&
      !new AjvJsonSchemaValidator().getValidator(params.requestedSchema)(content).valid
    )
      throw new Fault("ANSWER_INVALID", "The answer does not match the native form schema.");
    return { action: "accept", content, _meta: null };
  }
  throw new Fault("REQUEST_UNSUPPORTED", "This native request is not supported.");
}
