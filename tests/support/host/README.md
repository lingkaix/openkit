# Real-Use Host Support

This directory owns the smallest scripts that consume the product-owned A1 host identity, provision and assert it, observe NanoHost readiness, and tear down one real-use attempt.

From the repository root, run `pnpm host:provision a1`, `pnpm host:assert a1`, `pnpm host:nanohost:bring-up a1`, and `pnpm host:teardown a1`. Retain the redacted two-cycle result at `temp/state/nanohost/host-manifest/a1/result.json`.

## Harness Contract

- `provision.sh` and `assert.sh` are streamed whole; each `remote` branch precedes any sibling source and depends on no sibling file.
- `tests/host-manifest.test.mjs` owns manifest, provisioning, assertion, and streamed-payload checks; `tests/host-manifest-runtime.test.mjs` owns bring-up and teardown lifecycle checks; `fixture-runner.mjs` owns shared fixture execution.
- Every named host-harness predicate row requires a positive observation bound to its subject; absence of an error alone is never PASS. Generic oracle authority remains with [`docs/verification-instruments.md`](../../../docs/verification-instruments.md) and the [Test Strategy](../../../docs/specs/20260529-test_strategy.md).

`apps/nanohost/deploy/host-manifest.json` is the sole repository copy of the admitted architecture, kernel, cgroup, init, container-runtime, and command facts, including the exact path, version, and SHA-256 of the NanoHost network helper; these scripts only consume it, and `provision.sh` does not install or upgrade it. `ssh-alias.sh` owns the `require_ssh_alias` validator sourced by `provision.sh`, `assert.sh`, `nanohost-bring-up.sh`, and `teardown.sh`. `provision.sh` may create only the absent `/usr/bin/node` symlink after the exact source path, version, and SHA-256 match. `assert.sh` collects fixture and remote observations separately, submits both normalized fact objects to one shared comparator, and on success emits exactly `manifestDigest=<SHA-256 of the asserted manifest bytes>` followed by one newline. Ordinary `nanohost-bring-up.sh` remains prohibited until the current manifest and a separate controlled real-host network-noninterference gate pass; that gate alone may start the fixed service during proof. `teardown.sh` stops the service and uses the existing decommission owner to clear both credential slots when the caller supplies the attempt's NanoCore URL and server-admin token.

The external path of all four consumers requires exactly one explicit SSH alias matching `[a-z][a-z0-9-]{0,62}`; no script provides a default target. Their internal fixture modes, and the internal remote modes in `provision.sh` and `assert.sh`, are reserved for bounded repository execution. Fixture execution operates only below `OPENKIT_HOST_FIXTURE_ROOT`. These scripts do not create sandboxes, run worker Turns, or perform Unit E or Unit F work.
