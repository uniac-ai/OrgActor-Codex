import { z } from "zod";

export const Authority = z.enum(["desktop", "hub"]);
export const ExecutionConfig = z.strictObject({
  model: z.string().min(1).optional(),
  approvalAuthority: Authority.default("desktop"),
});
export const Backend = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ssh"),
    host: z.string().regex(/^[A-Za-z0-9_.:-]+$/),
    port: z.number().int().min(1).max(65535).default(22),
    user: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/),
    privateKey: z.string().min(1).optional(),
    knownHosts: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("app-server"),
    endpoint: z.string().regex(/^(unix:\/\/\/|wss?:\/\/)/),
  }),
]);
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
export const ProbeStage = z.enum(["backend", "account", "desktop", "bridge", "hub"]);
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
export const RequestAnswer = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("approval"),
    decision: z.enum(["accept", "decline", "cancel"]),
  }),
  z.strictObject({
    kind: z.literal("input"),
    answers: z.record(z.string(), z.object({ answers: z.array(z.string()) })),
  }),
]);
export type RequestAnswer = z.infer<typeof RequestAnswer>;
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
  approvalAuthority: "desktop" | "hub";
  requests: { id: string; method: string; turnId: string | null; summary: string }[];
  lastError?: string;
  output: string;
}
export interface PublicState {
  revision: number;
  settings: Omit<Settings, "backend" | "hub"> & {
    backend?: Omit<BackendConfig, "privateKey" | "knownHosts"> & {
      privateKeyPresent?: boolean;
      knownHostsPresent?: boolean;
      keyFingerprint?: string;
    };
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
export class Fault extends Error {
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
