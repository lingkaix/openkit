"""Upgrade the prepared L-RT fixture without provisioning or resetting it.

The operator owns previous-release installation, synthetic authentication, provider setup, and private payload bindings. Failures retain their unknown effect. This driver never retries a Worker request or rolls old binaries onto changed data.
"""

import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

PRIVATE_BASE = Path("/home/simonx/.cache/openkit-tmp/lrt")
GUEST = "lrt-p14-rehearsal"
CARRIER = "lrt-p14-network"
APP = "lrt-p14-upgrade"
SERVICE = "openkit-nanohost.service"
DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")
COMMIT = re.compile(r"[a-f0-9]{40}\Z")
CGROUP_PROOF = """from pathlib import Path
import json
root=Path('/sys/fs/cgroup')
assert (root/'cgroup.controllers').is_file()
p=root/'openkit.slice/openkit-nanohost.slice'
try:p.lstat()
except FileNotFoundError:present=False
else:
 present=True
 assert dict(x.split() for x in (p/'cgroup.events').read_text().splitlines())['populated']=='0'
print(json.dumps({'positiveKernelObservation':True,'hostDomainEmpty':True,'slicePresent':present}))
"""


def require(condition, code):
    """Raise only a fixed safe code; private input never enters diagnostics."""
    if not condition:
        raise RuntimeError(code)


def digest(path):
    """Hash payload bytes without decoding configuration or credentials."""
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def worker_archive_identity(path):
    """Verify the saved OCI archive's own descriptor without assuming its published index identity."""
    with tarfile.open(path, "r:*") as archive:
        require(json.load(archive.extractfile("oci-layout"))["imageLayoutVersion"] == "1.0.0",
                "worker_archive_not_oci")
        index = json.load(archive.extractfile("index.json"))
        require(index["schemaVersion"] == 2 and len(index["manifests"]) == 1,
                "worker_archive_descriptor_ambiguous")
        descriptor = index["manifests"][0]
        source = descriptor["digest"]
        require(DIGEST.fullmatch(source) and type(descriptor["size"]) is int and descriptor["size"] > 0,
                "worker_archive_descriptor_invalid")
        blob = archive.getmember("blobs/sha256/" + source[7:])
        require(blob.isfile() and blob.size == descriptor["size"], "worker_archive_blob_size_mismatch")
        h = hashlib.sha256()
        size = 0
        with archive.extractfile(blob) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(chunk)
                size += len(chunk)
        require(size == descriptor["size"] and "sha256:" + h.hexdigest() == source,
                "worker_archive_blob_digest_mismatch")
    return {"sha256": digest(path), "sourceDescriptor": source}


class DockerConnection(http.client.HTTPConnection):
    """Use the local Engine socket without credentials in process arguments."""

    def connect(self):
        """Open the local socket with a finite operation timeout."""
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/var/run/docker.sock")


class Boundary:
    """Keep subprocess, Engine, HTTP, and kernel observations at one test seam."""

    def run(self, args, *, env=None, timeout=60):
        """Capture private output; callers expose only fixed safe verdicts."""
        return subprocess.run(
            args, env=env, timeout=timeout, check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        ).stdout.strip()

    def docker(self, path, body=None, method="GET"):
        """Perform one Engine request; never print inspection or its body."""
        connection = DockerConnection("localhost", timeout=125)
        try:
            connection.request(
                method, "/v1.47" + path,
                None if body is None else json.dumps(body),
                {"content-type": "application/json"},
            )
            response = connection.getresponse()
            data = response.read()
            require(200 <= response.status < 300, "docker_operation_failed")
            return json.loads(data) if data else None
        finally:
            connection.close()

    def namespace(self, pid):
        """Observe a process's real network namespace."""
        return os.readlink(f"/proc/{pid}/ns/net")

    def process_root(self, pid):
        """Resolve the running guest's root from the kernel."""
        return Path(f"/proc/{pid}/root").resolve(strict=True)

    def guest_digest(self, pid, path):
        """Hash the payload visible in the running guest's mount namespace."""
        return digest(Path(f"/proc/{pid}/root") / str(path).lstrip("/"))

    def http(self, origin, path, body=None, token=None):
        """Read or submit one bounded fixture request, with no redirect."""
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            """Keep authentication and fixture requests on the admitted origin."""

            def redirect_request(self, req, fp, code, msg, headers, newurl):
                """Reject redirects rather than forward a credential."""
                return None

        headers = {"content-type": "application/json", "origin": origin}
        if token:
            headers["authorization"] = "Bearer " + token
        request = urllib.request.Request(
            origin + path, headers=headers,
            data=None if body is None else json.dumps(body).encode(),
        )
        try:
            response = urllib.request.build_opener(NoRedirect).open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(2 * 1024 * 1024)
            return response.status, json.loads(raw) if raw else {}


