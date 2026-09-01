# NanoHost Real-Use Host

Use this workflow for a real NanoHost R001 acceptance attempt on the configured lowercase `a1` SSH target. The ordinary host scripts prepare only the admitted Node projection, validate the finite host manifest, observe existing NanoHost readiness, and clean an ordinary attempt; they do not create a sandbox, run a Worker Turn, or perform Unit E or Unit F work. The separate explicitly authorized `pnpm host:nanohost:unit-f` command is the sole R001 gate executable owner and uses the existing runner to perform the real Worker gate and terminal cleanup without rebooting A1.

The current host manifest admits the exact `/usr/bin/slirp4netns` path, version, and SHA-256 used by the epoch-private Docker network namespace. Provisioning does not install or upgrade that OS package; a missing or mismatched artifact blocks assertion and NanoHost start. Ordinary `pnpm host:nanohost:bring-up a1` remains prohibited until the manifest passes and the controlled Unit F gate proves that start and stop leave the system Docker bridge, canonical nftables structure, business-container attachments, and build egress unchanged. Only the explicitly authorized Unit F command may start the fixed service during that proof.

## Prerequisites

- `ssh a1` reaches the reviewed execution host.
- NanoCore is already running in server mode with the configured NanoHost identity, deployment, and safe-sink credential paths.
- The reviewed `openkit-nanohost.service` and its required immutable artifacts are installed on A1.
- The attempt has the two Unit F secrets in protected process environment only, and NanoCore enrollment has delivered one attempt-local NanoHost transport credential to a configured slot.

Never write tokens, cookies, private keys, or raw credential material into the repository or the retained result.

## Assert The Host

From the repository root, provision the only allowed host correction and then assert every admitted fact:

```bash
pnpm host:provision a1
pnpm host:assert a1
```

The ordinary bring-up and teardown scripts remain available for their existing non-Unit-F workflow, but they are not part of this gate and must not run concurrently with it. Do not run ordinary bring-up before the retained Unit F PASS has been reviewed.

## Configure The Unit F Attempt

The fixed retained filename is:

```text
temp/changes/202608150321350001-nanohost_runtime_implementation_completion/r001-a1-unit-f-result.json
```

Supply every non-secret input read by the gate with the exact attempt value:

| Environment variable | Required value |
| --- | --- |
| `OPENKIT_NHC_UNIT_F_ATTEMPT_ID` | One new attempt identity. |
| `OPENKIT_L6_TASK_GIT_COMMIT` | The exact real Worker checkout commit. |
| `OPENKIT_L6_TASK_GIT_URL` | The exact public Git checkout URL. |
| `OPENKIT_L6_TASK_HOST_MANIFEST_DIGEST` | The digest printed by the successful A1 manifest assertion. |
| `OPENKIT_NHC_UNIT_F_LOCAL_PORT` | The exact local tunnel port reserved for this attempt. |
| `OPENKIT_NHC_UNIT_F_NANOCORE_CONTAINER` | The exact NanoCore business-container name. |
| `OPENKIT_NHC_UNIT_F_NANOCORE_IMAGE_ID` | The exact NanoCore image ID. |
| `OPENKIT_NHC_UNIT_F_NANOCORE_IMAGE_REF` | The exact NanoCore image reference. |
| `OPENKIT_HOST_NANOHOST_DEPLOYMENT_ID` | The configured NanoHost deployment ID. |
| `OPENKIT_NHC_UNIT_F_NANOHOST_EXECUTABLE_SHA256` | The exact installed NanoHost executable SHA-256. |
| `OPENKIT_HOST_NANOHOST_IDENTITY_ID` | The configured NanoHost identity ID. |
| `OPENKIT_NHC_UNIT_F_OUTPUT_PATH` | The absolute path resolved from the fixed repository-relative filename at invocation. |
| `OPENKIT_NHC_UNIT_F_OWNER_TIMEOUT_MS` | Exactly `7200000`. |
| `OPENKIT_L6_TASK_PRODUCT_COMMIT` | The exact OpenKit product commit under test. |
| `OPENKIT_NHC_UNIT_F_NANOCORE_PORT` | The exact remote NanoCore rendezvous port. |
| `OPENKIT_NHC_UNIT_F_SSH_ALIAS` | Exactly the lowercase alias `a1`. |
| `OPENKIT_L6_TASK_WORKER_IMAGE_REF` | The exact Worker image digest reference. |

