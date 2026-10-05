# NanoHost Real-Use Host

Use this workflow before a real NanoHost acceptance attempt on the configured lowercase `a1` SSH target. It prepares only the admitted Node projection, observes the checksum-verified bundled capability profile, observes existing NanoHost readiness, and cleans the attempt. It does not create a sandbox, run a worker Turn, or perform Unit E or Unit F work.

The schema-version-2 profile requires executable regular non-symlink `/usr/bin/slirp4netns` and a usable resolver, without pinning a package version or digest. Provisioning does not install or upgrade that OS package; a missing executable or unmet capability blocks assertion and installation. Unavailable inspection fails closed as `cannot-check`. Ordinary bring-up remains prohibited until the manifest passes and a dedicated controlled NanoHost noninterference gate proves that start and stop leave the system Docker bridge, canonical nftables structure, business-container attachments, and build egress unchanged.

## Prerequisites

- Checking and installation, including staging verification, require Python 3.8 or later with its standard library at `/usr/bin/python3`; it is not a NanoHost service runtime dependency. Missing or unusable inspection yields one bounded `cannot-check` result and blocks installation.
- `ssh a1` reaches the reviewed execution host.
- NanoCore is already running in server mode with the configured NanoHost identity, deployment, and safe-sink credential paths.
- The reviewed `openkit-nanohost.service` and its required immutable artifacts are installed on A1.
- The attempt has one server-admin token in process environment only, and NanoCore enrollment has delivered one attempt-local NanoHost transport credential to a configured slot.

Never write tokens, cookies, private keys, or raw credential material into the repository or the retained result.

## Run

From the repository root, provision the only allowed host correction and then assert every admitted fact:

```bash
pnpm host:provision a1
OPENKIT_HOST_BUNDLE="/absolute/path/to/extracted/candidate" pnpm host:assert a1
```

Set the non-secret configured identity and deployment together with the attempt-local NanoCore URL and server-admin token, then observe readiness:

```bash
OPENKIT_HOST_BUNDLE="/absolute/path/to/extracted/candidate" \
OPENKIT_HOST_NANOCORE_URL="https://nanocore.example.invalid" \
OPENKIT_HOST_SERVER_ADMIN_TOKEN="$ATTEMPT_SERVER_ADMIN_TOKEN" \
OPENKIT_HOST_NANOHOST_IDENTITY_ID="nanohost-a1" \
OPENKIT_HOST_NANOHOST_DEPLOYMENT_ID="deployment-a1" \
pnpm host:nanohost:bring-up a1
```

The command starts only `openkit-nanohost.service`, polls only authenticated `POST /api/app/operations/nanohost.runtime-target`, accepts only the configured identity and deployment with a positive current generation and all three readiness booleans true, and runs teardown on success, failure, interruption, or timeout. Teardown stops the service and calls the existing decommission endpoint, which fences the identity and clears both configured credential slots.

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

The static assertion emits the exact profile, product commit, archive, machine identity and ordered-observation digests with its timestamp, hard verdict and separate resource recommendation. Keep the original archive beside the extraction so the checker can verify its identity; it never obtains another profile from the repository or network. The later real-use result identifies the profile digest and its separately retained instrument path/content digest. It records stage exits, readiness, teardown, and credential issue/removal booleans without credential values. The real-use verifier owns that result; these scripts do not create or prefill it.
