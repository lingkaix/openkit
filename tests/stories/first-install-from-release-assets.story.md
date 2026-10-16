---
id: first-install-from-release-assets
title: Install a published release in an empty installation scope
persona: Operator installing OpenKit for the first time
entrypoint: skill
default_tool: openkit
timeout_seconds: 1800
requires_real_provider: false
requires_real_codex: false
contracts: docs/specs/20260529-l6_story_acceptance.md, docs/specs/20260909-persistent_deployment_acceptance.md, docs/specs/20260829-release_management.md, docs/specs/20260910-agent_operator_skill.md, docs/specs/20260704-nanocore_bootstrap_readiness.md, docs/specs/20260802-nanohost_runtime_and_transport.md, docs/specs/20260708-container_image_packaging.md
---

## Intent

Persona: An operator installing OpenKit for the first time in an empty installation scope on the dedicated development machine.

Ask: Install this published release and show me that it is ready to use.

## Starting World

The dedicated development machine has one selected empty OpenKit installation scope with no OpenKit data and no running OpenKit service in that scope. The public repository and published prerelease assets are available. No source checkout or locally built image is in use for the installation. No disposable VM is used. Any earlier OpenKit installation on the machine is fenced from this attempt.

## Setup

The stage manager prepares the selected empty OpenKit installation scope on the dedicated development machine and makes the public repository and published release assets available. Before the Actor run, the stage manager fences any earlier OpenKit installation from the selected scope and prevents its services from interfering with the attempt. The stage manager preserves its data and credentials, keeps unrelated machine state unchanged, and does not destroy the host. The installation uses no source checkout, locally built image, or disposable VM.

## Outcome Predicates

- Channel outside-in, tier required. The public health response and the Web entry both show that the installed product is serving. `docs/specs/20260708-container_image_packaging.md` names the health observation. The Web entry is the public product surface.
- Channel inside-out, tier required. The authenticated diagnostics boot projection shows readiness, and its blocking set is empty. The record is the diagnostics boot projection. `docs/specs/20260704-nanocore_bootstrap_readiness.md` owns that projection.
- Channel inside-out, tier optional. When the install includes a NanoHost target, the runtime-target read shows that configured target ready. The judge skips this predicate when the install has no NanoHost target. The record is the runtime-target observation. `docs/specs/20260802-nanohost_runtime_and_transport.md` owns that observation.

## Perturbations

None.

## Integrity Invariants

None.

## Evidence To Collect

The stage manager records the public release identity and the digest of each installation asset, the selected scope, its initial empty state, and the fencing of any earlier OpenKit installation. The stage manager also keeps the public health response, the Web entry, and the authenticated diagnostics read. When a runtime target is configured, the stage manager keeps that runtime-target read.

## Cleanup

The stage manager retains the installation as the dedicated development machine's OpenKit deployment, together with its data, credentials, and collected evidence. Cleanup removes only attempt-owned disposable state. It preserves any earlier fenced installation and unrelated machine state; it does not destroy the host or remove the retained deployment.

## Failure Triage Notes

- A product failure means the install does not serve, the diagnostics projection is not ready, or a configured runtime target is not ready.
- An environment failure means the dedicated development machine, public repository, published assets, or network fails during preflight, setup, or execution before the product result can be judged. After the Actor completes the ask and evidence collection succeeds, a doubtful product outcome is inconclusive; it is not an environment failure or tool failure.
- A tool failure means the operations client or the evidence collector fails on its own.
- An inconclusive result means a required readiness read was never witnessed.
- The likely lower layer is the image smoke and the host-requirement check.
