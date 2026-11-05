import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { cleanEnvironment } from "../codex/index.js";
import { type AccessPlan, type AccessWrite, Fault } from "../management/schema.js";
import { type AccessRecord, hash, type RuntimeStore, token } from "../runtime/index.js";

/** The SSH host alias Codex Desktop connects to; the guided setup writes it to `~/.ssh/config`. */
export const ALIAS = "this-mac";

/** The Mac this Provider runs on, as the guided setup reads it. Tests substitute their own. */
export interface ThisMac {
  platform: NodeJS.Platform;
  home: string;
  user: string;
  shell: string;
  /** The Mac's own host key, so SSH clients trust nothing on first use. */
  hostKey: string;
  /** Where Codex Desktop's bundled `codex` may be, in order. */
  codex: string[];
  sshPort: number;
  /** Codex Desktop's own state, where it records its projects. */
  desktopState: string;
  ssh(args: string[]): Promise<{ code: number | null; stdout: string }>;
}

export function thisMac(): ThisMac {
  const user = userInfo();
  return {
    platform: process.platform,
    home: homedir(),
    user: user.username,
    shell: user.shell ?? "/bin/zsh",
    hostKey: "/etc/ssh/ssh_host_ed25519_key.pub",
    codex: [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      ...(process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((d) => join(d, "codex")),
    ],
    sshPort: 22,
    desktopState: join(homedir(), ".codex", ".codex-global-state.json"),
    ssh: (args) =>
      new Promise((resolve) => {
        const child = spawn("ssh", args, {
          stdio: ["ignore", "pipe", "ignore"],
          env: cleanEnvironment(),
          timeout: 10_000,
        });
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          if (stdout.length < 4096) stdout += chunk;
        });
        child.on("error", () => resolve({ code: 255, stdout: "" }));
        child.on("close", (code) => resolve({ code, stdout }));
      }),
  };
}