`OPENKIT_NANOCORE_TOKEN` and `OPENKIT_NANOCORE_SESSION_COOKIE` are the only secret inputs. Supply them through protected process environment without sample values, keep them non-empty, and never place them in argv, a shell file, repository content, logs, or retained output.

## Run The Authorized Gate

From the repository root, resolve the fixed filename beneath that root, create its parent before any gate effect with mode `0700`, prove the mode and result absence, and invoke only the package command:

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

The runner rejects a relative output or pre-existing result before it creates the real driver. It captures the pre-attempt baseline, runs exact scenarios F1, F2, and F4 plus the normal-lifecycle coordinator, and treats `SIGINT` and `SIGTERM` cooperatively: the current bounded operation settles, no later phase starts, and the same one-time terminal finalizer runs. The gate has no reboot, shutdown, equivalent host-reset, or simulated-reboot path; machine-wide restart truthfulness is outside R001 and must not be tested on A1 by this command.

F1 retains both raw pre/post system-Docker baseline digests and one deciding restart-invariant pair. That invariant normalizes only the unique exact configured NanoCore container's unique `host` network 64-hex endpoint ID; bridge, `docker0`, nftables, container identity, image, every other NanoCore network field, and every other container attachment remain exact. Missing, duplicate, differently networked, malformed, or otherwise changed observations fail closed, while F2 and F4 continue to require complete raw digest equality.

The terminal finalizer captures a fresh reference baseline and exact last epoch immediately before cleanup, stops `openkit-nanohost.service`, calls the exact admin App API decommission owner for the configured identity, stops the tunnel, proves the service inactive and final epoch cgroup members, private network namespace, and sockets absent, validates and removes only the matching attempt-observed state/runtime root pair through the explicit operator path, and reobserves both roots absent before comparing the post-cleanup baseline only with the terminal reference and running the bounded system-Docker build-network smoke. A changed or unsafe root shape, an additional epoch root, or any missing, unknown, timed-out, or failed terminal observation forces Aggregate `FAIL` without broader deletion, while every independent cleanup step is still attempted. Credential removal is true only for an exact redacted decommission response with status `decommissioned` and a nonnegative revoked-token count. This attempt cleanup does not remove the Image Store or retained invalidation evidence and is not complete uninstall proof.

The command writes only after terminal cleanup, uses create-only mode with file mode `0600`, and never overwrites a result. Stdout is exactly `aggregate=<PASS|FAIL> evidenceSha256=<SHA-256|none>`. Aggregate `PASS` requires the gate PASS and every terminal row; this procedure does not claim R001 passed or unblock ordinary bring-up until the retained A1 result is independently reviewed.

## Verify The Retained Result

After the command returns, prove mode `0600`, compute SHA-256 and compare it with the CLI digest, and check credential non-retention without printing either credential value:

```bash
test "$(stat -c '%a' "$RESULT_PATH")" = 600
sha256sum "$RESULT_PATH"
if printf '%s\n%s\n' "$OPENKIT_NANOCORE_TOKEN" "$OPENKIT_NANOCORE_SESSION_COOKIE" | grep -Fqf - "$RESULT_PATH"; then
  echo "credential retention detected" >&2
  exit 1
fi
```

The retained JSON contains normalized gate evidence, public byte identity, closed reason codes, and terminal cleanup booleans. It must not contain raw credentials, PIDs, namespace identifiers, host inventory, raw network tables, response bodies, or untrusted error text.
