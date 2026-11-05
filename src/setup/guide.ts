import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { waitsForDesktop } from "../actors/supervisor.js";
import type { AppServerAdapter, CodexBackend } from "../codex/index.js";
import {
  type AccessPlan,
  type ConnectorSettings,
  Fault,
  type Guide,
  type GuideStep,
  STEPS,
  type StepId,
} from "../management/schema.js";
import type { CodexProvider } from "../provider/index.js";
import { type RuntimeStore, token } from "../runtime/index.js";
import { ALIAS, listening, type ThisMac, ThisMacAccess, thisMac } from "./access.js";
import type { SetupService } from "./index.js";

type Check = Omit<GuideStep, "id">;
const done = (code: string, details?: Record<string, unknown>): Check => ({
  state: "done",
  code,
  ...(details ? { details } : {}),
});
const missing = (code: string, details?: Record<string, unknown>): Check => ({
  state: "missing",
  code,
  ...(details ? { details } : {}),
});
const broken = (code: string, details?: Record<string, unknown>): Check => ({
  state: "broken",
  code,
  ...(details ? { details } : {}),
});

/** A folder connected to AgentOrg's own Codex adapter defines the `org` server the Actor needs. */
export function hasAdapter(root: string): boolean {
  try {
    const config = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    return /^\s*(\[\s*mcp_servers\s*\.\s*("org"|'org'|org)\s*[\].]|mcp_servers\s*\.\s*("org"|'org'|org)\s*[.=])/m.test(
      config,
    );
  } catch {
    return false;
  }
}

/**
 * The guided setup for Codex Desktop over SSH to this Mac: eight ordered steps, each checked live,
 * a step waiting while an earlier one isn't done, and the consented actions that complete them.
 */
