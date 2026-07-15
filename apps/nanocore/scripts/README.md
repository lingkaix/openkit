# NanoCore Operator Scripts

This directory contains privileged or stopped-server operator helpers that are installed outside the NanoCore process.

## OpenShell Disposable Cell

`openshell-cell.sh` is installed as root at `/usr/local/libexec/openkit-openshell-cell` with mode `0700`. NanoCore invokes only `sudo -n /usr/local/libexec/openkit-openshell-cell prepare <owner-id>` and `sudo -n /usr/local/libexec/openkit-openshell-cell recycle <owner-id>`; the helper rejects every other action, unsafe owner, non-root caller, configurable path, and shell fragment.

The helper requires Linux with systemd, util-linux `flock`, containerd, Docker Engine and CLI, curl, and official binaries whose exact version output is `openshell 0.0.80` for `/usr/bin/openshell` and `openshell-gateway 0.0.80` for `/usr/bin/openshell-gateway`. It owns `openkit-openshell-cell.slice`, fixed loopback Gateway endpoints `http://127.0.0.1:17670` and `http://127.0.0.1:17671/readyz`, mutable epoch state under `/var/lib/openkit/openshell-cell/epochs`, and epoch runtime state under `/run/openkit/openshell-cell/epochs`. A fresh epoch is ready only after its exact Gateway service is active, Providers v2 reads back as enabled, Docker has no containers, and OpenShell has no sandboxes.

The inert image cache is `/var/lib/openkit/openshell-cell/image-cache/*.tar`. Each fresh dockerd loads every archive before Gateway startup. The cache must include the host-built OpenKit worker image and the exact supervisor tag baked into the official Gateway `0.0.80` binary: `ghcr.io/nvidia/openshell/supervisor:709aa0fe3e9e4d2b5fea336b5d6e393b45481898`. On the supported A1 arm64 runtime, its source image id is `sha256:7c37c367f63d2d160673c41d58363be8a4beb543b82a3de8547d09c0b5be1a2f`, and Docker `29.6.1` normalizes the saved archive to the pinned fresh-Cell image id `sha256:d87e54175490a7dc5e75daef1c4aaf43955cf3fc3945827e4f03698ea99faadb`. The cache archive is named `openshell-supervisor-709aa0fe-aarch64.tar`; other architectures are rejected rather than accepted without a verified identity.

Install the helper with:

```bash
sudo install -D -o root -g root -m 0700 \
  apps/nanocore/scripts/openshell-cell.sh \
  /usr/local/libexec/openkit-openshell-cell
```

Grant the NanoCore systemd service account non-interactive sudo access only to that installed helper and its two actions. Owner validation remains mandatory inside both NanoCore and the root helper; do not grant access to a shell, an alternate helper path, or environment overrides.

NanoCore may invoke the same helper on a remote Cell host only through `/usr/bin/ssh -T -o BatchMode=yes -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no -o PermitLocalCommand=no -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=2 <target> /usr/bin/sudo -n /usr/local/libexec/openkit-openshell-cell <prepare|recycle> <owner-id>`. The SSH target is validated deployment configuration, and this command is lifecycle control only; Gateway and sandbox worker-control connectivity are configured separately.

Recycle stops the exact epoch Gateway before Docker cleanup, removes every epoch container and the deterministic epoch network, stops dockerd and containerd, kills the complete Cell slice, verifies its cgroups are empty, and proves the old Docker bridge remains absent. It then persists a `fenced` cleanup marker before removing mutable roots, so a root-removal timeout can retry only the already fenced proof instead of requiring a vanished Docker socket. The helper starts and verifies a fresh idle replacement only after cleanup succeeds. A same-boot Docker control-plane failure retains the owner marker and mutable roots and fails closed; after a host reboot, the next same-owner recycle may discard the stale epoch because the previous boot can no longer own effects.
