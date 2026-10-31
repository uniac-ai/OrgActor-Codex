import type {
  ConnectorSettings,
  Probe,
  ProbeStage,
  PublicState,
} from "../../../src/management/schema";
export class ManagementClient {
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const r = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await r.json();
    if (!r.ok) throw new Error(value.error?.message ?? "The console could not reach the server.");
    return value;
  }
  state() {
    return this.request<PublicState>("/state");
  }
  setup(value: ConnectorSettings) {
    return this.request("/setup", "PUT", value);
  }
  probe(stage: ProbeStage) {
    return this.request<Probe>(`/setup/probes/${stage}`, "POST");
  }
  desktop(threadId: string, workspaceRoot: string) {
    return this.request("/setup/desktop-confirmation", "POST", {
      threadId,
      workspaceRoot,
      observation: "rendered",
    });
  }
  provider(enabled: boolean) {
    return this.request("/provider", "PUT", { enabled });
  }
  attach(actorId: string, credential: string, model: string) {
    return this.request("/actors", "POST", {
      actorId,
      ...(credential ? { credential } : {}),
      config: { ...(model ? { model } : {}), approvalAuthority: "desktop" },
    });
  }
  actor(id: string, value: { enabled?: boolean; approvalAuthority?: "desktop" | "hub" }) {
    return this.request(`/actors/${encodeURIComponent(id)}`, "PATCH", value);
  }
  input(id: string, text: string, turnId?: string) {
    return this.request(
      `/actors/${encodeURIComponent(id)}/${turnId ? "steer" : "inputs"}`,
      "POST",
      { inputId: crypto.randomUUID(), text, ...(turnId ? { turnId } : {}) },
    );
  }
  interrupt(id: string, turnId: string) {
    return this.request(`/actors/${encodeURIComponent(id)}/interrupt`, "POST", { turnId });
  }
  terminals(id: string) {
    return this.request<{ terminals: { processId: string; command: string; cwd: string }[] }>(
      `/actors/${encodeURIComponent(id)}/terminals`,
    );
  }
  terminate(id: string, processId: string) {
    return this.request(
      `/actors/${encodeURIComponent(id)}/terminals/${encodeURIComponent(processId)}/terminate`,
      "POST",
    );
  }
  login() {
    return this.request<{ loginId: string; authUrl: string }>("/setup/login", "POST");
  }
  cancelLogin(id: string) {
    return this.request(`/setup/login/${encodeURIComponent(id)}`, "DELETE");
  }
}
