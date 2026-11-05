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
import type { ActorSnapshot, Guide, GuideStep, StepId } from "../../../src/management/schema";
import type { AttachForm, ConsentFeature, GuideFeature } from "../features";

export const TITLES: Record<StepId, string> = {
  hub: "Hub",
  codex: "Codex on this Mac",
  account: "ChatGPT account",
  folder: "Workspace folder",
  actor: "Actor",
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
    case "CODEX_NOT_FOUND":
      return "Codex Desktop's codex isn't installed on this Mac.";
    case "CODEX_NOT_IN_USE":
      return "This Provider doesn't use Codex on this Mac yet.";
    case "CODEX_UNREACHABLE":
      return `Codex's app server on this Mac doesn't answer at ${d.socket}.`;
    case "APP_SERVER_INITIALIZED":
      return `Codex's app server on this Mac answers at ${d.socket}.`;
    case "PLAN_USAGE_ALLOWED":
      return "Signed in to ChatGPT, and the plan allows this usage.";
    case "CHATGPT_SIGN_IN_REQUIRED":
      return "Codex on this Mac isn't signed in to ChatGPT.";
    case "PLAN_USAGE_DENIED":
      return "The ChatGPT plan doesn't allow this usage.";
    case "CHATGPT_AUTHENTICATED_QUOTA_UNAVAILABLE":
      return "Signed in to ChatGPT; the plan's usage can't be read yet.";
    case "FOLDER_UNCHOSEN":
      return "No workspace folder is chosen.";
    case "FOLDER_MISSING":
      return `${d.path} doesn't exist yet.`;
    case "FOLDER_NOT_DIRECTORY":
      return `${d.path} isn't a folder.`;
    case "FOLDER_HAS_ADAPTER":
      return "Its .codex/config.toml connects AgentOrg's Codex adapter as mcp_servers.org, the name this Actor's tools use.";
    case "PREFLIGHT_REFUSED":
      return `Codex refused a test session in ${d.path} with the Actor's settings.`;
    case "FOLDER_READY":
      return d.project
        ? `Sessions start in ${d.path}, filed under its Codex project ${d.project}.`
        : `Sessions start in ${d.path}. Codex couldn't file it as a project, so Codex Desktop lists them outside one.`;
    case "ACTOR_PROVISIONING_FAILED":
      return `${d.actorId}'s session couldn't be created here.`;
    case "ACTOR_CREATING":
      return "Creating the Actor's session.";
    case "NO_ACTOR":
      return "No Actor is attached.";
    case "ACTOR_ATTACHED":
      return `${(d.actors as { actorId: string }[]).map((a) => a.actorId).join(", ")} has its session.`;
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
  codex: "Codex not reachable",
  account: "ChatGPT account not ready",
  folder: "Workspace folder not ready",
};
const REASONS: Record<string, string> = {
  ACTOR_PROVISIONING_FAILED: "Session creation failed: detach and attach again",
  ACTOR_CREATING: "Creating its session",
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
  return next ? `Next: ${TITLES[next.id]}` : "Ready: the Actor works through Codex on this Mac.";
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
            {step.state === "missing" || step.state === "broken" ? (
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
  let body: ReactNode = <Actions>{recheck}</Actions>;
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
    case "CODEX_NOT_FOUND":
      body = (
        <>
          <p className="muted text-sm">Install the ChatGPT app with Codex, then re-check.</p>
          <Actions>{recheck}</Actions>
        </>
      );
      break;
    case "CODEX_NOT_IN_USE":
      body = (
        <Actions>
          <Button
            disabled={p.busy}
            onClick={() => p.onAsk({ kind: "use-codex", socket: d.socket })}
          >
            Use Codex on this Mac
          </Button>
        </Actions>
      );
      break;
    case "CHATGPT_SIGN_IN_REQUIRED":
      body = (
        <Actions>
          <Button size="sm" onClick={() => p.onPage("backend")}>
            Open Codex backend
          </Button>
          {recheck}
        </Actions>
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

function Actions({ children }: { children: ReactNode }) {
  return <div className="actions">{children}</div>;
}

export function ConsentView(p: ConsentFeature) {
  const c = p.consent;
  const title =
    c?.kind === "use-codex"
      ? "Use Codex on this Mac"
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
          {c?.kind === "use-codex" ? (
            <>
              <li>
                Start Codex's app server for this Mac's <code>~/.codex</code> if it isn't running,
                as Codex Desktop does: <code>codex app-server daemon start</code>
              </li>
              <li>
                Use it, at <code>{c.socket}</code>, as this Provider's Codex backend
              </li>
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
            {c?.kind === "use-codex"
              ? "Use Codex on this Mac"
              : c?.kind === "create-folder"
                ? "Create folder"
                : "Detach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