def local_origin(value):
    """Admit only a loopback HTTP origin with no user information or path."""
    parsed = urllib.parse.urlsplit(value)
    require(
        parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")
        and parsed.username is None and parsed.password is None
        and parsed.path in ("", "/") and not parsed.query and not parsed.fragment,
        "fixture_origin_invalid",
    )
    return value.rstrip("/")


def check_external_custody(input, sources):
    """Keep each selected opaque sample inside a complete retained source."""
    for selections in input["externalSelections"].values():
        require(isinstance(selections, list) and selections, "external_selection_missing")
        for selection in selections:
            relative = Path(selection)
            selected = (Path(input["externalRoot"]) / relative).resolve()
            require(not relative.is_absolute() and ".." not in relative.parts and any(
                selected.is_relative_to(p) for p in sources), "external_selection_not_retained")


def validate(input):
    """Admit exact artifacts and the operator's existing private layout."""
    layout = input["preparedLayout"]
    require(set(layout) == {"privateRoot", "guestRoot", "appContainer", "payloads", "retainedPaths"},
            "prepared_layout_fields_invalid")
    root = Path(layout["privateRoot"]).resolve(strict=True)
    require(root.is_relative_to(PRIVATE_BASE.resolve()) and root != PRIVATE_BASE.resolve(),
            "private_root_outside_fixture")
    require(root.stat().st_mode & 0o077 == 0, "private_root_permissions_invalid")
    require(layout["appContainer"] == APP, "fixture_container_invalid")
    for key in ("dataRoot", "externalRoot", "retainedRoot"):
        path = Path(input[key]).resolve()
        require(path.is_relative_to(root) and (path != root or key == "externalRoot"),
                "fixture_path_outside_private_root")
    output = Path(input["retainedRoot"]).resolve()
    sources = [Path(input["dataRoot"]).resolve(strict=True)]
    sources += [Path(p).resolve() for p in layout["retainedPaths"]]
    corpus = output / "file-corpus"
    if corpus not in sources:
        sources.append(corpus)
    require(len(sources) >= 2, "complete_host_retention_missing")
    for path in sources:
        require(path.is_relative_to(root) and path != root and not (output / "whole-state").is_relative_to(path)
                and not path.is_relative_to(output / "whole-state"), "retention_path_invalid")
    for index, path in enumerate(sources):
        require(not any(path.is_relative_to(other) or other.is_relative_to(path)
                        for other in sources[:index]), "retention_paths_overlap")
    check_external_custody(input, sources)
    guest = Path(layout["guestRoot"]).resolve(strict=True)
    require(guest.is_relative_to(root) and guest != root, "guest_root_invalid")
    require((guest / "var/lib/openkit").resolve(strict=True) in sources,
            "complete_host_root_not_retained")
    require((guest / "etc/openkit").resolve(strict=True) in sources,
            "host_configuration_not_retained")
    require(layout["payloads"], "payload_bindings_missing")
    installed = set()
    for payload in layout["payloads"]:
        require(set(payload) == {"installed", "previous", "candidate", "previousSha256", "candidateSha256"},
                "payload_fields_invalid")
        target = Path(payload["installed"])
        require(not target.is_symlink() and target.resolve(strict=True).is_relative_to(guest),
                "payload_binding_outside_guest")
        require(str(target.resolve()) not in installed, "payload_binding_duplicated")
        installed.add(str(target.resolve()))
        for revision in ("previous", "candidate"):
            source = Path(payload[revision]).resolve(strict=True)
            require(source.is_relative_to(root) and DIGEST.fullmatch(payload[revision + "Sha256"])
                    and digest(source) == payload[revision + "Sha256"], "payload_source_mismatch")
        require(digest(target) == payload["previousSha256"], "installed_previous_payload_mismatch")
    host = next((p for p in layout["payloads"]
                 if Path(p["installed"]).resolve() == guest / "opt/published-nanohost"), None)
    require(host is not None, "prepared_host_binding_missing")
    for name in ("previous", "candidate"):
        pin = input[name]
        require(COMMIT.fullmatch(pin["commit"]) is not None, "source_pin_invalid")
        require(all(DIGEST.fullmatch(pin[key]) for key in ("appImage", "nanoHost", "workerImage", "workerPlatformImage")),
                "artifact_pin_invalid")
        require(pin["nanoHost"] == host[name + "Sha256"], "host_pin_mismatch")
        archive = Path(input[name + "WorkerArchive"])
        require(archive.is_absolute() and ".." not in archive.parts
                and (guest / str(archive).lstrip("/")).resolve(strict=True).is_relative_to(guest),
                "worker_archive_outside_prepared_guest")
    require(input["previous"]["commit"] != input["candidate"]["commit"], "source_pair_identical")
    tag = re.fullmatch(r"v?0\.1\.0-rc\.([0-9]+)", input["previous"]["tag"])
    require(tag and int(tag[1]) >= 9, "previous_reset_not_upgrade")
    input["origin"] = local_origin(input["origin"])
    require(input.get("liveDevOrigin") and input.get("liveDevAppContainer") == "openkit-app",
            "live_observation_boundary_required")
    input["liveDevOrigin"] = local_origin(input["liveDevOrigin"])
    require(input["origin"] != input["liveDevOrigin"], "live_fixture_origin_collision")
    require(Path(input["baseline"]).resolve().parent == output, "baseline_outside_retained_root")
    require(Path(input["checkout"]).is_absolute(), "checkout_path_invalid")
    require(os.environ.get("OPENKIT_UPGRADE_ADMIN_TOKEN") and os.environ.get("OPENKIT_UPGRADE_LOGIN_PASSWORD"),
            "synthetic_fixture_credentials_missing")
    require(input["login"]["userId"] == input["userId"], "synthetic_login_identity_mismatch")
    return sources


