# OrgActor-Codex

Codex execution Provider and independent Actors for [AgentOrg](https://github.com/uniac-ai/AgentOrg), with a managing console.

## Run

Use Node 24.22.1 (see `.node-version`):

```sh
npm ci --ignore-scripts
npm run build
npm start
```

Open `http://127.0.0.1:8787/` directly. The deployment owns external access to the console and ManagementApi. `ORGACTOR_HOME` selects the private persistent directory (default `.runtime`); `HOST` and `PORT` select the listener (default `127.0.0.1:8787`). Runtime secrets and execution records remain on the persistent volume.

Configure the Hub binding on the server with `HUB_URL` and `PROVIDER_ID` together, plus optional `PROVIDER_CREDENTIAL`. Programmatic composition accepts the same `{url, providerId, credential?}` as `startServer({root, hub, ...})`. The validated binding is retained in the private runtime; later starts can use that binding without environment overrides. Retained execution records prevent retargeting it. Hub URL and identity are read-only in the console, and credentials are never returned.

A fresh runtime enables Provider intent. When configured and active, startup awaits actual Hub admission before opening HTTP. The returned runtime's `ready` getter is true only while that active Provider is connected. Failed admission leaves a diagnostic console showing unreachable or rejected state; an unconfigured console is a setup shell. Persisted pause and revocation suspension survive restart; **Enable/Resume Provider** explicitly reconnects. Successful admission does not claim backend or Desktop readiness.

For a container:

```sh
docker compose up --build
docker compose logs orgactor-codex
```

Open `http://localhost:8787/` directly. The compose service publishes only on loopback and keeps its private state in the `runtime` volume. Bind-mount an existing co-located app-server socket when choosing that backend; mount access must permit the container's `node` user to connect.

## Connect

1. In **Setup**, choose SSH first for a container deployment. Supply the target host, port, user, private key and a verified known-host entry. SSH uses strict host verification and the existing host's `codex app-server proxy`. The host must already run the app server used by Codex Desktop. Co-located mode accepts an existing `unix:///absolute/socket/path`, loopback WebSocket or TLS WebSocket listener.
2. Set the exact workspace root saved in Codex Desktop's SSH connection or local project. Set the container MCP address as reachable **from the Codex host**, including `/mcp`. For a remote machine, arrange a protected network route or SSH reverse forwarding to this container; loopback addresses refer to each machine's own network namespace. On Docker Desktop, the SSH host may be `host.docker.internal` with its corresponding verified known-host entry.
3. Check the backend and account. Authentication uses the backend's existing ChatGPT sign-in and plan quota. **Start sign-in** is an explicit operator action with one login owner. Quota unavailable and quota denied are separate observations. Native session creation uses read-only sandboxing and on-request approvals.
4. Enroll the Provider in your Hub and supply its server-side binding before launch. **Check admission** shares the active Provider's existing connection owner. Pause or resume provisioning from the Provider page. The Provider serves its factory RPC while each Actor consumes the Hub's exposed Tools; see [architecture](docs/architecture.md).
5. In your Hub, create an Actor with `execution: {providerId, config: {}}`, or choose **Attach Actor** with an existing Hub-issued identity and credential. Optional execution config selects `model` and `approvalAuthority` (`desktop` or `hub`). Each Actor admits itself independently.
6. Open that session in Codex Desktop using the saved workspace root. Confirm the attached session ID in Setup after you see it. This records an explicit operator observation tied to the workspace and configuration revision. Backend mapping checks alone leave the Desktop step unconfirmed.

The bridge check uses thread-specific native MCP discovery after an Actor is attached. Before attachment it can perform a read-only connectivity challenge from the backend; sandbox rejection of that command is reported separately. Model work waits for the real Actor MCP catalog. Factory success confirms native setup and private bootstrap handoff, independently of Actor admission and model activity.

## Operate

Actors expose no remote execution/control Tools. Start native work from the local console, or let the Actor's local policy read its Hub inbox and accept a message. Native sessions belong to this executor's implementation; the Hub manages Actor identity independently. Duplicate inbox messages retain one accepted input, and uncertain native outcomes require reconciliation.

**Pause connection** disconnects that Actor executor; it preserves the native session and any running work. **Interrupt** requests cancellation of its named active turn. **Background terminals** lists and stops registered terminals belonging to that native session. Reconnect resumes the same private session binding and reconciles native user-message IDs without replaying unknown work. Replaced or revoked connections require an explicit operator resume.

Desktop approval ownership observes requests without answering. Hub ownership asks the current manager through a question with a designated answerer, binds the answer to the native request and turn, and rejects stale answers. Command/file approvals, requested permission grants, user-input responses and MCP elicitation use typed responses. Unknown owned request kinds are explicitly refused in Hub mode. Console access does not confer Hub root authority.

The browser uses only ManagementApi. Hub credentials remain server-side; SSH material and Actor bootstrap credentials are write-only. The native MCP capability is separate from every Hub credential. Actor creation results are projected for the model with a matching schema; newly issued credentials stay private. Execution settings are immutable while their bindings or unresolved journals remain. Unknown creation/input outcomes require reconciliation before another launch.

## Verify

```sh
npm run check
npm test
npm run test:browser
```

CI pins Node 22.22.0 and 24.22.1; browser and container checks run on Node 24. Model-free integration launches the checked Hub wire/type checkpoint `79508a612121ed17e38e847facc67b02c5ee1954` through its public CLI, with an isolated temporary home and a fake native backend. The same public CLI path supports separately authorized, opt-in real model integration:

```sh
CODEX_SSH_PROOF_ROOT=/absolute/path/to/authorized-ssh-proof \
npm run test:real
```

That run uses existing ChatGPT authentication, records pre/post inventories and quota, creates only owned sessions and local resources, and cleans its turns, registered terminals and sessions. `--setup-only` spends no model turns. `--retain-proof` retains one idle session for review and names it in its private evidence manifest. [Verification evidence](docs/verification.md) distinguishes real native/Hub results, browser fixtures, supported Desktop app observation and rendered pixels.

Console parts use shadcn/Base UI components adapted from AgentOrg. Feature controls, typed definitions and views have separate ownership.
