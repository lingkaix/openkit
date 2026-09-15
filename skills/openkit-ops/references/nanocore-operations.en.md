---
status: Accepted
---
# NanoCore Operations

Operate only the selected deployment and requested effect. Keep its persistent Data Root, external Vault key, protected authentication configuration and NanoHost transport credentials intact. NanoCore/Web replacement does not authorize NanoHost, unrelated containers or host reverse-proxy maintenance.

NanoHost startup and Worker-image availability are separate checks. The accepted stock OpenShell Supervisor bootstrap may contact GHCR before readiness; a locally retained Worker image does not remove that dependency. Follow [NanoHost Runtime](nanocore-deployment-modes.en.md#nanohost-runtime) when diagnosing registry-related startup failure. NanoCore/Web updates do not authorize a NanoHost restart to test this behavior.

## Inspect A Running Deployment

With the public `openkit` Skill installed, run its `scripts/openkit doctor`, search for `diagnostics`, describe the matching operation and perform an authorized read. Inspect the relevant Workspace, Thread, Task, Artifact, Evidence, Audit or Usage records through their public operations. A presented usable `server-admin` bearer admits active Workspace product routes as owner (including Task start). Prefer a workspace-scoped token for least privilege when only one Workspace is needed. Session cookies remain membership-bound.

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

Worker execution volumes live on NanoHost separately from NanoCore's Data Root. A Core-only backup omits them. Declare this omission, or separately preserve the host's complete admitted storage associations and their identity metadata after proving their writers stopped. Preserve unknown files, ignored work, native runtime history, memory and configuration as whole-volume data; these examples are not a file inventory. A live filesystem copy is not a consistent backup. Restoring bytes does not restore a process, native session authority or permission to attach the volume.

Record source version, image identity and backup scope. An old image does not reverse a database migration. If compatibility of the old executable with current data is not established, stop to an explicit recovery procedure rather than automatically starting it or restoring old data over newer writes. Restore into a stopped, correctly identified target and prove lock exclusivity, readable durable records and credential usability before resuming work.

## Convert A Pre-Witness Deployment

This one-time internal protocol conversion is a separately authorized NanoCore and NanoHost maintenance operation. It is not a routine App update and cannot use the migration-free App-update helper. Acquire the exact reviewed source, matching App and NanoHost builds, and the source toolchain described in [getting started](getting-started.en.md). Fresh installations already use the new schema and must not run this conversion.

1. Inspect current Tasks, leases, service identities, storage associations and deployment mounts. Preserve pending or unknown work for ordinary recovery; do not replay it. Stop NanoCore and prove its Data Root has no writer and its lock is released.
2. Stop the selected NanoHost through its existing complete effect-domain fence. Verify actual predecessor processes, cgroup members and private backend namespaces are absent; a stop request or supplied report alone is insufficient. Preserve its credentials, Image Store and complete retained Worker volumes. Never reset a rebuild marker to force startup.
3. Keep both services stopped. Run the selected source's cold converter with the exact Data Root and a new external backup destination. The converter verifies the complete backup before changing the three existing runtime record schemas in one transaction; retain the backup and its evidence report.
4. Install the matched NanoCore and NanoHost versions, preserving configuration, credentials, mounts and retained data. Start NanoCore, then the fresh NanoHost coordinator through its normal startup fence. Old and new readiness protocols cannot be mixed.
5. Verify the matched installed versions and authenticated readiness from the newly started coordinator. Inspect pending Task recovery and storage disposition through their existing owners; conversion itself neither settles work nor grants a new attachment. Use a new authorized Task to check the original volume bytes and requested work after recovery.

Run step 3 from the verified source checkout using its pinned Node and pnpm:

```bash
pnpm --filter @openkit/nanocore run physical-epoch:migrate -- \
  --data-root /absolute/path/to/openkit-data \
  --backup-root /absolute/path/to/openkit-pre-witness-backup
```

The evidence report is `server/migrations/physical-epoch-cutover.json` inside Data Root. Its backup identity refers to the complete external predecessor copy; it does not cover separately retained NanoHost volumes or external secrets.

A failed transaction preserves the predecessor records; a failed backup or unproved physical fence stops the dependent operation. Converted old physical handles carry `pre-witness` provenance and cannot be reused as live handles. A repeated conversion is refused. The migration report is evidence, not retry, resume or replay authority. Do not start the predecessor App against the converted database as an automatic rollback; the retained external cold backup is the recovery source, and restoring it is a separate stopped-target operation.

## Recover Access Or Startup

If access alone is lost, the stopped-server commands in [deployment modes](nanocore-deployment-modes.en.md) use the existing App image's `openkit-operator` executable. They require a functioning container runtime and a compatible local image, but not a running NanoCore. Choose a current active user and a future expiry within the permitted bound. Keep the resulting envelope private and pass it directly to the public Skill credential-store operation when available; never inspect its token in Agent context.

If the Vault is locked, inspect its non-secret status and exact external-key availability. Do not regenerate a key for an existing encrypted store. If storage is exhausted, identify owned disposable build artifacts and obtain any missing deletion authority before removing them; do not prune unrelated host state. If NanoHost is disconnected, inspect its existing evidence and report the separate maintenance need; do not restart or reenroll it as a routine App repair.

Retain the exact failure and partial outcome. A fresh task may continue after recovery; no script or Agent may relabel the interrupted attempt as successful.

### Maintain Local Worker Images

Use these commands on the selected NanoHost only with authorized host administrator access. They operate on `/var/lib/openkit/nanohost-images` and do not read transport credentials, connect to NanoCore or start the service:

```bash
sudo /usr/lib/openkit/nanohost image list
sudo /usr/lib/openkit/nanohost image capacity
sudo /usr/lib/openkit/nanohost image import /absolute/path/worker.oci.tar sha256:<expected-manifest-digest>
sudo /usr/lib/openkit/nanohost image capacity <positive-byte-count>
sudo /usr/lib/openkit/nanohost image remove sha256:<exact-manifest-digest>
```

Replace placeholders with the reviewed archive, exact lowercase digest or positive integer byte count before execution. Import verifies the archive and does not fetch missing images or run its contents. The default capacity is 214748364800 bytes (200 GiB); changes take effect without a restart. Lowering it below usage keeps all stored images and running Workers but refuses further growth. Images are not automatically evicted. Listing includes incomplete entries and attributed temporary content so an interrupted import can be inspected and explicitly removed by exact digest. A busy store fails the current command; wait for the active transaction and make a fresh authorized request.

Before removing an image, inspect affected Agent configurations through public operations. The local command cannot determine which NanoCore configurations reference it. Removal can block later admissions, and local-only content may not be recoverable without its source archive. It does not delete backend containers, retained Worker volumes or running processes. Never remove the whole store or restart NanoHost to resolve capacity pressure.

## Prepare And Reuse A Worker Environment

Use the installed public `openkit` Skill to discover and describe Worker environment operations. If the installed server does not expose them, report the version prerequisite; do not substitute Docker commands against NanoHost's private runtime. These technical operations require the requesting user's current administrator authority and independent access to the Agent configuration and every affected Workspace and source audience. Ordinary Workspace membership and a user's willingness to continue do not grant administration authority.

Inspect eligible retained environments for the exact target work. Prefer useful existing data for related Tasks or Goals in the same Workspace, considering its source lineage, current occupancy and compatibility; choose fresh storage when reuse is unsuitable. Never share storage across Workspaces. Current Core admission decides eligibility and exclusive attachment; an image family label, an earlier successful mount or an Agent's relatedness judgment cannot authorize reuse.

Prepare the exact image declaration through the public owner and retain its immutable candidate reference. A digest-pinned Dockerfile base already verified in the selected NanoHost Image Store is used locally without publishing it to a registry; retain the exact authored `FROM` reference. Only a missing digest permits the existing authorized registry lookup. Corrupt, busy or unreadable retained content stops preparation for inspection, and the existing strict Buildx policy remains required. Preparation must not mount the retained data or interrupt the existing Worker. Review the resolved image, complete storage layout, target revision, affected work and stated interruption before confirming activation. Bind confirmation to that exact candidate; a changed target, image, revision or impact requires a new review. Activation must prove the old writer fenced before attaching retained volumes. Missing storage, an incompatible layout or an unknown attachment is a reason to inspect and stop the dependent action, never to initialize an empty replacement or force another mount.

Preparation and activation use the global public operations because their target is one exact Server Agent manifest, not a Workspace or Agent profile. Initial preparation supplies `mode: "prepare"`, target `{ "kind": "agent", "agentId": "..." }`, the authored runtime image declaration, and the existing Agent configuration file id plus its exact SHA-256 revision. Optional `replaceNow` selects one current Workspace and Thread; its nonempty prompt is the actual successor Turn input authored or explicitly adopted by the administrator. Omitting it changes later admissions only. Preserve the separate immutable version-1 authored and resolved candidate Artifact references. Result-only recovery supplies `mode: "recover"`, a fresh request id, and the exact authored candidate reference. It resolves the original retained result without rebasing the configuration or dispatching image acquisition again.

Activation supplies the exact resolved candidate, target, configuration revision, affected storage revisions, optional replacement input, and the payload-bound confirmation. Display the complete prepared response and obtain the administrator's decision first. After approval, copy its `activationConfirmation` preview unchanged into the activation request. The preview is not approval or authorization; do not use it before the decision or after any field changes. List, select, status, and purge remain Workspace-scoped.

After activation, inspect the owner-reported attachment and readiness, then run the requested work to verify the new software and retained data. Image availability and successful configuration writes do not prove an active environment. Old native files do not authorize automatic conversation resume, and compatible mounts do not prove older software can read a newer native data format. Preserve unknown outcomes without replaying external effects. Normal close, image replacement and App update retain storage; whole-storage deletion is a separate exact-reference operation with explicit administrator confirmation and the owner's retention checks.

## Classify Predecessor Thread Visibility

PR #55 requires every durable Thread to carry `visibility` / `privateOwnerUserId` and `openkit.thread-visibility.v1`. Restart cutover classifies owner-bound Quick Chat as private and formal Task/Goal or agent-inception history as workspace. Ambiguous project history fails closed and blocks NanoCore startup until an authorized operator classifies it.

Use this stopped-process migrator before deploying a build that enforces the visibility feature against a Data Root that still has predecessor Thread envelopes:

1. Stop NanoCore and prove the Data Root has no other writer.
2. Choose an external backup destination outside the Data Root.
3. Dry-run classification, then apply with an explicit ambiguous default when dogfood or other reviewed history should become workspace-visible.

```bash
pnpm --filter @openkit/nanocore run thread-visibility:migrate -- \
  --data-root /absolute/path/to/openkit-data \
  --backup-root /absolute/path/to/thread-visibility-backup \
  --dry-run

pnpm --filter @openkit/nanocore run thread-visibility:migrate -- \
  --data-root /absolute/path/to/openkit-data \
  --backup-root /absolute/path/to/thread-visibility-backup \
  --ambiguous-default workspace
```

The migrator acquires the ordinary data-root lock, copies each rewritten `thread.json` into the backup root, and writes canonical envelopes with `openkit.thread-visibility.v1`. Without `--ambiguous-default`, ambiguous Threads remain unchanged and the command exits blocked. The only supported ambiguous default is `workspace`. Do not invent private owners for project history. Restore from the external backup only onto a stopped target when rolling back the classification writes.


## Sync A2 Dogfood Linked Repositories

A2 dogfood Workspaces that edit OpenKit bind the host checkout `$HOME/openkit/workspaces-repos/openkit` at `/srv/repos/openkit`. That tree is separate from the clean `$HOME/openkit/source` build checkout. `scripts/dogfood/deploy.sh` fast-forwards clean public OpenKit linked checkouts to `origin/main` on every deploy target and records SHAs in `$HOME/openkit/current-linked-repos`.

For dogfood prep without rebuilding images:

```bash
"$HOME/openkit/deploy.sh" linked-repos
```

Refuse dirty or divergent linked trees; backup under `$HOME/openkit/backups/linked-repos/` before any intentional reset. Verify with `git -C "$HOME/openkit/workspaces-repos/openkit" rev-parse HEAD` against public `origin/main` and by reading a file that only exists on the expected tip.

## Dogfood Task Smoke With Admin Bearer


Non-interactive ops that only have a usable `server-admin` bearer can:

1. `openkit ops call workspace.list --input -` with `{}` (App authorized set; expects 200).
2. Create or select a **workspace-visible** Thread in the target Workspace.
3. `openkit ops call task.start` (or `POST .../threads/{threadId}/task`) with an actionable prompt and `workerStorageChoice: { "kind": "fresh" }`.

Do not print token secrets. Prefer rotating into a named local destination via `token.create` / `token.rotate` when issuing dedicated automation credentials.

## Store a GitHub token for dogfood push

Prerequisites: a running NanoCore with an unlocked encrypted-file Vault, the public `openkit` Skill executable, deployment-admin authority, an authorized Workspace and host repository, and a GitHub token supplied privately by its owner. No production token is needed for local tests. The examples use `openkit` as the installed Skill's `scripts/openkit` executable.

1. Run `openkit doctor`, then describe `vault.secret-create`, `vault.grant-create`, and `repository.set-default`. Inspect the selected Workspace's existing repository and Git settings.
2. Enroll material through hidden input and a pipe. The secret is never an argument, shell-history entry, temporary file, or command output visible to the Agent. Replace only the non-secret Workspace ID in this example:

```bash
python3 -c 'import getpass,json; print(json.dumps({"workspaceId":"WORKSPACE_ID","secretKind":"github-token","material":getpass.getpass("GitHub token: ")}))' | openkit ops call vault.secret-create --input -
```

3. Use the returned redacted `referenceId` to create a grant:

```bash
printf '%s' '{"workspaceId":"WORKSPACE_ID","referenceId":"vault_RETURNED_ID"}' | openkit ops call vault.grant-create --input -
```

4. Bind the returned `grantId` using `repository.set-default`. Supply the existing `resourceId`, `displayName`, authorized host `localPath`, and complete existing `git` object with only `vaultGrantRef` changed to the returned grant ID. Read `repository.list` afterwards to verify the binding. Keep the repository's review linkage, allowed push targets, protected branches, and author settings intact.
5. Use `repository.push-request-approval`, obtain the required human approval, and then use `repository.push-execute`. Inspect `repository.push-list` and `vault.use-list` for redacted evidence. The `git-push:github-token` adapter resolves host-only `GITHUB_TOKEN`; no worker AEP or sandbox receives the token.
6. Rotate with `vault.secret-rotate` using the same hidden-input pipe and `{ workspaceId, referenceId, material }`. Re-read `vault.reference-list` and verify the new version. Revoke a grant with `vault.grant-revoke` and `{ workspaceId, grantId }`, or destroy all material versions and dependent grants with `vault.secret-revoke` and `{ workspaceId, referenceId }`.

A grant created by this recipe is restricted to `gateway-only` and `workspace.git.push`. Agent Manifest `requirementId: github-token` / `targetEnvVarName: GITHUB_TOKEN` declarations and Workspace `credentialBindings` belong to the separate worker credential-injection path; this host-push grant cannot satisfy a `runtime-env` declaration. Generic secrets may use another lowercase `secretKind`, but the public grant-creation operation in this slice remains host-push-only.

Web uses **Settings → Vault backend → Workspace secrets** for the same lifecycle, with a password field cleared on submission and redacted inventory. Existing Workspace Vault remains an evidence view. Revocation retains reference and grant history and does not make an ID reusable. A failed or interrupted mutation requires inventory inspection before a fresh request; the system does not automatically repair Core/backend disagreement.
