# Vault

This directory owns NanoCore's encrypted-file Vault backend contract, unlock state, non-secret reference and grant records, audited material resolution, Vault use evidence, and Vault operation implementations.

## Boundaries

- `../storage/schema/` owns Vault table definitions and migrations.
- `../providers/vault-credential-resolver.ts` owns provider credential projection from Vault references.
- `../bootstrap/vault.ts` owns the boot-time Vault readiness projection.
- `@openkit/app-api-schemas` owns public Vault request and response schemas.
- Secret material must remain inside backend-private values and must never enter logs, diagnostics, durable evidence, or public responses.

## File Map

- `vault-backend.ts`, `vault-encrypted-file-*`, `vault-key-file.ts`, and `vault-store-directory.ts` own the encrypted-file backend contract and material storage mechanics.
- `vault-unlock-state.ts` owns the process-local locked or available backend state.
- `vault-references.ts`, `vault-grants.ts`, and `vault-use-records.ts` own non-secret durable Vault records.
- `vault-references.ts` also owns idempotent insert evidence, active equal-or-next material-version advancement, and atomic dependent-state revocation.
- `vault-use-audited-backend.ts` owns audited material resolution across server and workspace scopes.
- `vault-admin-audit-events.ts` and `vault-operation-implementations.ts` own administrative audit projection and App API behavior.

## Runtime Lifecycle

- The encrypted-file backend becomes available only after its raw 32-byte master key authenticates `header.json`; an empty store may initialize the header, while a non-empty headerless store fails closed without mutation.
- `vault-key-file.ts` accepts only an absolute regular non-symlink file owned by the process user with exact `0600` mode and exactly 32 raw bytes, using one bounded no-follow descriptor read.
- `../bootstrap/vault.ts` may unlock the shared process state from the configured key file. Missing, invalid, or wrong keys remain a redacted non-critical degraded condition.
- The unlock state owns one mutable key buffer. Failed replacement, lock, orderly shutdown, and exit cleanup zero owned material; key-file and operation callers zero their temporary buffers in `finally`.
- Retained encrypted-file backend references fail locked after state replacement or lock, so a cleared key cannot be reused to write new material.

## Verification

```bash
pnpm exec vitest run src/bootstrap/vault.test.ts src/vault/*.test.ts
pnpm run lint
pnpm run typecheck
pnpm run build
```

## Related Design

- [Vault Secret Injection](../../../../docs/specs/20260703-vault_secret_injection.md)
- [Vault Backend Implementation](../../../../docs/specs/20260704-vault_backend_implementation.md)
- [Worker Credential Access Declarations](../../../../docs/specs/20260709-worker_credential_access_declarations.md)

`vault-operation-implementations.ts` projects deployment-admin Workspace secret create/rotate/revoke and supported gateway-only or GitHub Worker runtime-env grant create/narrow/revoke. Optional exact Agent and AgentSession restrictions use current execution facts. Gateway capability restrictions name only `mcp.list_tools` or `mcp.call_tool`; runtime-env rejects capability targets. Worker grants remain separate from Gateway grants, and every use checks current Vault authority. The existing backend and Core lifecycle reject scope/version disagreement and return fixed redacted failures for partial effects.

The `vault.*` definitions live in `packages/app-api-schemas/src/vault-operations.ts`. The exact native map is composed once through `operation-composition.ts`; JSON HTTP, Core Client, CLI and remote MCP derive their framing from that table. Every output remains redacted, and unlock, bootstrap, provider-key, secret create/rotate and reference rebind inputs retain `secret stdin` handling. Server admission owns common administrator refusals; Workspace secret and grant effects retain their additional administrator requirement.

`vault-grants.ts` narrows current grants by atomic revoke-and-replace. Every dimension retains or reduces authority and one strictly reduces it. The public operation supports only the current Workspace-lifetime sink shapes. The original grant resource and replacement grant id share one initiating-human Audit event in the same transaction. Bindings remain on the revoked original until explicit rebind. Metadata narrowing works while locked and reads no material; unknown responses require inventory and Audit inspection. User/Agent requests, approval workflow and cross-scope review remain separate open work. Run the grant-narrowing and administration route suites for constraint, locked-state, replay, scope, Audit and rollback proof; the Worker MCP route suite verifies explicit replacement consumption with a synthetic upstream.

`../vault-injection-plans.ts` and `../vault-injection-receipts.ts` reject a repeated identity with different immutable input. Exact creation replay returns the retained completion or plan with its current lifecycle projection; it does not reset revocation or creation time. Run `pnpm exec vitest run src/vault-injection-plans.test.ts src/vault-injection-receipts.test.ts --maxWorkers=1` from NanoCore for conflict, unchanged-history and replay evidence.

`vault-receipt-revocation.ts` gives grant and reference revocation one receipt projection. Completed gateway-only use becomes revoked. Other or unproved visibility remains stale-session; existing non-active projections and immutable completion fields remain unchanged. This metadata projection does not recall exposed material or create a runtime removal proof.

`vault-admin-audit-events.ts` retains the initiating human in both the Vault administrative row and its general Audit projection. A token or session is an authentication source; it does not replace the human actor or imply a system actor.

`server-mcp-authority.ts` owns the shared predicate used by Server administration and Gateway resolution: only Server-owned `mcp-credential` references with matching active backend inventory qualify. Provider subscription metadata, owner/version/backend contradictions and other Server secret families fail before resolution. Server grants retain existing Server lifetime and exactly Gateway-only visibility. Shared use records belong to Core with no Workspace owner; the audited backend carries actual consuming Workspace and actor only into the linked general Audit. Revoke/narrow uses the existing grant and receipt owners and never edits a catalog binding automatically.

Administrator MCP discovery has no Worker/AEP/capability-call lineage. Its existing injection receipt may use only an exact successful human preview delivery Audit link with matching plan/grant and Gateway-only mcp.list_tools intent. Resolution and transport delivery stay separate; missing or contradictory linkage refuses a receipt. Existing Worker receipt requirements and immutable completion facts remain unchanged.

VaultGrant metadata requires immutable `issuance: target | imported-history`. Normal issuance writes `target`; portable import always writes `imported-history`, including when the source claims `target`. Canonical readers refuse missing or unknown provenance, and duplicate issuance cannot upgrade imported history. Injection plans, Worker MCP and AEP preparation require target issuance before effects and retain each consuming owner's current-authority predicate. Reference rebind, restart and re-export do not promote a historical grant. Entity IDs use the shared Protocol allocator; their shape grants no authority.
