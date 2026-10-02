---
status: Accepted
date: "2026-10-02"
decider: Engineer
---
# Hosting Goes Through The Gateway MCP

## Decision

The engineer ruled on 2026-10-02 that platform-managed GitHub writes go through the Gateway, and that the NanoCore host Git publication path retires. Remote GitHub writes, including creating branches, pushing file changes, and opening and updating pull requests, default to the Gateway-mediated vendor MCP. That path places no write credential in the Sandbox. Native `git push` stays possible only as user-space configuration: a user-injected credential plus admitted `git-receive-pack` egress. The platform adds no mechanism for native push. This ruling resolves roadmap gate D1.

Three follow-up rulings, each the coordinator's recommendation accepted by the engineer, settle the remaining host-repository questions. (a) The first initialization of a Sandbox Git work slot is verified against the commit id the data source pins. The Sandbox Git client fetches and checks out that commit, reports its HEAD and tree, and NanoCore compares the commit id. No NanoCore host repository is read. (b) The Workspace host repository resource retires entirely, including `workspace_repository_resources`, the host `localPath`, write settings, and the Assistant's read-only inspection of that resource. A repository is a data source, a URL and a commit, in the catalog. The Assistant inspects code through the Gateway vendor MCP read tools or by delegating a Task. The Repositories settings screen goes away. (c) Private repository clone and fetch in the first release use a read-only token the user injects into the worker environment through the existing runtime-env injection. That injection is user-space configuration. The platform adds no source-credential mechanism in the first release.

Workers use installed Git freely for local work inside the admitted Sandbox. Platform-managed external hosting calls use an explicitly selected vendor MCP server through NanoCore's Gateway, with gateway-held credentials and the MCP owner's authentication, current authorization, configured per-tool approval, and audit. OpenKit adds no first-party Git or GitHub operation, owner, proxy, registry, or approval mode. Publication into Core-owned canonical Workspace data stays on the non-Git Workspace synchronization apply path. Ruling (a) replaces the Git-source clause of the 2026-09-30 baseline decision that required the accepted commit and its tree in NanoCore's own repository. That record is otherwise unchanged, including baseline timing, the double scan, retained slots, and fail-closed acceptance. The rules live in the affected owners named below.

## Reason

Translated from Chinese. The engineer: "Our NanoCore is positioned as the agent Control Plane, and it is general purpose, not only for software development; software development is a very large and important use case. For GitHub, NanoCore should have an MCP proxy connecting the worker's operation requests to the remote GitHub MCP server, performing authentication, audit and so on in between. Git is installed in the Sandbox, and the worker in the Sandbox performs commits, pull-request changes and similar operations through the NanoCore-proxied GitHub MCP."

The coordinator had first recommended keeping host publication for writes. The engineer rejected that recommendation because it builds one business into NanoCore. The engineer then chose the Gateway-mediated vendor MCP as the default for remote GitHub writes, user-space configuration as the only native-push path, and retirement of the NanoCore host Git publication path. The engineer accepted the coordinator's recommendations for the Git work-slot check, the retirement of the host repository resource, and the first-release private-read token.

## Rejected Alternatives

- Keep NanoCore host publication for writes. The coordinator recommended this first. The engineer rejected it because it builds one business into NanoCore.
- Make native `git push` the platform default. Rejected. Remote GitHub writes default to the Gateway-mediated vendor MCP, and that path puts no write credential in the Sandbox.
- Allow only the vendor MCP and ban user-space native push. Rejected. Native `git push` stays possible as user-space configuration, and the platform adds no mechanism for it.
- Keep a read-only host repository for inspection. Rejected by ruling (b). The host repository resource retires entirely. The Assistant inspects code through the Gateway vendor MCP read tools or by delegating a Task, and the Repositories settings screen goes away.
- Add a platform-managed private read credential in the first release. Rejected by ruling (c). Private clone and fetch use a read-only token the user injects through the existing runtime-env injection, and the platform adds no source-credential mechanism in the first release.

## Revisit When

The engineer stated no revisit trigger.

## Affected Owners

- docs/specs/20260704-worker_mcp_tool_supply.md
- docs/specs/20260709-worker_sandbox_freedom_policy.md
- docs/specs/20260704-workspace_data_source_catalog.md
- docs/specs/20260704-vault_backend_implementation.md
- docs/specs/20260703-vault_secret_injection.md
- docs/specs/20260704-session_static_workspace_materialization.md
- docs/specs/20260703-workspace_synchronization.md
- docs/specs/20260704-chat_mode_assistant.md
- docs/specs/20260628-web_product_surface_projection.md
- docs/specs/20260704-git_write_workflow.md
- docs/core/storage.md
- docs/roadmap.md
- docs/decisions/20261002-first_release_interface_scope.md
- docs/decisions/20260930-first_accepted_base_by_baseline_scan.md
