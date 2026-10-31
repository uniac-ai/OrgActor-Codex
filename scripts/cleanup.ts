export interface CleanupApi {
  loaded(): Promise<string[]>;
  read(threadId: string): Promise<any>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  terminals(threadId: string): Promise<{ processId: string }[]>;
  terminate(threadId: string, processId: string): Promise<unknown>;
  archive(threadId: string): Promise<unknown>;
}
/** Cleanup continues across independent owned sessions and reports every unresolved operation. */
export async function cleanupOwned(
  api: CleanupApi,
  owned: Iterable<string>,
  options: { retained?: string; archived?: Set<string> } = {},
) {
  const ids = [...owned];
  const unresolved: { threadId: string; operation: string }[] = [];
  const retained: string[] = [];
  for (const threadId of ids) {
    if (options.archived?.has(threadId)) continue;
    let operation = "read";
    try {
      const read = await api.read(threadId);
      const active = read.thread.turns?.find((t: any) => t.status === "inProgress");
      if (active) {
        operation = "interrupt";
        await api.interrupt(threadId, active.id);
        const deadline = Date.now() + 15_000;
        while (
          (await api.read(threadId)).thread.turns?.find((t: any) => t.id === active.id)?.status ===
          "inProgress"
        ) {
          if (Date.now() >= deadline) throw new Error("Owned turn did not stop");
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      operation = "terminals";
      for (const terminal of await api.terminals(threadId)) {
        operation = "terminate";
        await api.terminate(threadId, terminal.processId);
      }
      operation = "terminal-readback";
      if ((await api.terminals(threadId)).length) throw new Error("Owned terminal still running");
      if (threadId === options.retained) retained.push(threadId);
      else {
        operation = "archive";
        await api.archive(threadId);
      }
    } catch {
      unresolved.push({ threadId, operation });
    }
  }
  let loadedThreadIds: string[] = [];
  try {
    loadedThreadIds = await api.loaded();
    for (const threadId of loadedThreadIds.filter(
      (id) => ids.includes(id) && !retained.includes(id),
    ))
      if (!unresolved.some((u) => u.threadId === threadId))
        unresolved.push({ threadId, operation: "archive-readback" });
  } catch {
    for (const threadId of ids)
      if (!unresolved.some((u) => u.threadId === threadId))
        unresolved.push({ threadId, operation: "inventory-readback" });
  }
  return { success: unresolved.length === 0, unresolved, retained, loadedThreadIds };
}
