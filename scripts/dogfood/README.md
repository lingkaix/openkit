# A2 Dogfood Deployment

`deploy.sh` is the repository-owned copy of the existing A2 helper for `ai.simonxu.net`. It updates that prepared deployment from public `origin/main`; it is not a general installer. The [persistent deployment cookbook](../../docs/cookbooks/persistent-live-acceptance.md) describes coordination and observation around an authorized update. The [NanoHost specification](../../docs/specs/20260802-nanohost_runtime_and_transport.md) owns image identities and session environment inputs.

## Host Prerequisites

The helper retains the A2 layout under the invoking user's `$HOME/openkit`: the clean `source` checkout, `app.Caddyfile`, `web.Dockerfile`, `nanohost.env`, `seed-nanohost-image.py`, and `workspaces-repos`. Those existing host configuration files and the image-seeding helper are not distributed here.

`deploy.sh nanocore` and `deploy.sh all` both build the App image from the repository `containers/app/Dockerfile` (which installs `openkit-operator` for `openkit-app-smoke`). Do not point NanoCore builds at a divergent host-side `nanocore.Dockerfile`; a past A2 drift dropped the operator chmod/symlink and failed smoke until the host file was patched live. It also requires the existing `$HOME/.openkit` Data Root, enrolled NanoHost credentials, private Image Store with the pinned Supervisor content, and host service configuration. Preserve the host's secrets and credentials.

Use the existing A2 Linux account with Docker/buildx, passwordless sudo for the helper's operations, systemd, Python 3, jq, curl, flock, Git, OpenSSL, tar, standard GNU utilities, and `$HOME/.local/bin/mise` with the existing Rust build toolchain. Worker builds retain the A2 `linux/arm64` target. Supervisor lookup selects the host platform from `apps/nanohost/openshell/release.json` and rejects missing or malformed digests before installing NanoHost.

## Install And Run

After this change reaches main, update the clean A2 checkout and copy the canonical helper to the existing entry point:

```bash
git -C "$HOME/openkit/source" pull --ff-only origin main
install -m 0755 "$HOME/openkit/source/scripts/dogfood/deploy.sh" "$HOME/openkit/deploy.sh"
"$HOME/openkit/deploy.sh" all
```

Run during an authorized maintenance window with active work coordinated. Targets are `web`, `nanocore`, `nanohost`, `linked-repos`, or `all` (default). The helper fetches main and records the deployed commit; it does not deploy the caller's arbitrary working tree. NanoHost updates remove `OPENKIT_NANOHOST_REQUIRED_IMAGE_DIGESTS` from the host source environment before installing `/etc/openkit/nanohost.env`; unrelated settings remain intact. Image verification and seeding remain separate from the session environment. App replacement keeps all bind mounts and environment arguments in one Docker invocation. Web-only updates also check both the Web and repository bind mounts and recreate the current image if either mount is missing or points elsewhere. Keep the installed helper synchronized with the repository copy before every update; fetching application source does not replace an already-running old helper. Every target also fast-forwards clean public OpenKit checkouts under `$HOME/openkit/workspaces-repos` to `origin/main` and writes `$HOME/openkit/current-linked-repos`.

## Linked Workspace Repositories

Dogfood Workspaces bind `/srv/repos/openkit` (host `$HOME/openkit/workspaces-repos/openkit`) into the App. That checkout is not the clean `source` tree used for builds; it was historically a one-time clone and stayed stale across deploys. `deploy.sh` now syncs it on every run.

Use the lightweight target when only the linked tree needs refresh:

```bash
"$HOME/openkit/deploy.sh" linked-repos
git -C "$HOME/openkit/workspaces-repos/openkit" rev-parse HEAD
cat "$HOME/openkit/current-linked-repos"
```

The sync refuses dirty or non-fast-forward trees. Before a destructive reset, create a backup under `$HOME/openkit/backups/linked-repos/` (for example `git -C ... bundle create ... --all`), inspect local work, then either commit/stash it or reset intentionally. Non-OpenKit remotes under `workspaces-repos` are left pinned and recorded with a `pin` marker.

## Worker PR Handoff

For dogfood repository Tasks and Goals, prefer a plan+patch handoff when worker push or PR creation is unavailable because of missing GitHub credentials or TLS failures. The worker retains the plan and patch locally and closes out with their exact locations, repository/base revision, check results, and the publication failure without secrets. A human or local agent retrieves and reviews the handoff, applies the patch in a local checkout, runs the relevant checks, pushes a branch, and opens the PR. Report the handoff as complete only when it meets the agreed stop condition; keep PR publication explicitly pending until confirmed.

Do not provision broad worker GitHub write credentials without an explicit house decision. Worker publication failure is a reason to hand off, not authorization to expand credential access.

## Focused Verification

```bash
bash -n scripts/dogfood/deploy.sh
node --test tests/dogfood-deploy.test.mjs
```

The tests execute the helper's Bash functions with command doubles at external effect boundaries. They check platform digest selection and rejection, environment-file cleanup, and the actual Docker argument vector. They do not prove A2 readiness, build images, access production data, or start services.

Worker Git data sources are separately pinned to exact commits. Refreshing the App or linked host checkout does not advance those pins. Use the deployment-admin Configuration editor or public Skill `runtime.file-read`, revision-bound `runtime.file-update`, and `runtime.reload` to select an obtainable commit for future sessions; existing session snapshots retain their accepted source. A missing Docker bind mount requires the host operator and this deployment helper, not a repository-path API edit or an in-product administrator token.
