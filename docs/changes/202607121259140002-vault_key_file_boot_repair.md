# Vault Key File Boot Repair

Type: change-plan
Status: complete
Date: 2026-07-12

## Intent

Make the accepted encrypted-file Vault key-file source safe and real by verifying the master key against a durable store header before any entry can be read or written, then use the configured key during NanoCore boot without turning Vault availability into a critical boot requirement.

Eliminate the current split-key risk, key-file time-of-check/time-of-use gap, and unzeroed key copies while preserving the existing Vault backend, admin API, storage layout, and deployment model.

## Scope

- Add one strict optional `vault.encryptedFile.keyFilePath` server-config field for the encrypted-file backend.
- Replace path-stat-then-read with one bounded no-follow file-descriptor read that validates absolute path, regular file, owner, exact `0600` mode, and exact 32-byte length.
- Convert every filesystem and validation failure to a typed redacted Vault error that exposes neither path nor key material.
- Replace test-only header placeholders with one runtime initialize-or-verify operation using AES-256-GCM authentication metadata.
- Initialize a header only for an empty safe store and verify an existing header before backend availability or entry mutation.
- Reject missing headers on non-empty stores, wrong keys, malformed headers, tampered tags, unsupported KDF metadata, symlinks, owner mismatch, weak permissions, and unsupported secure-file platforms.
- Reduce key copies, zero temporary and owned key buffers on failure, replacement, lock, and orderly shutdown, and zero per-entry data keys in `finally` blocks.
- Create and optionally unlock the Vault state inside the existing non-critical boot phase, project real health into boot readiness, and reuse the same state in the app.
- Keep missing or invalid configured keys locked and degraded while allowing NanoCore to boot.
- Align the Vault spec, configuration guide, Vault and NanoCore documentation, and parent maintainability record.

## Non-Goals

- Do not add passphrases, Argon2id, environment-key input, KMS, key recovery, key rotation, a watcher, hot reload, registry, migration compatibility layer, or a second Vault abstraction.
- Do not auto-initialize a header for a non-empty store, overwrite or repair a failed header, guess a key, or silently weaken platform security checks.
- Do not expose key paths, key bytes, encoded keys, errno values, secret locators, or raw filesystem errors through logs, diagnostics, API, audit, or tests.
- Do not make Vault availability a critical boot dependency.
- Do not change App API, Core Client, MCP, or OpenAPI contracts.

## Related Context

- [Parent NanoCore Maintainability Recovery](202607111531450001-nanocore_maintainability_recovery.md)
- [Architecture](../core/architecture.md)
- [Storage](../core/storage.md)
- [Vault](../core/vault.md)
- [Product Vision](../product-vision.md)
- [Vault Backend Implementation](../specs/20260704-vault_backend_implementation.md)
- [Storage Layout and Record Ownership](../specs/20260703-storage_layout_record_ownership.md)
- [NanoCore Deployment Modes](../nanocore-deployment-modes.en.md)

## Baseline Evidence

- `vault-key-file.ts` has no production caller and currently performs `lstat(path)` followed by a separate path read, leaving a replacement race and omitting owner and no-follow checks.
- Header types and read/write functions are test-only; runtime backend construction, unlock, health, and entry mutation never initialize or verify the header.
- Any 32-byte key currently creates an available backend, so a wrong key can write a second incompatible set of entries before a read fails.
- Vault unlock state and backend copy key material and `lock()` discards objects without zeroing those copies.
- Boot readiness checks a hard-coded degraded Vault result before the Vault state is created, so configured encrypted-file keys can never make boot Vault readiness available.

## Accepted Decisions

1. The only configured V1 encrypted-file key source is an absolute raw 32-byte key file with exact owner-only `0600` permissions.
2. Secure loading uses one `O_RDONLY | O_NOFOLLOW` descriptor, `fstat` on that descriptor, a fixed 33-byte bounded read, redacted errors, guaranteed close, and buffer zeroization.
3. The V1 header supports only `raw-key-file`. Unimplemented Argon2id and generic parameter branches are removed rather than preserved speculatively.
4. Header verification uses AES-256-GCM over empty plaintext with associated data binding the creation timestamp, format version, raw-key kind, and fixed verification purpose. The header stores nonce and tag, never key or ciphertext.
5. Missing header plus empty safe store may initialize atomically. Missing header plus any existing store content fails locked without mutation.
6. Backend construction verifies or initializes the header before reporting available. Wrong or malformed keys cannot construct a writable backend.
7. The unlock state owns one mutable key buffer shared with the backend and zeros it on failed replacement, lock, and shutdown. Callers zero their temporary buffers after unlock returns.
8. Vault boot unlock is non-critical. Missing or invalid configured material produces locked degraded health with a redacted reason and does not stop the server.

## Execution Plan

### Slice 1: Config Contract

- Add failing config-schema tests for the nested key path and strict unknown-field rejection.
- Add the one optional nested config field without a parallel interface or watcher.

