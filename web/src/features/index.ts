import type { ReactNode } from "react";
import type { ActorSnapshot, ProbeStage, PublicState } from "../../../src/management/schema";
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
  hubUrl: string;
  providerId: string;
  credential: string;
}
export interface ShellFeature {
  page: Page;
  onPage(page: Page): void;
  onLogout(): void;
  error: string | null;
  children: ReactNode;
}
export interface SignInFeature {
  loading: boolean;
  error: string | null;
  token: string;
  onToken(value: string): void;
  onSignIn(): void;
}
export interface SetupFeature {
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
  busy: boolean;
  attach: { actorId: string; credential: string; model: string };
  onAttachField(name: "actorId" | "credential" | "model", value: string): void;
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
  SignIn(props: SignInFeature): ReactNode;
  Setup(props: SetupFeature): ReactNode;
  Provider(props: ProviderFeature): ReactNode;
  Backend(props: BackendFeature): ReactNode;
  Actors(props: ActorsFeature): ReactNode;
}
