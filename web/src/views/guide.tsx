import { CheckCircle2, CircleAlert, CircleDashed, Lock, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type {
  AccessWrite,
  ActorSnapshot,
  Guide,
  GuideStep,
  StepId,
} from "../../../src/management/schema";
import type { AttachForm, ConsentFeature, GuideFeature } from "../features";

export const TITLES: Record<StepId, string> = {
  hub: "Hub",
  login: "Remote Login",
  access: "SSH access",
  desktop: "Codex Desktop connected",
  folder: "Workspace folder",
  actor: "Actor",
  session: "Session in Desktop",
  tools: "Actor tools",
};
const STATE: Record<GuideStep["state"], { label: string; icon: ReactNode; className: string }> = {
  done: { label: "Done", icon: <CheckCircle2 />, className: "status-ready" },
  missing: { label: "Needs you", icon: <CircleDashed />, className: "state-missing" },
  broken: { label: "Broken", icon: <CircleAlert />, className: "state-broken" },
  waiting: { label: "Waiting", icon: <Lock />, className: "state-waiting" },
};

/** What was checked and what it saw, in words. */
function fact(step: GuideStep): string {
  const d = (step.details ?? {}) as Record<string, any>;
  switch (step.code) {
    case "WAITING":
      return `Waits for ${TITLES[d.on as StepId].toLowerCase()}.`;
    case "PROVIDER_ADMITTED":
      return `Admitted as Provider ${d.providerId} at ${d.url}.`;
    case "HUB_UNCONFIGURED":
      return "This server has no Hub binding.";
    case "PROVIDER_PAUSED":
      return "The Provider is paused.";
    case "HUB_CONNECTING":
      return `Connecting to the Hub at ${d.url}.`;
    case "HUB_REJECTED":
      return "The Hub refused this Provider's credential.";
    case "PROVIDER_SUSPENDED":
      return "The Hub replaced or revoked this Provider's connection.";
    case "HUB_UNREACHABLE":
      return `The Hub at ${d.url} doesn't answer.`;
    case "REMOTE_LOGIN_ON":
      return "Remote Login answers on this Mac.";
    case "REMOTE_LOGIN_OFF":
      return `Port ${d.port} on this Mac refuses connections: Remote Login is off.`;
    case "CODEX_NOT_FOUND":
      return "Codex Desktop's codex isn't installed on this Mac.";
    case "HOST_KEY_UNREADABLE":
      return `This Mac's SSH host key at ${d.path} can't be read.`;
    case "PATH_UNSUPPORTED":
      return `${d.path} has a quote, backslash or % sign, which SSH's files can't hold.`;
    case "ACCESS_CONFLICT":
      return `${d.path} already has a Host this-mac that this Provider didn't write.`;
    case "ACCESS_MISSING":
      return "No SSH access is set up for this Provider yet.";
    case "ACCESS_INCOMPLETE":
      return "Part of this Provider's SSH access is missing.";
    case "ACCESS_OVERRIDDEN":
      return `An earlier line in ${d.path} sets this-mac's ${(d.options as string[]).join(", ")} first.`;
    case "PROVIDER_KEY_REFUSED":
      return "SSH refused this Provider's key.";
    case "DESKTOP_KEY_REFUSED":
      return "Desktop's key can't run codex --version through this-mac.";
    case "ACCESS_READY":
      return `This Provider's key reaches codex app-server proxy; Desktop's key runs ${d.codex}.`;
    case "APP_SERVER_INITIALIZED":
      return "Codex on this Mac answers through this-mac.";
    case "DESKTOP_NOT_CONNECTED":
      return "Codex on this Mac doesn't answer yet: Desktop hasn't connected to this-mac.";
    case "FOLDER_UNCHOSEN":
      return "No workspace folder is chosen.";
    case "FOLDER_MISSING":
      return `${d.path} doesn't exist yet.`;
    case "FOLDER_NOT_DIRECTORY":
      return `${d.path} isn't a folder.`;
    case "FOLDER_HAS_ADAPTER":
      return "Its .codex/config.toml connects AgentOrg's Codex adapter as mcp_servers.org, the name this Actor's tools use.";
    case "FOLDER_NOT_IN_DESKTOP":
      return `Desktop has no project for ${d.path} on this-mac.`;
    case "FOLDER_LOCAL_PROJECT":
      return `Desktop has ${d.path} as the local project ${d.project}, not as a project on this-mac, where the Actor's session runs.`;
    case "PREFLIGHT_REFUSED":
      return `Codex refused a test session in ${d.path} with the Actor's settings.`;
    case "FOLDER_READY":
      return `${d.path} is open in Desktop on this-mac${d.project ? ` as ${d.project}` : ""}, and a session starts there.`;
    case "ACTOR_PROVISIONING_FAILED":
      return `${d.actorId}'s session couldn't be created here.`;
    case "ACTOR_CREATING":
      return "Creating the Actor's session.";
    case "NO_ACTOR":
      return "No Actor is attached.";
    case "ACTOR_ATTACHED":
      return `${(d.actors as { actorId: string }[]).map((a) => a.actorId).join(", ")} has its session.`;
    case "SESSION_UNCONFIRMED":
      return "Not confirmed for this setup yet.";
    case "SESSION_CONFIRMED":
      return "You confirmed the session for this setup.";
    case "CONFIRMATION_NOT_REQUIRED":
      return "AgentOrg answers this Actor's requests, so Desktop needn't confirm its session.";
    case "ACTOR_PAUSED":
      return `${d.actorId} is paused.`;
    case "ACTOR_TOOLS_MISSING":
      return `${d.actorId}'s session hasn't listed its Hub tools yet.`;
    case "ACTOR_TOOLS_READY":
      return "The Actor's session lists its Hub tools.";
    default:
      return step.code.replaceAll("_", " ").toLowerCase();
  }
}

const SHORT: Partial<Record<StepId, string>> = {
  hub: "Hub not connected",
  login: "Remote Login off",
  access: "SSH access not ready",
  desktop: "Desktop not connected",
  folder: "Folder not ready in Desktop",
};
const REASONS: Record<string, string> = {
  ACTOR_PROVISIONING_FAILED: "Session creation failed: detach and attach again",
  ACTOR_CREATING: "Creating its session",
  SESSION_UNCONFIRMED: "Waiting for Desktop: confirm the session",
  ACTOR_TOOLS_MISSING: "Tools not ready",
};

/**
 * The one reason an Actor isn't working, and the Setup step that fixes it. Only a step that needs
 * someone counts, and a step about one Actor counts only for that Actor.
 */
export function actorStatus(
  actor: ActorSnapshot,
  guide: Guide | null,
): { text: string; step?: StepId; ready?: boolean } {
  if (actor.connectionState === "suspended") return { text: "Suspended: resume its connection" };
  const blocker = guide?.steps.find(
    (s) =>
      (s.state === "missing" || s.state === "broken") &&
      (s.details?.actorId ?? actor.actorId) === actor.actorId &&
      s.code !== "ACTOR_PAUSED",
  );
  if (blocker)
    return {
      text: REASONS[blocker.code] ?? SHORT[blocker.id] ?? TITLES[blocker.id],
      step: blocker.id,
    };
  if (actor.connectionState === "awaiting-desktop")
    return { text: REASONS.SESSION_UNCONFIRMED, step: "session" };
  if (!actor.enabled) return { text: "Paused" };
  if (actor.requests.length)
    return {
      text: `Request pending: answer in ${actor.approvalAuthority === "desktop" ? "Codex Desktop" : "AgentOrg"}`,
    };
  if (actor.connectionState === "connected") return { text: "Ready", ready: true };
  return { text: "Connecting" };
}

export function StateBadge({ state }: { state: GuideStep["state"] }) {
  return (
    <Badge variant="outline" className={STATE[state].className}>
      {STATE[state].icon}
      {STATE[state].label}
    </Badge>
  );
}

/** The Setup heading's one line: what is next, or Ready. */
export function nextLine(guide: Guide): string {
  const next = guide.steps.find((s) => s.state !== "done");
  return next ? `Next: ${TITLES[next.id]}` : "Ready: the Actor works from Codex Desktop.";
}

export function GuideSteps(p: GuideFeature) {
  return (
    <ol className="guide-steps">
      {p.guide.steps.map((step, i) => (
        <li key={step.id}>
          <Card id={`step-${step.id}`} className={`guide-step guide-${step.state}`}>
            <CardHeader>
              <div className="guide-step-head">
                <span className="step-number">{i + 1}</span>
                <CardTitle>{TITLES[step.id]}</CardTitle>
                <StateBadge state={step.state} />
              </div>
              <CardDescription>{fact(step)}</CardDescription>
            </CardHeader>
            {step.state === "missing" ||
            step.state === "broken" ||
            (step.id === "access" && p.guide.accessPresent) ? (
              <StepBody step={step} {...p} />
            ) : null}
          </Card>
        </li>
      ))}
    </ol>
  );
}

/** The person's instructions and the console's actions for a step that isn't done. */
function StepBody(p: GuideFeature & { step: GuideStep }) {
  const d = (p.step.details ?? {}) as Record<string, any>;
  const recheck = (
    <Button variant="outline" size="sm" disabled={p.checking} onClick={p.onRecheck}>
      <RefreshCw />
      Re-check
    </Button>
  );
  const remove = (
    <Button
      variant="ghost"
      size="sm"
      disabled={p.busy}
      onClick={() => p.onAsk({ kind: "remove-access" })}
    >
      Remove SSH access
    </Button>
  );
  let body: ReactNode =
    p.step.state === "waiting" || p.step.state === "done" ? null : <Actions>{recheck}</Actions>;
  switch (p.step.code) {
    case "HUB_UNCONFIGURED":
      body = (
        <p className="muted text-sm">
          Enroll this Provider on the Hub's machine, then start the console with HUB_URL,
          PROVIDER_ID and PROVIDER_CREDENTIAL.
        </p>
      );
      break;
    case "PROVIDER_PAUSED":
    case "PROVIDER_SUSPENDED":
      body = (
        <Actions>
          <Button size="sm" onClick={() => p.onPage("provider")}>
            Open Provider
          </Button>
        </Actions>
      );
      break;
    case "HUB_REJECTED":
      body = (
        <p className="muted text-sm">
          Enroll this Provider again on the Hub's machine, then restart the console with the new
          credential.
        </p>
      );
      break;
    case "REMOTE_LOGIN_OFF":
      body = (
        <>
          <Person
            items={[
              "Open System Settings → General → Sharing.",
              "Turn on Remote Login.",
              "Under Allow access for, choose Only these users, with your user.",
              "Leave Allow full disk access for remote users off.",
            ]}
          />
          <Actions>{recheck}</Actions>
        </>
      );
      break;
    case "ACCESS_CONFLICT":
      body = (
        <>
          <p className="muted text-sm">Rename or remove that host, then re-check.</p>
          <Actions>{recheck}</Actions>
        </>
      );
      break;
    case "ACCESS_MISSING":
      body = (
        <Actions>
          <Button disabled={p.busy} onClick={p.onSetUpAccess}>
            Set up SSH access for this Mac
          </Button>
        </Actions>
      );
      break;
    case "ACCESS_OVERRIDDEN":
      body = (
        <>
          <p className="muted text-sm">Move or remove that line for this-mac, then re-check.</p>
          <Actions>{recheck}</Actions>
        </>
      );
      break;
    case "ACCESS_INCOMPLETE":
    case "PROVIDER_KEY_REFUSED":
    case "DESKTOP_KEY_REFUSED":
      body = (
        <>
          <p className="muted text-sm">Remove this Provider's SSH access, then set it up again.</p>
          <Actions>{recheck}</Actions>
        </>
      );
      break;
    case "DESKTOP_NOT_CONNECTED":
      body = (
        <>
          <Person
            items={[
              "In Codex Desktop, open Settings → Connections.",
              "Under SSH connections from this Mac, turn on this-mac.",
            ]}
          />
          <Actions>{recheck}</Actions>
        </>
      );
      break;
    case "FOLDER_UNCHOSEN":
    case "FOLDER_NOT_DIRECTORY":
      body = <ChooseFolder {...p} />;
      break;
    case "FOLDER_HAS_ADAPTER":
      body = <Refused path={d.path} disconnect={d.disconnect} {...p} />;
      break;
    case "FOLDER_MISSING":
      body = (
        <Actions>
          <Button
            disabled={p.busy}
            onClick={() => p.onAsk({ kind: "create-folder", path: d.path })}
          >
            Create folder
          </Button>
        </Actions>
      );
      break;
    case "FOLDER_NOT_IN_DESKTOP":
    case "FOLDER_LOCAL_PROJECT":
      body = (
        <>
          <Person
            items={[
              "In Codex Desktop, open Settings → Connections.",
              "Under SSH connections from this Mac, choose Add a remote project on this-mac.",
              `Enter ${d.path}, then choose Use folder.`,
            ]}
          />
          <Actions>{recheck}</Actions>
        </>
      );
      break;
    case "PREFLIGHT_REFUSED":
      body = (
        <>
          <p className="muted text-sm">
            Check the .codex/config.toml files in this folder and the folders above it, then
            re-check.
          </p>
          <Actions>{recheck}</Actions>
        </>
      );
      break;
    case "ACTOR_PROVISIONING_FAILED":
      body = (
        <Actions>
          <Button disabled={p.busy} onClick={() => p.onAsk({ kind: "detach", actorId: d.actorId })}>
            Detach {d.actorId}
          </Button>
          <span className="muted text-xs">Then attach it again with its credential.</span>
        </Actions>
      );
      break;
    case "NO_ACTOR":
      body = (
        <>
          <AttachFields attach={p.attach} onAttachField={p.onAttachField} />
          <Actions>
            <Button disabled={p.busy || !p.attach.actorId} onClick={p.onAttach}>
              Attach Actor
            </Button>
            <span className="muted text-xs">Or create it from the Hub with this Provider.</span>
          </Actions>
        </>
      );
      break;
    case "SESSION_UNCONFIRMED":
      body = (
        <>
          <Person
            items={[
              `In Codex Desktop, open the project ${
                d.project ??
                String(d.path ?? "")
                  .split("/")
                  .pop()
              } on this-mac.`,
              `Open ${d.actorId}'s session, ${d.threadId}.`,
            ]}
          />
          <Actions>
            <Button disabled={p.busy} onClick={() => p.onConfirmSession(d.threadId)}>
              I see it
            </Button>
          </Actions>
        </>
      );
      break;
    case "ACTOR_PAUSED":
      body = (
        <Actions>
          <Button size="sm" onClick={() => p.onPage("actors")}>
            Open Actors
          </Button>
        </Actions>
      );
      break;
  }
  // The guide's access can be removed whatever step the guide is on.
  if (p.step.id === "access" && p.guide.accessPresent)
    body = (
      <>
        {body}
        <Actions>{remove}</Actions>
      </>
    );
  return <CardContent className="stack">{body}</CardContent>;
}

function ChooseFolder(p: GuideFeature) {
  if (p.refusedFolder) return <Refused path={p.refusedFolder} {...p} />;
  return (
    <>
      <div className="field">
        <span>Folder</span>
        <Input
          aria-label="Folder"
          value={p.folder ?? p.guide.folder.suggested}
          onChange={(e) => p.onFolder(e.target.value)}
        />
      </div>
      <Actions>
        <Button
          disabled={p.busy}
          onClick={() => p.onChooseFolder(p.folder ?? p.guide.folder.suggested)}
        >
          Use this folder
        </Button>
      </Actions>
    </>
  );
}

const shellQuote = (path: string) => `'${path.replaceAll("'", `'\\''`)}'`;

/** A folder connected to AgentOrg's Codex adapter, with its two fixes. */
function Refused(p: GuideFeature & { path: string; disconnect?: string }) {
  return (
    <>
      <div role="status" className="notice">
        {p.path} can't hold this Actor: AgentOrg's Codex adapter is connected there, and Codex would
        refuse the Actor's session. Use a folder of its own, or disconnect the adapter.
      </div>
      <Actions>
        <Button
          className="wrap-button"
          disabled={p.busy}
          onClick={() => p.onChooseFolder(p.guide.folder.suggested)}
        >
          Use {p.guide.folder.suggested}
        </Button>
        <Button variant="outline" size="sm" disabled={p.checking} onClick={p.onRecheck}>
          <RefreshCw />
          Re-check
        </Button>
      </Actions>
      <p className="muted text-sm">
        Or, keeping that folder:{" "}
        <code>
          {p.disconnect ?? `agentorg-mcp disconnect codex --project ${shellQuote(p.path)}`}
        </code>
      </p>
    </>
  );
}

export function AttachFields(p: {
  attach: AttachForm;
  onAttachField(name: keyof AttachForm, value: string): void;
}) {
  return (
    <div className="attach-fields">
      {(
        [
          ["actorId", "Actor ID", "text"],
          ["credential", "Actor credential", "password"],
          ["model", "Model (optional)", "text"],
        ] as const
      ).map(([name, label, type]) => (
        <div className="field" key={name}>
          <span>{label}</span>
          <Input
            aria-label={label}
            type={type}
            autoComplete="off"
            placeholder={name === "model" ? "Backend default" : undefined}
            value={p.attach[name]}
            onChange={(e) => p.onAttachField(name, e.target.value)}
          />
        </div>
      ))}
    </div>
  );
}

function Person({ items }: { items: string[] }) {
  return (
    <ol className="guide-person">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="actions">{children}</div>;
}

function Write({ write }: { write: AccessWrite }) {
  switch (write.action) {
    case "key":
      return (
        <>
          Create <code>{write.path}</code> ({write.mode}): Codex Desktop's private key,{" "}
          {write.fingerprint}
        </>
      );
    case "directory":
      return (
        <>
          Create the folder <code>{write.path}</code> ({write.mode})
        </>
      );
    case "backup":
      return (
        <>
          Copy <code>{write.from}</code> to <code>{write.path}</code>
        </>
      );
    case "backend":
      return (
        <>
          Use SSH to {write.user}@{write.host}:{write.port} as this Provider's Codex backend, with
          its own key, {write.fingerprint}
        </>
      );
    default:
      return (
        <>
          {write.action === "file" ? (
            <>
              Create <code>{write.path}</code> ({write.mode}):
            </>
          ) : write.creates ? (
            <>
              Create <code>{write.path}</code> (0600) with:
            </>
          ) : (
            <>
              Append to <code>{write.path}</code>:
            </>
          )}
          <pre className="consent-lines">{write.lines.join("\n")}</pre>
        </>
      );
  }
}

export function ConsentView(p: ConsentFeature) {
  const c = p.consent;
  const title =
    c?.kind === "access"
      ? "Set up SSH access for this Mac"
      : c?.kind === "remove-access"
        ? "Remove this Provider's SSH access"
        : c?.kind === "create-folder"
          ? "Create the Actor's folder"
          : `Detach ${c?.kind === "detach" ? c.actorId : ""}`;
  return (
    <Dialog open={c !== null} onOpenChange={(open) => !open && p.onCancel()}>
      <DialogContent className="consent">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Nothing changes until you confirm.</DialogDescription>
        </DialogHeader>
        <ul className="consent-writes">
          {c?.kind === "access" ? (
            c.writes.map((write) => (
              <li key={`${write.action}:${"path" in write ? write.path : "backend"}`}>
                <Write write={write} />
              </li>
            ))
          ) : c?.kind === "remove-access" ? (
            <>
              <li>
                Remove the lines between this Provider's BEGIN and END markers from{" "}
                <code>~/.ssh/authorized_keys</code> and <code>~/.ssh/config</code>, keeping
                everything else
              </li>
              <li>Delete Desktop's key, known_hosts and desktop-shell from the runtime folder</li>
              <li>Delete the backup of ~/.ssh/config once the config matches it again</li>
              <li>Clear this Provider's SSH backend</li>
            </>
          ) : c?.kind === "create-folder" ? (
            <li>
              Create <code>{c.path}</code>
            </li>
          ) : c?.kind === "detach" ? (
            <li>
              Forget {c.actorId} on this Provider: its session binding and creation record. Its Hub
              identity and its Codex session stay; attach it again with its credential.
            </li>
          ) : null}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={p.onCancel}>
            Cancel
          </Button>
          <Button disabled={p.busy} onClick={p.onConfirm}>
            {c?.kind === "access"
              ? "Write these"
              : c?.kind === "remove-access"
                ? "Remove access"
                : c?.kind === "create-folder"
                  ? "Create folder"
                  : "Detach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
