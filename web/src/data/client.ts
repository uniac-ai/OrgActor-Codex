import type { Probe, ProbeStage, PublicState, Settings } from "../../../src/management/schema";
export class ManagementClient {
  csrf = "";
  async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const r = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.csrf ? { "X-CSRF-Token": this.csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await r.json();
    if (!r.ok) throw new Error(value.error?.message ?? "The console could not reach the server.");
    return value;
  }
  async session(value?: string) {
    const r = await this.request<{ csrf: string }>(
      "/session",
      value ? "POST" : "GET",
      value ? { token: value } : undefined,
    );
    this.csrf = r.csrf;
  }
  logout() {
    return this.request("/session", "DELETE");
  }
  state() {
    return this.request<PublicState>("/state");
  }
  setup(value: Settings) {
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