class Upgrade:
    """Run one prepared same-state upgrade through the existing corpus phases."""

    def __init__(self, input, boundary, sources):
        """Keep private input in memory and expose only safe result fields."""
        self.input = input
        self.layout = input["preparedLayout"]
        self.boundary = boundary
        self.output = Path(input["retainedRoot"])
        self.result = {"passed": False, "effect": "not_started", "steps": []}
        self.owned = False
        self.stopped = False
        self.app_id = None
        self.stop_in_progress = False
        self.images = {}
        self.image_defaults = {}
        self.sources = sources

    def note(self, stage):
        """Persist only fixed stage names and safe statuses."""
        self.result["steps"].append(stage)
        path = self.output / "report.json"
        with path.open("w") as stream:
            json.dump(self.result, stream, indent=2)
            stream.write("\n")

    def machine(self, *args):
        """Bound commands to the one already running disposable guest."""
        return self.boundary.run(["systemctl", "-M", GUEST, *args])

    def inspect_app(self):
        """Keep the inspected owned container identity stable across operations."""
        info = self.boundary.docker("/containers/" + APP + "/json")
        if self.app_id:
            require(info["Id"] == self.app_id, "owned_container_replaced_externally")
        return info

    def prerequisites(self):
        """Prove namespaces, exact image source, private mounts and Host bytes."""
        b = self.boundary
        carrier = b.docker("/containers/" + CARRIER + "/json")
        require(carrier["State"]["Running"] and carrier["State"]["Pid"] > 0,
                "prepared_carrier_not_running")
        self.carrier_pid = carrier["State"]["Pid"]
        leader = int(b.run(["machinectl", "show", GUEST, "-p", "Leader", "--value"]))
        self.leader = leader
        require(leader > 0 and b.process_root(leader) == Path(self.layout["guestRoot"]).resolve(),
                "prepared_guest_root_mismatch")
        require(b.namespace(leader) == b.namespace(self.carrier_pid)
                and b.namespace(leader) != b.namespace(1), "fixture_network_not_isolated")
        require(b.namespace(os.getpid()) == b.namespace(1), "driver_not_in_host_network_namespace")
        for payload in self.layout["payloads"]:
            relative = Path(payload["installed"]).resolve().relative_to(Path(self.layout["guestRoot"]).resolve())
            require(b.guest_digest(leader, "/" + str(relative)) == payload["previousSha256"],
                    "running_guest_payload_mismatch")
        require(self.machine("show", SERVICE, "-p", "ActiveState", "--value") == "active",
                "prepared_host_not_running")
        require("/opt/published-nanohost" in self.machine("show", SERVICE, "-p", "ExecStart", "--value"),
                "prepared_service_payload_mismatch")
        local_images = b.docker("/images/json?digests=1")
        for name in ("previous", "candidate"):
            pin = self.input[name]
            for key in ("appImage", "workerImage"):
                matches = {entry["Id"] for entry in local_images if entry["Id"] == pin[key] or any(
                    ref.endswith("@" + pin[key]) for ref in (entry.get("RepoDigests") or []))}
                require(len(matches) == 1, "loaded_image_identity_ambiguous_or_missing")
                image = b.docker("/images/" + next(iter(matches)) + "/json")
                require(DIGEST.fullmatch(image["Id"]) and (image["Id"] == pin[key] or any(
                    ref.endswith("@" + pin[key]) for ref in (image.get("RepoDigests") or [])))
                    and image["Config"]["Labels"].get(
                    "org.opencontainers.image.revision") == pin["commit"], "image_source_mismatch")
                self.images[(name, key)] = image["Id"]
                if key == "appImage":
                    self.image_defaults[name] = image["Config"]
                if name == "previous" and key == "appImage":
                    require(image["Config"]["Labels"].get("org.opencontainers.image.version")
                            == pin["tag"].removeprefix("v"), "previous_image_tag_mismatch")
        app = self.inspect_app()
        require(app["Name"] == "/" + APP and app["State"]["Running"]
                and app["Image"] == self.images[("previous", "appImage")], "prepared_app_mismatch")
        require(app["HostConfig"]["NetworkMode"] in ("container:" + CARRIER, "container:" + carrier["Id"]),
                "app_network_not_carrier")
        mounts = app["Mounts"]
        require(sum(m["Destination"] == "/data/openkit" and m["RW"] and Path(m["Source"]).resolve()
                    == Path(self.input["dataRoot"]).resolve() for m in mounts) == 1,
                "app_data_root_mismatch")
        root = Path(self.layout["privateRoot"]).resolve()
        require(all(m["Type"] == "bind" and Path(m["Source"]).resolve().is_relative_to(root)
                    for m in mounts), "app_mount_outside_fixture")
        require(not app["HostConfig"].get("Privileged") and not app["HostConfig"].get("Devices")
                and not app["HostConfig"].get("CapAdd") and not app["HostConfig"].get("PidMode")
                and not app["HostConfig"].get("AutoRemove")
                and app["HostConfig"].get("RestartPolicy", {}).get("Name", "no") in ("", "no"),
                "app_security_or_restart_policy_unexpected")
        for mount in mounts:
            source = Path(mount["Source"]).resolve(strict=True)
            require(any((p.is_dir() and source.is_relative_to(p)) or (p.is_file() and source == p)
                        for p in self.sources), "app_mount_not_retained")
        reserved = json.dumps({"name": ["^/" + APP + "-(reader|previous-retained)$"]})
        require(not b.docker("/containers/json?all=1&filters=" + urllib.parse.quote(reserved)),
                "reserved_fixture_container_already_exists")
        self.app_id = app["Id"]
        self.original = app
        preflight = self.operation("app-update.preflight")
        require(preflight["state"] == "idle" and all(v == 0 for v in preflight["counts"].values()),
                "prepared_fixture_not_idle")
        self.owned = True
        self.note("isolated_exact_pair_admitted")

    def stop(self):
        """Fence the entire Host failure group before stopping its App."""
        self.stop_in_progress = True
        self.machine("stop", SERVICE)
        require(self.machine("show", SERVICE, "-p", "MainPID", "--value") == "0"
                and self.machine("show", SERVICE, "-p", "Slice", "--value") == "openkit-nanohost.slice",
                "host_service_stop_unproved")
        raw = self.boundary.run([
            "systemd-run", "-M", GUEST, "--wait", "--pipe", "--collect",
            "/usr/bin/python3", "-c", CGROUP_PROOF,
        ])
        proof = json.loads(raw)
        require(proof.get("positiveKernelObservation") is True and proof.get("hostDomainEmpty") is True,
                "host_kernel_stop_unproved")
        self.note("host_kernel_domain_empty")
        app = self.inspect_app()
        if app["State"]["Running"]:
            self.boundary.docker("/containers/" + self.app_id + "/stop?t=60", method="POST")
        require(not self.inspect_app()["State"]["Running"], "app_stop_unproved")
        self.stopped = True
        self.stop_in_progress = False
        self.note("app_stopped")

    def import_worker(self, revision):
        """Use the exact stopped guest Host to import the prepared OCI archive."""
        require(self.stopped, "worker_import_requires_stop")
        path = Path(self.layout["guestRoot"]) / self.input[revision + "WorkerArchive"].lstrip("/")
        identity = worker_archive_identity(path)
        self.result[revision + "WorkerArchive"] = identity
        self.note(revision + "_worker_archive_verified")
        observed = self.boundary.run([
            "systemd-run", "-M", GUEST, "--wait", "--pipe", "--collect",
            "/opt/published-nanohost", "image", "import", self.input[revision + "WorkerArchive"],
            identity["sourceDescriptor"],
        ], timeout=660)
        require(observed == self.input[revision]["workerPlatformImage"], "worker_platform_image_mismatch")
        self.result[revision + "WorkerPlatformImage"] = observed
        self.note(revision + "_worker_image_imported")

    def inspect_previous_image(self, revision):
        """Require the previous image metadata to remain usable through the exact Host reader."""
        require(self.stopped, "image_metadata_read_requires_stop")
        output = self.boundary.run([
            "systemd-run", "-M", GUEST, "--wait", "--pipe", "--collect",
            "/opt/published-nanohost", "image", "list",
        ])
        expected = "digest=" + self.input["previous"]["workerPlatformImage"]
        rows = [line.split() for line in output.splitlines() if expected in line.split()]
        require(len(rows) == 1 and "status=usable" in rows[0], "previous_image_metadata_not_usable")
        self.note(revision + "_reader_previous_image_usable")

    def operation(self, name):
        """Read one authenticated public fixture operation."""
        status, body = self.boundary.http(self.input["origin"], "/api/app/operations/" + name,
                                          {}, os.environ["OPENKIT_UPGRADE_ADMIN_TOKEN"])
        require(status == 200, "fixture_operation_rejected")
        return body

    def start(self, revision):
        """Start the same state, then prove health, login, admin and exact readiness."""
        self.stopped = False
        self.boundary.docker("/containers/" + self.app_id + "/start", method="POST")
        deadline = time.monotonic() + 125
        while True:
            try:
                status, _ = self.boundary.http(self.input["origin"], "/api/health")
                if status == 200:
                    break
            except (OSError, ValueError):
                pass
            require(time.monotonic() < deadline and self.inspect_app()["State"]["Running"],
                    "fixture_health_deadline")
            time.sleep(1)
        status, login = self.boundary.http(self.input["origin"], "/api/auth/sign-in/email", {
            "email": self.input["login"]["email"], "password": os.environ["OPENKIT_UPGRADE_LOGIN_PASSWORD"],
        })
        require(status == 200 and login.get("user", {}).get("id") == self.input["userId"],
                "retained_login_failed")
        require(self.operation("diagnostics.app")["build"]["sourceCommit"]
                == self.input[revision]["commit"], "running_app_source_mismatch")
        self.machine("start", SERVICE)
        deadline = time.monotonic() + 125
        while True:
            target = self.operation("nanohost.runtime-target")
            if target.get("ready") and target.get("freshEmpty") and target.get("predecessorFenced") \
                    and target.get("connectionGeneration", 0) > 0:
                break
            require(time.monotonic() < deadline and self.machine(
                "show", SERVICE, "-p", "ActiveState", "--value") not in ("failed", "inactive"),
                "host_readiness_deadline")
            time.sleep(1)
        require(all(target.get(k) == self.input["expectedRuntime"][k]
                    for k in ("identityId", "deploymentId")), "runtime_binding_changed")
        preflight = self.operation("app-update.preflight")
        require(preflight["state"] == "idle" and all(v == 0 for v in preflight["counts"].values()),
                "fixture_not_idle")
        self.note(revision + "_same_state_ready")

    def phase(self, phase, revision):
        """Invoke the existing corpus ABI using the selected image's own readers."""
        online = phase in ("activate-before", "activate", "worker-before", "worker")
        require(self.stopped != online, "phase_stop_boundary_invalid")
        value = {key: val for key, val in self.input.items()
                 if key not in ("preparedLayout", "login", "liveDevOrigin", "liveDevAppContainer")}
        worker = phase in ("worker-before", "worker")
        if worker:
            value["requestId"] = str(uuid.uuid4())
            self.result.setdefault("workers", {})[phase] = {"requestId": value["requestId"]}
        host_only = phase in ("fixtures", "operator-read-before", "operator-read")
        if online or host_only:
            path = self.output / (phase + "-input.json")
            path.write_text(json.dumps(value))
            path.chmod(0o600)
            args = ["node",
                str(Path(self.input["checkout"]) / "scripts/upgrade-from-previous.mjs"), phase, str(path),
            ]
            env = {key: val for key, val in os.environ.items() if key not in (
                "OPENKIT_UPGRADE_ADMIN_TOKEN", "OPENKIT_UPGRADE_LOGIN_PASSWORD")}
            if online:
                args = ["nsenter", "--target", str(self.carrier_pid), "--net", "--", *args]
                env["OPENKIT_UPGRADE_ADMIN_TOKEN"] = os.environ["OPENKIT_UPGRADE_ADMIN_TOKEN"]
            if worker:
                self.note(phase + "_admission_attempt")
            try:
                output = self.boundary.run(args, env=env, timeout=660)
            except subprocess.CalledProcessError as error:
                if worker:
                    try:
                        self.worker_observation(phase, json.loads(error.stderr))
                    except (ValueError, TypeError):
                        pass
                raise
        else:
            value["appRoot"] = "/app/nanocore"
            path = self.output / "reader-input.json"
            path.write_text(json.dumps(value))
            path.chmod(0o600)
            binds = [self.layout["privateRoot"] + ":" + self.layout["privateRoot"],
                     self.input["checkout"] + ":" + self.input["checkout"] + ":ro"]
            if self.input.get("previousCheckout"):
                binds.append(self.input["previousCheckout"] + ":" + self.input["previousCheckout"] + ":ro")
            spec = {
                "Image": self.images[(revision, "appImage")], "Entrypoint": ["node"],
                "Cmd": [str(Path(self.input["checkout"]) / "scripts/upgrade-from-previous.mjs"), phase, str(path)],
                "WorkingDir": "/app/nanocore",
                "HostConfig": {"NetworkMode": "none", "Binds": binds},
            }
            created = self.boundary.docker("/containers/create?name=" + APP + "-reader", spec, "POST")
            reader_id = created["Id"]
            try:
                output = self.boundary.run(["docker", "start", "--attach", reader_id], timeout=660)
                reader = self.boundary.docker("/containers/" + reader_id + "/json")
                require(not reader["State"]["Running"] and reader["State"]["ExitCode"] == 0,
                        "corpus_reader_exit_failed")
            finally:
                reader = self.boundary.docker("/containers/" + reader_id + "/json")
                if reader["State"]["Running"]:
                    self.boundary.docker("/containers/" + reader_id + "/stop?t=20", method="POST")
                require(not self.boundary.docker("/containers/" + reader_id + "/json")["State"]["Running"],
                        "corpus_reader_cleanup_unproved")
                self.boundary.docker("/containers/" + reader_id, method="DELETE")
        observed = json.loads(output)
        require(observed.get("passed") is True, "corpus_phase_failed")
        if worker:
            self.worker_observation(phase, observed)
        if phase == "fixtures":
            selections = observed["externalSelections"]
            for family in ("App update helper settings and receipts", "Component update outcomes"):
                self.input["externalSelections"][family] = selections[family]
            check_external_custody(self.input, self.sources)
        self.note(phase + "_passed")

    def worker_observation(self, phase, observed):
        """Retain only bounded synthetic selectors for inspection after uncertainty."""
        target = self.result["workers"][phase]
        for key in ("workspaceId", "threadId", "turnId"):
            value = observed.get(key)
            if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
                target[key] = value
        if observed.get("outcome") in ("completed", "failed", "cancelled", "interrupted"):
            target["outcome"] = observed["outcome"]

    def retain(self, sources):
        """Copy complete stopped state before the first candidate mutation."""
        require(self.stopped, "retention_requires_stop")
        backup = self.output / "whole-state"
        backup.mkdir(mode=0o700)
        for index, source in enumerate(sources):
            target = backup / str(index)
            if source.is_dir():
                shutil.copytree(source, target, symlinks=True)
            else:
                shutil.copy2(source, target, follow_symlinks=False)
        # This private recovery map contains no inspection, Env, or decoded state.
        (backup / "recovery.json").write_text(json.dumps({"sources": [str(p) for p in sources]}))
        (backup / "recovery.json").chmod(0o600)
        self.note("complete_preupgrade_state_retained")

    def replace(self):
        """Replace App and explicit private payloads without moving retained roots."""
        require(self.stopped and "complete_preupgrade_state_retained" in self.result["steps"],
                "candidate_mutation_before_retention")
        # Keep the stopped previous container as the private recovery source for its original in-memory Engine configuration, including synthetic Env.
        self.boundary.docker("/containers/" + self.app_id + "/rename?name=" + APP + "-previous-retained",
                             method="POST")
        previous_defaults = self.image_defaults["previous"]
        # Preserve operator overrides and synthetic secrets. Let the candidate image supply its own baked defaults instead of copying old image code.
        config = {key: copy.deepcopy(value) for key, value in self.original["Config"].items()
                  if key not in ("Image", "Env", "Hostname", "Domainname")
                  and value != previous_defaults.get(key)}
        old_env = {entry.split("=", 1)[0]: entry for entry in previous_defaults.get("Env", [])}
        config["Env"] = [entry for entry in self.original["Config"].get("Env", [])
                         if entry != old_env.get(entry.split("=", 1)[0])]
        config["Image"] = self.images[("candidate", "appImage")]
        config["HostConfig"] = copy.deepcopy(self.original["HostConfig"])
        created = self.boundary.docker("/containers/create?name=" + APP, config, "POST")
        self.app_id = created["Id"]
        for payload in self.layout["payloads"]:
            shutil.copyfile(payload["candidate"], payload["installed"])
            require(digest(payload["installed"]) == payload["candidateSha256"], "candidate_payload_write_mismatch")
            relative = Path(payload["installed"]).resolve().relative_to(Path(self.layout["guestRoot"]).resolve())
            require(self.boundary.guest_digest(self.leader, "/" + str(relative)) == payload["candidateSha256"],
                    "candidate_guest_payload_mismatch")
        require(self.inspect_app()["Image"] == self.images[("candidate", "appImage")],
                "candidate_container_image_mismatch")
        self.note("candidate_payloads_replaced_same_roots")

    def live_observation(self):
        """Read public health and only the fixed live App and Host process identities."""
        origin = self.input["liveDevOrigin"]
        status, body = self.boundary.http(origin, "/api/health")
        require(status == 200, "live_readonly_health_failed")
        service = self.boundary.run([
            "systemctl", "show", SERVICE, "-p", "MainPID", "-p", "InvocationID",
            "-p", "NRestarts", "-p", "ActiveState",
        ])
        app = self.boundary.docker("/containers/openkit-app/json")
        identity = {"id": app["Id"], "image": app["Image"],
                    "startedAt": app["State"]["StartedAt"], "running": app["State"]["Running"]}
        require(identity["running"] is True and re.fullmatch(r"[a-f0-9]{64}", identity["id"])
                and DIGEST.fullmatch(identity["image"]) and isinstance(identity["startedAt"], str)
                and identity["startedAt"], "live_app_identity_unavailable")
        return hashlib.sha256(json.dumps({"status": status, "healthStatus": body.get("status"),
                                         "serviceName": body.get("service"),
                                         "service": service, "app": identity}, sort_keys=True).encode()).hexdigest()


