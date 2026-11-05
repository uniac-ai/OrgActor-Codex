import {
  Cable,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  KeyRound,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Square,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { Probe, ProbeStage } from "../../../src/management/schema";
import type { ActorsFeature, SetupFeature, SetupForm, ViewSet } from "../features";
import { AttachFields, actorStatus, ConsentView, GuideSteps, nextLine, TITLES } from "./guide";

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-heading">
      <h1>{title}</h1>
      {children ? <p>{children}</p> : null}
    </header>
  );
}
function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  return (
    <div className="field">
      <span>{label}</span>
      {children}
      {help ? <small>{help}</small> : null}
    </div>
  );
}
function Status({ probe }: { probe?: Probe }) {
  return (
    <Badge
      variant={probe?.state === "ready" ? "secondary" : "outline"}
      className={probe?.state === "ready" ? "status-ready" : ""}
    >
      {probe?.state === "ready" ? <CheckCircle2 /> : <CircleHelp />}
      {probe ? probe.state : "Not checked"}
    </Badge>
  );
}
const stages: { id: ProbeStage; title: string; description: string }[] = [
  { id: "backend", title: "Codex connection", description: "Reach the shared app server." },
  { id: "account", title: "ChatGPT plan", description: "Verify sign-in and included usage." },
  {
    id: "bridge",
    title: "Container connection",
    description: "Reach this container from the Codex host.",
  },
  { id: "hub", title: "Hub admission", description: "Verify the enrolled Provider identity." },
];
function SetupView(p: SetupFeature) {
  if (!p.guided)
    return (
      <>
        <Heading title="Setup">Connect your Codex workspace.</Heading>
        <ManualSetup {...p} />
      </>
    );
  return (
    <>
      <Heading title="Setup">{nextLine(p.guided.guide)}</Heading>
      <GuideSteps {...p.guided} />
      <details className="other-setups" open={!p.guided.guide.inUse && !!p.state.settings.backend}>
        <summary>Other setups</summary>
        <ManualSetup {...p} />
      </details>
    </>
  );
}
function ManualSetup(p: SetupFeature) {
  const field = (name: keyof SetupForm, label: string, secret = false, help?: string) => (
    <Field label={label} help={help}>
      <Input
        aria-label={label}
        autoComplete="off"
        type={secret ? "password" : "text"}
        value={p.form[name]}
        onChange={(e) => p.onField(name, e.target.value as never)}
      />
    </Field>
  );
  return (
    <div className="setup-layout">
      <div className="stack">
        <Card>
          <CardHeader>
            <CardTitle>Codex backend</CardTitle>
            <CardDescription>Codex's app server, where the Actors' sessions run.</CardDescription>
          </CardHeader>
          <CardContent className="stack">
            {field(
              "endpoint",
              "App server endpoint",
              false,
              "Codex's app server: a unix:///path/to/socket, or a protected WebSocket listener.",
            )}
            {field(
              "workspaceRoot",
              "Workspace root",
              false,
              "The folder the Actor works in. Its sessions are filed under its Codex project.",
            )}
            {field(
              "bridgeUrl",
              "Container MCP address",
              false,
              "This address must be reachable from the Codex host.",
            )}
          </CardContent>
        </Card>
        <div className="actions">
          <Button disabled={p.busy} onClick={p.onSave}>
            Save connections
          </Button>
          <span className="muted text-xs">Pause enabled connections before changing settings.</span>
        </div>
      </div>
      <aside className="stack">
        <Card>
          <CardHeader>
            <CardTitle>Verify setup</CardTitle>
          </CardHeader>
          <CardContent className="probe-list">
            {stages.map((s, i) => (
              <div className="probe" key={s.id}>
                <div className="step-number">{i + 1}</div>
                <div className="min-w-0 flex-1">
                  <h3>{s.title}</h3>
                  <p>{s.description}</p>
                  <Status probe={p.state.probes[s.id]} />
                  {p.state.probes[s.id] ? (
                    <p className="probe-code">
                      {p.state.probes[s.id]?.code.replaceAll("_", " ").toLowerCase()}
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Check ${s.title}`}
                  disabled={p.busy}
                  onClick={() => p.onProbe(s.id)}
                >
                  <RefreshCw />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
function ActorStatus({
  status,
  onStep,
}: {
  status: ReturnType<typeof actorStatus>;
  onStep: ActorsFeature["onSetupStep"];
}) {
  if (status.step)
    return (
      <Button
        variant="outline"
        size="sm"
        className="state-missing"
        onClick={() => onStep(status.step as never)}
      >
        {status.text}
        <ChevronRight />
      </Button>
    );
  return (
    <Badge variant="outline" className={status.ready ? "status-ready" : ""}>
      {status.text}
    </Badge>
  );
}
function ActorsView(p: ActorsFeature) {
  const actor = p.selectedActor;
  const step = p.guide?.steps.find((s) => s.id === "actor");
  // Attaching follows the guide's order: the folder open in Desktop and a session accepted there.
  const gate =
    step?.state === "waiting" ? { on: step.details?.on as keyof typeof TITLES } : undefined;
  const status = actor ? actorStatus(actor, p.guide) : undefined;
  return (
    <>
      <Heading title="Actors">Attach existing Hub positions to managed Codex sessions.</Heading>
      <Card>
        <CardHeader>
          <CardTitle>Attach Actor</CardTitle>
          <CardDescription>
            Use the identity and bootstrap credential issued by your Hub. Attached Actors run with
            full access to this Mac.
          </CardDescription>
        </CardHeader>
        <CardContent className="stack">
          <div className="attach-row">
            <AttachFields attach={p.attach} onAttachField={p.onAttachField} />
            <Button disabled={p.busy || !p.attach.actorId || !!gate} onClick={p.onAttach}>
              <Plus />
              Attach Actor
            </Button>
          </div>
          {gate ? (
            <Button
              variant="link"
              className="self-start px-0"
              onClick={() => p.onSetupStep(gate.on)}
            >
              Attaching waits for {TITLES[gate.on].toLowerCase()} in Setup
              <ChevronRight />
            </Button>
          ) : null}
        </CardContent>
      </Card>
      <div className="actor-layout">
        <Card>
          <CardHeader>
            <CardTitle>
              Hosted Actors <span className="count">{p.actors.length}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {p.actors.length ? (
              <div className="table-scroll">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Actor</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Queue</TableHead>
                      <TableHead>
                        <span className="sr-only">Controls</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {p.actors.map((a) => (
                      <TableRow key={a.actorId}>
                        <TableCell>
                          <Button variant="link" onClick={() => p.onSelect(a.actorId)}>
                            {a.actorId}
                          </Button>
                        </TableCell>
                        <TableCell>
                          <ActorStatus status={actorStatus(a, p.guide)} onStep={p.onSetupStep} />
                        </TableCell>
                        <TableCell>{a.queued}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`${a.connectionState === "suspended" || !a.enabled ? "Resume connection for" : "Pause connection for"} ${a.actorId}`}
                            disabled={p.busy}
                            onClick={() => p.onToggleConnection(a.actorId)}
                          >
                            {a.connectionState === "suspended" || !a.enabled ? <Play /> : <Pause />}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="empty">
                <Users />
                <h3>No Actors attached</h3>
                <p>Attach a Hub Actor above, or request one through this Provider from your Hub.</p>
              </div>
            )}
          </CardContent>
        </Card>
        {actor ? (
          <Card>
            <CardHeader>
              <CardTitle>{actor.actorId}</CardTitle>
              <CardDescription className="break-all">
                Session {actor.threadId || "creation outcome unknown"}
              </CardDescription>
            </CardHeader>
            <CardContent className="stack">
              {status && !status.ready ? (
                <div role="status" className="notice actor-reason">
                  <span>{status.text}</span>
                  {status.step ? (
                    <Button variant="link" onClick={() => p.onSetupStep(status.step as never)}>
                      Open in Setup
                      <ChevronRight />
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <p className="muted text-sm">
                Runs with full access to this Mac, network included, and never asks for approval.
              </p>
              {actor.observation === "unavailable" ? (
                <div role="status" className="notice">
                  Native state is unavailable. Resume the connection to refresh the current turn.
                </div>
              ) : null}
              {actor.lastError ? (
                <div role="status" className="notice">
                  {actor.lastError}
                </div>
              ) : null}
              <Field label="Task input">
                <Textarea
                  aria-label="Task input"
                  rows={4}
                  value={p.text}
                  onChange={(e) => p.onText(e.target.value)}
                  placeholder="Give this Actor a task…"
                />
              </Field>
              <div className="actions">
                <Button
                  disabled={p.busy || !p.text.trim() || !actor.connected}
                  onClick={p.onSubmit}
                >
                  Queue task
                </Button>
                <Button
                  variant="outline"
                  disabled={p.busy || !p.text.trim() || !actor.turnId}
                  onClick={p.onSteer}
                >
                  Steer turn
                </Button>
                <Button
                  variant="destructive"
                  disabled={p.busy || !actor.turnId}
                  onClick={p.onInterrupt}
                >
                  <Square />
                  Interrupt
                </Button>
              </div>
              <Button
                variant="outline"
                disabled={p.busy || !actor.connected}
                onClick={p.onTerminals}
              >
                Background terminals
              </Button>
              <div className="output" role="log" aria-label="Actor output">
                {actor.output || "Output appears when the Actor runs."}
              </div>
              <Button
                variant="ghost"
                className="self-start"
                disabled={p.busy}
                onClick={() => p.onDetach(actor.actorId)}
              >
                Detach Actor
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </div>
      <Dialog
        open={p.terminals !== null}
        onOpenChange={(open) => {
          if (!open) p.onCloseTerminals();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Background terminals</DialogTitle>
          </DialogHeader>
          {p.terminals?.length ? (
            p.terminals.map((t) => (
              <div key={t.processId} className="terminal-row">
                <code>{t.command}</code>
                <Button
                  variant="destructive"
                  disabled={p.busy}
                  onClick={() => p.onTerminate(t.processId)}
                >
                  Stop terminal
                </Button>
              </div>
            ))
          ) : (
            <p className="muted">No running background terminals were reported for this session.</p>
          )}
          <p className="muted text-xs">
            Interrupting a turn and stopping a background terminal are separate actions.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
export const views = {
  Shell: (p) => (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Operations</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {(
                  [
                    ["setup", "Setup", Settings2],
                    ["provider", "Provider", Cable],
                    ["actors", "Actors", Users],
                    ["backend", "Codex backend", Server],
                  ] as const
                ).map(([id, label, Icon]) => (
                  <SidebarMenuItem key={id}>
                    <SidebarMenuButton isActive={p.page === id} onClick={() => p.onPage(id)}>
                      <Icon />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <div className="mobile-bar">
          <SidebarTrigger />
          <span>
            {
              { setup: "Setup", provider: "Provider", actors: "Actors", backend: "Codex backend" }[
                p.page
              ]
            }
          </span>
        </div>
        <div className="console-main">
          {p.error ? (
            <div role="alert" className="error">
              {p.error}
            </div>
          ) : null}
          {p.children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  ),
  Loading: (p) => (
    <div className="console-main">
      <Heading title="Connecting…" />
      {p.error ? (
        <div role="alert" className="error">
          {p.error}
        </div>
      ) : null}
    </div>
  ),
  Setup: SetupView,
  Consent: ConsentView,
  Provider: (p) => (
    <>
      <Heading title="Provider">Provision Codex execution for existing Hub Actors.</Heading>
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Hub connection</CardTitle>
          <CardDescription>
            {p.state.settings.hub?.url ?? "Hub is not configured on this server."}
          </CardDescription>
        </CardHeader>
        <CardContent className="stack">
          <dl className="facts">
            <dt>Provider ID</dt>
            <dd>{p.state.settings.hub?.providerId ?? "Not configured"}</dd>
            <dt>Connection</dt>
            <dd>
              <Badge variant="outline">
                {
                  {
                    connected: "Connected",
                    connecting: "Connecting",
                    paused: "Paused",
                    suspended: "Suspended",
                    unconfigured: "Unconfigured",
                    unreachable: "Unreachable",
                    rejected: "Rejected",
                  }[p.state.provider.state]
                }
              </Badge>
            </dd>
            <dt>Admission check</dt>
            <dd>
              <Status probe={p.state.probes.hub} />
            </dd>
          </dl>
          {p.state.provider.error ? <div className="notice">{p.state.provider.error}</div> : null}
          <div className="actions">
            <Button disabled={p.busy || !p.state.settings.hub} onClick={p.onToggle}>
              {!p.state.settings.hub ||
              ["suspended", "rejected"].includes(p.state.provider.state) ||
              !p.state.provider.enabled ? (
                <Play />
              ) : (
                <Pause />
              )}
              {["suspended", "rejected"].includes(p.state.provider.state)
                ? "Resume Provider"
                : !p.state.settings.hub
                  ? "Enable Provider"
                  : p.state.provider.enabled
                    ? "Pause Provider"
                    : "Enable Provider"}
            </Button>
            <Button variant="outline" disabled={p.busy} onClick={p.onProbe}>
              <RefreshCw />
              Check admission
            </Button>
          </div>
          <p className="muted text-sm">
            Pausing the Provider stops new provisioning. Attached Actors keep their independent Hub
            connections.
          </p>
        </CardContent>
      </Card>
    </>
  ),
  Backend: (p) => (
    <>
      <Heading title="Codex backend">Manage connectivity and ChatGPT authentication.</Heading>
      <div className="grid-two">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="size-4" />
              Backend
            </CardTitle>
          </CardHeader>
          <CardContent className="stack">
            <dl className="facts">
              <dt>App server</dt>
              <dd className="break-all">
                {p.state.settings.backend?.endpoint ?? "Not configured"}
              </dd>
              <dt>Workspace</dt>
              <dd className="break-all">{p.state.settings.workspaceRoot ?? "Not configured"}</dd>
              <dt>Connection</dt>
              <dd>
                <Status probe={p.state.probes.backend} />
              </dd>
            </dl>
            <div className="actions">
              <Button variant="outline" disabled={p.busy} onClick={() => p.onProbe("backend")}>
                Check connection
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4" />
              ChatGPT account
            </CardTitle>
          </CardHeader>
          <CardContent className="stack">
            <Status probe={p.state.probes.account} />
            <p className="muted text-sm">
              This runtime uses the backend's ChatGPT sign-in and plan quota. Sign-in starts only
              when you choose it here.
            </p>
            <div className="actions">
              <Button disabled={p.busy || !!p.loginUrl} onClick={p.onLogin}>
                Start sign-in
              </Button>
              <Button variant="outline" disabled={p.busy} onClick={() => p.onProbe("account")}>
                Check account & quota
              </Button>
            </div>
            {p.loginUrl ? (
              <div className="notice">
                <a href={p.loginUrl} target="_blank" rel="noreferrer">
                  Continue ChatGPT sign-in ↗
                </a>
                <Button variant="ghost" disabled={p.busy} onClick={p.onCancelLogin}>
                  Cancel sign-in
                </Button>
              </div>
            ) : null}
            {p.state.probes.account?.details ? (
              <dl className="facts">
                <dt>Plan</dt>
                <dd>{String(p.state.probes.account.details.planType ?? "Unavailable")}</dd>
                <dt>Included usage</dt>
                <dd>
                  {p.state.probes.account.details.ordinaryUsageAllowed === true
                    ? "Allowed"
                    : "Not confirmed"}
                </dd>
              </dl>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  ),
  Actors: ActorsView,
} satisfies ViewSet;
