---
status: Accepted
---
# Getting Started With OpenKit

This procedure requires an authorized host, a supported container runtime for App-image deployment, persistent storage and a selected release or source revision. NanoHost additionally needs the supported OpenShell runtime. Confirm OS, architecture, available disk and current service bindings before installation. The empirical small-team starting shape is 2 CPU cores, 8 GiB memory and 30 GiB available storage; image builds and caches can need more.

## Choose The Installation

For an existing deployment, inspect it and use the operations reference. Do not replay first-run setup, replace its Vault key or create a second process on its writable Data Root.

For a release installation, acquire the selected App image and required matching release assets through the repository's release distribution. Retain exact image digest and source identity. Use [deployment modes](nanocore-deployment-modes.en.md) for persistence, authentication and the separate NanoHost boundary. A package or image download alone is not a working installation.

For a source installation, explicitly acquire the source checkout and pinned toolchain before using repository commands:

```bash
git clone --filter=blob:none https://github.com/lingkaix/openkit.git openkit-source
cd openkit-source
git checkout --detach <full-commit>
bash scripts/repo-init.sh
```

The placeholder must be replaced with the selected full commit. Record `git rev-parse HEAD`; do not build an unreviewed moving branch by accident. From that acquired checkout, read `docs/toolchain.md` and `docs/cookbooks/docker-app.md`, then use their current App build/run commands. These source-build procedures intentionally require a checkout; installed-Skill host-only recovery does not.

Initial NanoHost installation is separately scoped and must establish exact required Worker images, the configured identity/deployment pair, safe credential delivery and readiness. Use the selected source's `docs/cookbooks/nanohost-real-use-host.md` with the operator's actual target. Do not copy a repository test-host alias, invoke teardown on a persistent instance, or treat a NanoCore container as proof that Worker execution is ready.

## Establish Access And Configuration

Choose local mode only for an intended implicit local-user deployment. For shared or remote use, configure server mode, its exact public origin and protected authentication secret, then use the normal first-login/bootstrap flow. Browser sign-in or protected credential storage supplies access; never paste raw tokens into Agent context.

Use [configuration](nanocore-data-root-config.en.md) for separate Server, Workspace and User settings. Supply a Provider through its supported credential mechanism, one logical model and an Agent default. Every model needs a sourced or explicitly authored positive context limit; prices and other optional metadata need not be invented. Use the public Skill's discovery and configuration operations when the service is running.

## Verify Useful Work

Observe public health and authorized diagnostics, then verify Provider inference and NanoHost readiness independently. Create or select a Workspace, attach the requested source/data through supported product operations, and ask for one bounded real Worker task in Web or through the public Skill. Inspect the terminal task and meaningful output; a successful Assistant reply or HTTP request does not prove Worker execution.

If a prerequisite is unavailable, report that exact boundary and follow [operations](nanocore-operations.en.md). Preserve the running deployment and unrelated state. [Product use](using-openkit.en.md) explains ordinary work after installation.
