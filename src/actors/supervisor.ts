import type { CodexAdapter } from "../codex/index.js";
import { Fault } from "../management/schema.js";
import type { RuntimeStore } from "../runtime/index.js";
import { ActorController } from "./controller.js";

export class ActorSupervisor {
  readonly actors = new Map<string, ActorController>();
  private retry = new Map<string, NodeJS.Timeout>();
  private closed = false;
  constructor(
    private store: RuntimeStore,
    private adapter: () => Promise<CodexAdapter>,
  ) {}
  recover(): void {
    for (const actor of Object.values(this.store.data.actors))
      if (actor.enabled && actor.threadId && !actor.suspended) this.launch(actor.actorId);
  }
  launch(id: string): void {
    if (this.closed || this.actors.has(id)) return;
    const bootstrap = this.store.data.actors[id];
    if (!bootstrap?.enabled || !bootstrap.threadId || bootstrap.suspended) return;
    const actor = new ActorController(bootstrap, this.store, this.adapter);
    this.actors.set(id, actor);
    const reconnect = () => {
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
    };
    actor.on("disconnected", reconnect);
    void actor.open().catch((error) => {
      if (error instanceof Fault && error.code === "HUB_REJECTED") {
        bootstrap.suspended = "admission-rejected";
        this.store.save();
      }
      actor.lastError = "The Actor could not connect. Check backend and Hub readiness.";
      reconnect();
    });
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
