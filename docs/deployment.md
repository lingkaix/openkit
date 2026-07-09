# Deployment Model

Status: Accepted

This document defines OpenKit deployment semantics.

This document owns deployment placement axes, Core placement, agent placement, release artifact placement, bridge sidecar deployment shape, communication-plane mapping by deployment, and deployment-level vault boundaries.

This document does not own concrete provisioning scripts, container image Dockerfiles, registries, cloud providers, bridge wire schemas, runtime session lifecycle, sandbox containment details, protocol schemas, app endpoints, release workflow syntax, or backend-specific launch commands.

Deployment describes where Core runs, where agents run, and how communication planes connect.

## Principles

- Deployment placement must not change core semantics for workspace, thread, turn, item, artifact, approval, agent, agent session, knowledge, vault, audit, or usage.
- Communication planes may use different transports in different deployments, but the logical model remains stable.
- Desktop, server, remote, container, and managed shapes are deployment projections over the same Core model.
- Bridge sidecars are communication infrastructure, not policy owners, product-state owners, or worker agents.
- Secret values must remain in vault backends or Core-controlled injection paths across deployment shapes.
- Release artifacts should make deployment placement reproducible without changing Core semantics.

## Deployment Axes

OpenKit deployment has two main axes:

```text
Core placement:   desktop-embedded | server-side | future managed
Agent placement: local container | remote agent | managed sandbox
```

These axes are independent. The same core model should work across combinations.

These axes are conceptual placement shapes, not the exact runtime config enum values used by server config or agent setup config.

Local and server deployments should use the same data-root hierarchy. Local mode is an auth and user-resolution posture with a reserved local user scope; it is not a separate storage tree.

## Release Artifact Placement

Release artifacts are deployable projections of the Core and worker placement model.

OpenKit deployment may use separate app and worker artifacts:

- The app artifact contains the Core server, product HTTP entrypoint, Web assets when present, migrations, and data-root templates.
- Worker artifacts contain agent runtime dependencies, worker shims or sidecars, and worker-visible setup paths.

App artifacts and worker artifacts MUST remain separate release units unless a deployment explicitly owns a single-machine evaluation bundle.

Release artifact versioning SHOULD be traceable to one source commit and one release tag.

Production-style deployments SHOULD prefer exact version or digest references over mutable convenience tags.

Development deployments MAY use local image tags or locally built artifacts, but those tags are not release identity.

Release artifacts MUST NOT contain durable product state, vault secret values, workspace truth, approval decisions, or final policy decisions.

Changing a release artifact must not change workspace, thread, turn, item, artifact, approval, agent session, knowledge, vault, audit, or usage semantics.

## Core Placement

### Desktop-Embedded Core

Desktop-embedded Core runs as a local background service inside or beside a desktop app.

It may only expose loopback endpoints. It usually has no public domain or stable inbound IP.

This shape is important for local-first usage, personal workspaces, direct filesystem access, and simple development.

### Server-Side Core

Server-side Core runs on a reachable server.

It may expose public or private HTTPS endpoints, support multiple clients, and eventually support team workspaces.

This shape is more suitable for remote agents, shared workspaces, background jobs, and external channel integrations.

### Future Managed Core

Future managed deployments may add hosted Core services, relays, managed agents, managed storage, or organization policy.

The core protocol should not assume this deployment exists.

## Agent Placement

### Local Container Agent

A local container agent runs on the same machine as Core but inside a container.

Workspace and artifact planes may use bind mounts. Capability traffic may use Core loopback endpoints or a local bridge sidecar.

This improves packaging and isolation while preserving local operation.

Local container agents may use locally built worker artifacts during development.

Release deployments should use versioned or digest-pinned worker artifacts that implement the same worker contract.

### Remote Agent

A remote agent runs in another controlled runtime environment.

Remote agent deployment needs explicit handling for:

- provisioning
- setup
- control connection
- workspace synchronization
- artifact return
- agent capability gateway access
- session recovery
- audit

### Managed Sandbox

A managed sandbox is a provider-hosted runtime environment.

It may support snapshots, remote storage mounts, lifecycle APIs, managed credentials, and provider-specific isolation.

Provider-native state must be projected into OpenKit concepts before it becomes product-visible.

## Bridge Sidecar

`Bridge Sidecar` is an agent-side communication helper for deployments where the agent runtime should not call Core capability services directly or cannot directly reach the right endpoint shape.

The logical model is:

```text
Core <-> Bridge Sidecar <-> Agent
```

The physical connection direction is deployment-specific:

- Server-side Core with a reachable endpoint may let the sidecar dial Core.
- Desktop-embedded Core may dial a remote agent endpoint or sidecar after provisioning.
- Desktop-embedded Core may use SSH, a tunnel, a tailnet, a provider API, or a relay.
- Future managed deployments may let both Core and sidecar dial a relay.

The sidecar is part of communication infrastructure. It is not the agent runtime and not the policy decision owner.

## Communication Planes

Deployment must preserve the four communication planes:

```text
Control
Workspace
Artifact
Capability
```

Different deployments may use different transports for each plane.

Transport choices must not change the core semantics for workspace, thread, turn, item, artifact, approval, agent, or agent session.

## Vault Boundary

Secret values should remain in the vault backend or Core-controlled injection path.

Agents should receive credentials only through approved proxy, bridge, or adapter injection mechanisms.

Deployment must not require writing secret values into prompts, knowledge, manifests, item logs, normal workspace files, or container images.

## Invariants

- Deployment choices MUST NOT change core object semantics or product history semantics.
- A bridge sidecar MUST NOT own model choice, provider fallback, rate limits, tool visibility, permission policy, or product workflow state.
- Deployment MUST preserve distinct control, workspace, artifact, and capability planes even when one physical transport multiplexes them.
- Deployment MUST NOT require writing secret values into prompts, knowledge, manifests, item logs, normal workspace files, or container images.
- Backend-native state MUST be normalized into OpenKit records before it becomes product-visible.
- Release artifacts MUST be traceable to their source version and MUST NOT become owners of product state, policy decisions, or vault secrets.
