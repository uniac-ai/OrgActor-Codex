import { z } from "zod";
import type { CodexAdapter } from "../codex/index.js";
import { HubConnection } from "../hub/connection.js";
import { Attach, ExecutionConfig, Fault, safeError } from "../management/schema.js";
import { hash, type RuntimeStore, token } from "../runtime/index.js";

const Creation = Attach;
export class CodexProvider {
  connection?: HubConnection;
  error?: string;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private opening?: Promise<void>;
  private creating = new Map<string, Promise<{ actorId: string }>>();
  constructor(
    private store: RuntimeStore,
    private adapter: () => Promise<CodexAdapter>,
    private launch: (id: string) => void,
    private stop: (id: string) => Promise<void>,
  ) {}
  snapshot() {
    return {
      enabled: this.store.data.providerEnabled,
      connected: this.connection?.connected ?? false,
      state: !this.store.data.settings.hub
        ? ("unconfigured" as const)
        : this.store.data.providerSuspended === "admission-rejected"
          ? ("rejected" as const)
          : this.store.data.providerSuspended
            ? ("suspended" as const)
            : this.connection?.connected
              ? ("connected" as const)
              : this.store.data.providerEnabled
                ? this.error
                  ? ("unreachable" as const)
                  : ("connecting" as const)
                : ("paused" as const),
      ...(this.error ? { error: this.error } : {}),
    };
  }
  start(probe = false): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.connect(probe).finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }
  private async connect(probe: boolean): Promise<void> {
    if (
      this.closed ||
      (!probe && !this.store.data.providerEnabled) ||
      this.store.data.providerSuspended ||
      this.connection?.connected
    )
      return;
    const hub = this.store.data.settings.hub;
    if (!hub) return;
    const connection = new HubConnection(hub.url);
    this.connection = connection;
    connection.once("closed", () => this.schedule(connection.closeCode));
    try {
      await connection.admit({
        providerId: hub.providerId,
        ...(hub.credential === undefined ? {} : { credential: hub.credential }),
      });
      this.error = undefined;
      connection.listen((text) => {
        let m: any;
        try {
          m = JSON.parse(text);
        } catch {
          return;
        }
        if (m.jsonrpc !== "2.0" || m.id === undefined || !m.method) return;
        const work = async () => {
          if (m.method === "provider.describe") {
            z.strictObject({}).parse(m.params);
            return { configSchema: z.toJSONSchema(ExecutionConfig, { io: "input" }) };
          }
          if (m.method === "provider.createActor") {
            if (!this.store.data.providerEnabled)
              throw new Fault("unavailable", "This Provider is paused.");
            return this.create(m.params);
          }
          throw new Fault("METHOD_NOT_FOUND", "This Provider does not implement that method.");
        };
        void work().then(
          (result) => {
            if (connection.connected) connection.send({ jsonrpc: "2.0", id: m.id, result });
          },
          (e) => {
            if (connection.connected)
              connection.send({
                jsonrpc: "2.0",
                id: m.id,
                error: {
                  code: e instanceof z.ZodError ? -32602 : -32000,
                  message: safeError(e),
                  data: {
                    code:
                      e instanceof z.ZodError
                        ? "invalid"
                        : e instanceof Fault
                          ? e.code
                          : "PROVISIONING_UNKNOWN",
                  },
                },
              });
          },
        );
      });
    } catch (e) {
      this.error = safeError(e);
      if (e instanceof Fault && e.code === "HUB_REJECTED") {
        this.store.data.providerSuspended = "admission-rejected";
        this.store.save();
      }
      connection.close();
      this.schedule();
    }
  }
  async probeAdmission(): Promise<boolean> {
    await this.start(true);
    const connected = this.connection?.connected ?? false;
    if (!this.store.data.providerEnabled) {
      this.connection?.close();
      this.connection = undefined;
    }
    return connected;
  }
  private schedule(code = this.connection?.closeCode): void {
    if (code === 4000 || code === 4001) {
      this.store.data.providerSuspended = code;
      this.error =
        code === 4000
          ? "This Provider connection was replaced. Resume explicitly after choosing the executor."
          : "The Hub revoked this Provider connection.";
      this.store.save();
      return;
    }
    if (
      this.closed ||
      !this.store.data.providerEnabled ||
      this.store.data.providerSuspended ||
      this.timer
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.start();
    }, 2000);
    this.timer.unref();
  }
  async create(raw: unknown): Promise<{ actorId: string }> {
    const params = Creation.parse(raw);
    const hub = this.store.data.settings.hub;
    const settings = this.store.data.settings;
    if (!hub || !settings.workspaceRoot || !settings.bridgeUrl)
      throw new Fault(
        "PROVISIONING_FAILED",
        "Finish backend, workspace, bridge and Hub setup before provisioning.",
      );
    if (["__proto__", "constructor", "prototype"].includes(params.actorId))
      throw new Fault("invalid", "The Actor identity is invalid.", 422);
    const key = `${hub.url}|${hub.providerId}|${params.actorId}`;
    const fingerprint = hash(
      JSON.stringify({
        actorId: params.actorId,
        credential: params.credential ?? null,
        model: params.config.model ?? null,
        approvalAuthority: params.config.approvalAuthority,
        workspaceRoot: settings.workspaceRoot,
        hubUrl: hub.url,
        executionBinding: hash(JSON.stringify(settings)),
      }),
    );
    const old = this.store.data.journal[key];
    if (old && old.fingerprint !== fingerprint)
      throw new Fault(
        "CREATION_CONFLICT",
        "This Actor already has different accepted execution inputs.",
      );
    if (old?.state === "ready") return { actorId: params.actorId };
    const inflight = this.creating.get(key);
    if (inflight) return inflight;
    if (old)
      throw new Fault(
        old.state === "failed" ? "PROVISIONING_FAILED" : "PROVISIONING_UNKNOWN",
        "The accepted native creation requires reconciliation before another launch.",
      );
    if (Object.hasOwn(this.store.data.actors, params.actorId))
      throw new Fault("CREATION_CONFLICT", "This Actor is already attached to an executor.");
    this.store.data.journal[key] = { fingerprint, state: "creating" };
    this.store.save();
    const work = this.provision(params, key).finally(() => this.creating.delete(key));
    this.creating.set(key, work);
    return work;
  }
  private async provision(
    params: z.infer<typeof Creation>,
    key: string,
  ): Promise<{ actorId: string }> {
    const settings = this.store.data.settings;
    const hub = settings.hub as NonNullable<typeof settings.hub>;
    const bootstrap = {
      actorId: params.actorId,
      hubUrl: hub.url,
      ...(params.credential === undefined ? {} : { credential: params.credential }),
      config: params.config,
      threadId: "",
      bridgeToken: token(),
      enabled: true,
      submissions: [],
    };
    this.store.data.actors[params.actorId] = bootstrap;
    this.store.save();
    this.launch(params.actorId);
    let sent = false;
    try {
      const adapter = await this.adapter();
      sent = true;
      const threadId = await adapter.create({
        cwd: settings.workspaceRoot as string,
        model: params.config.model,
        bridgeUrl: settings.bridgeUrl as string,
        bridgeToken: bootstrap.bridgeToken,
      });
      bootstrap.threadId = threadId;
      this.store.data.journal[key] = { ...this.store.data.journal[key], state: "ready", threadId };
      this.store.save();
      this.launch(params.actorId);
      return { actorId: params.actorId };
    } catch (e) {
      const unknown = sent && (!(e instanceof Fault) || e.code === "NATIVE_UNKNOWN");
      this.store.data.journal[key].state = unknown ? "unknown" : "failed";
      bootstrap.enabled = false;
      this.store.save();
      await this.stop(params.actorId);
      throw new Fault(
        unknown ? "PROVISIONING_UNKNOWN" : "PROVISIONING_FAILED",
        unknown
          ? "The native session creation outcome is unknown. No launch will be replayed automatically."
          : "The native session could not be set up.",
      );
    }
  }
  async setEnabled(enabled: boolean): Promise<void> {
    this.store.data.providerEnabled = enabled;
    if (enabled) delete this.store.data.providerSuspended;
    this.store.save();
    if (enabled) {
      this.closed = false;
      await this.start();
    } else {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.connection?.close();
      this.connection = undefined;
    }
  }
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.connection?.close();
  }
}
