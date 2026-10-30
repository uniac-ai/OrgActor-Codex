import { z } from "zod";
import type { CodexBackend } from "../codex/index.js";
import { Fault, type Probe, type ProbeStage, Settings } from "../management/schema.js";
import type { CodexProvider } from "../provider/index.js";
import { hash, type RuntimeStore, token } from "../runtime/index.js";

export class SetupService {
  private loginOwner?: { key: string; loginId?: string; unwatch?: () => void };
  readonly challenges = new Map<string, number>();
  constructor(
    private store: RuntimeStore,
    private backend: CodexBackend,
    private provider?: CodexProvider,
  ) {}
  configure(raw: unknown): void {
    if (this.loginOwner)
      throw new Fault(
        "LOGIN_IN_PROGRESS",
        "Finish or cancel the owned Codex sign-in before changing settings.",
      );
    const next = Settings.parse(raw);
    const old = this.store.data.settings;
    if (next.backend?.kind === "ssh" && old.backend?.kind === "ssh") {
      next.backend.privateKey ??= old.backend.privateKey;
      next.backend.knownHosts ??= old.backend.knownHosts;
    }
    if (
      next.hub &&
      old.hub &&
      next.hub.providerId === old.hub.providerId &&
      next.hub.url === old.hub.url
    )
      next.hub.credential ??= old.hub.credential;
    if (
      (Object.keys(this.store.data.journal).length || Object.keys(this.store.data.actors).length) &&
      JSON.stringify(next) !== JSON.stringify(old)
    )
      throw new Fault(
        "EXECUTION_CONFIG_BOUND",
        "Existing execution records are bound to these settings. Resolve or remove their native execution before switching backend, workspace, bridge or Hub settings.",
      );
    if (
      this.store.data.providerEnabled ||
      Object.values(this.store.data.actors).some((a) => a.enabled)
    )
      throw new Fault(
        "CONNECTIONS_ENABLED",
        "Pause the Provider and attached Actors before changing connection settings.",
      );
    this.store.data.settings = next;
    this.store.data.revision += 1;
    this.store.data.probes = {};
    this.store.save();
    this.backend.close();
  }
  publicSettings(): any {
    const { backend, hub, ...rest } = this.store.data.settings;
    return {
      ...rest,
      ...(backend
        ? {
            backend:
              backend.kind === "ssh"
                ? {
                    kind: backend.kind,
                    host: backend.host,
                    port: backend.port,
                    user: backend.user,
                    privateKeyPresent: !!backend.privateKey,
                    knownHostsPresent: !!backend.knownHosts,
                    ...(backend.privateKey
                      ? { keyFingerprint: hash(backend.privateKey).slice(0, 16) }
                      : {}),
                  }
                : backend,
          }
        : {}),
      ...(hub
        ? { hub: { url: hub.url, providerId: hub.providerId, credentialPresent: !!hub.credential } }
        : {}),
    };
  }
  async probe(stage: ProbeStage): Promise<Probe> {
    const revision = this.store.data.revision;
    let result: Omit<Probe, "revision" | "checkedAt">;
    try {
      result = await this.inspect(stage);
    } catch (e) {
      result = {
        state:
          e instanceof Fault && ["HUB_REJECTED", "NATIVE_REJECTED"].includes(e.code)
            ? "rejected"
            : e instanceof Fault && e.code.includes("UNCONFIGURED")
              ? "unconfigured"
              : "unreachable",
        code: e instanceof Fault ? e.code : "PROBE_UNAVAILABLE",
      };
    }
    const report = { ...result, checkedAt: new Date().toISOString(), revision };
    if (revision === this.store.data.revision) {
      this.store.data.probes[stage] = report;
      this.store.save();
    }
    return report;
  }
  private async inspect(stage: ProbeStage): Promise<Omit<Probe, "revision" | "checkedAt">> {
    if (stage === "hub") {
      const hub = this.store.data.settings.hub;
      if (!hub) return { state: "unconfigured", code: "HUB_UNCONFIGURED" };
      const admitted = await this.provider?.probeAdmission();
      return admitted
        ? { state: "ready", code: "PROVIDER_ADMITTED" }
        : { state: "unreachable", code: "PROVIDER_NOT_ADMITTED" };
    }
    const adapter = await this.backend.get();
    if (stage === "backend") return { state: "ready", code: "APP_SERVER_INITIALIZED" };
    if (stage === "account") {
      const account = await adapter.protocol.request("account/read", { refreshToken: false });
      if (account.account?.type !== "chatgpt")
        return { state: "rejected", code: "CHATGPT_SIGN_IN_REQUIRED" };
      let quota: any;
      try {
        quota = await adapter.protocol.request("account/rateLimits/read");
      } catch {
        quota = {};
      }
      return {
        state: quota.ordinaryUsageAllowed === false ? "rejected" : "ready",
        code:
          quota.ordinaryUsageAllowed === true
            ? "PLAN_USAGE_ALLOWED"
            : quota.ordinaryUsageAllowed === false
              ? "PLAN_USAGE_DENIED"
              : "CHATGPT_AUTHENTICATED_QUOTA_UNAVAILABLE",
        details: {
          type: "chatgpt",
          planType: account.account.planType ?? null,
          ordinaryUsageAllowed: quota.ordinaryUsageAllowed ?? null,
          rateLimits: publicLimits(quota.rateLimits),
          rateLimitsByLimitId: Object.fromEntries(
            Object.entries(quota.rateLimitsByLimitId ?? {}).map(([key, value]) => [
              key,
              publicLimits(value),
            ]),
          ),
        },
      };
    }
    if (stage === "desktop") {
      const root = this.store.data.settings.workspaceRoot;
      if (!root) return { state: "unconfigured", code: "WORKSPACE_ROOT_REQUIRED" };
      const projects = await adapter.protocol.request("project/list", { limit: 100 });
      const matches =
        projects.data?.filter((p: any) =>
          p.roots?.some((r: any) => (typeof r === "string" ? r : r.path) === root),
        ) ?? [];
      return {
        state: "unconfigured",
        code: "DESKTOP_OBSERVATION_REQUIRED",
        details: {
          workspaceRoot: root,
          backendProjectMatch: matches.length > 0,
          renderedVisibility: "unverified",
          instruction:
            "In Codex Desktop, open this exact saved SSH workspace root (or local project), then verify the managed session appears and updates. Backend project matching alone does not verify Desktop visibility.",
        },
      };
    }
    const url = this.store.data.settings.bridgeUrl;
    if (!url) return { state: "unconfigured", code: "BRIDGE_URL_REQUIRED" };
    for (const actor of Object.values(this.store.data.actors))
      if (
        actor.enabled &&
        actor.threadId &&
        (await adapter.bridgeReady(actor.threadId).catch(() => false))
      )
        return {
          state: "ready",
          code: "ACTOR_MCP_INITIALIZED",
          details: { threadId: actor.threadId },
        };
    const challenge = token();
    const endpoint = new URL(`/bridge-health/${challenge}`, url);
    this.challenges.set(challenge, Date.now() + 15_000);
    try {
      const r = await adapter.protocol.request("command/exec", {
        command: ["curl", "--fail", "--silent", "--show-error", "--max-time", "5", endpoint.href],
        cwd: this.store.data.settings.workspaceRoot,
        sandboxPolicy: { type: "readOnly" },
        timeoutMs: 8000,
      });
      return r.exitCode === 0 && r.stdout.trim() === challenge
        ? { state: "ready", code: "BACKEND_REACHED_CONTAINER" }
        : { state: "rejected", code: "BACKEND_BRIDGE_PROBE_FAILED" };
    } finally {
      this.challenges.delete(challenge);
    }
  }
  challenge(value: string): boolean {
    const expiry = this.challenges.get(value);
    return expiry !== undefined && expiry > Date.now();
  }
  async confirmDesktop(raw: unknown): Promise<Probe> {
    const confirmation = z
      .strictObject({
        threadId: z.string().min(1),
        workspaceRoot: z.string().startsWith("/"),
        observation: z.enum(["catalog", "rendered"]),
      })
      .parse(raw);
    const revision = this.store.data.revision;
    if (
      confirmation.workspaceRoot !== this.store.data.settings.workspaceRoot ||
      !Object.values(this.store.data.actors).some((a) => a.threadId === confirmation.threadId)
    )
      throw new Fault(
        "DESKTOP_SCOPE_MISMATCH",
        "Choose an attached Actor session in the configured workspace.",
      );
    const adapter = await this.backend.get();
    const native = await adapter.read(confirmation.threadId);
    if (native.thread?.cwd !== confirmation.workspaceRoot || revision !== this.store.data.revision)
      throw new Fault(
        "DESKTOP_SCOPE_MISMATCH",
        "The session no longer matches this setup configuration.",
      );
    const report: Probe = {
      state: "ready",
      code: "OPERATOR_CONFIRMED_DESKTOP",
      revision,
      checkedAt: new Date().toISOString(),
      details: { source: "operator", ...confirmation },
    };
    this.store.data.probes.desktop = report;
    this.store.save();
    return report;
  }
  async login(): Promise<{ loginId: string; authUrl: string }> {
    if (this.loginOwner)
      throw new Fault("LOGIN_IN_PROGRESS", "A sign-in is already owned by this setup session.");
    const owner = {
      key: token(),
      loginId: undefined as string | undefined,
      unwatch: undefined as (() => void) | undefined,
    };
    this.loginOwner = owner;
    try {
      const adapter = await this.backend.get();
      owner.unwatch = adapter.protocol.watch((event) => {
        if (
          event.method === "account/login/completed" &&
          event.params.loginId === owner.loginId &&
          this.loginOwner === owner
        ) {
          owner.unwatch?.();
          this.loginOwner = undefined;
        }
      });
      const r = await adapter.protocol.request("account/login/start", { type: "chatgpt" });
      if (typeof r.loginId !== "string" || typeof r.authUrl !== "string")
        throw new Fault("LOGIN_UNAVAILABLE", "Codex did not start an interactive sign-in.");
      owner.loginId = r.loginId;
      return { loginId: r.loginId, authUrl: r.authUrl };
    } catch (error) {
      if (!(error instanceof Fault) || error.code !== "NATIVE_UNKNOWN") {
        owner.unwatch?.();
        if (this.loginOwner === owner) this.loginOwner = undefined;
      }
      throw error;
    }
  }
  async cancelLogin(id: string): Promise<void> {
    const owner = this.loginOwner;
    if (!owner || id !== owner.loginId)
      throw new Fault("LOGIN_NOT_OWNED", "This setup session does not own that sign-in.");
    const adapter = await this.backend.get();
    await adapter.protocol.request("account/login/cancel", { loginId: id });
    owner.unwatch?.();
    if (this.loginOwner === owner) this.loginOwner = undefined;
  }
}
function publicLimits(value: any): any {
  if (!value) return null;
  return {
    limitId: value.limitId ?? null,
    primary: value.primary ?? null,
    secondary: value.secondary ?? null,
    planType: value.planType ?? null,
  };
}
