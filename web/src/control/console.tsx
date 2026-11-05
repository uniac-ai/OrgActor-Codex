import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Guide, PublicState, StepId } from "../../../src/management/schema";
import { ManagementClient } from "../data/client";
import type { Consent, Page, SetupForm } from "../features";
import { views } from "../views";

const client = new ManagementClient();
const empty: SetupForm = {
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
  const [attach, setAttach] = useState({ actorId: "", credential: "", model: "" });
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [terminals, setTerminals] = useState<
    { processId: string; command: string; cwd: string }[] | null
  >(null);
  const [login, setLogin] = useState<{ loginId: string; authUrl: string } | null>(null);
  const [guide, setGuide] = useState<Guide | null>(null);
  const [checking, setChecking] = useState(false);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [refusedFolder, setRefusedFolder] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const [next, steps] = await Promise.all([client.state(), client.guide()]);
    setState(next);
    setGuide(steps);
  }, []);
  useEffect(() => {
    const update = () => void client.state().then(setState, (e) => setError(e.message));
    update();
    const timer = setInterval(update, 2000);
    return () => clearInterval(timer);
  }, []);
  // The guided steps check themselves again every few seconds, as the person works in other apps.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () =>
      void client.guide().then(
        (next) => {
          setGuide(next);
          if (next.available) timer = setTimeout(update, 3000);
        },
        () => {
          timer = setTimeout(update, 3000);
        },
      );
    update();
    return () => clearTimeout(timer);
  }, []);
  const formRevision = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!state || formRevision.current === state.revision) return;
    formRevision.current = state.revision;
    const s = state.settings;
    setForm({
      ...empty,
      endpoint: s.backend?.endpoint ?? "",
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
  const recheck = async () => {
    // A refused folder may have had its adapter disconnected; it can be chosen again.
    if (refusedFolder) {
      setFolder(refusedFolder);
      setRefusedFolder(null);
    }
    setChecking(true);
    try {
      setGuide(await client.guide(true));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const openStep = (step: StepId) => {
    setPage("setup");
    setTimeout(
      () => document.getElementById(`step-${step}`)?.scrollIntoView({ block: "center" }),
      50,
    );
  };
  const attachActor = () =>
    void perform(async () => {
      await client.attach(attach.actorId, attach.credential, attach.model);
      setAttach({ actorId: "", credential: "", model: "" });
    });
  const confirm = (c: Consent) =>
    void perform(async () => {
      try {
        if (c.kind === "use-codex") await client.codexOnThisMac();
        else if (c.kind === "create-folder") await client.createFolder();
        else await client.detach(c.actorId);
      } finally {
        setConsent(null);
      }
    });
  if (!state) return <views.Loading error={error} />;
  const guided = guide?.available ? guide : null;
  const actor = state.actors.find((a) => a.actorId === selected);
  let content: ReactNode;
  if (page === "setup")
    content = (
      <views.Setup
        guided={
          guided && {
            guide: guided,
            busy,
            checking,
            folder,
            refusedFolder,
            onFolder: setFolder,
            onChooseFolder: (path) =>
              void perform(async () => {
                try {
                  await client.chooseFolder(path);
                  setRefusedFolder(null);
                  setFolder(null);
                } catch (e) {
                  if ((e as { code?: string }).code !== "FOLDER_HAS_ADAPTER") throw e;
                  setRefusedFolder(path);
                }
              }),
            onRecheck: () => void recheck(),
            onAsk: setConsent,
            attach,
            onAttachField: (name, value) => setAttach((old) => ({ ...old, [name]: value })),
            onAttach: attachActor,
            onPage: setPage,
          }
        }
        state={state}
        form={form}
        busy={busy}
        onField={(name, value) => setForm((old) => ({ ...old, [name]: value }))}
        onSave={() =>
          void perform(async () => {
            await client.setup({
              ...(form.endpoint
                ? { backend: { kind: "app-server", endpoint: form.endpoint } }
                : {}),
              workspaceRoot: form.workspaceRoot || undefined,
              bridgeUrl: form.bridgeUrl || undefined,
            });
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
        guide={guided?.inUse ? guided : null}
        onSetupStep={openStep}
        onDetach={(actorId) => setConsent({ kind: "detach", actorId })}
        busy={busy}
        attach={attach}
        onAttachField={(name, value) => setAttach((s) => ({ ...s, [name]: value }))}
        onAttach={attachActor}
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
      <views.Consent
        consent={consent}
        busy={busy}
        onCancel={() => setConsent(null)}
        onConfirm={() => consent && confirm(consent)}
      />
    </views.Shell>
  );
}
