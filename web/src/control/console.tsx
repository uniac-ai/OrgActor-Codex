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
  hubUrl: "",
  providerId: "",
  credential: "",
};
export function ConsoleControl() {
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
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
  const authenticate = useCallback(
    async (value?: string) => {
      setLoading(true);
      setError(null);
      try {
        await client.session(value);
        setSignedIn(true);
        setToken("");
        await refresh();
      } catch (e) {
        setSignedIn(false);
        if (value) setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [refresh],
  );
  useEffect(() => {
    const match = new URLSearchParams(window.location.hash.slice(1)).get("sign-in");
    if (match) history.replaceState(null, "", window.location.pathname);
    void authenticate(match ?? undefined);
  }, [authenticate]);
  useEffect(() => {
    if (!signedIn) return;
    const timer = setInterval(() => {
      void refresh().catch((e) => setError(e.message));
    }, 2000);
    return () => clearInterval(timer);
  }, [signedIn, refresh]);
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
      hubUrl: s.hub?.url ?? "",
      providerId: s.hub?.providerId ?? "",
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
  if (!signedIn || !state)
    return (
      <views.SignIn
        loading={loading}
        error={error}
        token={token}
        onToken={setToken}
        onSignIn={() => void authenticate(token)}
      />
    );
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
              hub: form.hubUrl
                ? {
                    url: form.hubUrl,
                    providerId: form.providerId,
                    ...(form.credential ? { credential: form.credential } : {}),
                  }
                : undefined,
            });
            setForm((s) => ({ ...s, privateKey: "", knownHosts: "", credential: "" }));
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
        onEnabled={(enabled) => void perform(() => client.provider(enabled))}
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
        onEnabled={(id, enabled) => void perform(() => client.actor(id, { enabled }))}
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
    <views.Shell
      page={page}
      onPage={setPage}
      error={error}
      onLogout={() =>
        void perform(async () => {
          await client.logout();
          setSignedIn(false);
          setState(null);
        })
      }
    >
      {content}
    </views.Shell>
  );
}
