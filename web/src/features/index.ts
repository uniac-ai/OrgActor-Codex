import type { ReactNode } from "react";
import type {
  AccessWrite,
  ActorSnapshot,
  Guide,
  ProbeStage,
  PublicState,
  StepId,
} from "../../../src/management/schema";
export type Page = "setup" | "provider" | "actors" | "backend";
export interface SetupForm {
  kind: "ssh" | "app-server";
  host: string;
  port: string;
  user: string;
  privateKey: string;
  knownHosts: string;
  endpoint: string;
  workspaceRoot: string;
  bridgeUrl: string;
}
export interface ShellFeature {
  page: Page;
  onPage(page: Page): void;
  error: string | null;
  children: ReactNode;
}
export interface AttachForm {
  actorId: string;
  credential: string;
  model: string;
}
/** A write the person reviews before the console makes it. */
export type Consent =
  | { kind: "access"; planId: string; writes: AccessWrite[] }
  | { kind: "remove-access" }
  | { kind: "create-folder"; path: string }
  | { kind: "detach"; actorId: string };
export interface ConsentFeature {
  consent: Consent | null;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}
/** The guided steps for Codex Desktop over SSH to this Mac. */
export interface GuideFeature {
  guide: Guide;
  busy: boolean;
  checking: boolean;
  folder: string;
  /** A folder just refused because AgentOrg's Codex adapter is connected there. */
  refusedFolder: string | null;
  onFolder(value: string): void;
  onChooseFolder(path: string): void;
  onRecheck(): void;
  onSetUpAccess(): void;
  onAsk(consent: Consent): void;
  onConfirmSession(threadId: string): void;
  attach: AttachForm;
  onAttachField(name: keyof AttachForm, value: string): void;
  onAttach(): void;
  onPage(page: Page): void;
}
export interface SetupFeature {
  /** Present when this Provider runs on a Mac the guide can set up. */
  guided: GuideFeature | null;
  state: PublicState;
  form: SetupForm;
  busy: boolean;
  onField<K extends keyof SetupForm>(name: K, value: SetupForm[K]): void;
  onSave(): void;
  onProbe(stage: ProbeStage): void;
  desktopThread: string;
  onDesktopThread(value: string): void;
  onConfirmDesktop(): void;
}
export interface ProviderFeature {
  state: PublicState;
  busy: boolean;
  onToggle(): void;
  onProbe(): void;
}
export interface BackendFeature {
  state: PublicState;
  busy: boolean;
  loginUrl: string | null;
  onLogin(): void;
  onCancelLogin(): void;
  onProbe(stage: ProbeStage): void;
}
export interface ActorsFeature {
  actors: ActorSnapshot[];
  guide: Guide | null;
  onSetupStep(step: StepId): void;
  onDetach(id: string): void;
  busy: boolean;
  attach: AttachForm;
  onAttachField(name: keyof AttachForm, value: string): void;
  onAttach(): void;
  selectedActor: ActorSnapshot | null;
  onSelect(id: string | null): void;
  text: string;
  onText(value: string): void;
  onSubmit(): void;
  onSteer(): void;
  onInterrupt(): void;
  onToggleConnection(id: string): void;
  onAuthority(id: string, value: "desktop" | "hub"): void;
  onTerminals(): void;
  terminals: { processId: string; command: string; cwd: string }[] | null;
  onCloseTerminals(): void;
  onTerminate(processId: string): void;
}
export interface ViewSet {
  Shell(props: ShellFeature): ReactNode;
  Loading(props: { error: string | null }): ReactNode;
  Setup(props: SetupFeature): ReactNode;
  Consent(props: ConsentFeature): ReactNode;
  Provider(props: ProviderFeature): ReactNode;
  Backend(props: BackendFeature): ReactNode;
  Actors(props: ActorsFeature): ReactNode;
}
