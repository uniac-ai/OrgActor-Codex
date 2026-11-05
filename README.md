# OrgActor-Codex

Codex execution Provider and independent Actors for [AgentOrg](https://github.com/uniac-ai/AgentOrg), with a managing console.

## Run

Use Node 24.22.1 (see `.node-version`):

```sh
npm ci --ignore-scripts
npm run build
npm start
```

Open `http://127.0.0.1:8787/` directly. The deployment owns external access to the console and ManagementApi; the API answers only requests addressed to 127.0.0.1, localhost or [::1], so a proxy in front must pass one of those as the Host. `ORGACTOR_HOME` selects the private persistent directory (default `.runtime`); `HOST` and `PORT` select the listener (default `127.0.0.1:8787`). Runtime secrets and execution records remain on the persistent volume.

Configure the Hub binding on the server with `HUB_URL` and `PROVIDER_ID` together, plus optional `PROVIDER_CREDENTIAL`. Programmatic composition accepts the same `{url, providerId, credential?}` as `startServer({root, hub, ...})`. The validated binding is retained in the private runtime; later starts can use that binding without environment overrides. Retained execution records prevent retargeting it. Hub URL and identity are read-only in the console, and credentials are never returned.

A fresh runtime enables Provider intent. When configured and active, startup awaits actual Hub admission before opening HTTP. The returned runtime's `ready` getter is true only while that active Provider is connected. Failed admission leaves a diagnostic console showing unreachable or rejected state; an unconfigured console is a setup shell. Persisted pause and revocation suspension survive restart; **Enable/Resume Provider** explicitly reconnects. Successful admission does not claim backend readiness.

For a container:

```sh
docker compose up --build
docker compose logs orgactor-codex
```

Open `http://localhost:8787/` directly. The compose service publishes only on loopback and keeps its private state in the `runtime` volume. Bind-mount an existing co-located app-server socket when choosing that backend; mount access must permit the container's `node` user to connect.

## Connect

### On a Mac: guided setup

When the console runs on the Mac where Codex runs, **Setup** guides one path: Codex on this Mac, through Codex's own app server. Its steps are only what the Provider needs to run. Each step says whether it is done, what it saw, and who acts. A step waits while an earlier one isn't done. The Provider checks the steps every 10 seconds whether or not the console is open, the page checks again every 3 seconds, and every step has **Re-check**. A person acts only where a step says so, always in this console.

1. **Hub:** the Provider is admitted (see step 4 under Other setups for the Hub binding).
2. **Codex on this Mac:** **Use Codex on this Mac** shows what it does first: start Codex's app server for this Mac's `~/.codex` if it isn't running (`codex app-server daemon start`, as Codex Desktop does), and use its control socket as the backend. The Provider runs the same start before each connect, so the backend comes back after the app server stops.
3. **ChatGPT account:** Codex is signed in to ChatGPT, and the plan allows this usage.
4. **Workspace folder:** one folder for this Provider, used for nothing else, created when you confirm. The Provider files it as a Codex project itself, and files the Actors' sessions under it; if Codex can't, the step still passes. A folder connected to AgentOrg's Codex adapter (`agentorg-mcp connect codex`) is refused: Codex would refuse the Actor's session there. The step offers another folder or the exact `disconnect` command.
5. **Actor:** attach it here, or create it from the Hub. The console's Attach waits until steps 1 to 4 are done; an Actor created from the Hub isn't held back, so create it once they are.
6. **Actor tools:** the Actor's session lists its Hub tools.

The Provider names each Actor's session `AgentOrg <actorId>` and files it under the folder's project. Codex Desktop is an optional viewer: nothing in setup depends on it, and while the Provider runs an Actor's session, Desktop can't open it ("This is open in another app"). An Actor's work shows in the Hub: its Work, asks and messages.

The Actors table's **Status** gives each Actor's one blocking reason and links its Setup step. **Detach Actor** forgets an Actor on this Provider and keeps its Hub identity, for example to set it up again under another setup.

### Other setups

Setup keeps these collapsed under **Other setups** on a Mac, and shows them alone elsewhere.

1. In **Setup**, enter the endpoint of Codex's app server: an existing `unix:///absolute/socket/path`, loopback WebSocket or TLS WebSocket listener. The host must already run the app server used by Codex Desktop. A container reaches a Unix socket through a bind mount.
2. Set the workspace root, the folder the Actors work in. Set the container MCP address as reachable **from the Codex host**, including `/mcp`; loopback addresses refer to each machine's own network namespace, so a Codex host on another machine needs a protected network route to this container.
3. Check the backend and account. Authentication uses the backend's existing ChatGPT sign-in and plan quota. **Start sign-in** is an explicit operator action with one login owner. Quota unavailable and quota denied are separate observations. Every Actor session runs with full access to this Mac, network included, and Codex never asks for approval. The session's own Hub Tools are pre-approved, since the Hub already decides what the Actor may do with them.
4. Enroll the Provider in your Hub and supply its server-side binding before launch. **Check admission** shares the active Provider's existing connection owner. Pause or resume provisioning from the Provider page. The Provider serves its factory RPC while each Actor consumes the Hub's exposed Tools; see [architecture](docs/architecture.md).
5. In your Hub, create an Actor with `execution: {providerId, config: {}}`, or choose **Attach Actor** with an existing Hub-issued identity and credential. Optional execution config selects `model`; the native session is offered the whole Hub catalog. Each Actor admits itself independently.

The bridge check uses thread-specific native MCP discovery after an Actor is attached. Before attachment it can perform a read-only connectivity challenge from the backend; sandbox rejection of that command is reported separately. Model work waits for the real Actor MCP catalog. Factory success confirms native setup and private bootstrap handoff, independently of Actor admission and model activity.

## Operate

An Actor's only boundary with the world outside it is the interfaces its Hub exposes to it. How it drives its work forward from what those interfaces give it, including Codex's app server, is internal to this Provider.

Actors expose no remote execution/control Tools. Start native work from the local console, or let the Actor's inbox deliver what reaches it through the Hub's `attention`: Work given to it or changed by its requester, answers to its asks and submissions, Messages, asks routed to it, and submissions of Work it requested. Each becomes native input, starting a turn when the session is idle and steering the turn that runs. A Message arrives with its conversation from the Actor's own last message. The Provider keeps its own delivered-through position, and a new Actor starts at the Hub's current position. Native sessions belong to this executor's implementation; the Hub manages Actor identity independently. A repeated item retains one accepted input, and uncertain native outcomes require reconciliation.

A provisioned Actor's only guidance is the bridge's fixed server instruction, since the factory refuses arbitrary model instructions. It carries the `agentorg` skill's report: one Work per workstream with its progress steps, the asks on it with a recommended option, and its submission.

**Pause connection** disconnects that Actor executor; it preserves the native session and any running work. **Interrupt** requests cancellation of its named active turn. **Background terminals** lists and stops registered terminals belonging to that native session. Reconnect resumes the same private session binding and reconciles native user-message IDs without replaying unknown work. Replaced or revoked connections require an explicit operator resume.

**An Actor runs with full access to this Mac,** network included (`sandbox: danger-full-access`), and Codex never asks for approval (`approvalPolicy: never`). A request Codex still sends, such as a question for the user, is declined at once, so no turn waits on a person and nothing of it reaches the Hub. Permission gating will come back through the Hub. Console access does not confer Hub root authority.

The browser uses only ManagementApi. Hub credentials remain server-side; Actor bootstrap credentials are write-only. The native MCP capability is separate from every Hub credential. Actor creation results are projected for the model with a matching schema; newly issued credentials stay private. Execution settings are immutable while their bindings or unresolved journals remain. Unknown creation/input outcomes require reconciliation before another launch.

## Verify

```sh
npm run check
npm test
npm run test:browser
```

CI pins Node 22.22.0 and 24.22.1; browser and container checks run on Node 24. Model-free integration launches the checked Hub wire/type checkpoint `426abca58bb806f0fead1abbd6ddd89ac82fb889` through its public CLI, with an isolated temporary home and a fake native backend. The same public CLI path supports separately authorized, opt-in real model integration:

```sh
CODEX_PROOF_ROOT=/absolute/path/to/authorized-proof \
npm run test:real
```

`CODEX_PROOF_ROOT` holds the workspace and a `codex/` home whose app server is running. That run uses existing ChatGPT authentication, records pre/post inventories and quota, creates only owned sessions and local resources, and cleans its turns, registered terminals and sessions. `--setup-only` spends no model turns. `--retain-proof` retains one idle session for review and names it in its private evidence manifest. [Verification evidence](docs/verification.md) distinguishes real native/Hub results, browser fixtures, supported Desktop app observation and rendered pixels.

Console parts use shadcn/Base UI components adapted from AgentOrg. Feature controls, typed definitions and views have separate ownership.
