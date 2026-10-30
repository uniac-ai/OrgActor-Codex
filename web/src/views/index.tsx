import {
  Cable,
  CheckCircle2,
  CircleHelp,
  KeyRound,
  LogOut,
  Monitor,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
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
    id: "desktop",
    title: "Desktop workspace",
    description: "Open the exact saved workspace root in Codex Desktop.",
  },
  {
    id: "bridge",
    title: "Container connection",
    description: "Reach this container from the Codex host.",
  },
  { id: "hub", title: "Hub admission", description: "Verify the enrolled Provider identity." },
];
function SetupView(p: SetupFeature) {
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
    <>
      <Heading title="Setup">Connect your Codex workspace and AgentOrg Hub.</Heading>
      <div className="setup-layout">
        <div className="stack">
          <Card>
            <CardHeader>
              <CardTitle>Codex backend</CardTitle>
              <CardDescription>
                Use the backend shared with your Codex Desktop connection.
              </CardDescription>
            </CardHeader>
            <CardContent className="stack">
              <Field label="Connection">
                <Select
                  value={p.form.kind}
                  onValueChange={(value) => p.onField("kind", value as "ssh" | "app-server")}
                >
                  <SelectTrigger aria-label="Connection">
                    <SelectValue>
                      {p.form.kind === "ssh" ? "SSH host" : "Co-located app server"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ssh">SSH host</SelectItem>
                    <SelectItem value="app-server">Co-located app server</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {p.form.kind === "ssh" ? (
                <>
                  <div className="grid-two">
                    {field("host", "Host")}
                    {field("port", "SSH port")}
                  </div>
                  {field("user", "SSH user")}
                  {field(
                    "privateKey",
                    "SSH private key",
                    true,
                    p.state.settings.backend?.privateKeyPresent
                      ? "A key is stored. Leave blank to keep it."
                      : "Stored privately on the container.",
                  )}
                  <Field label="Verified known-host entry">
                    <Textarea
                      aria-label="Verified known-host entry"
                      rows={3}
                      value={p.form.knownHosts}
                      onChange={(e) => p.onField("knownHosts", e.target.value)}
                      placeholder="[host]:port ssh-ed25519 …"
                    />
                  </Field>
                </>
              ) : (
                field(
                  "endpoint",
                  "App server endpoint",
                  false,
                  "Use an existing unix:///path/to/socket or protected WebSocket listener.",
                )
              )}
              {field(
                "workspaceRoot",
                "Workspace root",
                false,
                "Use the exact root saved in Codex Desktop's SSH connection or local project.",
              )}
              {field(
                "bridgeUrl",
                "Container MCP address",
                false,
                "This address must be reachable from the Codex host.",
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>AgentOrg Hub</CardTitle>
            </CardHeader>
            <CardContent className="stack">
              {field("hubUrl", "Hub URL")}
              {field("providerId", "Provider ID")}
              {field(
                "credential",
                "Provider credential",
                true,
                p.state.settings.hub?.credentialPresent
                  ? "A credential is stored. Leave blank to keep it."
                  : "Enroll this Provider in the Hub first.",
              )}
            </CardContent>
          </Card>
          <div className="actions">
            <Button disabled={p.busy} onClick={p.onSave}>
              Save connections
            </Button>
            <span className="muted text-xs">
              Pause enabled connections before changing settings.
            </span>
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
          <p className="muted text-sm">
            In Codex Desktop, open Settings → Connections → SSH and use the exact workspace root
            saved above. Open an attached Actor's session to confirm it appears.
          </p>
          <Field label="Session visible in Desktop">
            <Input
              aria-label="Session visible in Desktop"
              placeholder="Attached Actor's session ID"
              value={p.desktopThread}
              onChange={(e) => p.onDesktopThread(e.target.value)}
            />
          </Field>
          <Button
            variant="outline"
            disabled={p.busy || !p.desktopThread}
            onClick={p.onConfirmDesktop}
          >
            Confirm I see this session
          </Button>
        </aside>
      </div>
    </>
  );
}
function ActorsView(p: ActorsFeature) {
  const actor = p.selectedActor;
  return (
    <>
      <Heading title="Actors">Attach existing Hub positions to managed Codex sessions.</Heading>
      <Card>
        <CardHeader>
          <CardTitle>Attach Actor</CardTitle>
          <CardDescription>
            Use the identity and bootstrap credential issued by your Hub.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="attach-row">
            <Field label="Actor ID">
              <Input
                aria-label="Actor ID"
                value={p.attach.actorId}
                onChange={(e) => p.onAttachField("actorId", e.target.value)}
              />
            </Field>
            <Field label="Actor credential">
              <Input
                aria-label="Actor credential"
                type="password"
                autoComplete="off"
                value={p.attach.credential}
                onChange={(e) => p.onAttachField("credential", e.target.value)}
              />
            </Field>
            <Field label="Model (optional)">
              <Input
                aria-label="Model (optional)"
                placeholder="Backend default"
                value={p.attach.model}
                onChange={(e) => p.onAttachField("model", e.target.value)}
              />
            </Field>
            <Button disabled={p.busy || !p.attach.actorId} onClick={p.onAttach}>
              <Plus />
              Attach Actor
            </Button>
          </div>
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
                      <TableHead>Connection</TableHead>
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
                          <Badge variant="outline">
                            {a.connected ? "Connected" : a.enabled ? "Connecting" : "Paused"}
                          </Badge>
                        </TableCell>
                        <TableCell>{a.queued}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`${a.enabled ? "Pause connection for" : "Resume connection for"} ${a.actorId}`}
                            disabled={p.busy}
                            onClick={() => p.onEnabled(a.actorId, !a.enabled)}
                          >
                            {a.enabled ? <Pause /> : <Play />}
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
              <Field label="Approval owner">
                <Select
                  value={actor.approvalAuthority}
                  disabled={p.busy || !!actor.requests.length}
                  onValueChange={(value) =>
                    p.onAuthority(actor.actorId, value as "desktop" | "hub")
                  }
                >
                  <SelectTrigger aria-label="Approval owner">
                    <SelectValue>
                      {actor.approvalAuthority === "desktop"
                        ? "Codex Desktop"
                        : "Designated Hub manager"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="desktop">Codex Desktop</SelectItem>
                    <SelectItem value="hub">Designated Hub manager</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {actor.observation === "unavailable" ? (
                <div role="status" className="notice">
                  Native state is unavailable. Resume the connection to refresh the current turn and
                  requests.
                </div>
              ) : null}
              {actor.lastError ? (
                <div role="status" className="notice">
                  {actor.lastError}
                </div>
              ) : null}
              {actor.requests.map((r) => (
                <div key={r.id} className="notice">
                  <strong>{r.summary}</strong>
                  <p>
                    Answer in{" "}
                    {actor.approvalAuthority === "desktop"
                      ? "Codex Desktop"
                      : "the Hub question as its designated answerer"}
                    .
                  </p>
                </div>
              ))}
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
        <SidebarFooter>
          <Button variant="ghost" className="justify-start" onClick={p.onLogout}>
            <LogOut />
            Sign out
          </Button>
        </SidebarFooter>
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
        <main>
          {p.error ? (
            <div role="alert" className="error">
              {p.error}
            </div>
          ) : null}
          {p.children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  ),
  SignIn: (p) => (
    <div className="signin">
      <Card>
        <CardHeader>
          <KeyRound className="mb-3 size-6" />
          <CardTitle>Operator sign-in</CardTitle>
          <CardDescription>
            Open the one-time link printed when OrgActor-Codex starts, or paste its sign-in token.
          </CardDescription>
        </CardHeader>
        <CardContent className="stack">
          {p.error ? (
            <div role="alert" className="error">
              {p.error}
            </div>
          ) : null}
          <Field label="Sign-in token">
            <Input
              aria-label="Sign-in token"
              type="password"
              autoComplete="off"
              value={p.token}
              onChange={(e) => p.onToken(e.target.value)}
            />
          </Field>
          <Button disabled={p.loading || !p.token} onClick={p.onSignIn}>
            {p.loading ? "Connecting…" : "Sign in"}
          </Button>
        </CardContent>
      </Card>
    </div>
  ),
  Setup: SetupView,
  Provider: (p) => (
    <>
      <Heading title="Provider">Provision Codex execution for existing Hub Actors.</Heading>
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Hub connection</CardTitle>
          <CardDescription>
            {p.state.settings.hub?.url ?? "Configure a Hub in Setup."}
          </CardDescription>
        </CardHeader>
        <CardContent className="stack">
          <dl className="facts">
            <dt>Provider ID</dt>
            <dd>{p.state.settings.hub?.providerId ?? "Not configured"}</dd>
            <dt>Connection</dt>
            <dd>
              <Badge variant="outline">
                {p.state.provider.connected
                  ? "Connected"
                  : p.state.provider.enabled
                    ? "Connecting"
                    : "Paused"}
              </Badge>
            </dd>
            <dt>Admission check</dt>
            <dd>
              <Status probe={p.state.probes.hub} />
            </dd>
          </dl>
          {p.state.provider.error ? <div className="notice">{p.state.provider.error}</div> : null}
          <div className="actions">
            <Button
              disabled={p.busy || !p.state.settings.hub}
              onClick={() => p.onEnabled(!p.state.provider.enabled)}
            >
              {p.state.provider.enabled ? <Pause /> : <Play />}
              {p.state.provider.enabled ? "Pause Provider" : "Enable Provider"}
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
              <dt>Transport</dt>
              <dd>
                {p.state.settings.backend?.kind === "ssh"
                  ? "SSH"
                  : p.state.settings.backend
                    ? "Co-located app server"
                    : "Not configured"}
              </dd>
              <dt>Workspace</dt>
              <dd className="break-all">{p.state.settings.workspaceRoot ?? "Not configured"}</dd>
              <dt>Connection</dt>
              <dd>
                <Status probe={p.state.probes.backend} />
              </dd>
              <dt>Desktop mapping</dt>
              <dd>
                <Status probe={p.state.probes.desktop} />
              </dd>
            </dl>
            <div className="actions">
              <Button variant="outline" disabled={p.busy} onClick={() => p.onProbe("backend")}>
                Check connection
              </Button>
              <Button variant="outline" disabled={p.busy} onClick={() => p.onProbe("desktop")}>
                <Monitor />
                Check workspace
              </Button>
            </div>
            <p className="muted text-sm">
              Open Settings → Connections → SSH in Codex Desktop and select the saved workspace root
              shown above.
            </p>
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
