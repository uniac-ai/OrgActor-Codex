# OrgActor-Codex contracts

## Exposure

One server/container serves an authenticated Managing Console and ManagementApi. The browser uses only the typed ManagementApi client. Operator sign-in redeems a one-time token into an HttpOnly, SameSite=Strict cookie; same-origin checks and CSRF protect mutations. Secrets are write-only; reads return presence and fingerprints. Runtime files have mode 0600 inside a 0700 directory.

The implementation consumes the Hub contracts reviewed at AgentOrg PR 52 (`3f39ac7f07bfc7f1dd7e2568b902e41ea0331fc6`) and PR 53 (`6b5504cec47a5d2c5d7a98f0e156375b0d46172d`). Provider and Actor initiate independent `/connection` WebSockets. Admission is JSON-RPC 2.0 `connection.connect({providerId,credential?})` or `{actorId,credential?}` and returns `{connectionId}`. Identities already exist in the Hub. Actor connections initialize bidirectional MCP after admission. Provider connections implement `provider.describe({}) -> {configSchema}` and `provider.createActor({actorId,credential?,config}) -> {actorId}`. No additional handshake fields or Provider routing are used.

Hub owns organizational identity, state, management relationships and authority. Provider owns execution. The private `(hub URL, providerId, actorId) -> native threadId` journal is recovery policy, not a Hub lifetime binding. Creation persists accepted inputs before native effects. Identical retries reconcile; different inputs return CREATION_CONFLICT. Lost replies leave PROVISIONING_UNKNOWN without automatic native creation replay. Provisioning success requires actual native session setup, accepted per-thread bridge configuration and durable private bootstrap handoff. Actor admission, turn-triggered MCP startup and model activity are independent observations, not creation prerequisites. Hub's combined 45-second creation budget does not cancel or replay accepted work.

Initial execution configuration is a strict object: optional `model` (an available backend model), optional `approvalAuthority` (`desktop` by default, or `hub`). The configured workspace root is the execution cwd. No arbitrary model instructions, credentials or native configuration overrides cross this factory boundary.

## Actor advertisement

An Actor advertises the following local interfaces with JSON object input/output schemas. Hub discovers them using reverse MCP `initialize` and `tools/list`; it supplies caller aliases in its semantic Tool catalog. Local names are not parsed from aliases.

- `run {text:string}` is long-running and returns `{inputId:string,turnId:string,status:"completed"|"interrupted"|"failed",output:string}`. It uses MCP task support; the Hub call ID is its durable idempotency key. Active work queues subsequent runs.
- `status {}` returns `{connected:boolean,threadId:string,turnId:string|null,queued:number,requests:number}` and is read-only.
- `steer {turnId:string,text:string}` returns `{inputId:string,turnId:string,status:"accepted"|"unknown"}`. An observed different active turn is rejected; a lost native reply is unknown and never replayed blindly.
- `interrupt {turnId:string}` returns `{turnId:string,requested:true}`. This confirms cancellation was requested; terminal exit and turn completion remain separate observations.

All operations receive `Incoming {id,from,cause,signal}` from Hub `_meta["agentorg/call"]`. Mutation authority is checked against the authenticated Hub caller and the current root/manager relationship, never text claiming to be the user. Missing delivery metadata is rejected. Provenance survives queuing, steering, MCP cause propagation and restart. Task cancellation removes queued work or interrupts only the turn belonging to that call. Caller wait expiry does not cancel execution.

## ManagementApi

Runtime Zod schemas are shared with the inferred browser types. `/api/session` supports redeem/read/logout. `/api/state` returns sanitized settings, configuration revision, setup reports, Provider observation and Actor snapshots. `/api/setup` accepts backend/bridge/Hub settings; `/api/setup/probes/:stage` runs backend/account/desktop/bridge/Hub checks. `/api/setup/login` explicitly starts/cancels one native login owned by SetupService. `/api/provider` sets enabled intent. `/api/actors` attaches an existing Hub Actor using private bootstrap; it never creates Hub identity. Actor-scoped endpoints submit input, steer, interrupt, list/terminate native background terminals and respond to scoped pending requests. Errors use stable codes and sanitized messages.

