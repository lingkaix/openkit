# Real-Use Host Support

This directory owns the repository's declarative A1 host identity and the smallest scripts that provision, assert, observe NanoHost readiness, tear down one ordinary real-use attempt, and execute the explicitly authorized Unit F gate.

From the repository root, the ordinary host commands are `pnpm host:provision a1`, `pnpm host:assert a1`, `pnpm host:nanohost:bring-up a1`, and `pnpm host:teardown a1`. These four scripts do not create sandboxes, run Worker Turns, or perform Unit E or Unit F work. Ordinary `pnpm host:nanohost:bring-up a1` remains prohibited until the current manifest and the separate Unit F gate pass.

The sole executable owner for the authorized R001 gate is `pnpm host:nanohost:unit-f`; do not invoke its Node runner directly. The command accepts no positional host target, requires `OPENKIT_NHC_UNIT_F_SSH_ALIAS=a1`, runs exact scenarios F1, F2, and F4 plus normal lifecycle, and has no reboot, shutdown, equivalent host-reset, or simulated-reboot path.

## Harness Contract

- `provision.sh` and `assert.sh` are streamed whole; each `remote` branch precedes any sibling source and depends on no sibling file.
- `tests/host-manifest.test.mjs` owns manifest, provisioning, assertion, and streamed-payload checks; `tests/host-manifest-runtime.test.mjs` owns bring-up and teardown lifecycle checks; `fixture-runner.mjs` owns shared fixture execution.
- Every named host-harness predicate row requires a positive observation bound to its subject; absence of an error alone is never PASS. Generic oracle authority remains with [`docs/verification-instruments.md`](../../../docs/verification-instruments.md) and the [Test Strategy](../../../docs/specs/20260529-test_strategy.md).

`manifest.json` is the sole repository copy of the admitted architecture, kernel, cgroup, init, container-runtime, and command facts, including the exact path, version, and SHA-256 of the NanoHost network helper; `provision.sh` does not install or upgrade it. `ssh-alias.sh` owns the `require_ssh_alias` validator sourced by `provision.sh`, `assert.sh`, `nanohost-bring-up.sh`, and `teardown.sh`. `provision.sh` may create only the absent `/usr/bin/node` symlink after the exact source path, version, and SHA-256 match. `assert.sh` collects fixture and remote observations separately, submits both normalized fact objects to one shared comparator, and on success emits exactly `manifestDigest=<SHA-256 of the asserted manifest bytes>` followed by one newline. Ordinary `nanohost-bring-up.sh` remains prohibited until the current manifest and the separate controlled real-host network-noninterference gate pass; only the explicitly authorized `pnpm host:nanohost:unit-f` gate may start the fixed service during that proof. `teardown.sh` stops the service and uses the existing decommission owner to clear both credential slots when the caller supplies the attempt's NanoCore URL and server-admin token.

The external path of all four consumers requires exactly one explicit SSH alias matching `[a-z][a-z0-9-]{0,62}`; no script provides a default target. Their internal fixture modes, and the internal remote modes in `provision.sh` and `assert.sh`, are reserved for bounded repository execution. Fixture execution operates only below `OPENKIT_HOST_FIXTURE_ROOT`. These scripts do not create sandboxes, run worker Turns, or perform Unit E or Unit F work.

## Unit F Attempt Contract

Run the Unit F gate only inside an authorized A1 attempt and only after `pnpm host:assert a1` succeeds. The fixed retained filename is `temp/changes/202608150321350001-nanohost_runtime_implementation_completion/r001-a1-unit-f-result.json`. Before any gate effect, resolve that repository-relative filename under the current repository root, create its parent with mode `0700`, prove the parent mode, and prove that the result is absent. The runner independently requires an absolute `OPENKIT_NHC_UNIT_F_OUTPUT_PATH` and rejects a pre-existing result before it creates the real driver.

