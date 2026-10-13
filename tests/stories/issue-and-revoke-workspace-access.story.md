---
id: issue-and-revoke-workspace-access
title: Issue workspace access and then revoke it
persona: Operator granting an outside helper access to one workspace
entrypoint: skill
default_tool: openkit
timeout_seconds: 600
requires_real_provider: false
requires_real_codex: false
contracts: docs/specs/20260704-remote_auth_credential_bootstrap.md, docs/specs/20261002-remote_mcp_interface.md, docs/core/protocol.md, docs/specs/20260703-storage_layout_record_ownership.md, docs/specs/20260909-thread_visibility_and_sharing.md
---

## Intent

Persona: An operator who needs an outside helper in one workspace and then needs that access withdrawn.

Ask: Let an outside helper connect with access that can start a project thread in this workspace, make sure a look-only pass cannot start a thread, and then withdraw the access that can make changes. Keep the access key in the helper's connection settings and do not show it.

## Starting World

One persistent deployment has one workspace the operator can administer. No attempt-owned access exists yet.

## Setup

The stage manager provisions that workspace through the existing administrator path. The stage manager does not put an access-key value in the story or in the ask.

## Outcome Predicates

- Channel inside-out, tier required. A workspace-scoped Token was issued for that workspace, and a Thread in that workspace exists from a use of that Token. The records are the Token and the Thread. `docs/specs/20260704-remote_auth_credential_bootstrap.md` owns the Token's workspace scope. `docs/core/protocol.md` owns the Thread's canonical semantics. `docs/specs/20260703-storage_layout_record_ownership.md` owns the Thread's storage source of truth. `docs/specs/20260909-thread_visibility_and_sharing.md` owns the Thread's audience and read boundary.
- Channel outside-in, tier required. A look-only pass is refused when it tries to start a Thread, and the refusal does not reveal whether a target exists. `docs/specs/20260704-remote_auth_credential_bootstrap.md` owns that refusal.
- Channel inside-out, tier required. That look-only attempt leaves no Thread that it created. The record is the Thread set. `docs/specs/20260704-remote_auth_credential_bootstrap.md` owns the look-only boundary. `docs/core/protocol.md` owns those Thread records' canonical semantics. `docs/specs/20260703-storage_layout_record_ownership.md` owns their storage source of truth. `docs/specs/20260909-thread_visibility_and_sharing.md` owns their audience and read boundary.
- Channel inside-out, tier required. The changing access is revoked. The record is the Token status. `docs/specs/20260704-remote_auth_credential_bootstrap.md` owns revocation.
- Channel outside-in, tier required. A later use of that revoked access is refused. `docs/specs/20260704-remote_auth_credential_bootstrap.md` owns that refusal.
- Channel outside-in, tier required. The access key does not appear in the actor's result or in retained story evidence. `docs/specs/20260704-remote_auth_credential_bootstrap.md` owns the rule that a verification failure does not echo the presented value.
- Channel inside-out, tier required. The helper connection's last-used summary records the remote channel and does not record the secret. The record is the Token last-used summary. `docs/specs/20261002-remote_mcp_interface.md` owns that summary. `docs/specs/20260704-remote_auth_credential_bootstrap.md` owns the static bearer as an ordinary Token.

## Perturbations

None.

## Integrity Invariants

None.

## Evidence To Collect

The stage manager keeps the public Token inventory without secret material, the public Thread read, the authorization refusal, the response from a later use of the revoked access, and the last-used channel summary.

## Cleanup

The stage manager revokes any attempt-owned Token that is still active and removes attempt-owned helper state. The created Thread may remain.

## Failure Triage Notes

- A product failure means a look-only pass creates a Thread, a revoked Token still works, a secret is printed, or a workspace-scoped Token cannot create a Thread.
- An environment failure means the administrator or the workspace is missing before issuance.
- A tool failure means the administrator client fails on its own.
- An inconclusive result means a required Token use was never witnessed.
- The likely lower layer is the scope and revocation tests under `docs/specs/20260704-remote_auth_credential_bootstrap.md`.
