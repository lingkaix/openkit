# Vault

This directory owns NanoCore's Vault backend contract, concrete encrypted-file and operating-system keychain backends, unlock state, non-secret reference and grant records, audited material resolution, Vault use evidence, and Vault App API routes.

## Boundaries

- `../storage/schema/` owns Vault table definitions and migrations.
- `../providers/vault-credential-resolver.ts` owns provider credential projection from Vault references.
- `../bootstrap/vault.ts` owns the boot-time Vault readiness projection.
- `@openkit/app-api-schemas` owns public Vault request and response schemas.
- Secret material must remain inside backend-private values and must never enter logs, diagnostics, durable evidence, or public responses.

## File Map

- `vault-backend.ts`, `vault-encrypted-file-*`, `vault-os-keychain-backend.ts`, `vault-key-file.ts`, and `vault-store-directory.ts` own backend contracts and material storage mechanics.
- `vault-unlock-state.ts` owns the process-local locked or available backend state.
- `vault-references.ts`, `vault-grants.ts`, and `vault-use-records.ts` own non-secret durable Vault records.
- `vault-use-audited-backend.ts` owns audited material resolution across server and workspace scopes.
- `vault-admin-audit-events.ts` and `vault-admin-routes.ts` own administrative audit projection and App API behavior.

## Runtime Lifecycle

- The encrypted-file backend becomes available only after its raw 32-byte master key authenticates `header.json`; an empty store may initialize the header, while a non-empty headerless store fails closed without mutation.
- `vault-key-file.ts` accepts only an absolute regular non-symlink file owned by the process user with exact `0600` mode and exactly 32 raw bytes, using one bounded no-follow descriptor read.
- `../bootstrap/vault.ts` may unlock the shared process state from the configured key file. Missing, invalid, or wrong keys remain a redacted non-critical degraded condition.
- The unlock state owns one mutable key buffer. Failed replacement, lock, orderly shutdown, and exit cleanup zero owned material; key-file and admin-route callers zero their temporary buffers in `finally`.
- Retained encrypted-file backend references fail locked after state replacement or lock, so a cleared key cannot be reused to write new material.

## Verification

```bash
mise exec -- pnpm exec vitest run src/bootstrap/vault.test.ts src/vault/*.test.ts
mise exec -- pnpm run lint
mise exec -- pnpm run typecheck
mise exec -- pnpm run build
```

## Related Design

- [Vault Secret Injection](../../../../docs/specs/20260703-vault_secret_injection.md)
- [Vault Backend Implementation](../../../../docs/specs/20260704-vault_backend_implementation.md)
- [Worker Credential Access Declarations](../../../../docs/specs/20260709-worker_credential_access_declarations.md)
