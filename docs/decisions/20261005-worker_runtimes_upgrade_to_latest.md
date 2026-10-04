---
status: Accepted
date: "2026-10-05"
decider: Engineer
---
# Worker Runtimes Upgrade To Latest

## Decision

On 2026-10-05 the engineer decided, translated into English: "Upgrade; upgrade all four runtimes to their latest versions." The selected exact worker versions are Codex 0.159.2 to 0.160.0, OpenCode CLI and client 2.0.20 to 2.0.22, Pi coding-agent and its worker pi-ai, pi-tui and pi-mcp closure 0.99.1 to 1.0.2, and DeepSeek ACP client 1.4.0 to 1.7.0. DeepSeek dsh stays 0.2.0-rc.2 because that is npm latest. NanoCore's separate Gateway pi-ai is not a worker runtime and remains 0.99.2.

The upgrades preserve each accepted native adapter architecture and require exact installed-byte and dependency-closure qualification. This decision does not enable disabled Agent templates, accept implementation, or close deployed Sandbox and live-provider gates. Earlier-version data is not carried under the existing first-release decision; no migration is introduced.

## Reason

The engineer selected current published worker versions after the Pi 1.x research identified an available SDK/resident-host/JSONL v3 continuation path and relevant upstream correctness fixes. Research conclusions remain claims until checked against the selected installed packages. Worker dependencies and Gateway dependencies have separate owners and qualification boundaries.

## Rejected Alternatives

- Retaining older available worker pins: the engineer expressly selected upgrading all four runtimes.
- Upgrading the Gateway pi-ai with Pi: Gateway is outside the worker-runtime decision and has separate transport and provider qualification.
- Adding a compatibility reader or migration for earlier test data: the accepted first-release cutover uses a new data root and carries no earlier-version sessions.

## Revisit When

A selected release fails an accepted adapter, dependency-closure, credential, lifecycle or deployment criterion, or a future runtime upgrade changes its native architecture or retained-data contract. Such evidence requires an owner decision rather than weakening a failing check.

## Affected Owners

- [Codex Worker Adapter](../specs/20260716-codex_worker_adapter.md)
- [Pi Worker Adapter](../specs/20260716-pi_worker_adapter.md)
- [OpenCode Worker Adapter](../specs/20260716-opencode_worker_adapter.md)
- [DeepSeek Worker Adapter](../specs/20260930-deepseek_worker_adapter.md)
- [Worker Execution Environment Images](../specs/20260721-worker_execution_environment_images.md)
- [Container Image Packaging And Release Publishing](../specs/20260708-container_image_packaging.md)
- [Earlier-version data is not carried](20260930-earlier_version_data_not_carried.md)
