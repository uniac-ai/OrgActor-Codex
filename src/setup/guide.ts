import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { AppServerAdapter, CodexBackend } from "../codex/index.js";
import {
  type ConnectorSettings,
  Fault,
  type Guide,
  type GuideStep,
  STEPS,
  type StepId,
} from "../management/schema.js";
import type { CodexProvider } from "../provider/index.js";
import { type RuntimeStore, token } from "../runtime/index.js";
import type { SetupService } from "./index.js";
import { controlSocket, type ThisMac, thisMac } from "./this-mac.js";

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
 * The guided setup for an Actor worked by Codex on this Mac: only what the Provider needs to run,
 * checked in order, again and again in the background. A person acts only where a step says so,
 * never in Codex Desktop, which is an optional viewer of the Actor's sessions.
 */
export class GuideService {
  /** Where Codex on this Mac reaches this Provider's MCP bridge; set at listen. */
  bridgeUrl?: string;
  private running?: Promise<Guide>;
  private timer?: NodeJS.Timeout;
  /** Passed live checks, reused briefly so a check re-runs only what isn't done. */
  private passed = new Map<string, { until: number; value: unknown }>();
  constructor(
    private store: RuntimeStore,
    private setup: SetupService,
    private backend: Pick<CodexBackend, "get">,
    private provider: Pick<CodexProvider, "snapshot" | "setEnabled">,
    readonly mac: ThisMac = thisMac(),
  ) {}
  get available(): boolean {
    return this.mac.platform === "darwin";
  }
  /** Codex's app server for this Mac's home, as a backend endpoint. */
  get endpoint(): string {
    return `unix://${controlSocket(this.mac.home)}`;
  }
  /** Whether the Provider's backend is Codex on this Mac, so the guide's order governs it. */
  get inUse(): boolean {
    const backend = this.store.data.settings.backend;
    return this.available && backend?.endpoint === this.endpoint;
  }
  codex(): string | undefined {
    return this.mac.codex.find((path) => existsSync(path));
  }
  /** Start Codex's app server before each connect while it is the backend. */
  async prepare(): Promise<void> {
    const codex = this.codex();
    if (this.inUse && codex) await this.mac.startDaemon(codex);
  }
  suggested(): string {
    return join(this.mac.home, `agentorg-${this.store.data.settings.hub?.providerId ?? "codex"}`);
  }
  /** Check the steps every interval, so a break or a recovery takes effect unwatched. */
  start(interval = 10_000): void {
    this.timer ??= setInterval(() => void this.check().catch(() => undefined), interval);
    this.timer.unref();
  }
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
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
      codex: () => this.codexStep(),
      account: () => this.account(),
      folder: () => this.folder(),
      actor: () => this.actor(),
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
  private async codexStep(): Promise<Check> {
    const socket = controlSocket(this.mac.home);
    if (!this.codex()) return broken("CODEX_NOT_FOUND", { searched: this.mac.codex.slice(0, 1) });
    if (!this.inUse) return missing("CODEX_NOT_IN_USE", { socket });
    if (!(await this.adapter())) return broken("CODEX_UNREACHABLE", { socket });
    return done("APP_SERVER_INITIALIZED", { socket });
  }
  private async account(): Promise<Check> {
    const probe = await this.once(
      `account:${this.store.data.revision}`,
      () => this.setup.probe("account"),
      (p) => p.state === "ready",
    );
    if (probe.state === "ready") return done(probe.code);
    return probe.code === "PLAN_USAGE_DENIED" ? broken(probe.code) : missing(probe.code);
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
    if (!adapter) return broken("CODEX_UNREACHABLE", { socket: controlSocket(this.mac.home) });
    const revision = this.store.data.revision;
    // Codex on this Mac shares Desktop's home, so the folder's project lists its sessions there.
    const project = await this.once(
      `project:${revision}:${root}`,
      () => adapter.fileProject(root).catch(() => undefined),
      Boolean,
    );
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
    return done("FOLDER_READY", { path: root, ...(project ? { project: project.name } : {}) });
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
  /** Attaching waits until Codex accepts a session in the folder. */
  async admitAttach(): Promise<void> {
    if (!this.inUse) return;
    const folder = (await this.check(true)).steps.find((s) => s.id === "folder");
    if (folder?.state !== "done")
      throw new Fault(
        "SETUP_INCOMPLETE",
        "Finish Setup through the workspace folder before attaching an Actor.",
      );
  }
  /** Start Codex's app server on this Mac and make it the Provider's backend. */
  useThisMac(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.available)
        throw new Fault("THIS_MAC_UNAVAILABLE", "This Provider doesn't run on a Mac with Codex.");
      const codex = this.codex();
      if (!codex) throw new Fault("CODEX_NOT_FOUND", "Install Codex Desktop on this Mac first.");
      if (!(await this.mac.startDaemon(codex)))
        throw new Fault("CODEX_NOT_STARTED", "Codex's app server on this Mac didn't start.", 503);
      await this.reconfigure((current) => ({
        ...current,
        backend: { kind: "app-server", endpoint: this.endpoint },
        ...(current.bridgeUrl || !this.bridgeUrl ? {} : { bridgeUrl: this.bridgeUrl }),
      }));
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
