import { Hono } from "hono";
import { z } from "zod";
import type { ActorSupervisor } from "../actors/supervisor.js";
import type { CodexProvider } from "../provider/index.js";
import type { RuntimeStore } from "../runtime/index.js";
import type { SetupService } from "../setup/index.js";
import type { OperatorAuth } from "./auth.js";
import {
  Attach,
  Authority,
  Fault,
  Input,
  ProbeStage,
  type PublicState,
  Steer,
  safeError,
} from "./schema.js";

export function management(
  store: RuntimeStore,
  setup: SetupService,
  provider: CodexProvider,
  actors: ActorSupervisor,
  auth: OperatorAuth,
) {
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (c.req.path === "/api/session" && c.req.method === "POST") auth.origin(c);
    else auth.verify(c);
    await next();
  });
  app.onError((e, c) =>
    c.json(
      {
        error: {
          code:
            e instanceof z.ZodError
              ? "INVALID_INPUT"
              : e instanceof Fault
                ? e.code
                : "OPERATION_FAILED",
          message:
            e instanceof z.ZodError ? "Check the required fields and their formats." : safeError(e),
        },
      },
      (e instanceof z.ZodError ? 422 : e instanceof Fault ? e.status : 500) as any,
    ),
  );
  app.post("/api/session", async (c) =>
    c.json(
      auth.redeem(c, z.strictObject({ token: z.string().min(1) }).parse(await c.req.json()).token),
    ),
  );
  app.get("/api/session", (c) => c.json(auth.read(c)));
  app.delete("/api/session", (c) => {
    auth.logout(c);
    return c.json({ signedOut: true });
  });
  app.get("/api/state", (c) => {
    const state: PublicState = {
      revision: store.data.revision,
      settings: setup.publicSettings(),
      probes: store.data.probes,
      provider: provider.snapshot(),
      actors: Object.values(store.data.actors).map(
        (b) =>
          actors.actors.get(b.actorId)?.snapshot() ?? {
            actorId: b.actorId,
            enabled: b.enabled,
            connected: false,
            connectionState: b.suspended ? "suspended" : b.enabled ? "connecting" : "paused",
            observation: "unavailable",
            observedAt: null,
            threadId: b.threadId,
            turnId: null,
            queued: b.submissions.filter((s) => s.state === "queued").length,
            approvalAuthority: b.config.approvalAuthority,
            requests: [],
            output: "",
          },
      ),
    };
    return c.json(state);
  });
  app.put("/api/setup", async (c) => {
    setup.configure(await c.req.json());
    return c.json({ revision: store.data.revision, settings: setup.publicSettings() });
  });
  app.post("/api/setup/probes/:stage", async (c) =>
    c.json(await setup.probe(ProbeStage.parse(c.req.param("stage")))),
  );
  app.post("/api/setup/login", async (c) => c.json(await setup.login()));
  app.post("/api/setup/desktop-confirmation", async (c) =>
    c.json(await setup.confirmDesktop(await c.req.json())),
  );
  app.delete("/api/setup/login/:id", async (c) => {
    await setup.cancelLogin(c.req.param("id"));
    return c.json({ cancelled: true });
  });
  app.put("/api/provider", async (c) => {
    const { enabled } = z.strictObject({ enabled: z.boolean() }).parse(await c.req.json());
    if (enabled && !store.data.settings.hub)
      throw new Fault("HUB_UNCONFIGURED", "Configure the Hub before enabling the Provider.");
    await provider.setEnabled(enabled);
    return c.json(provider.snapshot());
  });
  app.post("/api/actors", async (c) => {
    const attached = Attach.parse(await c.req.json());
    await provider.create(attached);
    return c.json({ actorId: attached.actorId }, 201);
  });
  app.patch("/api/actors/:id", async (c) => {
    const data = z
      .strictObject({ enabled: z.boolean().optional(), approvalAuthority: Authority.optional() })
      .parse(await c.req.json());
    const id = c.req.param("id");
    if (!Object.hasOwn(store.data.actors, id))
      throw new Fault("ACTOR_NOT_FOUND", "This Actor is not attached.", 404);
    if (data.approvalAuthority) {
      const running = actors.actors.get(id);
      if (running?.snapshot().requests.length)
        throw new Fault(
          "REQUEST_PENDING",
          "Resolve pending requests before changing their answer owner.",
        );
      store.data.actors[id].config.approvalAuthority = data.approvalAuthority;
      store.save();
    }
    if (data.enabled !== undefined) await actors.setEnabled(id, data.enabled);
    return c.json({ updated: true });
  });
  app.post("/api/actors/:id/inputs", async (c) => {
    const data = Input.parse(await c.req.json());
    const s = actors.get(c.req.param("id")).enqueue(`operator:${data.inputId}`, data.text);
    return c.json({ inputId: data.inputId, state: s.state, turnId: s.turnId ?? null }, 202);
  });
  app.post("/api/actors/:id/steer", async (c) => {
    const data = Steer.parse(await c.req.json());
    return c.json(
      await actors.get(c.req.param("id")).steer(`operator:${data.inputId}`, data.turnId, data.text),
    );
  });
  app.post("/api/actors/:id/interrupt", async (c) => {
    const data = z.strictObject({ turnId: z.string().min(1) }).parse(await c.req.json());
    return c.json(await actors.get(c.req.param("id")).interrupt(data.turnId));
  });
  app.get("/api/actors/:id/terminals", async (c) => {
    const actor = actors.get(c.req.param("id"));
    if (!actor.adapter) throw new Fault("BACKEND_UNREACHABLE", "The Actor backend is unavailable.");
    const terminals = await actor.adapter.terminals(actor.bootstrap.threadId);
    return c.json({
      terminals: terminals.map(({ processId, command, cwd }) => ({ processId, command, cwd })),
    });
  });
  app.post("/api/actors/:id/terminals/:processId/terminate", async (c) => {
    const actor = actors.get(c.req.param("id"));
    return c.json({
      terminated:
        (await actor.adapter?.terminate(actor.bootstrap.threadId, c.req.param("processId"))) ??
        false,
    });
  });
  app.post("/api/actors/:id/requests/:requestId/respond", async (c) => {
    await actors.get(c.req.param("id")).checkRequest(c.req.param("requestId"));
    return c.json({ checked: true });
  });
  return app;
}