Readiness is `unconfigured`, `unreachable`, `rejected` or `ready` from explicit probes with timestamps and configuration revisions. Configuration changes invalidate affected observations. No result is equivalent to a successful probe. Desktop root/catalog alignment and rendered Desktop visibility are separate evidence; native thread creation or persistence alone establishes neither Desktop claim. Setup guides the saved exact root and records factual mapping observations.

## Module contracts and layout

| Directory                               | Contract and owned state                                                                                | Dependencies                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `src/server`                            | Composition, HTTP/static serving, shutdown.                                                             | All public module clients.                                |
| `src/management`                        | Operator sessions, validation, redacted projections, routes.                                            | Setup, Provider, Supervisor clients.                      |
| `src/setup`                             | Connectivity, one login owner, account/quota, Desktop root mapping, bridge/Hub probes.                  | RuntimeStore, native protocol probes, HubConnection.      |
| `src/codex`                             | Pure session/turn/event/request/terminal execution; SSH and local socket adapters share native framing. | Native app-server transport.                              |
| `src/provider`                          | Provider RPC, durable provisioning journal, private bootstrap handoff.                                  | HubConnection, CodexAdapter, RuntimeStore, ActorLauncher. |
| `src/actors`                            | Supervisor; independent ActorHubSession, SessionMcpBridge, ActorController, durable inputs/cursors.     | HubConnection, CodexAdapter, RuntimeStore.                |
| `src/hub`                               | Admission and bidirectional MCP; validated semantic Tool catalog.                                       | WebSocket and MCP SDK.                                    |
| `src/runtime`                           | Atomic private persistence and secret material.                                                         | Filesystem.                                               |
| `web/src/{control,features,views,data}` | Control -> feature definition <- view; API client; shadcn parts.                                        | ManagementApi only.                                       |

Modules depend on the clients of their dependencies. CodexActor has no Provider dependency. Setup/auth/root alignment never enters ActorController or CodexProvider's execution adapter. Both SSH and co-located app-server adapters are supported, with SSH first in container setup. SSH uses strict host verification and `codex app-server proxy`; co-located mode connects an existing Unix/WebSocket app-server listener. Neither path uses `codex exec`.

SessionMcpBridge uses an independent Actor-scoped capability and never sends a Hub credential to Codex. It validates Hub `agentorg/tool` metadata and forwards only the Actor's offered interfaces. Known credential-bearing `actor_create` results are projected using their actual structured contract, storing credentials privately and regenerating model-visible text. It does not heuristically scrub arbitrary valid results. Listing and invocation preserve aliases, tool identity, schemas and per-input cause. Model-provided metadata cannot impersonate another thread or input.

Desktop-observe is the conservative default: it never starts login or answers native approval/input requests. SetupService starts login only on an explicit operator action. Hub-governed approval uses a pending request bound to thread, turn, request ID and authorized answerer. One timeout owner controls each request; stale/resolved responses are rejected. Operator attachment does not imply organizational root identity.

## Verification

Unit/integration tests cover admission, independent credentials, write-only projections, 0600 persistence, journal conflict/unknown behavior, real catalog dispatch, provenance, task/reconnect deduplication and approval ownership. Browser E2E covers authentication, actual setup/operations, failure/empty states, desktop/mobile layout and screenshots. Clean install, format/lint, build, tests and container startup use matching pinned CI runtimes.

The opt-in real E2E runs an isolated Hub at the pinned revision and this module, using the authenticated shared SSH backend and an owned session/workspace. It verifies Provider factory -> private handoff -> Actor admission -> native model/Hub MCP roundtrip, steering, interruption, reconnect/restart, scoped terminal cleanup and app catalog/history updates. Pre/post inventories and quota evidence are retained without secrets. Existing proof sessions/services/configuration are preserved. Supported app catalog/history observation and rendered pixels are reported separately. Only owned resources are deleted, and no merge or deployment occurs.
