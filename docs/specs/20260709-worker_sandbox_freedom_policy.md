---
status: Accepted
implementation: Partial
kind: concept
aspect: sandbox
---
# Worker Sandbox Freedom Policy

## Scope

OpenKit does not adopt the upstream OpenShell policy file as the product contract.

## Owns

- Worker sandbox freedom principles for process execution, filesystem access, network access, and user-provided secret injection.
- The relationship between raw sandbox policy controls, Agent Environment Package policy intent, OpenShell policy materialization, and future capability presets.
- The first product rule for user-configurable filesystem and network allowlists in worker sandbox creation.

## Does Not Own

- The full Capability Catalog, organization approval, and workspace admin workflows belong to their capability and policy owners.
- Gateway metering, HTTP method filtering, and payload inspection are not this policy.
- Provider API semantics beyond credential and endpoint attachment belong to the provider owner.
- Governed MCP, knowledge, artifact, diagnostic, and inference planes keep their existing owners.
- The upstream OpenShell policy file is a materialization baseline, not this product contract.

[Sandbox](../core/sandbox.md), [Mediation](../core/mediation.md), [Agent Supply](../core/agent-supply.md), [Policy](../core/policy.md), and [Vault](../core/vault.md) are the Core links.

## Principles

- The sandbox exists to give the worker agent a useful environment with real tools, not to reduce it to a narrow remote procedure executor.
- Process execution is not the primary security boundary for ordinary developer tools; filesystem, network, credentials, resource limits, and review gates carry the main containment responsibility.
- Network egress remains deny-by-default and must be allowlisted by host, port, protocol, access level, and where the backend supports it, binary path.
- The resolved AEP is the complete effective network authority for one worker launch; backend defaults, deployment environment values, image metadata, adapter configuration, runtime discovery, and provider defaults MUST NOT add an endpoint, widen a rule, or expand the authorized executable-and-descendant scope defined by [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md#manifest-shape).
- Filesystem access remains bounded by declared read-only and read-write roots, with the worker's own sandbox workspace and temporary directories available by default.
- User-provided secrets may be injected into worker sessions, but secret values must not be persisted into AEP snapshots, prompts, item payloads, context packages, audit rows, normal workspace files, or sandbox snapshots.
- Capability presets should make common grants easy and reviewable, but they should not be the only long-term mechanism for expressing sandbox access.
- Backend-native policy files are materialization outputs and evidence; NanoCore-owned records remain the product source of truth.

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

The writable temporary root is `/tmp/openkit-bootstrap`. The image sets `TMPDIR`, `TMP`, and `TEMP` to that path. The fixed OpenShell policy does not grant the whole `/tmp` tree.

Writable grants to Core-managed config, server data roots, vault storage, or backend control directories remain blocked unless a future trusted maintenance-agent mode explicitly owns that risk.

## Network Model

Network policy is default-deny.

Exact selected MCP supply may add only the fixed loopback Integration capability route; it adds no upstream MCP endpoint or direct egress.

The effective allowlist is exactly the normalized network rules recorded in the immutable AEP, including any Core-projected worker-control or inference endpoint. The governed backend may reject an AEP rule it cannot enforce, but it MUST NOT merge undeclared endpoints from backend defaults, process environment, deployment configuration, selected image, runtime adapter, or provider configuration.

Users may add network allowlist entries at worker creation time.

A network allowlist entry must declare id, host, port, protocol, purpose label, and non-empty binary paths. It declares either an access mode or a non-empty exact REST rule list, never both.

Wildcard hosts, unrestricted ports, and private network ranges should be rejected in the first user-facing implementation unless an operator-only escape hatch explicitly enables them.

The first implementation supports HTTPS REST access presets and bounded `GET` or `POST` path rules because stock OpenShell already enforces that shape. Exact rules may use OpenShell path globs but hosts remain exact, rule paths must be absolute and free of line breaks, and another HTTP method remains unsupported until a present workload and backend proof justify it.

The authored grant schema admits `http` and `https` access-mode declarations. The OpenShell backend accepts only `rest` and refuses an unsupported protocol before launch. The backend adds no built-in Codex or DeepWiki endpoint, backend network option, or deployment environment variable.

Encoded-slash authority is owned by the `allowEncodedSlash` grant contract in [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md#manifest-shape). NanoHost projects admitted `true` as native OpenShell `allow_encoded_slash: true` on that endpoint with `protocol: rest`, `access: read-only`, and `enforcement: enforce`. Omission or `false` retains native strict behavior. Every other endpoint key remains subject to closed validation. The backend must reject unsupported or conflicting intent before launch rather than dropping the field, widening another endpoint, relaxing TLS inspection, or substituting a broader access mode.

The decision and its reason are recorded in [a decision record](../decisions/20261008-encoded_slash_authority_and_release_hold.md).

Public-class eligibility and effective-rule overlap are owned by [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md#manifest-shape). This owner materializes the admitted host, port, binary, method and path constraints and the separately admitted encoded-slash setting; it adds no undeclared backend capability or header, query, MCP tool, argument or body inspection. Public-class exact-rule grants cannot declare the encoded-slash setting. User-supplied keys inside user space are not converted into platform credential declarations or a payload-inspection obligation.

The decision and its reason are recorded in [a decision record](../decisions/20260930-public_endpoints_by_admitted_grant.md).

### Built-In Development Baseline

The repository-owned AgentManifest templates explicitly grant GitHub Smart HTTP clone and fetch, read-only GitHub REST access through `gh`, scoped and unscoped npm registry reads through the declared Node package binaries, and read-only PyPI index and artifact access through the declared uv, Python, and pip binaries. [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md#built-in-development-grant-templates) owns the exact copy-on-init grants, including npm's explicit encoded-slash authorization. [Worker Execution Environment Images](20260721-worker_execution_environment_images.md) owns installed binary paths and image correspondence; images confer no grant authority.

GitHub Smart HTTP uses `GET /**/info/refs*` and `POST /**/git-upload-pack`; it omits `POST /**/git-receive-pack`, so the baseline does not grant push. These entries are ordinary manifest-authored AEP rules, not backend defaults or image policy. An explicit user-injected credential together with an admitted `git-receive-pack` grant may authorize native Git push. That path is user-space configuration. OpenKit adds no platform mechanism for it. Credentials delivered for platform-managed hosting remain gateway-only and are not this baseline. The decision and its reason are recorded in [a decision record](../decisions/20261002-hosting_through_gateway_mcp.md).

Trusted worker inference requires its exact control and inference routes and excludes direct provider authority, but it may coexist with unrelated manifest-authored development grants. A validator must distinguish the LLM route boundary from the package's complete network list rather than requiring a relay-only list.

Acceptance requires successful scoped npm metadata and tarball reads through the declared registry and executable scope, with both `%2f` and `%2F` metadata paths accepted when explicitly granted. Omitted or false encoded-slash authorization must reject those path encodings. Read-only enforcement must reject POST, PUT, PATCH, and DELETE before forwarding. Existing exact-rule grants retain their method/path restrictions and strict encoded-slash behavior, including Git clone/fetch authorization and denial of `git-receive-pack`. Conflicting same-destination settings must refuse launch rather than relax an exact-rule grant. A native denial record or an upstream non-arrival observation must distinguish policy refusal from an upstream application error.

Tarballs using ordinary unencoded paths do not themselves require the new flag. At the native boundary, controlled upstream capture must prove `%2f` becomes `%2F`, malformed input still fails, and POST/PUT/PATCH/DELETE never arrive. A registry 401/404 or any npm command's zero exit alone cannot prove write denial. Synthetic write probes use controlled disposable fixtures, not the public registry.

The final authorized product observation must bind source candidate, selected authored manifest, AEP, loaded policy, and execution result. Fetch pinned scoped metadata and its actual tarball, verify archive integrity/content, and run a minimal npm/pnpm dependency acquisition containing scoped and unscoped packages from an empty cache with lifecycle scripts disabled. Include the strict omitted/false control and unchanged Git allow/deny behavior.

## Secret Injection Model

[Worker Credential Access Declarations](20260703-vault_secret_injection.md#runtime-file-visibility) owns declaration fields, visibility, lifetime, and channel lifecycle. A declaration also names its intended consumer, its redaction behavior, and whether the value is session-only or a reusable vault reference. Secret values pass only through backend-private materialization and must not appear in a durable package snapshot. Ungoverned or raw provider input still refuses before execution. A governed static binding follows that owner. If the backend cannot enforce a declared injection, launch fails before worker execution.

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

The AEP retains the recognized admission marker as policy evidence; OpenShell YAML remains a projection of the existing enforceable network fields. Materialization must not invent a publicAccess backend field, a middleware, a credential injection or a request filter. Unknown admission-class semantics fail at the owning Core boundary rather than being treated as a harmless optional field. Existing credentialed non-LLM REST grants and Vault injection contracts are unchanged.

## Invariants

- Worker process execution SHOULD be broad inside the sandbox, subject to image composition and explicit dangerous-class restrictions.
- Worker network access MUST remain default-deny and allowlist-based.
- Materialized network policy MUST equal the AEP allowlist and MUST NOT contain a backend-added or environment-added endpoint.
- Worker filesystem access MUST remain bounded by declared read-only and read-write grants.
- User-provided secrets MUST use explicit injection declarations and MUST NOT appear in AEP snapshots, prompts, item payloads, context packages, audit records, usage records, normal workspace files, or sandbox snapshots.
- Capability presets MUST expand to explicit sandbox, provider, gateway, approval, and instruction effects rather than bypassing them.
- Backend-native OpenShell policy files MUST remain derived materialization output, not canonical product state.

## Acceptance

Acceptance materializes one AEP through the governance backend and compares the normalized network rules exactly. A backend-shaped extra endpoint is ignored rather than merged. A non-transient ungoverned provider credential fails before provider upsert or sandbox creation. Encoded-slash acceptance stays in [Built-In Development Baseline](#built-in-development-baseline).

## Implementation

- `apps/nanohost/src/`
- `apps/nanocore/src/runtime/`
- `packages/config-schema/src/`

## Implementation Gaps

- Reusable capability presets, inherited approval policy, and admin governance remain beyond direct grants - The full catalog is not implemented - #330
- Organization role policy for who can approve reusable network, filesystem, and secret grants - That approval surface is not implemented - #334
- Selected backend and native egress qualification - That qualification is not established - #684

## Decisions

- [Encoded slash](../decisions/20261008-encoded_slash_authority_and_release_hold.md) records encoded-slash authority.
- [Public endpoints](../decisions/20260930-public_endpoints_by_admitted_grant.md) records public-class eligibility.
- [Hosting through Gateway MCP](../decisions/20261002-hosting_through_gateway_mcp.md) records that platform-managed hosting stays gateway-only.
