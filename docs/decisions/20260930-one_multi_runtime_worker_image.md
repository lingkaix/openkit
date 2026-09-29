---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# One Multi-Runtime Worker Image Is The Sole Deployment Image

## Decision

All four supported runtimes (Codex, Pi, OpenCode V2, and DeepSeek Harness) and the worker-shim with their adapters are packaged into one container image. That image is the only deployment worker image. It serves as the Sandbox configuration for the initial version's test and acceptance phase, and as the first, deliberately simple warm Sandbox after launch. The AEP selects the runtime per AgentSession within the image's declared runtime set.

`worker-common` remains the public extension base with an empty runtime set, from which users may derive their own images. The single-runtime images `worker-codex`, `worker-pi`, and `worker-opencode` are removed. Stored agent manifests that reference them are rewritten to the combined image by a one-way migration.

## Reason

In Round 17 on 2026-09-30 the engineer asked, translated from Chinese, that the four runtimes and their adapters be packaged into one container Sandbox, used both as the Sandbox configuration for the first version's test and acceptance phase and as the simple first warm Sandbox after launch. When asked whether the combined image should be the sole deployment image or an additional artifact, the engineer chose the sole image, accepting that the four runtimes' upgrades, architecture support, and failures become coupled and that the image is larger. Keeping three leaves would require rebuilding and testing each for the new adapters, plus a fourth DeepSeek leaf, at about four times the maintenance.

## Rejected Alternatives

- **The combined image as an additional artifact beside the three leaves**, rejected for the maintenance cost above.
- **Installing all runtimes into `worker-common`**, rejected because the common base keeps an empty runtime set for users' own derivations.
- **Keeping the old image ids as permanent aliases**, rejected as a compatibility shim; stored manifests are migrated instead.

## Revisit When

A runtime's upgrade or failure blocks the others often enough to justify separate artifacts, or the image size becomes a measured deployment problem.

## Affected Owners

- docs/specs/20260721-worker_execution_environment_images.md
- docs/specs/20260708-container_image_packaging.md