### Slice 2: Secure Key and Header Boundary

- Add failing key-file tests for valid input, symlink, weak mode, owner mismatch, length, bounded read, and redaction.
- Add failing store/backend tests for header initialization, reopen, wrong key, tamper, unsupported KDF, and non-empty headerless stores.
- Implement the secure descriptor reader and one initialize-or-verify store operation before backend availability.

### Slice 3: Key Lifetime

- Add failing unlock-state and backend tests for failed replacement, lock, retained backend references, restart recovery, and data-key zeroization behavior.
- Remove duplicate master-key copies and zero owned and temporary buffers at every lifecycle boundary.

### Slice 4: Boot Integration

- Add failing boot, admin-route, and built-process tests for configured available, missing locked, wrong-key degraded, and redacted diagnostics.
- Create and unlock one shared Vault state inside the existing non-critical boot phase and project its real health.

### Slice 5: Documentation Closeout

- Update the accepted Vault spec, configuration and deployment guidance, NanoCore/Vault README ownership, this record, and the parent maintainability checkpoint.

## Verification Plan

- Run config-schema tests, typecheck, lint, and build.
- Run Vault key-file, store, backend, unlock-state, bootstrap, admin-route, and server tests.
- Run built-process config load and Vault status coverage.
- Run the complete NanoCore test suite, typecheck, lint, build, OpenAPI drift, and smoke gates.
- Run `CI=true pnpm run check:repo` and `git diff --check`.

## Stop Rules

- Stop if a non-empty headerless store can be initialized, a failed header can be overwritten, or a wrong key can create or mutate an entry.
- Stop if the correct key cannot reopen an existing entry across process state recreation.
- Stop if any key path, key byte, encoded key, errno, secret locator, or raw filesystem error appears in logs, diagnostics, API, audit, or snapshots.
- Stop if the platform cannot guarantee no-follow, owner, and exact-mode checks; remain locked rather than using an insecure fallback.
- Stop if key material cannot be zeroed on failure, replacement, lock, and orderly shutdown.
- Stop if implementation requires passphrases, KMS, recovery, watcher, registry, migration compatibility, or a second backend abstraction.

## Expected Handoffs

1. Commit this plan before tests or implementation.
2. Commit config tests before the config field.
3. Commit security and split-key tests before header verification.
4. Commit boot behavior tests before startup integration.
5. Close this record only after independent security, data-loss, correctness, and Ponytail reviews plus full verification.

## Implementation Summary

- `6139800` and `84c7b4c` added the strict optional config field after its schema tests. No watcher, compatibility reader, parallel config interface, or environment key source was added.
- `2e7ccff` and `42d399b` replaced path-stat-then-read with one bounded no-follow descriptor read that validates absolute path, platform support, regular-file type, effective-user ownership, exact `0600` mode, and exact 32-byte length while redacting every failure.
- `f817c5a`, `f2c5a74`, `031bd35`, and `24315f3` made the encrypted-file header a runtime authentication boundary, authenticated its creation timestamp and fixed metadata, rejected wrong keys and unsafe store states before mutation, removed speculative KDF shapes, preserved business clock semantics, and made the unlock state own and zero one shared key buffer.
- `0b4782a` and `dde829b` created one Vault state inside the existing non-critical boot phase, optionally unlocked only encrypted-file from the configured key, reused the same state for runtime callers, zeroed key-file and admin-request buffers, and locked owned material on critical boot failure, orderly shutdown, and process exit.
- The accepted spec, DATA_ROOT config guide, deployment guide, NanoCore guide, and Vault source guide now describe only the implemented raw-key-file path. Passphrase, environment, KMS, recovery, watcher, registry, compatibility, and export implementations remain absent rather than represented by placeholder entities.

## Verification Evidence

- Config Schema passed 9 test files and 54 tests, plus typecheck, lint, and build.
- Vault source coverage passed 12 test files and 65 tests; the boot, admin, key-file, backend, and unlock-state focus passed 39 tests.
- The built-process config test passed three scenarios, including correct-key availability followed by a wrong-key restart that stayed healthy and locked. The built-process smoke gate passed four of four tests.
- The complete NanoCore suite passed 187 test files with 1 skipped and 1,403 tests with 7 skipped, followed by typecheck, lint, and build.
- OpenAPI generation, official validation, and drift checks passed without contract changes. Repository format and governance checks passed across 740 files, and `git diff --check` passed.

## Review Outcome

- The first independent header review found two P2 issues: header initialization consumed the business clock, and redaction tests encoded keys only after failure zeroization. Dedicated regression changes fixed both, and the follow-up review returned GO.
- The independent boot, admin, shutdown, security, and Ponytail review returned GO with no P0, P1, or P2 findings.
- The final implementation adds no new service, registry, lifecycle class, dependency, public API, public type, or compatibility layer. Every added helper and state check protects a demonstrated filesystem, authentication, mutation, or key-lifetime boundary.
