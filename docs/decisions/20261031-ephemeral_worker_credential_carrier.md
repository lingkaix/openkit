---
status: Accepted
date: "2026-10-31"
decider: Engineer
---
# General Worker Credential File Delivery

## Decision

NanoCore owns general credential-file delivery and its lifecycle through the existing Vault reference, grant, plan, receipt and use owners. A placement-neutral binding names material reference/version/format, target, access and REQUIRED ephemeral protection outside retained, captured and exported storage. The placement returns its realized protection; Core refuses any shortfall. The [credential declaration owner](../specs/20260709-worker_credential_access_declarations.md) owns this contract. Deliver, replace, revoke and inspection use the existing unified Vault operation family, Policy/PermissionDecision, Audit and uniform agent surface. Material never crosses that surface. Automatic replacement is a caller of the same operations.

NanoHost is the sole v0.1.0 realization. Its carrier is one per-Sandbox tmpfs with nodev, nosuid and noexec, mode 0700 and admitted Worker ownership, outside every retained root in its already-private backend mount domain. Read-only single-file mounts cover verified empty points after image seeding. Root-controlled sources and exact installed views are proved before receipts. Same-inode host rewrite uses no rename or remount. Removal follows proved native absence; uncertainty fences the existing lifecycle. The [NanoHost runtime owner](../specs/20260802-nanohost_runtime_and_transport.md) owns these adapter details. No proof of non-swapping or dump exclusion is required, and no host security change is implied.

Raw static files require explicit high-risk Worker-visible grants. Any raw static file, derived file or environment material readable by a Worker can be copied. Its explicit grant is the user's acceptance of that risk. Tier 1 channels exist to avoid the exposure. No mechanism against copying is added. The caller coordinates concurrent readers and consumer reload; the receipt proves the file view and does not imply application reload. A multi-write rewrite is not atomic, and the mechanism adds no consumer-profile acceptance gate.

## Reason

The engineer's 2026-10-31 ruling requires general delivery managed by NanoCore, including future placements, rather than a mechanism specific to subscription credentials. Persistent homes must retain user configuration and history while platform material stays outside retained data. The lifecycle must be usable by authorized agents through the same governed operations as other Core capabilities.

## Rejected Alternatives

- Direct delivery into retained homes: this places platform material in retained data and backups.
- Hide the whole home: this discards user configuration and history.
- Expose a native allocation mechanism in Core records: this makes future placements require Core changes and risks silent protection downgrade.
- Permit privileged automatic replacement: this bypasses the unified operation and Policy owners.

## Revisit When

A placement cannot establish the required protection or a consumer cannot safely reread a replaced file. Refuse that placement or replacement until another delivery realization is separately qualified. No new credential store, daemon, queue, retry engine or registry follows from this decision.

## Affected Owners

- [Worker Credential Access Declarations](../specs/20260709-worker_credential_access_declarations.md)
- [Core Vault](../specs/20260703-vault_secret_injection.md)
- [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md)
- [Persistent Worker Volumes](../specs/20260910-persistent_worker_volumes.md)
- [Operation Definition](../specs/20261002-operation_definition.md)
- [Compute Neutrality Target](../specs/20261020-compute_neutrality_target.md)