export class GuideService {
  readonly access: ThisMacAccess;
  /** Where the Codex backend on this Mac reaches this Provider's MCP bridge; set at listen. */
  bridgeUrl?: string;
  private running?: Promise<Guide>;
  /** Passed live checks, reused briefly so a poll re-runs only what isn't done. */
  private passed = new Map<string, { until: number; value: unknown }>();
  constructor(
    private store: RuntimeStore,
    private setup: SetupService,
    private backend: Pick<CodexBackend, "get">,
    private provider: Pick<CodexProvider, "snapshot" | "setEnabled">,
    readonly mac: ThisMac = thisMac(),
  ) {
    this.access = new ThisMacAccess(store, mac);
  }
  get available(): boolean {
    return this.mac.platform === "darwin";
  }
  /** Whether the Provider's backend is this guide's SSH access, so its order governs attaching. */
  get inUse(): boolean {
    return this.available && this.access.ownsBackend();
  }
  suggested(): string {
    return join(this.mac.home, `agentorg-${this.store.data.settings.hub?.providerId ?? "codex"}`);
  }
  check(force = false): Promise<Guide> {
    if (force) this.passed.clear();
    this.running ??= this.evaluate().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async evaluate(): Promise<Guide> {
    const steps: GuideStep[] = [];
    const checks: Record<StepId, () => Check | Promise<Check>> = {
      hub: () => this.hub(),
      login: async () =>
        (await listening(this.mac.sshPort))
          ? done("REMOTE_LOGIN_ON")
          : missing("REMOTE_LOGIN_OFF", { port: this.mac.sshPort }),
      access: () => this.sshAccess(),
      desktop: async () =>
        (await this.adapter())
          ? done("APP_SERVER_INITIALIZED", { alias: ALIAS })
          : missing("DESKTOP_NOT_CONNECTED", { alias: ALIAS }),
      folder: () => this.folder(),
      actor: () => this.actor(),
      session: () => this.session(),
      tools: () => this.tools(),
    };
    if (this.available)
      for (const id of STEPS) {
        const blocker = steps.find((s) => s.state !== "done");
        steps.push(
          blocker
            ? { id, state: "waiting", code: "WAITING", details: { on: blocker.id } }
            : { id, ...(await checks[id]()) },
        );
      }
    return {
      available: this.available,
      inUse: this.inUse,
      checkedAt: new Date().toISOString(),
      folder: {
        ...(this.store.data.settings.workspaceRoot
          ? { path: this.store.data.settings.workspaceRoot }
          : {}),
        suggested: this.suggested(),
      },
      steps,
    };
  }
  private async once<T>(key: string, run: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
    const hit = this.passed.get(key);
    if (hit && hit.until > Date.now()) return hit.value as T;
    const value = await run();
    if (ok(value)) this.passed.set(key, { until: Date.now() + 30_000, value });
    return value;
  }
  private hub(): Check {
    const snapshot = this.provider.snapshot();
    const hub = this.store.data.settings.hub;
    const where = hub ? { url: hub.url, providerId: hub.providerId } : undefined;
    switch (snapshot.state) {
      case "connected":
        return done("PROVIDER_ADMITTED", where);
      case "unconfigured":
        return missing("HUB_UNCONFIGURED");
      case "paused":
        return missing("PROVIDER_PAUSED", where);
      case "connecting":
        return missing("HUB_CONNECTING", where);
      case "rejected":
        return broken("HUB_REJECTED", where);
      case "suspended":
        return broken("PROVIDER_SUSPENDED", where);
      default:
        return broken("HUB_UNREACHABLE", where);
    }
  }
  private async sshAccess(): Promise<Check> {
    const found = this.access.inspect();
    if (!found.codex) return broken("CODEX_NOT_FOUND", { searched: this.mac.codex.slice(0, 1) });
    if (!found.hostKey) return broken("HOST_KEY_UNREADABLE", { path: this.mac.hostKey });
    if (found.unsupported) return broken("PATH_UNSUPPORTED", { path: found.unsupported });
    if (found.conflict) return broken("ACCESS_CONFLICT", { path: found.conflict, alias: ALIAS });
    const absent = Object.entries(found.present)
      .filter(([, present]) => !present)
      .map(([part]) => part);
    if (absent.length === 4) return missing("ACCESS_MISSING", { alias: ALIAS });
    if (absent.length) return broken("ACCESS_INCOMPLETE", { absent });
    const tested = await this.once(
      `access:${this.store.data.revision}`,
      () => this.access.test(),
      (t) => !t.overridden.length && t.provider && !!t.desktop,
    );
    // An earlier Host or Match, or a global option, can take this-mac's values first.
    if (tested.overridden.length)
      return broken("ACCESS_OVERRIDDEN", {
        path: join(this.mac.home, ".ssh", "config"),
        options: tested.overridden,
      });
    if (!tested.provider) return broken("PROVIDER_KEY_REFUSED", { alias: ALIAS });
    if (!tested.desktop) return broken("DESKTOP_KEY_REFUSED", { alias: ALIAS });
    return done("ACCESS_READY", { alias: ALIAS, user: this.mac.user, codex: tested.desktop });
  }
  private async adapter(): Promise<AppServerAdapter | undefined> {
    try {
      return await this.backend.get();
    } catch {
      return undefined;
    }
  }
  private attached() {
    return Object.values(this.store.data.actors).filter((actor) => actor.threadId);
  }
  private async folder(): Promise<Check> {
    const root = this.store.data.settings.workspaceRoot;
    const suggested = this.suggested();
    if (!root) return missing("FOLDER_UNCHOSEN", { suggested });
    if (!existsSync(root)) return missing("FOLDER_MISSING", { path: root });
    if (!statSync(root).isDirectory()) return broken("FOLDER_NOT_DIRECTORY", { path: root });
    if (hasAdapter(root))
      return broken("FOLDER_HAS_ADAPTER", {
        path: root,
        suggested,
        disconnect: `agentorg-mcp disconnect codex --project ${shellQuote(root)}`,
      });
    const adapter = await this.adapter();
    if (!adapter) return missing("DESKTOP_NOT_CONNECTED", { alias: ALIAS });
    const revision = this.store.data.revision;
    const open = await this.once(`project:${revision}`, () => projectOpen(adapter, root), Boolean);
    if (!open) return missing("FOLDER_NOT_IN_DESKTOP", { path: root, alias: ALIAS });
    // A session created in this folder already shows Codex accepts it there.
    if (!this.attached().length) {
      const bridgeUrl = this.store.data.settings.bridgeUrl;
      const accepted = await this.once(
        `preflight:${revision}`,
        () =>
          bridgeUrl
            ? adapter.preflight({ cwd: root, bridgeUrl, bridgeToken: token() }).then(
                () => true,
                () => false,
              )
            : Promise.resolve(false),
        Boolean,
      );
      if (!accepted) return broken("PREFLIGHT_REFUSED", { path: root });
    }
    return done("FOLDER_READY", { path: root, alias: ALIAS });
  }
  private actor(): Check {
    const journal = Object.entries(this.store.data.journal);
    const failed = journal.find(
      ([, entry]) => entry.state === "failed" || entry.state === "unknown",
    );
    if (failed)
      return broken("ACTOR_PROVISIONING_FAILED", {
        actorId: failed[0].slice(failed[0].lastIndexOf("|") + 1),
        outcome: failed[1].state,
      });
    if (journal.some(([, entry]) => entry.state === "creating")) return missing("ACTOR_CREATING");
    const attached = this.attached();
    if (!attached.length) return missing("NO_ACTOR");
    return done("ACTOR_ATTACHED", {
      actors: attached.map((a) => ({ actorId: a.actorId, threadId: a.threadId })),
    });
  }
  private session(): Check {
    const waiting = this.attached().find((actor) => waitsForDesktop(actor, this.store.data));
    if (waiting)
      return missing("SESSION_UNCONFIRMED", {
        alias: ALIAS,
        path: this.store.data.settings.workspaceRoot,
        actorId: waiting.actorId,
        threadId: waiting.threadId,
      });
    return done(
      this.attached().some((actor) => actor.config.approvalAuthority === "desktop")
        ? "SESSION_CONFIRMED"
        : "CONFIRMATION_NOT_REQUIRED",
    );
  }
  private async tools(): Promise<Check> {
    const adapter = await this.adapter();
    for (const actor of this.attached()) {
      if (!actor.enabled) return missing("ACTOR_PAUSED", { actorId: actor.actorId });
      const ready =
        !!adapter &&
        (await this.once(
          `tools:${actor.threadId}`,
          () => adapter.bridgeReady(actor.threadId).catch(() => false),
          Boolean,
        ));
      if (!ready) return missing("ACTOR_TOOLS_MISSING", { actorId: actor.actorId });
    }
    return done("ACTOR_TOOLS_READY");
  }
  /** Attaching waits until Desktop has the folder open and Codex accepts a session there. */
  async admitAttach(): Promise<void> {
    if (!this.inUse) return;
    const folder = (await this.check(true)).steps.find((s) => s.id === "folder");
    if (folder?.state !== "done")
      throw new Fault(
        "SETUP_INCOMPLETE",
        "Finish Setup through the workspace folder before attaching an Actor.",
      );
  }
  planAccess(): AccessPlan {
    if (!this.available)
      throw new Fault("THIS_MAC_UNAVAILABLE", "This Provider doesn't run on a Mac it can set up.");
    return this.access.plan();
  }
  /** Write the reviewed SSH access, then make it the Provider's backend. */
  applyAccess(planId: string): Promise<void> {
    return this.exclusive(async () => {
      this.unbound();
      const written = this.access.apply(planId);
      try {
        await this.reconfigure((current) => ({
          ...current,
          backend: {
            kind: "ssh",
            host: "127.0.0.1",
            port: written.port,
            user: written.user,
            privateKey: written.privateKey,
            knownHosts: written.knownHosts,
          },
          ...(current.bridgeUrl || !this.bridgeUrl ? {} : { bridgeUrl: this.bridgeUrl }),
        }));
      } catch (error) {
        this.access.remove();
        throw error;
      }
    });
  }
  /** Remove exactly what the guide wrote, and the backend it configured. */
  removeAccess(): Promise<void> {
    return this.exclusive(async () => {
      this.unbound();
      if (this.access.ownsBackend()) await this.reconfigure(({ backend: _, ...rest }) => rest);
      this.access.remove();
      this.passed.clear();
    });
  }
  chooseFolder(path: string): Promise<void> {
    return this.exclusive(async () => {
      if (
        !isAbsolute(path) ||
        normalize(path) !== path ||
        (path.length > 1 && path.endsWith("/")) ||
        [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
        path.length > 1024
      )
        throw new Fault("FOLDER_INVALID", "Choose an absolute folder path.", 422);
      if (hasAdapter(path))
        throw new Fault(
          "FOLDER_HAS_ADAPTER",
          "AgentOrg's Codex adapter is connected in this folder, and Codex would refuse the Actor's session there. Choose a folder of its own, or disconnect the adapter.",
        );
      await this.reconfigure((current) => ({ ...current, workspaceRoot: path }));
    });
  }
  createFolder(): void {
    const root = this.store.data.settings.workspaceRoot;
    if (!root) throw new Fault("FOLDER_UNCHOSEN", "Choose the workspace folder first.");
    mkdirSync(root, { recursive: true });
    this.passed.clear();
  }
  /** Setup changes run one at a time, so none reads settings another is about to replace. */
  private queue: Promise<unknown> = Promise.resolve();
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }
  private unbound(): void {
    if (Object.keys(this.store.data.journal).length || Object.keys(this.store.data.actors).length)
      throw new Fault(
        "EXECUTION_CONFIG_BOUND",
        "Detach this Provider's Actors before changing its setup.",
      );
  }
  /** Change connection settings, pausing the Provider around it as Setup requires. */
  private async reconfigure(change: (current: ConnectorSettings) => ConnectorSettings) {
    const { hub: _, ...current } = this.store.data.settings;
    const next = change(current);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    this.unbound();
    const resume = this.store.data.providerEnabled;
    if (resume) await this.provider.setEnabled(false);
    try {
      this.setup.configure(next);
    } finally {
      if (resume) await this.provider.setEnabled(true);
      this.passed.clear();
    }
  }
}

const shellQuote = (path: string) => `'${path.replaceAll("'", `'\\''`)}'`;

/** Whether Codex Desktop has the folder among its projects on this backend. */
async function projectOpen(adapter: AppServerAdapter, root: string): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const projects = await adapter.protocol.request("project/list", {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (
      projects.data?.some((p: any) =>
        p.roots?.some((r: any) => (typeof r === "string" ? r : r.path) === root),
      )
    )
      return true;
    cursor = projects.nextCursor ?? undefined;
    if (!cursor) return false;
  }
  return false;
}
