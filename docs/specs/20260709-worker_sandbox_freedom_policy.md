---
status: Accepted
implementation: Partial
---
# Worker Sandbox Freedom Policy

## Summary

OpenKit worker agents run in a sandbox so they can use a rich development environment while Core keeps filesystem, network, credential, audit, and review boundaries under control.

The target rule is: process execution is broadly available inside the sandbox, filesystem and network access are constrained, credentials are explicit user-supplied injections, and future capability presets are convenience templates over these lower-level controls rather than the only way to grant access.

## Owns

- Worker sandbox freedom principles for process execution, filesystem access, network access, and user-provided secret injection.
- The relationship between raw sandbox policy controls, Agent Environment Package policy intent, OpenShell policy materialization, and future capability presets.
- The first product rule for user-configurable filesystem and network allowlists in worker sandbox creation.

## Does Not Own

- The full Capability Catalog implementation.
- Organization role management, workspace admin workflows, or enterprise policy delegation.
- Complete network gateway metering, HTTP method filtering, and payload inspection.
- Provider-specific API semantics beyond credential and endpoint attachment.
- Replacement of the governed MCP, knowledge, artifact, diagnostic, and inference capability planes.

## Core References

- `docs/core/sandbox.md`
- `docs/core/agent-capability.md`
- `docs/core/agent-supply.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- OpenShell Community base sandbox policy: `https://github.com/NVIDIA/OpenShell-Community/blob/main/sandboxes/base/policy.yaml`

## Related Docs

- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260721-worker_execution_environment_images.md`

## Principles

- The sandbox exists to give the worker agent a useful environment with real tools, not to reduce it to a narrow remote procedure executor.
- Process execution is not the primary security boundary for ordinary developer tools; filesystem, network, credentials, resource limits, and review gates carry the main containment responsibility.
- Network egress remains deny-by-default and must be allowlisted by host, port, protocol, access level, and where the backend supports it, binary path.
- The resolved AEP is the complete effective network authority for one worker launch; backend defaults, deployment environment values, image metadata, adapter configuration, runtime discovery, and provider defaults MUST NOT add an endpoint, widen a rule, or authorize another binary.
- Filesystem access remains bounded by declared read-only and read-write roots, with the worker's own sandbox workspace and temporary directories available by default.
- User-provided secrets may be injected into worker sessions, but secret values must not be persisted into AEP snapshots, prompts, item payloads, context packages, audit rows, normal workspace files, or sandbox snapshots.
- Capability presets should make common grants easy and reviewable, but they should not be the only long-term mechanism for expressing sandbox access.
- Backend-native policy files are materialization outputs and evidence; NanoCore-owned records remain the product source of truth.

## Decision

OpenKit should move worker sandbox execution toward a permissive process model and constrained data/egress model.

For process execution, the worker should be able to use the normal tools installed inside the selected sandbox image, including shell, language runtimes, package tools, Git tools, GitHub CLI, search tools, build tools, and test runners, unless a specific class is blocked by backend policy or image composition.

For filesystem access, the worker may read the image-provided runtime directories that are safe to expose, may write to sandbox workspace and temporary directories, and may access user-declared workspace roots according to explicit read-only or read-write grants.

For network access, the worker may only connect to endpoints declared in the immutable AEP, including its exact worker-control and selected inference routes. Exact selected MCP supply may add only the fixed loopback Integration capability route; it adds no upstream MCP endpoint or direct egress.

For credentials, users may provide arbitrary secrets for a worker session through explicit injection declarations, but the injection must carry a target path or environment key, visibility class, intended consumer, scope, lifetime, and redaction policy.

## OpenShell Baseline

OpenShell Community base `policy.yaml` is the closest baseline for the first implementation shape.

The upstream base policy uses filesystem sections for read-only and read-write paths, configures the process user and group as `sandbox`, and expresses network access through named `network_policies` that map allowed binaries to allowed endpoints.

That baseline supports the OpenKit direction because it does not require a narrow global process allowlist for every executable; instead it constrains filesystem reach and network egress while allowing named endpoint policies for tools such as Git, GitHub CLI, package managers, and agent runtimes.

OpenKit should not copy the upstream policy verbatim as a product contract, but it should use the same practical shape: a useful base image, broad local tool use, default-deny network, explicit endpoint grants, and constrained filesystem access.

## Process Model

Process execution inside the sandbox should default to available.

The worker image owns which binaries exist.

OpenKit policy may block or omit dangerous classes such as privilege escalation tools, daemon control tools, host mount tools, host device access, kernel or container control, and backend management commands.

OpenKit should avoid a user-authored per-binary allowlist as the default product model because it makes normal development workflows brittle and shifts attention away from the stronger filesystem, network, secret, and review controls.

When OpenShell network policy requires binary-to-endpoint binding, OpenKit should still provide binary lists for network policy entries, but those lists should constrain egress rather than define every local command the worker may execute.

## Filesystem Model

Filesystem policy is default bounded, not globally open.

The first baseline should include image/runtime directories as read-only, sandbox workspace and temporary directories as read-write, and user-declared workspace roots with explicit access mode.

Users may add filesystem allowlist entries at worker creation time.

A filesystem allowlist entry should declare id, target path or workspace root reference, access mode, purpose label, and whether the grant is session-scoped or reusable.

Host paths must not be exposed directly in product records.

Writable grants to Core-managed config, server data roots, vault storage, or backend control directories remain blocked unless a future trusted maintenance-agent mode explicitly owns that risk.

## Network Model

Network policy is default-deny.

The effective allowlist is exactly the normalized network rules recorded in the immutable AEP, including any Core-projected worker-control or inference endpoint. The governed backend may reject an AEP rule it cannot enforce, but it MUST NOT merge undeclared endpoints from backend defaults, process environment, deployment configuration, selected image, runtime adapter, or provider configuration.

Users may add network allowlist entries at worker creation time.

A network allowlist entry must declare id, host, port, protocol, purpose label, and non-empty binary paths. It declares either an access mode or a non-empty exact REST rule list, never both.

Wildcard hosts, unrestricted ports, and private network ranges should be rejected in the first user-facing implementation unless an operator-only escape hatch explicitly enables them.

The first implementation supports HTTPS REST access presets and bounded `GET` or `POST` path rules because stock OpenShell already enforces that shape. Exact rules may use OpenShell path globs but hosts remain exact, rule paths must be absolute and free of line breaks, and another HTTP method remains unsupported until a present workload and backend proof justify it.

### Built-In Development Baseline

The three repository-owned AgentManifest templates explicitly grant GitHub Smart HTTP clone and fetch, read-only GitHub REST access through `gh`, read-only npm registry access through the declared Node package binaries, and read-only PyPI index and artifact access through the declared uv, Python, and pip binaries. `docs/specs/20260721-worker_execution_environment_images.md` owns the exact endpoints, binary paths, and image correspondence.

GitHub Smart HTTP uses `GET /**/info/refs*` and `POST /**/git-upload-pack`; it omits `POST /**/git-receive-pack`, so the baseline does not grant push. These entries are ordinary manifest-authored AEP rules, not backend defaults or image policy.

Trusted worker inference requires its exact control and inference routes and excludes direct provider authority, but it may coexist with unrelated manifest-authored development grants. A validator must distinguish the LLM route boundary from the package's complete network list rather than requiring a relay-only list.

## Secret Injection Model

Users may inject arbitrary secrets into a worker session because real developer workflows often require service tokens, package registry credentials, deploy keys, API keys, or test credentials that OpenKit cannot pre-model.

Secret injection must be explicit and scoped.

Each secret injection should declare a stable secret id, delivery kind, target environment key or file path, consumer summary, lifetime, redaction behavior, and whether the value is session-only or saved as a reusable vault reference.

The initial implementation may support simple environment variable and runtime file injection before it supports provider profiles or capability presets for every secret class.

Secret values must only pass through backend-private materialization paths and must not appear in durable package snapshots.

## Capability Presets

Capability presets are named templates over Sandbox access, credential injection, Gateway routing, approval defaults, and worker instructions.

Examples include `github-read`, `github-gh-rest`, `npm-install`, `python-package-install`, `docs-fetch`, and `browser-test`.

Presets should be useful defaults, not the only access model.

Users should be able to start with direct network, filesystem, and secret declarations, and later replace common combinations with presets when the system has enough real usage evidence.

The full Capability Catalog remains the long-term structure for discoverability, audit summaries, policy defaults, marketplace-style capability reuse, and admin governance.

## User-Facing Creation Shape

The worker creation shape should expose three direct controls before the full catalog exists.

- Filesystem grants: a list of read-only or read-write workspace roots or sandbox paths.
- Network grants: a list of allowed endpoint declarations.
- Secret injections: a list of environment-variable or runtime-file secret injections.

The UI or API may also offer presets, but those presets should expand into the same underlying grants.

## Relationship To AEP

AEP MUST carry the resolved effective sandbox policy intent, not raw user input.

NanoCore MUST validate user input, normalize it, redact sensitive details, resolve workspace-relative paths, attach vault references, and then write the effective policy intent into the package snapshot.

OpenShell YAML remains backend materialization output derived solely from the AEP and the selected backend's enforcement mechanics. Stock OpenShell policy baselines may supply filesystem and process mechanics required to run the sandbox, but they do not authorize network egress beyond the AEP.

If a backend cannot enforce a declared filesystem, network, or secret-injection requirement, launch MUST fail before worker execution.

## Invariants

- Worker process execution SHOULD be broad inside the sandbox, subject to image composition and explicit dangerous-class restrictions.
- Worker network access MUST remain default-deny and allowlist-based.
- Materialized network policy MUST equal the AEP allowlist and MUST NOT contain a backend-added or environment-added endpoint.
- Worker filesystem access MUST remain bounded by declared read-only and read-write grants.
- User-provided secrets MUST use explicit injection declarations and MUST NOT appear in AEP snapshots, prompts, item payloads, context packages, audit records, usage records, normal workspace files, or sandbox snapshots.
- Capability presets MUST expand to explicit sandbox, provider, gateway, approval, and instruction effects rather than bypassing them.
- Backend-native OpenShell policy files MUST remain derived materialization output, not canonical product state.

## Current Implementation Projection

The current OpenShell backend compiles base network policy only from the immutable AEP. It has no built-in Codex or DeepWiki endpoints, backend network option, or deployment environment variable that can append a rule. The 2026-07-21 refinement adds bounded authored `GET` or `POST` REST rules and the built-in development grants while preserving the same no-hidden-authority invariant. It also rejects non-transient backend provider credentials before provider or sandbox effects because the current AEP does not carry the exact Providers v2 endpoint and binary policy; the internally generated trusted-inference profile remains limited to the AEP's exact inference authority.

The correction preserves the unmodified stock OpenShell `0.0.80` boundary. The selected MCP `capability.local` slice uses only the existing fixed loopback Integration path and separately authenticated Gateway mediation; it authorizes no direct undeclared egress, upstream endpoint, or worker-visible credential.

Acceptance materializes one AEP through the governance backend and compares the normalized network rules exactly; regressions prove that a backend-shaped extra endpoint is ignored rather than merged and that a non-transient provider credential fails before provider upsert or sandbox creation.

## Deferred Work

- Full Capability Catalog with reusable presets, admin policy, workspace inheritance, and approval defaults.
- Additional HTTP methods, query-aware rule semantics beyond OpenShell path matching, and richer user-facing exact-rule editing.
- Organization role policy for who can approve reusable network, filesystem, and secret grants.
- Dynamic network or filesystem policy updates for already-running worker sessions.
- Rich secret classes such as provider profiles, refreshable credentials, and scoped credential brokers for every external service.
