# A2 Dogfood Deployment

`deploy.sh` is the repository-owned copy of the existing A2 helper for `ai.simonxu.net`. It updates that prepared deployment from public `origin/main`; it is not a general installer. The [persistent deployment cookbook](../../docs/cookbooks/persistent-live-acceptance.md) describes coordination and observation around an authorized update. The [NanoHost specification](../../docs/specs/20260802-nanohost_runtime_and_transport.md) owns image identities and session environment inputs.

## Host Prerequisites

The helper retains the A2 layout under the invoking user's `$HOME/openkit`: the clean `source` checkout, `app.Caddyfile`, `web.Dockerfile`, `nanocore.Dockerfile`, `nanohost.env`, `seed-nanohost-image.py`, and `workspaces-repos`. Those existing host configuration files and the image-seeding helper are not distributed here. It also requires the existing `$HOME/.openkit` Data Root, enrolled NanoHost credentials, private Image Store with the pinned Supervisor content, and host service configuration. Preserve the host's secrets and credentials.

Use the existing A2 Linux account with Docker/buildx, passwordless sudo for the helper's operations, systemd, Python 3, jq, curl, flock, Git, OpenSSL, tar, standard GNU utilities, and `$HOME/.local/bin/mise` with the existing Rust build toolchain. Worker builds retain the A2 `linux/arm64` target. Supervisor lookup selects the host platform from `apps/nanohost/openshell/release.json` and rejects missing or malformed digests before installing NanoHost.

## Install And Run

After this change reaches main, update the clean A2 checkout and copy the canonical helper to the existing entry point:

```bash
git -C "$HOME/openkit/source" pull --ff-only origin main
install -m 0755 "$HOME/openkit/source/scripts/dogfood/deploy.sh" "$HOME/openkit/deploy.sh"
"$HOME/openkit/deploy.sh" all
```

Run during an authorized maintenance window with active work coordinated. Targets are `web`, `nanocore`, `nanohost`, or `all` (default). The helper fetches main and records the deployed commit; it does not deploy the caller's arbitrary working tree. NanoHost updates remove `OPENKIT_NANOHOST_REQUIRED_IMAGE_DIGESTS` from the host source environment before installing `/etc/openkit/nanohost.env`; unrelated settings remain intact. Image verification and seeding remain separate from the session environment. App replacement keeps all bind mounts and environment arguments in one Docker invocation.

## Focused Verification

```bash
bash -n scripts/dogfood/deploy.sh
node --test tests/dogfood-deploy.test.mjs
```

The tests execute the helper's Bash functions with command doubles at external effect boundaries. They check platform digest selection and rejection, environment-file cleanup, and the actual Docker argument vector. They do not prove A2 readiness, build images, access production data, or start services.
