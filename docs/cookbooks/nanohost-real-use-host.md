# NanoHost Real-Use Host

Use this workflow before a real NanoHost acceptance attempt on the configured lowercase `a1` SSH target. It prepares only the admitted Node projection, validates the finite host manifest, observes existing NanoHost readiness, and cleans the attempt. It does not create a sandbox, run a worker Turn, or perform Unit E or Unit F work.

The current host manifest admits the exact `/usr/bin/slirp4netns` path, version, and SHA-256 used by the epoch-private Docker network namespace. Provisioning does not install or upgrade that OS package; a missing or mismatched artifact blocks assertion and NanoHost start. Ordinary bring-up remains prohibited until the manifest passes and a dedicated controlled NanoHost noninterference gate proves that start and stop leave the system Docker bridge, canonical nftables structure, business-container attachments, and build egress unchanged.

## Prerequisites

- `ssh a1` reaches the reviewed execution host.
- NanoCore is already running in server mode with the configured NanoHost identity, deployment, and safe-sink credential paths.
- The reviewed `openkit-nanohost.service` and its required immutable artifacts are installed on A1.
- The attempt has one server-admin token in process environment only, and NanoCore enrollment has delivered one attempt-local NanoHost transport credential to a configured slot.

Never write tokens, cookies, private keys, or raw credential material into the repository or the retained result.

## Run

From the repository root, provision the only allowed host correction and then assert every admitted fact:

```bash
pnpm host:provision a1
pnpm host:assert a1
```

Set the non-secret configured identity and deployment together with the attempt-local NanoCore URL and server-admin token, then observe readiness:

```bash
OPENKIT_HOST_NANOCORE_URL="https://nanocore.example.invalid" \
OPENKIT_HOST_SERVER_ADMIN_TOKEN="$ATTEMPT_SERVER_ADMIN_TOKEN" \
OPENKIT_HOST_NANOHOST_IDENTITY_ID="nanohost-a1" \
OPENKIT_HOST_NANOHOST_DEPLOYMENT_ID="deployment-a1" \
pnpm host:nanohost:bring-up a1
```

The command starts only `openkit-nanohost.service`, polls only authenticated `GET /api/app/nanohost/runtime-target`, accepts only the configured identity and deployment with a positive current generation and all three readiness booleans true, and runs teardown on success, failure, interruption, or timeout. Teardown stops the service and calls the existing decommission endpoint, which fences the identity and clears both configured credential slots.

Run teardown again after any caller-side failure; it is idempotent:

```bash
OPENKIT_HOST_NANOCORE_URL="https://nanocore.example.invalid" \
OPENKIT_HOST_SERVER_ADMIN_TOKEN="$ATTEMPT_SERVER_ADMIN_TOKEN" \
pnpm host:teardown a1
```

## Retained Result

Retain the later two-cycle verifier's redacted result at:

```text
temp/state/nanohost/host-manifest/a1/result.json
```

The result identifies the manifest digest and the sorted sixteen-file path/content digest. It records stage exits, readiness, teardown, and credential issue/removal booleans without credential values. The real-use verifier owns that result; these scripts do not create or prefill it.
