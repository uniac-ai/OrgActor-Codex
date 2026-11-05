import type { CodexAdapter } from "../codex/index.js";
import { Fault } from "../management/schema.js";
import type { Bootstrap, RuntimeStore } from "../runtime/index.js";
import { ActorController } from "./controller.js";

/**
 * An Actor whose native requests Codex Desktop answers waits, not admitted to the Hub, until the
 * operator confirms Desktop for the current setup revision.
 */
export function waitsForDesktop(bootstrap: Bootstrap, data: RuntimeStore["data"]): boolean {
  const desktop = data.probes.desktop;
  return (
    bootstrap.config.approvalAuthority === "desktop" &&
    !(desktop?.state === "ready" && desktop.revision === data.revision)
  );
}

export class ActorSupervisor {
  readonly actors = new Map<string, ActorController>();
  private retry = new Map<string, NodeJS.Timeout>();
  private closed = false;
  constructor(
    private store: RuntimeStore,
    private adapter: () => Promise<CodexAdapter>,
  ) {}
  /** Launch each enabled Actor setup allows, and stop those it no longer does. */
  recover(): void {
    for (const actor of Object.values(this.store.data.actors))
      if (actor.enabled && actor.threadId && !actor.suspended) this.launch(actor.actorId);
  }
  launch(id: string): void {
    if (this.closed) return;
    const bootstrap = this.store.data.actors[id];
    if (!bootstrap?.enabled || bootstrap.suspended) return;
    // Admitted only to create its native session, it leaves the Hub until Desktop is confirmed.
    if (bootstrap.threadId && waitsForDesktop(bootstrap, this.store.data)) {
      const running = this.actors.get(id);
      this.actors.delete(id);
      void running?.close();
      return;
    }
    let actor = this.actors.get(id);
    if (!actor) {
      actor = new ActorController(bootstrap, this.store, this.adapter);
      this.actors.set(id, actor);
      const created = actor;
      actor.on("disconnected", () => this.reconnect(created));
    }
    const current = actor;
    void current.open().catch((error) => {
      if (this.closed || !bootstrap.enabled) return;
      bootstrap.startupFailure ??= {
        phase: current.startupPhase,
        code: error instanceof Fault ? error.code : "STARTUP_FAILED",
        ...(error instanceof Fault && error.native ? { native: error.native } : {}),
        ...(current.hub?.connection.closeCode === undefined
          ? {}
          : { closeCode: current.hub.connection.closeCode }),
      };
      if (error instanceof Fault && error.code === "HUB_REJECTED")
        bootstrap.suspended = "admission-rejected";
      this.store.save();
      current.lastError = "The Actor could not connect. Check backend and Hub readiness.";
      this.reconnect(current);
    });
  }
  private reconnect(actor: ActorController): void {
    const bootstrap = actor.bootstrap;
    const id = bootstrap.actorId;
    if (this.actors.get(id) !== actor) return;
    const code = actor.hub?.connection.closeCode;
    if (code === 4000 || code === 4001) {
      bootstrap.suspended = code;
      this.store.save();
    }
    this.actors.delete(id);
    void actor.close();
    if (!this.closed && bootstrap.enabled && !bootstrap.suspended) {
      const timer = setTimeout(() => {
        this.retry.delete(id);
        this.launch(id);
      }, 1500);
      timer.unref();
      this.retry.set(id, timer);
    }
  }
  get(id: string): ActorController {
    const actor = this.actors.get(id);
    if (!actor) throw new Fault("ACTOR_OFFLINE", "This Actor executor is not connected.", 503);
    return actor;
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (!Object.hasOwn(this.store.data.actors, id))
      throw new Fault("ACTOR_NOT_FOUND", "This Actor is not attached.", 404);
    const bootstrap = this.store.data.actors[id];
    bootstrap.enabled = enabled;
    if (enabled) delete bootstrap.suspended;
    this.store.save();
    const timer = this.retry.get(id);
    if (timer) clearTimeout(timer);
    this.retry.delete(id);
    if (enabled) this.launch(id);
    else {
      const actor = this.actors.get(id);
      this.actors.delete(id);
      await actor?.close();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.retry.values()) clearTimeout(timer);
    this.retry.clear();
    await Promise.allSettled([...this.actors.values()].map((a) => a.close()));
    this.actors.clear();
  }
}
