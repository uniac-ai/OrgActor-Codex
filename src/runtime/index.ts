import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExecutionConfig, Probe, ProbeStage, Settings } from "../management/schema.js";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export const equalSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export interface Submission {
  id: string;
  text: string;
  from: string;
  cause: string | null;
  state: "queued" | "sending" | "running" | "unknown" | "done";
  turnId?: string;
  cancelRequested?: boolean;
  kind?: "run" | "steer";
  applied?: boolean;
  failure?: { code: string; message: string; status: number };
  result?: {
    inputId: string;
    turnId: string;
    status: "completed" | "interrupted" | "failed";
    output: string;
  };
}
export interface ApprovalBinding {
  requestId: string;
  threadId: string;
  turnId: string | null;
  method: string;
  answerer: string;
  inputIds?: string[];
  questionId?: string;
  questionText?: string;
  questionCursor?: number;
  state: "asking" | "waiting" | "resolved";
}
export interface Bootstrap {
  actorId: string;
  hubUrl: string;
  credential?: string;
  config: ExecutionConfig;
  threadId: string;
  bridgeToken: string;
  enabled: boolean;
  submissions: Submission[];
  cursor?: number;
  suspended?: number | "admission-rejected";
  approvals?: Record<string, ApprovalBinding>;
}
export interface Provision {
  fingerprint: string;
  state: "creating" | "ready" | "unknown" | "failed";
  threadId?: string;
}
export interface Runtime {
  revision: number;
  settings: Settings;
  probes: Partial<Record<ProbeStage, Probe>>;
  providerEnabled: boolean;
  providerSuspended?: number | "admission-rejected";
  actors: Record<string, Bootstrap>;
  journal: Record<string, Provision>;
  issuedCredentials: Record<string, string>;
}

/** The single process owns synchronous, atomic updates to its private runtime volume. */
export class RuntimeStore {
  readonly file: string;
  data: Runtime;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (lstatSync(root).isSymbolicLink())
      throw new Error("Runtime directory must not be a symbolic link");
    chmodSync(root, 0o700);
    this.file = join(root, "runtime.json");
    if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink())
      throw new Error("Runtime file must not be a symbolic link");
    this.data = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8"))
      : {
          revision: 0,
          settings: {},
          probes: {},
          providerEnabled: false,
          actors: {},
          journal: {},
          issuedCredentials: {},
        };
    this.save();
  }
  save(): void {
    const tmp = `${this.file}.next`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
  privateFile(name: "ssh-key" | "known-hosts", value: string): string {
    const path = join(this.root, name);
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error("Private material must not be a symbolic link");
    writeFileSync(path, value.endsWith("\n") ? value : `${value}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }
}
