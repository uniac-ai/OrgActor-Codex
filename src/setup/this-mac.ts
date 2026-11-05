import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { cleanEnvironment } from "../codex/index.js";

/** The Mac this Provider runs on, as the guided setup reads it. Tests substitute their own. */
export interface ThisMac {
  platform: NodeJS.Platform;
  home: string;
  /** Where Codex Desktop's bundled `codex` may be, in order. */
  codex: string[];
  /** Start Codex's app server for this home if it isn't running; its control socket. */
  startDaemon(codex: string): Promise<string | undefined>;
}

/** Codex's app server for a home listens here, whichever process started it. */
export const controlSocket = (home: string) =>
  join(home, ".codex", "app-server-control", "app-server-control.sock");

export function thisMac(): ThisMac {
  return {
    platform: process.platform,
    home: homedir(),
    codex: [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      ...(process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((d) => join(d, "codex")),
    ],
    // Codex Desktop runs the same command; it is a no-op while the app server runs.
    startDaemon: (codex) =>
      new Promise((resolve) =>
        execFile(
          codex,
          ["app-server", "daemon", "start"],
          { env: cleanEnvironment(), timeout: 30_000 },
          (error, stdout) => {
            try {
              const socket = JSON.parse(stdout).socketPath;
              resolve(!error && typeof socket === "string" ? socket : undefined);
            } catch {
              resolve(undefined);
            }
          },
        ),
      ),
  };
}
