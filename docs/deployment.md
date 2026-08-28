---
status: Accepted
---
# Deployment Model

## Judgments

Calibrated premises about scope and optimization target, formed from team shape and current operating conditions rather than derived from a contract. As `docs/documentation-model.md` requires of this section, they are not behavioral contracts, no implementation choice cites one as its sole authority, the owning core document or specification decides every behavioral question, and each premise states what it rests on and what observation would overturn it.

### The Deployment Target Is One Small Team, Not A Fleet

OpenKit is optimized for one small team, typically under ten people, running the single-process profile that `docs/specs/20260703-runtime_scheduling_scale.md` states rather than a fleet.

The team-size statement is a design and verification profile, not a hard authorization or membership limit. Nothing enforces a user count: no admission check, policy rule, seat record, license, or configuration value derives from it, and exceeding it produces no error. What it does is decide where effort goes — one writer instead of coordination, one configured target instead of scheduling policy, inspectable interruption instead of transparent recovery — and which shapes verification is expected to prove.

Rests on: the current internal-development posture, in which the product is dogfooded by its own small team; the single-writer, single-slot profile that `docs/specs/20260703-runtime_scheduling_scale.md` states; and no measured contention from real concurrent demand. The enforceable counts inside that shape are contracts owned by that specification, not consequences of this premise, so they are cited here rather than repeated.

Overturned by: sustained contention observed in real use — work queueing behind the single worker slot, writer-lock waits or failures under ordinary load, or a deployment whose membership makes the single-writer data root the binding constraint. Any of those retires the premise. The observation alone authorizes nothing; `docs/core/foundation.md` states what an accepted current design has to supply before implementation, configuration, or test obligations may follow a replacement profile.

## Owns

This guide owns no behavioral contract and no repository-operation decision. No deployment, architecture, product, runtime, release, security, or workflow decision is authoritative here.

## Does Not Own

This guide does not own any contract or implementation fact linked below. Core documents, specifications, code, configuration, and operator materials remain their owners. The index is non-exhaustive and exists only for discovery; where it disagrees with an owner, the owner wins and this document is the defect.

## Owner And Projection Index

- Deployment scope and semantic invariance: `docs/core/foundation.md`, `docs/core/architecture.md`
- Core mode, startup, configuration, identity, authentication, and storage: `docs/specs/20260628-nanocore_config_identity_contract.md`, `docs/specs/20260704-nanocore_bootstrap_readiness.md`, `docs/specs/20260704-remote_auth_credential_bootstrap.md`, `docs/specs/20260703-storage_layout_record_ownership.md`
- Worker placement, scheduling scale, sandboxing, and session continuity: `docs/specs/20260703-runtime_scheduling_scale.md`, `docs/core/sandbox.md`, `docs/core/agent-session.md`, `docs/specs/20260704-agent_session_continuity.md`, `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- Communication, worker control, workspace transfer, and capability supply: `docs/core/communication.md`, `docs/core/agent-capability.md`, `docs/specs/20260703-worker_control_protocol.md`, `docs/specs/20260703-workspace_synchronization.md`, `docs/specs/20260703-worker_agent_capability.md`
- Vault and provider credentials: `docs/core/vault.md`, `docs/specs/20260704-vault_backend_implementation.md`, `docs/specs/20260721-provider_subscription_accounts.md`
- Product releases and worker images: `docs/specs/20260829-release_management.md`, `docs/specs/20260708-container_image_packaging.md`, `docs/specs/20260721-worker_execution_environment_images.md`
- Operator projections: `docs/manual/nanocore-deployment-modes.en.md`, `docs/manual/nanocore-data-root-config.en.md`

## Known Debt

### Deployment Owner-Map Generation Debt

The Owner And Projection Index is a hand-written derivable projection. Owner: the Generated Projections rules in `docs/documentation-model.md`, with the linked Core and specification headers as source facts. Activation: when a generator slice is authorized, replace the list with a generated owner map and a `--check` drift gate.

### Deployment Type-Classification Debt

Whether this contracted judgment-and-link-index residue should remain a platform reference is unresolved. Owner: the platform-reference type definition in `docs/documentation-model.md`, resolved by an engineer. Activation: after this documentation-separation program closes, classify the stable residue without treating this guide as authority.
