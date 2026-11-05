import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

export const hubRevision = "98d651ede8f5dd4f98a86c51825f06d0db04e1b7";
export const hubPackageSha256 = "9991ec9625a6fc5617f923aa123bc0f9cc96a161634c35b059a500999a65bcd5";

/** Public packaged CLI only, with a caller-owned empty home. */
export async function startPublicHub(home: string, providerId: string, credential: string) {
  const digest = createHash("sha256")
    .update(readFileSync(resolve("test/fixtures/agentorg-cli-98d651e.tgz")))
    .digest("hex");
  assert.equal(digest, hubPackageSha256);
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(
    join(home, "providers.json"),
    JSON.stringify([
      { providerId, credentialHash: createHash("sha256").update(credential).digest("hex") },
    ]),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [resolve("node_modules/.bin/agentorg-server"), "--port", "0"],
    {
      env: { HOME: home, PATH: process.env.PATH ?? "", AGENTORG_HOME: home },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let log = "";
  child.stderr.on("data", (chunk) => {
    log += String(chunk);
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  };
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      const url = /core serving on (http:\/\/[\d.:]+)/.exec(log)?.[1];
      if (url)
        return {
          url,
          rootId: readFileSync(join(home, "root-actor"), "utf8").trim(),
          rootCredential: readFileSync(join(home, "root-credential"), "utf8").trim(),
          close,
        };
      assert.equal(child.exitCode, null, "The owned packaged Hub exited before readiness");
      await setTimeout(50);
    }
    throw new Error("The owned packaged Hub did not report readiness");
  } catch (error) {
    await close();
    throw error;
  }
}
