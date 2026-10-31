---
status: Accepted
date: "2026-10-31"
decider: Engineer
---
# Worker Runtimes Upgrade To Latest

## Decision

On 2026-10-31 the engineer selected direct upgrades of all four worker runtimes, Codex, Pi, OpenCode and DeepSeek, to their latest published versions. Each runtime keeps its existing architecture and acceptance criteria. The other three runtime selections are recorded by their implementation owner.

The Codex upgrade moves from `@openai/codex@0.160.0` to the latest published npm version. The npm `latest` dist-tag was checked at execution start and selected `0.166.0`. The image, adapter pin, generated App Server schema snapshot, templates and fixture pins move together. No `0.160.0` compatibility path remains. This replaces the Codex selection in the [2026-10-05 worker runtime upgrade decision](20261005-worker_runtimes_upgrade_to_latest.md); the Pi, OpenCode and DeepSeek upgrades keep their separate implementation and qualification owners.

## Reason

Credential delivery is in v0.1.0 scope and uses App Server host-managed ChatGPT token login: `account/login/start` with type `chatgptAuthTokens`, the server request `account/chatgptAuthTokens/refresh`, and the `account/rateLimits/updated` notification. The engineer also selected current upstream fixes. This upgrade supplies the pinned protocol boundary; credential delivery remains separate work and is not enabled by this decision.

Pre-v0.1.0 data is not carried under the [existing earlier-version data decision](20260930-earlier_version_data_not_carried.md). No migration or dual reader is introduced. Runtime upgrade evidence does not close deployed Sandbox, live-provider or credential-delivery acceptance gates.

## Rejected Alternatives

- Retain `0.160.0`: the engineer selected npm latest and current upstream fixes directly.
- Keep old-pin compatibility or migrate pre-v0.1.0 data: the accepted first-release reset carries no earlier-version sessions.
- Implement credential delivery as part of the pin upgrade: the credential owner controls that behavior and its acceptance.

## Revisit When

The selected release fails an accepted adapter, credential, lifecycle or deployment criterion, or a later upgrade changes the consumed protocol or retained-data boundary. Preserve the failing criterion and resolve it with its owner.

## Affected Owners

- [Pi-ai Unified LLM Backend](../specs/20260708-pi_ai_unified_llm_backend.md)
- [Codex Worker Adapter](../specs/20260716-codex_worker_adapter.md)
- [Worker Execution Environment Images](../specs/20260721-worker_execution_environment_images.md)
- [Container Image Packaging And Release Publishing](../specs/20260708-container_image_packaging.md)
