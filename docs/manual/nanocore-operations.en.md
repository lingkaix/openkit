---
status: Accepted
---
# NanoCore Operations

> **Scope placeholder:** This page intentionally records the operator procedures that must be documented before OpenKit has a complete supported operations manual. It does not replace the current deployment and configuration manuals.

## This Manual Should Cover

- Pre-upgrade inspection, release selection, release-note review, maintenance-window preparation, and post-upgrade verification for supported artifacts.
- Routine readiness, health, storage, runtime, worker, queue, usage, audit, and Telemetry checks, including expected signals and escalation thresholds.
- Backup boundaries for the NanoCore data root, repositories, external Vault key material, credential slots, and any data that remains authoritative in an external system.
- Restore validation, version and configuration preconditions, safe failure behavior, and proof that restored durable records and credentials are usable.
- Rotation and recovery procedures for operator credentials, provider credentials, NanoHost transport credentials, and Vault key custody without exposing secret material.
- Worker image and sandbox-policy updates, including acquisition, verification, rollout, interruption, retry, and cleanup behavior visible to the operator.
- Diagnosis and recovery for failed startup, degraded readiness, unavailable providers, disconnected NanoHost sessions, exhausted storage, failed migrations, and interrupted work.
- The supported export, portability, shutdown, restart, rollback, and decommission paths, with explicit data-loss warnings where an effect is irreversible.

## Owners This Manual Will Project

- [NanoCore Deployment Modes](./nanocore-deployment-modes.en.md)
- [NanoCore DATA_ROOT Config](./nanocore-data-root-config.en.md)
- [Deployment Model](../deployment.md)
- [Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md)
- [Vault](../core/vault.md)
- [AgentSession](../core/agent-session.md)
- [Release Management](../specs/20260829-release_management.md)