/** Whether something accepts TCP connections on this Mac's port: Remote Login's sshd. */
export function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(2000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const sshString = (value: Buffer | string): Buffer => {
  const data = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
};

export interface Key {
  /** The OpenSSH private key; never returned or logged. */
  private: string;
  /** `ssh-ed25519 <base64>`, without a comment. */
  public: string;
  fingerprint: string;
}

/** A new Ed25519 key in OpenSSH's own formats, made in memory. */
export function ed25519(comment: string): Key {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
  const check = randomBytes(4);
  let secret = Buffer.concat([
    check,
    check,
    sshString("ssh-ed25519"),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  const pad = (8 - (secret.length % 8)) % 8;
  secret = Buffer.concat([secret, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    count,
    sshString(blob),
    sshString(secret),
  ]).toString("base64");
  return {
    private: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.match(/.{1,70}/g)?.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`,
    public: `ssh-ed25519 ${blob.toString("base64")}`,
    fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
  };
}

/** What is in place now; the guide turns it into the SSH access step. */
export interface AccessInspection {
  codex?: string;
  hostKey?: string;
  /** A path the access would name that its files can't quote. */
  unsupported?: string;
  /** A `Host this-mac` the guided setup didn't write. */
  conflict?: string;
  present: { authorizedKeys: boolean; config: boolean; files: boolean; backend: boolean };
}

const quotable = (path: string) => !/["'\\%\n\r]/.test(path);
/** The first `Host` or `Match` line: ssh takes each option's first value, so the block goes there. */
const firstBlock = (lines: string[]) => lines.findIndex((line) => /^\s*(host|match)\s/i.test(line));
const sh = (path: string) => (/^[\w./+-]+$/.test(path) ? path : `'${path}'`);
const conf = (path: string) => (/\s/.test(path) ? `"${path}"` : path);

/**
 * This Mac's SSH access for the Provider and for Codex Desktop: keys in the runtime folder, marked
 * blocks in `~/.ssh`, written only on the person's consent and removed exactly.
 */
export class ThisMacAccess {
  private pending?: {
    id: string;
    provider: Key;
    desktop: Key;
    writes: AccessWrite[];
    /** What the review saw, so a change before the person confirms makes it stale. */
    seen: string;
  };
  constructor(
    private store: RuntimeStore,
    readonly mac: ThisMac,
  ) {}
  private get dir() {
    return join(this.store.root, "ssh");
  }
  private get files() {
    return {
      desktop: join(this.dir, "desktop"),
      knownHosts: join(this.dir, "known_hosts"),
      shell: join(this.dir, "desktop-shell"),
    };
  }
  /** The Provider's own key and known host, where its SSH backend connects from. */
  private get backendFiles() {
    return {
      key: join(this.store.root, "ssh-key"),
      knownHosts: join(this.store.root, "known-hosts"),
    };
  }
  private seen(): string {
    const { dir, authorizedKeys, config } = this.ssh;
    return hash(
      JSON.stringify([
        existsSync(dir),
        existsSync(authorizedKeys) && read(authorizedKeys),
        existsSync(config) && read(config),
        this.codex(),
        this.hostKey(),
        Object.values(this.files).map((path) => existsSync(path)),
      ]),
    );
  }
  private get ssh() {
    const dir = join(this.mac.home, ".ssh");
    return { dir, authorizedKeys: join(dir, "authorized_keys"), config: join(dir, "config") };
  }
  private get markers() {
    return [`# BEGIN OrgActor-Codex ${this.store.root}`, `# END OrgActor-Codex ${this.store.root}`];
  }
  codex(): string | undefined {
    return this.mac.codex.find((path) => existsSync(path));
  }
  hostKey(): string | undefined {
    try {
      const [type, key] = readFileSync(this.mac.hostKey, "utf8").trim().split(/\s+/);
      return type === "ssh-ed25519" && key ? `${type} ${key}` : undefined;
    } catch {
      return undefined;
    }
  }
  knownHosts(hostKey: string): string {
    const host = this.mac.sshPort === 22 ? "127.0.0.1" : `[127.0.0.1]:${this.mac.sshPort}`;
    return `${host} ${hostKey}\n`;
  }
  private block(path: string): boolean {
    const lines = read(path).split("\n");
    const begin = lines.indexOf(this.markers[0]);
    return begin >= 0 && lines.indexOf(this.markers[1], begin) > begin;
  }
  /** A `Host` line naming the alias outside this Provider's own block. */
  private conflict(): boolean {
    let ours = false;
    for (const line of read(this.ssh.config).split("\n")) {
      if (line === this.markers[0]) ours = true;
      else if (line === this.markers[1]) ours = false;
      else if (
        !ours &&
        /^\s*host\s/i.test(line) &&
        line.trim().split(/\s+/).slice(1).includes(ALIAS)
      )
        return true;
    }
    return false;
  }
  /** Whether the Provider's backend is the SSH access this guide wrote. */
  ownsBackend(): boolean {
    const backend = this.store.data.settings.backend;
    const record = this.store.data.access;
    return (
      !!record &&
      backend?.kind === "ssh" &&
      backend.host === "127.0.0.1" &&
      !!backend.privateKey &&
      hash(backend.privateKey) === record.providerKey
    );
  }
  inspect(): AccessInspection {
    const codex = this.codex();
    const unsupported = [this.store.root, codex ?? ""].find((p) => !quotable(p));
    return {
      ...(codex ? { codex } : {}),
      ...(this.hostKey() ? { hostKey: this.mac.hostKey } : {}),
      ...(unsupported ? { unsupported } : {}),
      ...(this.conflict() ? { conflict: this.ssh.config } : {}),
      present: {
        authorizedKeys: this.block(this.ssh.authorizedKeys),
        config: this.block(this.ssh.config),
        files: Object.values(this.files).every((path) => existsSync(path)),
        backend: this.ownsBackend(),
      },
    };
  }
  /**
   * Live checks: ssh resolves `this-mac` to the block's own values, the Provider's key reaches the
   * Codex proxy, and Desktop's key runs `codex`.
   */
  async test(): Promise<{ overridden: string[]; provider: boolean; desktop?: string }> {
    const backend = this.store.data.settings.backend;
    if (backend?.kind !== "ssh" || !backend.privateKey || !backend.knownHosts)
      return { overridden: [], provider: false };
    const resolved = await this.mac.ssh(["-G", "-F", this.ssh.config, ALIAS]);
    const values = resolved.stdout.split("\n").map((line) => {
      const at = line.indexOf(" ");
      return [line.slice(0, at), line.slice(at + 1)];
    });
    const value = (key: string) => values.find(([k]) => k === key)?.[1];
    const expected: Record<string, string> = {
      hostname: "127.0.0.1",
      port: String(this.mac.sshPort),
      user: this.mac.user,
      identitiesonly: "yes",
      identityagent: "none",
      stricthostkeychecking: "true",
      batchmode: "yes",
      forwardagent: "no",
    };
    const overridden = [
      ...Object.keys(expected).filter((key) => value(key) !== expected[key]),
      ...(values.some(([k, v]) => k === "identityfile" && v === this.files.desktop)
        ? []
        : ["identityfile"]),
      ...(value("userknownhostsfile")?.startsWith(this.files.knownHosts)
        ? []
        : ["userknownhostsfile"]),
    ];
    const provider = await this.mac.ssh([
      "-T",
      "-F",
      "/dev/null",
      "-oBatchMode=yes",
      "-oStrictHostKeyChecking=yes",
      "-oIdentitiesOnly=yes",
      "-oConnectTimeout=5",
      `-oUserKnownHostsFile=${this.store.privateFile("known-hosts", backend.knownHosts)}`,
      "-i",
      this.store.privateFile("ssh-key", backend.privateKey),
      "-p",
      String(backend.port),
      `${backend.user}@${backend.host}`,
    ]);
    const desktop = await this.mac.ssh([
      "-F",
      this.ssh.config,
      "-oBatchMode=yes",
      "-oConnectTimeout=5",
      ALIAS,
      "codex",
      "--version",
    ]);
    const version = desktop.stdout.trim().split("\n")[0]?.slice(0, 80);
    return {
      overridden: resolved.code === 0 ? overridden : ["config"],
      // ssh exits 255 for its own failures; anything else ran the forced Codex proxy.
      provider: provider.code !== 255,
      ...(desktop.code === 0 && version ? { desktop: version } : {}),
    };
  }
  /** The review of every write, with new keys held in memory until the person consents. */
  plan(): AccessPlan {
    const codex = this.codex();
    const hostKey = this.hostKey();
    const found = this.inspect();
    if (!codex || !hostKey || found.unsupported || found.conflict)
      throw new Fault("ACCESS_UNAVAILABLE", "Resolve the SSH access step's reason first.");
    if (Object.values(found.present).some(Boolean))
      throw new Fault(
        "ACCESS_PRESENT",
        "Remove the existing SSH access before setting it up again.",
      );
    const provider = ed25519("orgactor-codex provider");
    const desktop = ed25519("orgactor-codex desktop");
    const { desktop: desktopKey, knownHosts, shell } = this.files;
    const local = 'from="127.0.0.1,::1"';
    const ssh = this.ssh;
    const before = read(ssh.config).split("\n")[firstBlock(read(ssh.config).split("\n"))];
    const writes: AccessWrite[] = [
      {
        action: "key",
        path: this.backendFiles.key,
        mode: "0600",
        fingerprint: provider.fingerprint,
      },
      {
        action: "file",
        path: this.backendFiles.knownHosts,
        mode: "0600",
        lines: [this.knownHosts(hostKey).trim()],
      },
      { action: "key", path: desktopKey, mode: "0600", fingerprint: desktop.fingerprint },
      {
        action: "file",
        path: knownHosts,
        mode: "0600",
        lines: [this.knownHosts(hostKey).trim()],
      },
      {
        action: "file",
        path: shell,
        mode: "0700",
        lines: [
          "#!/bin/sh",
          "# Codex Desktop's SSH sessions to this Mac: Codex on PATH, then the requested command.",
          `PATH=${sh(dirname(codex))}:"$PATH"`,
          "export PATH",
          `if [ -n "$SSH_ORIGINAL_COMMAND" ]; then exec ${sh(this.mac.shell)} -c "$SSH_ORIGINAL_COMMAND"; fi`,
          `exec ${sh(this.mac.shell)} -l`,
        ],
      },
      ...(existsSync(ssh.dir)
        ? []
        : [{ action: "directory" as const, path: ssh.dir, mode: "0700" as const }]),
      {
        action: "append",
        path: ssh.authorizedKeys,
        creates: !existsSync(ssh.authorizedKeys),
        lines: [
          this.markers[0],
          `restrict,${local},command="exec ${sh(codex)} app-server proxy" ${provider.public} orgactor-codex provider`,
          `${local},no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc,command="${sh(shell)}" ${desktop.public} orgactor-codex desktop`,
          this.markers[1],
        ],
      },
      ...(existsSync(ssh.config)
        ? [
            {
              action: "backup" as const,
              path: `${ssh.config}.orgactor-codex-${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}`,
              from: ssh.config,
            },
          ]
        : []),
      {
        action: "append",
        path: ssh.config,
        creates: !existsSync(ssh.config),
        ...(before === undefined ? {} : { before }),
        lines: [
          this.markers[0],
          `Host ${ALIAS}`,
          "  HostName 127.0.0.1",
          `  Port ${this.mac.sshPort}`,
          `  User ${this.mac.user}`,
          `  IdentityFile ${conf(desktopKey)}`,
          "  IdentitiesOnly yes",
          "  IdentityAgent none",
          `  UserKnownHostsFile ${conf(knownHosts)}`,
          "  StrictHostKeyChecking yes",
          "  BatchMode yes",
          "  ForwardAgent no",
          this.markers[1],
        ],
      },
      {
        action: "backend",
        host: "127.0.0.1",
        port: this.mac.sshPort,
        user: this.mac.user,
        fingerprint: provider.fingerprint,
      },
    ];
    this.pending = { id: token(), provider, desktop, writes, seen: this.seen() };
    return { id: this.pending.id, writes };
  }
  /** Write the reviewed plan; returns the Provider's backend for the caller to configure. */
  apply(id: string): { privateKey: string; knownHosts: string; port: number; user: string } {
    const plan = this.pending;
    if (!plan || plan.id !== id || plan.seen !== this.seen())
      throw new Fault("PLAN_STALE", "Review the SSH access again before writing it.");
    this.pending = undefined;
    const record: AccessRecord = {
      marker: this.store.root,
      providerKey: hash(plan.provider.private),
      files: [],
      appended: [],
    };
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      for (const write of plan.writes) {
        if (write.action === "key" || write.action === "file") {
          const text =
            write.action === "file"
              ? `${write.lines.join("\n")}\n`
              : write.path === this.files.desktop
                ? plan.desktop.private
                : plan.provider.private;
          writeFileSync(write.path, text, { mode: Number.parseInt(write.mode, 8) });
          chmodSync(write.path, Number.parseInt(write.mode, 8));
          record.files.push(write.path);
        } else if (write.action === "directory") {
          mkdirSync(write.path, { mode: 0o700 });
          record.directory = write.path;
        } else if (write.action === "backup") {
          copyFileSync(write.from, write.path);
          chmodSync(write.path, 0o600);
          record.backup = write.path;
        } else if (write.action === "append") {
          const created = !existsSync(write.path);
          const text = read(write.path);
          const lines = text.split("\n");
          const at = write.before === undefined ? -1 : firstBlock(lines);
          if (at >= 0) {
            lines.splice(at, 0, ...write.lines);
            writeFileSync(write.path, lines.join("\n"));
            record.appended.push({ path: write.path, created, newline: false });
          } else {
            const newline = text.length > 0 && !text.endsWith("\n");
            writeFileSync(write.path, `${text}${newline ? "\n" : ""}${write.lines.join("\n")}\n`, {
              mode: 0o600,
            });
            record.appended.push({ path: write.path, created, newline });
          }
        }
      }
    } catch (error) {
      this.store.data.access = record;
      this.remove();
      throw error instanceof Fault
        ? error
        : new Fault(
            "ACCESS_WRITE_FAILED",
            "The SSH access could not be written; nothing was kept.",
          );
    }
    this.store.data.access = record;
    this.store.save();
    return {
      privateKey: plan.provider.private,
      knownHosts: this.knownHosts(this.hostKey() as string),
      port: this.mac.sshPort,
      user: this.mac.user,
    };
  }
  /**
   * Undo exactly what `apply` wrote, keeping anything the person added since. Without its record
   * (a runtime replaced at the same path), the blocks naming this runtime and its `ssh/` files go.
   */
  remove(): void {
    const record: AccessRecord = this.store.data.access ?? {
      marker: this.store.root,
      providerKey: "",
      files: Object.values(this.files),
      appended: [this.ssh.authorizedKeys, this.ssh.config].map((path) => ({
        path,
        created: false,
        newline: false,
      })),
    };
    const begin = `# BEGIN OrgActor-Codex ${record.marker}`;
    const end = `# END OrgActor-Codex ${record.marker}`;
    for (const { path, created, newline } of record.appended) {
      const lines = read(path).split("\n");
      const first = lines.indexOf(begin);
      const last = lines.indexOf(end, first + 1);
      if (first < 0 || last < 0) continue;
      const atEnd = last === lines.length - 2 && lines[lines.length - 1] === "";
      lines.splice(first, last - first + 1);
      // The newline added before the block goes too, while nothing follows it.
      const next = lines.join("\n").slice(0, newline && atEnd ? -1 : undefined);
      if (created && next === "") rmSync(path, { force: true });
      else writeFileSync(path, next);
    }
    if (record.backup && read(this.ssh.config) === read(record.backup))
      rmSync(record.backup, { force: true });
    for (const path of record.files) rmSync(path, { force: true });
    for (const dir of [this.dir, record.directory])
      if (dir && existsSync(dir) && !readdirSync(dir).length) rmdirSync(dir);
    delete this.store.data.access;
    this.store.save();
  }
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