The operator must supply every non-secret input consumed by the command: `OPENKIT_NHC_UNIT_F_ATTEMPT_ID`, `OPENKIT_L6_TASK_GIT_COMMIT`, `OPENKIT_L6_TASK_GIT_URL`, `OPENKIT_L6_TASK_HOST_MANIFEST_DIGEST`, `OPENKIT_NHC_UNIT_F_LOCAL_PORT`, `OPENKIT_NHC_UNIT_F_NANOCORE_CONTAINER`, `OPENKIT_NHC_UNIT_F_NANOCORE_IMAGE_ID`, `OPENKIT_NHC_UNIT_F_NANOCORE_IMAGE_REF`, `OPENKIT_HOST_NANOHOST_DEPLOYMENT_ID`, `OPENKIT_NHC_UNIT_F_NANOHOST_EXECUTABLE_SHA256`, `OPENKIT_HOST_NANOHOST_IDENTITY_ID`, `OPENKIT_L6_TASK_PRODUCT_COMMIT`, `OPENKIT_NHC_UNIT_F_NANOCORE_PORT`, `OPENKIT_L6_TASK_WORKER_IMAGE_REF`, the absolute output path, the lowercase alias, and the timeout. `OPENKIT_NHC_UNIT_F_SSH_ALIAS` is exactly `a1`, and `OPENKIT_NHC_UNIT_F_OWNER_TIMEOUT_MS` is exactly `7200000`.

`OPENKIT_NANOCORE_TOKEN` and `OPENKIT_NANOCORE_SESSION_COOKIE` are the only secret inputs. They must already exist in the protected process environment, must be non-empty, and must never be assigned sample values, written to a command file, passed as arguments, or retained in output.

From the repository root, after supplying all other exact non-secret inputs and both protected secret inputs, run:

```bash
RESULT_RELATIVE=temp/changes/202608150321350001-nanohost_runtime_implementation_completion/r001-a1-unit-f-result.json
REPOSITORY_ROOT="$(pwd -P)"
RESULT_PATH="$REPOSITORY_ROOT/$RESULT_RELATIVE"
RESULT_PARENT="$(dirname "$RESULT_PATH")"
install -d -m 0700 "$RESULT_PARENT"
test "$(stat -c '%a' "$RESULT_PARENT")" = 700
test ! -e "$RESULT_PATH"
test -n "$OPENKIT_NANOCORE_TOKEN"
test -n "$OPENKIT_NANOCORE_SESSION_COOKIE"
export OPENKIT_NHC_UNIT_F_OUTPUT_PATH="$RESULT_PATH"
export OPENKIT_NHC_UNIT_F_SSH_ALIAS=a1
export OPENKIT_NHC_UNIT_F_OWNER_TIMEOUT_MS=7200000
pnpm host:nanohost:unit-f
```

`SIGINT` and `SIGTERM` are cooperative: the command records the interrupt, permits the current bounded operation to settle, starts no later phase, and then runs the same one-time terminal finalizer. The finalizer captures a terminal reference and the exact last epoch before stopping the service, decommissions the exact configured NanoHost identity through the admin App API, stops the tunnel, proves the service inactive and the final epoch cgroup, network namespace, and sockets absent, validates and removes only the matching attempt-observed state/runtime root pair through the explicit operator path, reobserves both roots absent, compares the post-cleanup baseline only with the terminal reference, and runs the bounded system-Docker build-network smoke. A changed or unsafe root shape, an additional epoch root, or any missing, unknown, timed-out, or failed cleanup observation forces Aggregate `FAIL` without broader deletion while independent cleanup continues. This attempt cleanup does not remove the Image Store or retained invalidation evidence and is not complete uninstall proof.

F1 retains the raw system-Docker baseline digests and separately adjudicates one restart-invariant digest that normalizes only the unique exact configured NanoCore container's unique `host` network 64-hex endpoint ID. Every bridge, `docker0`, nftables, container identity, image, other network field, and other container attachment remains in that digest; a missing, duplicate, differently networked, or malformed NanoCore row fails closed. F2 and F4 continue to adjudicate the complete raw baseline digest without that normalization.

The command writes only after cleanup, creates the retained file once with mode `0600`, and never overwrites an existing result. Its only stdout summary is `aggregate=<PASS|FAIL> evidenceSha256=<SHA-256|none>`. Aggregate `PASS` requires exact F1, F2, and F4 evidence, network conformance, normal lifecycle, and every terminal row to pass; this guide does not claim that R001 passed or that ordinary bring-up is unblocked before an actual retained A1 PASS is reviewed.

After the command returns, verify the retained mode, compute its digest and compare it with the printed `evidenceSha256`, and fail without printing either credential if the result retained one:

```bash
test "$(stat -c '%a' "$RESULT_PATH")" = 600
sha256sum "$RESULT_PATH"
if printf '%s\n%s\n' "$OPENKIT_NANOCORE_TOKEN" "$OPENKIT_NANOCORE_SESSION_COOKIE" | grep -Fqf - "$RESULT_PATH"; then
  echo "credential retention detected" >&2
  exit 1
fi
```
