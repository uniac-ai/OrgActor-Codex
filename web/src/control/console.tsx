import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { PublicState } from "../../../src/management/schema";
import { ManagementClient } from "../data/client";
import type { Page, SetupForm } from "../features";
import { views } from "../views";

const client = new ManagementClient();
const empty: SetupForm = {
  kind: "ssh",
  host: "",
  port: "22",
  user: "",
  privateKey: "",
  knownHosts: "",
  endpoint: "",
  workspaceRoot: "",
  bridgeUrl: "",
};
export function ConsoleControl() {
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<Page>("setup");
  const [state, setState] = useState<PublicState | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(empty);
  const [desktopThread, setDesktopThread] = useState("");
  const [attach, setAttach] = useState({ actorId: "", credential: "", model: "" });
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [terminals, setTerminals] = useState<
    { processId: string; command: string; cwd: string }[] | null
  >(null);
  const [login, setLogin] = useState<{ loginId: string; authUrl: string } | null>(null);
  const refresh = useCallback(async () => setState(await client.state()), []);
  useEffect(() => {
    const update = () => void refresh().catch((e) => setError(e.message));
    update();
    const timer = setInterval(update, 2000);
    return () => clearInterval(timer);
  }, [refresh]);
  const formRevision = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!state || formRevision.current === state.revision) return;
    formRevision.current = state.revision;
    const s = state.settings;
    const b = s.backend as any;
    setForm({
      ...empty,
      kind: b?.kind ?? "ssh",
      host: b?.host ?? "",
      port: String(b?.port ?? 22),
      user: b?.user ?? "",
      endpoint: b?.endpoint ?? "",
      workspaceRoot: s.workspaceRoot ?? "",
      bridgeUrl: s.bridgeUrl ?? `${location.origin}/mcp`,
    });
  }, [state]);
  const perform = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!state) return <views.Loading error={error} />;
  const actor = state.actors.find((a) => a.actorId === selected);
  let content: ReactNode;
  if (page === "setup")
    content = (
      <views.Setup
        state={state}
        form={form}
        busy={busy}
        desktopThread={desktopThread}
        onDesktopThread={setDesktopThread}
        onConfirmDesktop={() =>
          void perform(() => client.desktop(desktopThread, state.settings.workspaceRoot ?? ""))
        }
        onField={(name, value) => setForm((old) => ({ ...old, [name]: value }))}
        onSave={() =>
          void perform(async () => {
            await client.setup({
              backend:
                form.kind === "ssh"
                  ? {
                      kind: "ssh",
                      host: form.host,
                      port: Number(form.port),
                      user: form.user,
                      ...(form.privateKey ? { privateKey: form.privateKey } : {}),
                      ...(form.knownHosts ? { knownHosts: form.knownHosts } : {}),
                    }
                  : { kind: "app-server", endpoint: form.endpoint },
              workspaceRoot: form.workspaceRoot || undefined,
              bridgeUrl: form.bridgeUrl || undefined,
            });
            setForm((s) => ({ ...s, privateKey: "", knownHosts: "" }));
          })
        }
        onProbe={(stage) => void perform(() => client.probe(stage))}
      />
    );
  else if (page === "provider")
    content = (
      <views.Provider
        state={state}
        busy={busy}
        onToggle={() =>
          void perform(() =>
            client.provider(
              ["suspended", "rejected"].includes(state.provider.state) || !state.provider.enabled,
            ),
          )
        }
        onProbe={() => void perform(() => client.probe("hub"))}
      />
    );
  else if (page === "backend")
    content = (
      <views.Backend
        state={state}
        busy={busy}
        loginUrl={login?.authUrl ?? null}
        onLogin={() => void perform(async () => setLogin(await client.login()))}
        onCancelLogin={() =>
          void perform(async () => {
            if (login) await client.cancelLogin(login.loginId);
            setLogin(null);
          })
        }
        onProbe={(stage) => void perform(() => client.probe(stage))}
      />
    );
  else
    content = (
      <views.Actors
        actors={state.actors}
        busy={busy}
        attach={attach}
        onAttachField={(name, value) => setAttach((s) => ({ ...s, [name]: value }))}
        onAttach={() =>
          void perform(async () => {
            await client.attach(attach.actorId, attach.credential, attach.model);
            setAttach({ actorId: "", credential: "", model: "" });
          })
        }
        selectedActor={actor ?? null}
        onSelect={setSelected}
        text={text}
        onText={setText}
        onSubmit={() =>
          void perform(async () => {
            if (actor) await client.input(actor.actorId, text);
            setText("");
          })
        }
        onSteer={() =>
          void perform(async () => {
            if (actor?.turnId) await client.input(actor.actorId, text, actor.turnId);
            setText("");
          })
        }
        onInterrupt={() =>
          void perform(async () => {
            if (actor?.turnId) await client.interrupt(actor.actorId, actor.turnId);
          })
        }
        onToggleConnection={(id) =>
          void perform(() => {
            const current = state.actors.find((a) => a.actorId === id);
            return client.actor(id, {
              enabled: current?.connectionState === "suspended" || !current?.enabled,
            });
          })
        }
        onAuthority={(id, approvalAuthority) =>
          void perform(() => client.actor(id, { approvalAuthority }))
        }
        onTerminals={() =>
          void perform(async () => {
            if (actor) setTerminals((await client.terminals(actor.actorId)).terminals);
          })
        }
        terminals={terminals}
        onCloseTerminals={() => setTerminals(null)}
        onTerminate={(id) =>
          void perform(async () => {
            if (actor) {
              await client.terminate(actor.actorId, id);
              setTerminals((await client.terminals(actor.actorId)).terminals);
            }
          })
        }
      />
    );
  return (
    <views.Shell page={page} onPage={setPage} error={error}>
      {content}
    </views.Shell>
  );
}
