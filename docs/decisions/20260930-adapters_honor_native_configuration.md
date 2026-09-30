---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Adapters Honor Native Configuration

## Decision

Honor qualified runtime-native configuration, local instructions, Skills and tools in native precedence, with the necessary protected adapter overlay retaining current AEP, model/Gateway, managed MCP, platform credential and exact conversation authority. Prefer each selected pin's native separate-source layering for image defaults; otherwise initialize only a genuinely fresh private native home before resource loading. Retain populated homes without overwrite, synchronization or reseeding and preserve complete native bytes across close and exact successor resume. Each runtime pin must qualify its sources, precedence, loading, auth/logging posture and lifecycle; Codex plugins and hooks are assessed separately and are not enabled merely by accepting native configuration.

## Reason

The engineer's battle test asks whether a user who builds and configures their own Sandbox is served by OpenKit's designs and adapters. The engineer stated 「在这里事实上是应该给实际的用户留足空间和机制，以让他们能够 根据自己的需求，灵活的 创建和配置不同的沙盒和 workers」 (English translation: “Here we should in fact give real users enough room and mechanisms to flexibly create and configure different Sandboxes and workers according to their own needs.”). The engineer chose the recommended native layering, otherwise fresh-home initialization option for defaults and the recommended honor-native-conventions option for local configuration. Those choices preserve the user's native configuration without making OpenKit learn each user's packages or inventing another profile language.

The engineer selected 「原生分层，否则新 home 初始化」 (English translation: ‘Native layering, otherwise initialize a fresh home’) for defaults and 「遵从原生约定」 (English translation: ‘Honor native conventions’) for local configuration.

## Rejected Alternatives

- Manual per-home setup only: it leaves image-authored defaults unusable for fresh private homes even when the native runtime supports a qualified source.
- Explicit-AEP-resources-only discovery: it suppresses ordinary native local resources rather than separating them from managed supply and protected authority.
- An OpenKit profile format or synchronization service: it duplicates native format and lifecycle ownership, risks overwriting retained data and has no demonstrated need for this mechanism.

## Revisit When

A pinned runtime cannot preserve both native configuration and protected authority through a qualified native mechanism.

## Affected Owners

- [Persistent Worker Volumes](../specs/20260910-persistent_worker_volumes.md)
- [Worker Execution Environment Images](../specs/20260721-worker_execution_environment_images.md)
- [Codex Worker Adapter](../specs/20260716-codex_worker_adapter.md) — Adapter-specific amendment assigned to its builder; not included in this frozen commit.
- [Pi Worker Adapter](../specs/20260716-pi_worker_adapter.md) — Adapter-specific amendment assigned to its builder; not included in this frozen commit.
- [OpenCode Worker Adapter](../specs/20260716-opencode_worker_adapter.md) — Adapter-specific amendment assigned to its builder; not included in this frozen commit.
- [DeepSeek Worker Adapter](../specs/20260930-deepseek_worker_adapter.md) — Adapter-specific amendment assigned to its builder; not included in this frozen commit.
- [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md)
