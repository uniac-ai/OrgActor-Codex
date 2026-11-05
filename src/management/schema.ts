import { z } from "zod";

export const ExecutionConfig = z.strictObject({ model: z.string().min(1).optional() });
/** The Codex app server: a local socket, or a loopback or TLS WebSocket. */
export const Backend = z.strictObject({
  kind: z.literal("app-server"),
  endpoint: z.string().regex(/^(unix:\/\/\/|wss?:\/\/)/),
});
export const ConnectorSettings = z.strictObject({
  backend: Backend.optional(),
  workspaceRoot: z.string().startsWith("/").optional(),
  bridgeUrl: z.url().optional(),
});
export const HubConfig = z.strictObject({
  url: z.url(),
  providerId: z.string().min(1).max(64),
  credential: z.string().min(1).optional(),
});
export const Settings = ConnectorSettings.extend({ hub: HubConfig.optional() });
export type ConnectorSettings = z.infer<typeof ConnectorSettings>;
export type HubConfig = z.infer<typeof HubConfig>;
export type Settings = z.infer<typeof Settings>;
export type BackendConfig = z.infer<typeof Backend>;
export type ExecutionConfig = z.infer<typeof ExecutionConfig>;
export const ProbeStage = z.enum(["backend", "account", "bridge", "hub"]);
export type ProbeStage = z.infer<typeof ProbeStage>;
export const Probe = z.object({
  state: z.enum(["unconfigured", "unreachable", "rejected", "ready"]),
  code: z.string(),
  checkedAt: z.string(),
  revision: z.number(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type Probe = z.infer<typeof Probe>;
export const Input = z.strictObject({
  inputId: z.string().min(1).max(128),
  text: z.string().trim().min(1).max(20_000),
});
export const Steer = Input.extend({ turnId: z.string().min(1) });
export const Attach = z.strictObject({
  actorId: z.string().min(1).max(64),
  credential: z.string().min(1).optional(),
  config: ExecutionConfig,
});
export interface ActorSnapshot {
  actorId: string;
  enabled: boolean;
  connected: boolean;
  connectionState: "connected" | "connecting" | "paused" | "suspended";
  observation: "available" | "unavailable";
  observedAt: string | null;
  threadId: string;
  turnId: string | null;
  queued: number;
  lastError?: string;
  output: string;
}
export interface PublicState {
  revision: number;
  settings: Omit<Settings, "backend" | "hub"> & {
    backend?: BackendConfig;
    hub?: { url: string; providerId: string; credentialPresent: boolean };
  };
  probes: Partial<Record<ProbeStage, Probe>>;
  provider: {
    enabled: boolean;
    connected: boolean;
    state:
      | "connected"
      | "connecting"
      | "paused"
      | "suspended"
      | "unconfigured"
      | "unreachable"
      | "rejected";
    error?: string;
  };
  actors: ActorSnapshot[];
}
/** The guided setup on this Mac, in order. */
export const STEPS = ["hub", "codex", "account", "folder", "actor", "tools"] as const;
export type StepId = (typeof STEPS)[number];
export interface GuideStep {
  id: StepId;
  state: "done" | "missing" | "broken" | "waiting";
  /** What was checked and what it saw; a waiting step's is `WAITING`, naming the step it waits on. */
  code: string;
  details?: Record<string, unknown>;
}
export interface Guide {
  /** Whether this Provider runs on a Mac the guide can set up; otherwise only other setups apply. */
  available: boolean;
  /** Whether the Provider's backend is Codex on this Mac, so the guide's order governs attaching. */
  inUse: boolean;
  checkedAt: string;
  folder: { path?: string; suggested: string };
  steps: GuideStep[];
}
export const FolderChoice = z.strictObject({ path: z.string().startsWith("/").max(1024) });
export class Fault extends Error {
  native?: { method: string; code: number; reason?: "missing-rollout" };
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export const safeError = (error: unknown): string =>
  error instanceof Fault
    ? error.message
    : "The operation could not be completed. Check connectivity and run the setup probes.";
