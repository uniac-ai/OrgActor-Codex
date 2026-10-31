# Verification

The current compatibility candidate passes 45 model-free regression tests on Node 22.22.0 and 24.22.1, plus seven browser tests. Public Hub checkpoint integration and exact-head CI validation remain pending. Owned loopback fixtures exercise the assembled Provider RPC, Supervisor, Controller, native framing and HTTP MCP bridge with fake credentials. The Actor's MCP client declares no server capabilities and rejects reverse initialize, discovery and control calls.

The production fixture withholds native creation until actual MCP discovery completes before binding. It retains the same controller, Hub peer and creating native socket. Pre-binding execution is refused. The Actor reads its inbox and locally accepts one message, uses an actual Hub Tool without any inbound invocation or fabricated cause, and settles its native receipt. Duplicate delivery causes one native turn. Bridge regressions reject empty, missing, foreign and expired native identities; an observed current native MCP item binds its call ID and alias to the active turn. Completed and prior-turn calls are rejected. Credential projection and recorded-human-answer restrictions remain enforced.

The fixture also preserves uncertain accepted input, held Actor admission and rejected/lost creation cases without replay. Existing steering, account/plan, native first-use ownership, private persistence, local controls and lifecycle regressions remain. These tests create no real native sessions or model turns. Handwritten fixtures alone do not establish compatibility with the updated Hub public schema; that separate checkpoint proof is required.

Two generated-code negative controls confirm the bridge test detects removal of its native identity check and removal of its HTTP registration. Both fail as expected, and both mutations are restored. Native item emission precedes MCP dispatch in the pinned native source; requests arriving before local item observation are refused. No live transport-order claim is made by these fixtures.

The real execution and cross-service reports below are historical evidence for their named source revisions. Earlier Hub-dispatched Actor controls are not the current execution contract.


Live first-use diagnosis at `c7065e6` exposed the backend's default paginated history returning `list_turns is not supported yet`. Two authorized disposable native probes ran without model turns or Tool calls, and both were archived. The explicit legacy probe reported the scoped pre-first-message unmaterialized state; the corrected read and metadata-only admission guard passed on that same unnamed probe. New managed sessions request legacy history, and only that exact native state plus matching idle legacy metadata establishes initial empty history. Existing unsupported paginated history remains an error. The harness now checks native history and MCP readiness before its presentation rename. Earlier model/control runs renamed the session before readiness, so they do not establish untouched first-use readiness.

The final SSH run tested source checkpoint `f28eb06300e8c98e1a1fc82b8a6317a2b73d3489`. It completed on 2026-10-30 with two actual native Hub MCP calls, `ORGACTOR_MCP_OK`, its own native steering client ID and a durable applied/completed receipt containing `STEER_APPLIED`. Execution progressed to a separate interrupted command, and reconnect duplicated no input. Included plan usage was allowed before and after; its reported primary window remained at 27%. The [native report](../evidence/native-e2e.json), [supported app observation](../evidence/desktop-app-observation.json) and [cleanup manifest](../evidence/cleanup-manifest.json) contain the sanitized observations. Only the newest idle proof is retained; the prior owned proof was verified idle with zero terminals before archival. The [earlier SSH report](../evidence/history/948a58c/native-e2e.json) and [co-located setup report](../evidence/colocated-setup.json) remain labeled with their tested `948a58c` source checkpoint.

## Proof boundaries

| Surface                                     | Evidence                                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hub factory and independent Actor admission | Real isolated Hub at `58dbececc84289f378f658b35504371106a7c760`; describe/create remain callable after repeated active admission checks.                                                                                                          |
| Native SSH execution                        | Real ChatGPT-plan model roundtrip through actor-scoped `org.team` and `org.activity`; native-applied steering marker, a separate interrupted command and reconnect with no duplicated input. Final run details are in `evidence/native-e2e.json`. |
| Co-located adapter                          | Native Unix-socket setup-only run, including offline Actor provisioning and thread-specific MCP discovery; no model turn.                                                                                                                         |
| Desktop app                                 | Supported app catalog/history observation of the retained owned proof. Rendered Desktop pixels are unverified.                                                                                                                                    |
| Console browser                             | Screenshots below; Actor-control images use the explicitly labeled browser fixture. They establish UI behavior/layout, independently of native E2E evidence.                                                                                      |
| Container                                   | Local Docker daemon is unavailable. CI builds and starts the container; the PR checks show its result. The live native flow runs as the Node server on the host.                                                                                  |

## Console captures

![Setup](../evidence/console/setup.png)
![Provider](../evidence/console/provider.png)
![Backend](../evidence/console/backend.png)
![Actors empty](../evidence/console/actors-empty.png)
![Actor controls — browser fixture](../evidence/console/actors-controls-fixture.png)
![Mobile setup](../evidence/console/mobile-setup.png)
![Mobile Actor controls — browser fixture](../evidence/console/mobile-actors-fixture.png)

## Retention and repeatability

Start/build/setup commands are in [README](../README.md). The private runtime is a required recovery volume; publishing or copying it is unnecessary for review. The opt-in harness records pre/post native inventories and plan quota and fails if cleanup leaves unresolved owned work. One explicitly retained idle proof is classified separately and recorded in `evidence/cleanup-manifest.json`. Old canonical SSH proof infrastructure and existing AgentOrg services are preserved.

Sanitized evidence, screenshots, the dependency graph and run instructions are also persisted outside worktrees in the delivery's owned evidence directory. That bundle excludes RuntimeStore, SSH keys, authentication files and raw logs. Final commit, PR and CI run URLs are recorded in the durable handoff report.
