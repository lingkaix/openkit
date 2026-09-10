---
status: Accepted
---
# NanoCore Operations

Operate only the selected deployment and requested effect. Keep its persistent Data Root, external Vault key, protected authentication configuration and NanoHost transport credentials intact. NanoCore/Web replacement does not authorize NanoHost, unrelated containers or host reverse-proxy maintenance.

## Inspect A Running Deployment

With the public `openkit` Skill installed, run its `scripts/openkit doctor`, search for `diagnostics`, describe the matching operation and perform an authorized read. Inspect the relevant Workspace, Thread, Task, Artifact, Evidence, Audit or Usage records through their public operations. A server-admin credential does not itself grant private Workspace content.

Observe product-work readiness and its individual reasons rather than treating every degraded state as failure or success. Retain the actual boot and deployed image/source identity. Current optional telemetry consists of explicit HTTP response-handoff spans and process diagnostics; it does not trace a complete Worker task. Use retained product records to establish that outcome. Inspect deployment-owned rotated logs or Collector files through authorized host tools only for the missing diagnostic question, without dumping credentials, full configuration or unrelated transcripts.

## Update NanoCore And Web

Coordinate a maintenance window and inspect active work. A second deployment is optional. For a release, acquire and verify its published immutable image digest. For an exact source commit, build from that committed snapshot and record the resulting image digest. Run the selected image's `openkit-app-smoke` before replacing the active container; a local rebuild is not the published release artifact.

For a source build, acquire the selected checkout as described in [getting started](getting-started.en.md). Its `docs/cookbooks/persistent-live-acceptance.md` describes the maintained exact-source procedure, including a `git archive` transfer when the selected local commit is not published. A source checkout is an explicit prerequisite for building, not a prerequisite for inspecting or recovering the installed deployment.

Preserve current mounts, secret files, network/port bindings, restart policy and log retention. Stop and retain the previous App container; never run two Apps on one writable Data Root. If Web assets are mounted separately, stage the matching assets and switch them during the same maintenance window. Keep image and configuration changes coordinated: a new required configuration field and its supporting parser may need one stopped-App edit and replacement rather than a live reload of either half.

Observe the new image/container, Web assets, boot identity, product-work readiness and retained Workspace records before resuming work. NanoHost must retain its identity and deployment and become ready on an authoritative successor connection with a greater generation; NanoCore restart cannot reuse the old physical connection. Separately verify that NanoHost itself was not restarted, reenrolled or maintained. Readiness warnings with empty `blocks` remain visible; missing or malformed diagnostics, failed critical subsystems and nonempty blocking sets cannot pass update verification. A changed image, `docker ps` status or `/api/health` alone is insufficient. Retain failed or interrupted work as such; start a new authorized continuation after inspecting the result.

When the deployment has the restricted App-update helper installed, use Web Settings → App update or the public `openkit` Skill. Search for `app-update` and describe `app-update.prepare`, `app-update.start` and `app-update.status` before invoking them. Prepare supplies the exact source and expected current image for administrator review; it does not build or interrupt the App. Save its request ID before starting. Start requires consent to that exact prepared update and its maintenance interruption. Read status with the same ID after a disconnect or App restart; never create a second start to resolve an unknown handoff.

Inspect the returned verification predicates and retained-data observation. A submitted update or successful handoff is not a completed replacement. Missing helper configuration reports the capability unavailable; unusable SSH identity files also fail the operation while Core remains available. Until the installed version and host configuration support the complete path, an authorized external operator performs the procedure above. An internal Agent cannot substitute its own decision for the required administrator approval.

### Restricted Host Helper

The optional helper is a host-installed Python program, outside the App container. Install the reviewed `scripts/docker/app-update-helper.py` from the selected source revision as a root-owned regular file at `/usr/local/lib/openkit/app-update-helper.py`; retain its checksum. Its default configuration is the root-owned mode-0600 `/etc/openkit/app-update/helper.json`. Keep receipts, lock and staged source outside Data Root under a protected host directory. Configure the exact existing container, mounted paths, source repository/branch, image repository, App URL and a protected valid administrator-token file. The compatibility assessment binds the observed current image, applied migrations and exact candidate; the initial procedure admits only established migration-free replacements, not arbitrary rollback compatibility.

Use a dedicated locked-password SSH account with a working shell for the forced command. Pin its host key and mount its private client key and known-hosts file read-only into the App at `/run/openkit/app-update/id_ed25519` and `/run/openkit/app-update/known_hosts`. Configure `server.jsonc.appUpdate` with these paths and the dedicated user. Restrict its authorized key with `restrict,command="sudo -n /usr/local/sbin/openkit-app-update-entry"`; the root-owned entry accepts no arguments and executes the fixed Python helper. Validate a sudoers rule granting only that entry with an empty argument list. Do not grant the account general Docker, shell, Python or systemd privileges. The helper itself launches the bounded systemd job after validating the closed request.

For an unpushed exact commit, an authorized external operator can stage its clean Git archive under the configured staged-source directory, with the helper's content digest and matching `IDENTITY.json`. If computing that digest imports a Python module from the source tree, disable bytecode writes before import (`python3 -B` or `PYTHONDONTWRITEBYTECODE=1`) so inspection does not add `__pycache__` files to the candidate. The App SSH key cannot upload or stage arbitrary code. A changed staged tree must fail identity verification; do not repair the identity file to excuse a mismatch with the selected commit.

If the App is unavailable, an authorized host operator can read the same receipt without starting another update: pass `{"op":"status","requestId":"<saved UUID>"}` on standard input to the installed helper. Inspect the corresponding `openkit-app-update-<UUID>` systemd unit and protected receipt/log files for missing evidence. Preserve unknown, interrupted and recovery-required outcomes. Before any manual restoration, prove the candidate stopped and the Data Root has no other writer; an old image cannot undo database changes.

The helper's retained-auth observation compares nonempty persistent token metadata through the existing administrator endpoint, ignoring last-use fields. It does not establish private Workspace continuity. Use a separately authorized Workspace credential to verify the relevant retained product records after replacement.

## Backup And Restore

Use the public backup/export operations for their documented scopes and re-read their result. A Workspace export is not a complete deployment backup. A consistent offline deployment copy requires NanoCore stopped and its Data Root lock released; copy all selected authoritative data plus the external key and required protected configuration under separately secured custody. Do not copy a live SQLite file as if it were a consistent snapshot or place secret files into an ordinary artifact.

Record source version, image identity and backup scope. An old image does not reverse a database migration. If compatibility of the old executable with current data is not established, stop to an explicit recovery procedure rather than automatically starting it or restoring old data over newer writes. Restore into a stopped, correctly identified target and prove lock exclusivity, readable durable records and credential usability before resuming work.

## Recover Access Or Startup

If access alone is lost, the stopped-server commands in [deployment modes](nanocore-deployment-modes.en.md) use the existing App image's `openkit-operator` executable. They require a functioning container runtime and a compatible local image, but not a running NanoCore. Choose a current active user and a future expiry within the permitted bound. Keep the resulting envelope private and pass it directly to the public Skill credential-store operation when available; never inspect its token in Agent context.

If the Vault is locked, inspect its non-secret status and exact external-key availability. Do not regenerate a key for an existing encrypted store. If storage is exhausted, identify owned disposable build artifacts and obtain any missing deletion authority before removing them; do not prune unrelated host state. If NanoHost is disconnected, inspect its existing evidence and report the separate maintenance need; do not restart or reenroll it as a routine App repair.

Retain the exact failure and partial outcome. A fresh task may continue after recovery; no script or Agent may relabel the interrupted attempt as successful.
