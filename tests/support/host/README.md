# Real-Use Host Support

This directory owns the smallest scripts that consume the product-owned NanoHost capability profile, provision and assert it, observe NanoHost readiness, and tear down one real-use attempt.

From the repository root, run `pnpm host:provision a1`, `pnpm host:assert a1`, `pnpm host:nanohost:bring-up a1`, and `pnpm host:teardown a1`. Retain the redacted two-cycle result at `temp/state/nanohost/host-manifest/a1/result.json`.

## Harness Contract

- `provision.sh` and `assert.sh` are streamed whole; each `remote` branch precedes any sibling source and depends on no sibling file.
- `tests/host-manifest.test.mjs` owns manifest, provisioning, assertion, and streamed-payload checks; `tests/host-manifest-runtime.test.mjs` owns bring-up and teardown lifecycle checks; `fixture-runner.mjs` owns shared fixture execution.
- Every named host-harness predicate row requires a positive observation bound to its subject; absence of an error alone is never PASS. Generic oracle authority remains with [`docs/verification-instruments.md`](../../../docs/verification-instruments.md) and the [Test Strategy](../../../docs/specs/20260529-test_strategy.md).

`apps/nanohost/deploy/host-manifest.json` is the sole schema-version-2 profile projection for Linux amd64 and arm64. It declares capability predicates rather than a promoted kernel release, exact Docker output, Git package version, or slirp digest. `provision.sh` only provisions the existing harness-owned Node symlink after its source identity matches; Node is not a packaged-NanoHost prerequisite. The `ssh-alias.sh` validator remains shared by the four host commands.

Set `OPENKIT_HOST_BUNDLE` to the canonical absolute path of the exact extracted candidate bundle on the selected host, keeping its original archive beside the extraction. `assert.sh` invokes that bundle's checksum-verified `install.sh --check-host` and emits its one JSON result. The fixture branch replaces only normalized observation collection and executes the same bundled checker comparator and integrity path. Bring-up and Unit F consume the emitted profile, product, archive, machine, and observation identities; no `manifestDigest` line remains. Unit F additionally binds the emitted product commit to its selected candidate. A previous exact-host pass cannot qualify this changed instrument.

`profile-check-fixture.py`, invoked by `tests/host-profile-v2.test.mjs`, keeps independent finite comparator, bundle-integrity and contained no-write cases at their lowest sufficient layer. The same suite separately exercises interpreter failure and a surviving stdout descriptor at the shell boundary, systemd mismatch at the actual observer boundary, and delayed child reaping and inherited stdout at the supervisor boundary. These fixtures do not qualify real Linux systemd or loader behavior.

Ordinary bring-up remains prohibited until the current profile and the separately controlled real-host network-noninterference gate pass; only that authorized gate may start the fixed service during proof. Teardown retains its existing service-stop and decommission boundary, including both credential slots. Static requirement checking makes no runtime or readiness claim.

The external path of all four consumers requires exactly one explicit SSH alias matching `[a-z][a-z0-9-]{0,62}`; no script provides a default target. Their internal fixture modes, and the internal remote modes in `provision.sh` and `assert.sh`, are reserved for bounded repository execution. Fixture execution operates only below `OPENKIT_HOST_FIXTURE_ROOT`. These scripts do not create sandboxes, run worker Turns, or perform Unit E or Unit F work.

The Unit F blocked-create runner establishes a fresh NanoHost epoch through the ordinary stop, epoch-absence, recovery, and prior-root-absence sequence before it pauses dockerd and starts the fault Task. A projected `freshEmpty` RuntimeTarget alone does not prove that an idle Sandbox from an earlier scenario is physically absent.

F1 captures its process-continuity baseline after the Task reaches its durable post-launch barrier and before restarting NanoCore. Its initial epoch observation remains available for cleanup if Task lineage cannot be resolved; prior Task sandbox replacement is outside the restart interval.

Configured readiness and decommission use the definition-derived JSON bindings `POST /api/app/operations/nanohost.runtime-target` and `POST /api/app/operations/nanohost.decommission` with empty JSON objects. Credential delivery stays in curl stdin configuration and the existing attempt-local sink lifecycle. The Unit F runner reads the same canonical readiness operation.

The Unit F Task setup and fault interruption helpers use `workspace.create` and `turn.interrupt` through the canonical JSON operation binding with exact request identity and complete lineage. Their local stand-ins in `tests/nanohost-unit-f-runner.test.mjs` refuse retired Core URLs; these helpers are exported only to exercise those existing request owners without a host workload.