def run_upgrade(input, boundary=None):
    """Execute once, fail closed, and retain a credential-safe result on failure."""
    if (Path(input["retainedRoot"]) / "report.json").exists():
        raise FileExistsError("upgrade_attempt_already_recorded")
    sources = validate(input)
    job = Upgrade(input, boundary or Boundary(), sources)
    job.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(job.output.stat().st_mode & 0o077 == 0, "retained_root_permissions_invalid")
    with (job.output / "report.json").open("x") as stream:
        json.dump(job.result, stream)
    before = None
    try:
        before = job.live_observation()
        job.prerequisites()
        job.result["effect"] = "unknown_until_inspected"
        job.stop()
        job.phase("fixtures", "previous")
        job.phase("seed", "previous")
        job.import_worker("previous")
        job.start("previous")
        job.phase("activate-before", "previous")
        job.phase("worker-before", "previous")
        job.stop()
        job.phase("operator-read-before", "previous")
        job.inspect_previous_image("previous")
        job.phase("snapshot", "previous")
        job.retain(sources)
        job.replace()
        job.import_worker("candidate")
        job.inspect_previous_image("candidate")
        job.start("candidate")
        job.stop()
        job.phase("operator-read", "candidate")
        job.phase("compare", "candidate")
        job.start("candidate")
        job.phase("activate", "candidate")
        job.phase("worker", "candidate")
        job.stop()
        job.result.update(passed=True, effect="owned_fixture_stopped")
    except Exception:
        # Never retry a failed stop proof or a Worker mutation. Cleanup applies only when a later stage failed with known running state.
        if job.owned and not job.stopped and not job.stop_in_progress:
            try:
                job.stop()
                job.note("failure_cleanup_stopped")
            except Exception:
                job.note("failure_cleanup_needs_inspection")
        job.result["effect"] = "unknown_until_inspected"
        job.note("upgrade_failed_no_replay")
    if before is not None:
        try:
            after = job.live_observation()
            job.result["liveDevObservation"] = {"beforeSha256": before, "afterSha256": after,
                                                 "unchanged": after == before}
            require(after == before, "live_readonly_observation_changed")
            job.note("live_readonly_observation_unchanged")
        except Exception:
            job.result.update(passed=False, effect="unknown_until_inspected")
            job.note("live_readonly_observation_failed")
    if job.result["passed"]:
        job.note("upgrade_passed")
    return job.result


def main(argv):
    """Accept one private input path and print no private exception details."""
    try:
        require(len(argv) == 2 and argv[0] == "run", "usage_invalid")
        path = Path(argv[1])
        require(path.stat().st_mode & 0o077 == 0, "private_input_permissions_invalid")
        value = json.loads(path.read_text())
        require("token" not in value and "password" not in value, "credentials_must_enter_environment")
        result = run_upgrade(value)
        print(json.dumps(result))
        return 0 if result["passed"] else 1
    except Exception:
        print(json.dumps({"passed": False, "code": "upgrade_fixture_admission_failed"}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
