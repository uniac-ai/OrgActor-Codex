/**
 * The answer that declines a native request, or nothing for a kind Codex doesn't define. Codex asks
 * nothing under the `never` policy; whatever it still sends is declined at once, so no turn waits.
 */
export function declined(method: string, params: any): object | undefined {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return {
        answers: Object.fromEntries(
          (params.questions ?? []).map((q: any) => [q.id, { answers: [] }]),
        ),
      };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
  }
  return undefined;
}
