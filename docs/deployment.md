# Deployment Model

Status: Accepted

This document defines OpenKit deployment semantics.

This document owns deployment placement axes, Core placement, agent placement, release artifact placement, communication-plane mapping by deployment, and deployment-level vault boundaries.

This document does not own concrete provisioning scripts, container image Dockerfiles, registries, cloud providers, mediation wire schemas, runtime session lifecycle, sandbox containment details, protocol schemas, app endpoints, release workflow syntax, or backend-specific launch commands.

Deployment describes where Core runs, where agents run, and how communication planes connect.

## Principles

- Deployment placement must not change core semantics for workspace, thread, turn, item, artifact, approval, agent, agent session, knowledge, vault, audit, or usage.
- Communication planes may use different transports in different deployments, but the logical model remains stable.
- Desktop, server, remote, container, and managed shapes are deployment projections over the same Core model.
- Runtime mediation components are communication infrastructure, not policy owners, product-state owners, control relays, or worker agents.
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

## Current Small-Deployment Baseline

The current engineering target is one NanoCore process per data root, one logical SQLite writer over local scoped databases, a small team that is typically under ten people, and one configured local or remote worker target with one active worker slot. The team-size statement is a design and verification profile, not a hard authorization or membership limit.

The configured worker target may be local or remote, but V1 chooses it from deployment configuration rather than a dynamic fleet. The remote path uses the accepted stock OpenShell Cell and its authenticated operator-managed transport; remote placement does not expand the baseline into a multi-node Core or a general cluster scheduler.

This baseline does not promise multiple NanoCore writers, shared-database coordination, high availability, hot failover, dynamic multi-target placement, cross-workspace fairness, or transparent recovery from every crash boundary. A bounded same-worker reconnect may preserve useful work after NanoCore restart; when exact adoption or terminal proof fails, explicit interruption, inspection, cleanup, and a new authorized attempt are acceptable.

Future managed or scaled deployment descriptions are non-authorizing. They create no current record, state, configuration, compatibility, implementation, runner, harness, or test requirement until an accepted current design promotes a concrete need.

## Release Artifact Placement

Release artifacts are deployable projections of the Core and worker placement model.

OpenKit deployment may use separate app and worker artifacts:

- The app artifact contains the Core server, product HTTP entrypoint, Web assets when present, migrations, and data-root templates.
- Worker artifacts contain agent runtime dependencies, worker shims, and worker-visible setup paths.

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

Workspace and artifact planes may use bind mounts. Governed workers use direct NanoCore control. Future capability traffic may use an explicitly projected Core endpoint or managed mediation service.

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

## Capability Mediation

Future capability mediation may project an explicitly enabled Core capability route into an agent environment through a network proxy, runtime adapter, or managed service. The mediation component does not carry worker-control traffic and does not own product state, policy decisions, credentials, metering, or capability availability. Current worker AEPs disable the capability plane and expose no capability routes.

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

Agents should receive credentials only through approved proxy or adapter injection mechanisms.

Deployment must not require writing secret values into prompts, knowledge, manifests, item logs, normal workspace files, or container images.

## Invariants

- Deployment choices MUST NOT change core object semantics or product history semantics.
- A capability mediation component MUST NOT carry worker-control traffic or own model choice, provider fallback, rate limits, tool visibility, permission policy, or product workflow state.
- Deployment MUST preserve distinct control, workspace, artifact, and capability planes even when they share physical network infrastructure; capability mediation must not carry worker-control traffic.
- Deployment MUST NOT require writing secret values into prompts, knowledge, manifests, item logs, normal workspace files, or container images.
- Backend-native state MUST be normalized into OpenKit records before it becomes product-visible.
- Release artifacts MUST be traceable to their source version and MUST NOT become owners of product state, policy decisions, or vault secrets.
- The current baseline MUST remain operable with one NanoCore process, local SQLite storage, and one configured worker target; future scale assumptions MUST NOT become present deployment requirements.
