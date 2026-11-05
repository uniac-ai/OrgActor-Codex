import type { ReactNode } from "react";
import type {
  ActorSnapshot,
  Guide,
  ProbeStage,
  PublicState,
  StepId,
} from "../../../src/management/schema";
export type Page = "setup" | "provider" | "actors" | "backend";
export interface SetupForm {
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
  | { kind: "use-codex"; socket: string }
  | { kind: "create-folder"; path: string }
  | { kind: "detach"; actorId: string };
export interface ConsentFeature {
  consent: Consent | null;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}
/** The guided steps for an Actor worked by Codex on this Mac. */
export interface GuideFeature {
  guide: Guide;
  busy: boolean;
  checking: boolean;
  /** The folder being typed; null shows the suggested one. */
  folder: string | null;
  /** A folder just refused because AgentOrg's Codex adapter is connected there. */
  refusedFolder: string | null;
  onFolder(value: string): void;
  onChooseFolder(path: string): void;
  onRecheck(): void;
  onAsk(consent: Consent): void;
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
