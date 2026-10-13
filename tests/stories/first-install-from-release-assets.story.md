---
id: first-install-from-release-assets
title: Install a published release on an empty machine
persona: Operator installing OpenKit for the first time
entrypoint: skill
default_tool: openkit
timeout_seconds: 1800
requires_real_provider: false
requires_real_codex: false
contracts: docs/specs/20260829-release_management.md, docs/specs/20260910-agent_operator_skill.md, docs/specs/20260704-nanocore_bootstrap_readiness.md, docs/specs/20260802-nanohost_runtime_and_transport.md, docs/specs/20260708-container_image_packaging.md
---

## Intent

Persona: An operator installing OpenKit for the first time on an empty machine.

Ask: Install this published release and show me that it is ready to use.

## Starting World

One disposable host has no OpenKit data and no running OpenKit service. The host holds only the published prerelease assets. The host has no source checkout and no locally built image.

## Setup

The stage manager provides that disposable host and those published assets. The stage manager does not add a source checkout or a locally built image.

## Outcome Predicates

- Channel outside-in, tier required. The public health response and the Web entry both show that the installed product is serving. `docs/specs/20260708-container_image_packaging.md` names the health observation. The Web entry is the public product surface.
- Channel inside-out, tier required. The authenticated diagnostics boot projection shows readiness, and its blocking set is empty. The record is the diagnostics boot projection. `docs/specs/20260704-nanocore_bootstrap_readiness.md` owns that projection.
- Channel inside-out, tier optional. When the install includes a NanoHost target, the runtime-target read shows that configured target ready. The judge skips this predicate when the install has no NanoHost target. The record is the runtime-target observation. `docs/specs/20260802-nanohost_runtime_and_transport.md` owns that observation.

## Perturbations

None.

## Integrity Invariants

None.

## Evidence To Collect

The stage manager records the digest of each asset present on the host. The stage manager also keeps the public health response, the Web entry, and the authenticated diagnostics read. When a runtime target is configured, the stage manager keeps that runtime-target read.

## Cleanup

The stage manager destroys the disposable host and its attempt state after evidence collection.

## Failure Triage Notes

- A product failure means the install does not serve, the diagnostics projection is not ready, or a configured runtime target is not ready.
- An environment failure means the disposable host, a published asset, or the network fails before a product result exists.
- A tool failure means the operations client or the evidence collector fails on its own.
- An inconclusive result means a required readiness read was never witnessed.
- The likely lower layer is the image smoke and the host-requirement check.
