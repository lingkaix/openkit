# OpenKit Skills

OpenKit maintains two complementary packages. The [public `openkit` Skill](openkit/SKILL.md) operates running NanoCore through the bundled public CLI under [Agent Skill Interface](../docs/specs/20260713-openkit_agent_skill_interface.md). The independent [`openkit-ops` Skill](openkit-ops/SKILL.md) packages installation, configuration, upgrade, diagnosis and offline recovery guidance under [Agent Operator Skill](../docs/specs/20260910-agent_operator_skill.md).

## Public Product Interface

The public package contains its concise entrypoint, generated Agent-host metadata, bundled `scripts/openkit` executable and progressively loaded references. The CLI exposes supported public end-user and operator capabilities through operation search, description and invocation. Workflow truth, authorization, approvals and durable records remain in NanoCore. It has no arbitrary HTTP, source-editing, SSH or generic shell mode.

Public response redaction removes credentials and secret material while preserving authorized path text, quoting, and standalone slash punctuation. NanoCore operation projections own path confidentiality. Its focused regression is `node --test tests/openkit-public-redaction.test.mjs`.

Current-user Workspace invitation list, accept, and decline are exposed as `workspace.my-invitation-*` through implicit local identity only. Owner-scoped `workspace.invitation-*` operations remain distinct. Server-mode bearer credentials do not authorize current-user invitation operations; use the Web Account Invitations panel instead.

Workspace leave is exposed as `workspace.leave` through implicit local identity only. Server-mode bearer credentials remain unsupported; use Web Account for the session-based leave path.

Personal admin-token list and default selection are exposed as `token.my-admin-list` and `token.my-admin-default` through implicit local identity only. Both return redacted records and the effective default token ID. Server-mode bearer credentials remain unsupported; use Web **My admin access** for the session path.

Generic access-token creation and rotation are exposed as `token.create` and `token.rotate` with server-admin bearer authority in server mode and an explicit safe local `destination`. Named slots have separate keychain and encrypted fallback identities from the endpoint administration credential, with persisted backend selection to prevent stale reads after replacement, deletion or restart. Responses contain only redacted records, destination and storage metadata; normal authentication keeps using the endpoint credential. `skills/openkit-secrets.mjs` owns named preflight/write/read/delete and backend isolation. Run `node --test tests/openkit-skill-interface.test.mjs` after `pnpm build:openkit` to verify the source and regenerated executable together.

Conversation submission can forward the existing explicit retained Worker storage choice for new Task work. The public loop reference and Web Advanced settings share the same selection, authority and send-time admission rules; omitting the choice keeps the default new environment.

## Operations Interface

The operations package contains its entrypoint, directly linked canonical operator references and any bounded support scripts required by an accepted operation owner. It works from outside the source checkout and can guide recovery while NanoCore is unavailable. Procedures name required host tools and explicitly acquire source when needed. Credentials and host authority come from the user's Agent environment, not the Skill. NanoCore/Web updates and separately authorized NanoHost work remain distinct.

## Maintenance And Packaging

Keep one maintained source per topic. `docs/manual/` points to the operations package; release packaging includes each complete Skill tree and license with matching checksums. Changes to supported behavior update the affected reference in the same slice. Skill metadata and package checks do not replace a real-use proof.

Worker-side MCP and Skill supply retain their Agent Capability and catalog owners. Neither package introduces a user-facing MCP server, developer-mode product client, fleet, daemon or self-improvement harness.

The operations package's dogfood recipe distinguishes external-coordinator `repository.push-*` App API calls from the explicitly selected built-in worker `openkit-repository` tools. Worker publication uses the existing authenticated capability relay and retains the host-linked commit prerequisite, repository approval and Vault checks. The Skill CLI does not acquire a worker App API tunnel or bearer credential.

`workspace.dashboard`, `thread.dashboard`, `conversation.navigation`, `app.search`, and `worker.list` use existing public Core Client reads. `worker.list` maps `listWorkspaceWorkers` through `client.app.listWorkspaceWorkers` for one Workspace id and is distinct from configured `agent.list`. NanoCore filters Thread and Artifact-origin visibility before discovery, including for administrator credentials. Last-used Worker usage requires `audit.read` or is omitted as restricted. Public `thread.create` defaults to private; use explicit `visibility: workspace` when creating formal Task/Goal work.

Public Vault secret administration exposes `vault.secret-create`, `vault.secret-rotate`, `vault.secret-revoke`, `vault.grant-create`, and `vault.grant-revoke`. Creation and rotation consume secret stdin JSON. Validation failures for secret-input operations return a fixed error without request-derived schema issues, which may themselves contain secret keys or values. The default grant authorizes approved host Git push; an explicit `runtime-env` grant separately authorizes Worker GitHub CLI token injection. Repository binding stays in `repository.set-default`. See the public administration reference and operator recipe for the complete flow.

The public administration reference distinguishes host repository diagnostics and operator-owned container mount repair from revision-bound Worker Git source configuration for future sessions, and explains exact input-resource identity when repairing a missing review target. It also documents preserving repository identity and Git policy when enabling commit-on-apply through the existing public operation. Web and Skill use the same public configuration/reload operations; neither grants host privileges.

The recovery reference explains normalized Git HTTP-refusal evidence from the existing Turn read surface: unavailable attribution remains explicit, and a new Task still requires current authority and cleanup/storage admission. It does not promise delegated policy writes or whole-service recovery.
