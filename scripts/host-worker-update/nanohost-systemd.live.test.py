"""Exercise maintenance against rootless private PID1, D-Bus and real cgroup v2.

Only a fresh delegated child cgroup and private filesystem roots are writable. Runtime files are read-only. This fixture proves the mechanical maintenance posture, not a published release, Worker readiness, kernel reboot or power-loss durability. Target publication below uses synthetic fixture bytes; the unchanged release installer is a separate qualification surface.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


UNIT = "openkit-nanohost.service"
UNIT_PATH = Path("/etc/systemd/system") / UNIT
IDENTIFIER = "41830d22-d653-4838-ae3b-0ad78819b2fe"
GUARD = Path(str(UNIT_PATH) + ".d/zz-openkit-replacement-" + IDENTIFIER + ".conf")
ATTEMPT = GUARD.parent / (".openkit-replacement-" + IDENTIFIER + ".attempted")
PERMIT = Path("/run/openkit-replacement-" + IDENTIFIER + "/permit")
DESTINATIONS = {"nanohost": Path("/usr/lib/openkit/nanohost"),
                "gateway": Path("/usr/lib/openkit/openshell-gateway"), "unit": UNIT_PATH}
TRACE = Path("/var/lib/openkit-fixture/starts")
ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}
CASES = ("finalize", "second-activation", "failed-start", "unknown-finalize")


class FixtureFailure(Exception):
    """Carry one fixed local failure code without manager or OS output."""


def need(value, code):
    """Reject an unmet prior observation without echoing private child diagnostics."""
    if not value:
        raise FixtureFailure(code)


def write(path, data, mode=0o644):
    """Write only a fixture-owned setup path with explicit metadata."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    path.chmod(mode)


def command(argv, timeout=15):
    """Bound a fixed fixture command; its output is never a public diagnostic."""
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=ENV, start_new_session=True)
    try:
        stdout, stderr = child.communicate(timeout=timeout)
        return subprocess.CompletedProcess(argv, child.returncode, stdout, stderr)
    except BaseException:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.communicate(timeout=5)
        raise


def wait_for(predicate, code, seconds=15):
    """Poll only read observations and fail when the finite startup window ends."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    raise FixtureFailure(code)


def load_maintenance():
    """Import the actual adjacent production module, without replacing its commands."""
    spec = importlib.util.spec_from_file_location("live_maintenance", Path(__file__).with_name("nanohost-maintenance.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def state(unit=UNIT):
    """Read independent actual process and activation facts from the private manager."""
    result = command(["/usr/bin/systemctl", "show", "--no-pager", "--property=MainPID,ActiveState,SubState,Restart", unit])
    need(result.returncode == 0, "service_query_failed")
    return dict(line.split("=", 1) for line in result.stdout.decode("ascii").splitlines())


def inactive(unit=UNIT):
    """The deciding inhibition oracle requires both no main process and inactivity."""
    facts = state(unit)
    need(facts["MainPID"] == "0" and facts["ActiveState"] in ("inactive", "failed"), "activation_not_inhibited")


def domain_empty():
    """Independently inspect the actual entire v2 domain, including sibling scopes."""
    root = Path("/sys/fs/cgroup/openkit.slice/openkit-nanohost.slice")
    Path("/sys/fs/cgroup/cgroup.controllers").read_bytes()
    if not root.exists():
        return True
    for group in [root, *descendants(root)]:
        if "populated 0\n" not in (group / "cgroup.events").read_text() or (group / "cgroup.procs").read_text().strip():
            return False
    return True


def run_is_tmpfs():
    """Read the real kernel mount table rather than inferring volatility from a path."""
    mounts = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        before, separator, after = line.partition(" - ")
        if separator and before.split()[4] == "/run":
            mounts.append(after.split()[0])
    return mounts == ["tmpfs"]


def starts():
    """Count actual synthetic executions independently of manager command exit codes."""
    return TRACE.read_bytes().splitlines() if TRACE.exists() else []


def publish(keys, plan):
    """Populate only absent private fixture destinations; this is not installer proof."""
    for key in keys:
        path = DESTINATIONS[key]
        data = Path("/fixture/target-" + key).read_bytes()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o644 if key == "unit" else 0o755)
        try:
            os.fchmod(fd, 0o644 if key == "unit" else 0o755)
            need(os.write(fd, data) == len(data), "fixture_publication_short")
            os.fsync(fd)
        finally:
            os.close(fd)
        need(hashlib.sha256(path.read_bytes()).hexdigest() == plan["target"][key], "fixture_target_hash_mismatch")


def oracle_self_check():
    """Observe success, deliberate failure and timeout against a live stand-in unit."""
    unit = "openkit-fixture-oracle.service"
    need(command(["/usr/bin/systemctl", "start", unit]).returncode == 0, "oracle_standin_start_failed")
    failed = False
    try:
        inactive(unit)
    except FixtureFailure:
        failed = True
    need(failed, "oracle_did_not_reject_active_standin")
    timed_out = False
    try:
        wait_for(lambda: state(unit)["ActiveState"] == "inactive", "oracle_timeout", seconds=0.2)
    except FixtureFailure as error:
        timed_out = str(error) == "oracle_timeout"
    need(timed_out and state(unit)["ActiveState"] == "active", "oracle_timeout_not_observed")
    need(command(["/usr/bin/systemctl", "stop", unit]).returncode == 0, "oracle_standin_stop_failed")
    inactive(unit)


def inside(phase, case):
    """Run the production recipe in the actual private namespaces and fixed real root."""
    plan = json.loads(Path("/fixture/plan.json").read_text())
    need(hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == plan["instrumentSha256"], "fixture_source_changed_during_run")
    need(run_is_tmpfs(), "private_run_not_tmpfs")
    module = load_maintenance()
    manager = module.Maintenance(IDENTIFIER)
    if phase == "prepare":
        oracle_self_check()
        wait_for(lambda: state()["ActiveState"] == "active" and len(starts()) == 1, "predecessor_not_active")
        sibling = subprocess.Popen(["/usr/bin/systemd-run", "--scope", "--unit=openkit-fixture-sibling",
                                    "--slice=openkit-nanohost.slice", "/usr/bin/sleep", "infinity"],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            wait_for(lambda: state("openkit-fixture-sibling.scope")["ActiveState"] == "active", "sibling_not_active")
            try:
                manager.begin(plan["old"]["unit"])
            except module.MaintenanceRefusal:
                raise FixtureFailure("production_begin_refused") from None
            wait_for(lambda: sibling.poll() is not None, "sibling_survived_stop")
            need(domain_empty(), "predecessor_domain_not_empty")
            manager.assert_fenced_and_inhibited()
            need(GUARD.exists() and not PERMIT.exists(), "persistent_guard_missing")
            retained_before_vacancy = []

            class CustodyFence(module.Maintenance):
                """Keep actual fencing while independently observing the first retained hard link."""

                def assert_fenced_and_inhibited(self):
                    """Observe source and retained inode before any live destination is absent."""
                    super().assert_fenced_and_inhibited()
                    recovered = DESTINATIONS["nanohost"].parent / (".openkit-nanohost-replacement-" + IDENTIFIER) / "nanohost"
                    if all(path.exists() for path in DESTINATIONS.values()) and recovered.exists():
                        source = DESTINATIONS["nanohost"].stat()
                        copy = recovered.stat()
                        retained_before_vacancy.append((source.st_dev, source.st_ino) == (copy.st_dev, copy.st_ino))

            module._replacement.vacate_verified_payloads(
                {"replacementId": IDENTIFIER, "old": plan["old"], "target": plan["target"]}, CustodyFence(IDENTIFIER))
            need(retained_before_vacancy and all(retained_before_vacancy), "first_vacancy_without_retained_link")
            for key, path in DESTINATIONS.items():
                retained = path.parent / (".openkit-nanohost-replacement-" + IDENTIFIER) / path.name
                need(hashlib.sha256(retained.read_bytes()).hexdigest() == plan["old"][key], "old_custody_not_exact")
            publish(("nanohost", "unit"), plan)
            need(command(["/usr/bin/systemctl", "daemon-reload"]).returncode == 0, "partial_reload_failed")
            command(["/usr/bin/systemctl", "start", UNIT])
            inactive()
            need(domain_empty() and len(starts()) == 1 and not DESTINATIONS["gateway"].exists(), "partial_set_executed")
            need(command(["/usr/bin/systemctl", "daemon-reexec"]).returncode == 0, "private_reexec_failed")
        finally:
            if sibling.poll() is None:
                sibling.kill()
            sibling.wait(timeout=10)
        return {"prepared": True, "wholeSliceStopped": True, "retainedBeforeFirstVacancy": True,
                "partialActivationBlocked": True, "oracleSuccessFailureTimeout": True}

    inactive()
    need(domain_empty(), "domain_not_empty_after_restart")
    manager.assert_fenced_and_inhibited()
    need(len(starts()) == 1 and not PERMIT.exists(), "restart_activated_partial_set")
    command(["/usr/bin/systemctl", "start", UNIT])
    inactive()
    need(len(starts()) == 1, "reexec_activated_partial_set")
    if phase == "after-reexec":
        write(Path("/run/openkit-fixture-before-restart"), b"volatile fixture marker\n")
        return {"partialActivationBlockedAfterReexec": True}
    need(not Path("/run/openkit-fixture-before-restart").exists(), "volatile_marker_survived_restart")
    publish(("gateway",), plan)
    if case == "failed-start":
        refused = False
        try:
            manager.start_once(plan["target"])
        except module.MaintenanceRefusal:
            refused = True
        need(refused and GUARD.is_file() and ATTEMPT.is_file() and not PERMIT.exists(), "failed_start_lost_custody")
        need(len(starts()) == 1, "failed_start_executed_program")
        return {"knownFailedStartRetainedCustody": True, "runTmpfsVerified": True, "volatileMarkerCleared": True}
    stamp = manager.start_once(plan["target"])
    wait_for(lambda: len(starts()) == 2, "controlled_execution_not_observed")
    need(not PERMIT.exists() and GUARD.is_file() and ATTEMPT.is_file(), "controlled_start_did_not_consume_permit")
    if case == "second-activation":
        need(command(["/usr/bin/systemctl", "stop", UNIT]).returncode == 0, "controlled_stop_failed")
        command(["/usr/bin/systemctl", "start", UNIT])
        inactive()
        need(domain_empty() and len(starts()) == 2, "second_activation_executed")
        return {"permitConsumed": True, "secondActivationBlocked": True, "runTmpfsVerified": True, "volatileMarkerCleared": True}
    if case == "unknown-finalize":
        def lost_reply(argv):
            """Execute the real manager command, then discard only its final reload reply."""
            result = module.bounded_default(argv)
            if "daemon-reload" in argv and not GUARD.exists():
                raise TimeoutError("fixture_lost_reply")
            return result
        refused = False
        try:
            module.Maintenance(IDENTIFIER, run_command=lost_reply).finalize(stamp, plan["target"])
        except module.MaintenanceRefusal:
            refused = True
        need(refused and ATTEMPT.is_file() and manager._incarnation(False) == stamp, "unknown_finalization_invented_result")
        return {"permitConsumed": True, "lostActualReloadReplyRefused": True, "runTmpfsVerified": True, "volatileMarkerCleared": True}
    manager.finalize(stamp, plan["target"])
    need(manager._incarnation(False) == stamp and state()["Restart"] == "always", "finalization_changed_process")
    need(not GUARD.exists() and ATTEMPT.exists() and len(starts()) == 2, "finalization_restarted_or_lost_custody")
    return {"permitConsumed": True, "supervisionRestoredForSameProcess": True, "runTmpfsVerified": True, "volatileMarkerCleared": True}


def descendants(group):
    """List only actual directories below the one operation-owned cgroup."""
    result = []
    for path in group.iterdir():
        if path.is_dir() and not path.is_symlink():
            result.extend(descendants(path))
            result.append(path)
    return result


class PrivateManager:
    """Own one ephemeral root and delegated cgroup; no host manager is contacted."""

    def __init__(self, root):
        """Select private resources before any setup effect can fail."""
        self.root = root
        self.child = None
        self.pid = None
        self.entry_checked = False
        memberships = [line[3:] for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::")]
        need(len(memberships) == 1 and ".." not in Path(memberships[0]).parts, "delegated_parent_unavailable")
        self.group = Path("/sys/fs/cgroup") / memberships[0].lstrip("/") / ("openkit-p29-live-" + uuid.uuid4().hex)
        self.identity = None
        self.failure_facts = {}

    def prepare(self, case):
        """Prepare only private fixture bytes and the unique delegated child cgroup."""
        root = self.root
        self.group.mkdir()
        self.identity = self.group.stat()
        for name in ("etc", "var", "usr/lib/systemd/system", "usr/lib/openkit", "usr/local/lib/systemd/system", "fixture"):
            (root / name).mkdir(parents=True, exist_ok=True)
        for path in Path("/usr/lib").iterdir():
            if path.name not in ("systemd", "openkit"):
                (root / "usr/lib" / path.name).symlink_to("/runtime/usr/lib/" + path.name)
        for path in Path("/usr/lib/systemd").iterdir():
            if path.name != "system":
                (root / "usr/lib/systemd" / path.name).symlink_to("/runtime/usr/lib/systemd/" + path.name)
        for name in ("bin", "sbin", "share"):
            (root / "usr" / name).symlink_to("/runtime/usr/" + name)
        for name, data in {"passwd": "root:x:0:0:root:/root:/bin/sh\n", "group": "root:x:0:\n",
                           "nsswitch.conf": "passwd: files\ngroup: files\n", "machine-id": uuid.uuid4().hex + "\n",
                           "os-release": "NAME=OpenKit-Fixture\nID=openkit-fixture\n"}.items():
            write(root / "etc" / name, data.encode())
        write(root / "etc/dbus-1/system.conf", b'<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">\n<busconfig><type>system</type><listen>unix:path=/run/dbus/system_bus_socket</listen><policy context="default"><allow user="root"/><allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>\n')
        units = {"openkit-fixture.target": "[Unit]\nDefaultDependencies=no\nWants=basic.target dbus.service openkit-nanohost.service\n",
                 "dbus.socket": "[Unit]\nDefaultDependencies=no\n[Socket]\nListenStream=/run/dbus/system_bus_socket\n",
                 "dbus.service": "[Unit]\nDefaultDependencies=no\nRequires=dbus.socket\nAfter=dbus.socket\nBefore=basic.target\n[Service]\nType=notify\nSockets=dbus.socket\nRuntimeDirectory=dbus\nStandardError=append:/fixture/dbus.log\nExecStart=/usr/bin/dbus-daemon --nofork --nopidfile --nosyslog --systemd-activation --address=systemd: --config-file=/etc/dbus-1/system.conf\n",
                 "openkit-fixture-oracle.service": "[Unit]\nDefaultDependencies=no\n[Service]\nExecStart=/usr/bin/sleep infinity\n",
                 "openkit.slice": "[Unit]\nDefaultDependencies=no\n",
                 "openkit-nanohost.slice": "[Unit]\nDefaultDependencies=no\n",
                 "system.slice": "[Unit]\nDefaultDependencies=no\n", "basic.target": "[Unit]\nDefaultDependencies=no\n",
                 "sysinit.target": "[Unit]\nDefaultDependencies=no\n"}
        for name, data in units.items():
            write(root / "etc/systemd/system" / name, data.encode())
        source_root = Path(__file__).resolve().parents[2]
        old_unit = (source_root / "apps/nanohost/deploy/openkit-nanohost.service").read_bytes()
        program = b'#!/usr/bin/python3\nfrom pathlib import Path\nimport time\np=Path("/var/lib/openkit-fixture/starts")\np.parent.mkdir(parents=True,exist_ok=True)\nwith p.open("ab") as f: f.write(b"started\\n"); f.flush()\nwhile True: time.sleep(1)\n'
        old = {"nanohost": program + b"# old fixture\n", "gateway": b"#!/usr/bin/true\n# old gateway\n", "unit": old_unit}
        target = {"nanohost": program + b"# target fixture\n", "gateway": b"#!/usr/bin/true\n# target gateway\n",
                  "unit": old_unit + b"\nEnvironment=OPENKIT_FIXTURE_TARGET=1\n" + (b"ExecStartPre=/usr/bin/false\n" if case == "failed-start" else b"")}
        for key, path in DESTINATIONS.items():
            write(root / str(path).lstrip("/"), old[key], 0o644 if key == "unit" else 0o755)
            write(root / "fixture" / ("target-" + key), target[key])
        plan = {kind: {key: hashlib.sha256(value).hexdigest() for key, value in payloads.items()}
                for kind, payloads in (("old", old), ("target", target))}
        plan["instrumentSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        write(root / "fixture/plan.json", json.dumps(plan).encode())
        write(root / "etc/openkit/nanohost.env", b"OPENKIT_FIXTURE=1\n", 0o600)
        self.unrelated = root / "etc/systemd/system/openkit-fixture-unrelated.service.d/operator.conf"
        write(self.unrelated, b"[Service]\nEnvironment=KEEP_FIXTURE_BYTES=1\n")
        self.unrelated_before = (self.unrelated.stat().st_ino, self.unrelated.read_bytes())

    def start(self):
        """Start PID1 with a fresh tmpfs /run and the exact owned cgroup namespace root."""
        bootstrap = "import os;f=open('/sys/fs/cgroup/cgroup.procs','w');f.write('0');f.close();os.execv('/usr/bin/unshare',['unshare','--cgroup','/usr/lib/systemd/systemd','--system','--unit=openkit-fixture.target','--log-target=console','--log-level=warning'])"
        argv = ["/usr/bin/bwrap", "--unshare-user", "--cap-add", "CAP_SYS_ADMIN", "--uid", "0", "--gid", "0",
                "--unshare-pid", "--as-pid-1", "--unshare-net", "--unshare-uts", "--hostname", "openkit-qualification",
                "--die-with-parent", "--new-session", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin",
                "--setenv", "container", "bwrap", "--ro-bind", "/usr", "/runtime/usr", "--bind", str(self.root / "usr"), "/usr",
                "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib", "/lib64",
                "--dir", "/root", "--bind", str(self.root / "etc"), "/etc", "--bind", str(self.root / "var"), "/var",
                "--bind", str(self.root / "fixture"), "/fixture", "--ro-bind", str(Path(__file__).parent), "/qualification",
                "--tmpfs", "/run", "--dev", "/dev", "--proc", "/proc", "--ro-bind", "/proc/sys", "/proc/sys",
                "--ro-bind", "/sys", "/sys", "--bind", str(self.group), "/sys/fs/cgroup", "--tmpfs", "/tmp",
                "--", "/usr/bin/python3", "-I", "-B", "-c", bootstrap]
        self.log = open(self.root / "manager.log", "ab")
        self.child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)

        def ready():
            """Find the actual private manager, then wait for its private system bus."""
            if self.child.poll() is not None:
                raise FixtureFailure("namespace_manager_exited")
            if self.pid is None:
                for group in [self.group, *descendants(self.group)]:
                    for value in (group / "cgroup.procs").read_text().splitlines():
                        try:
                            if Path("/proc", value, "comm").read_text().strip() == "systemd":
                                self.pid = int(value)
                        except FileNotFoundError:
                            pass
            if self.pid is None:
                return False
            if not self.entry_checked:
                probe = self.run(["/usr/bin/python3", "-I", "-B", "-c",
                                  "from pathlib import Path;Path('/fixture/entered').write_text('entered');print('entered')"], timeout=3)
                marker = self.root / "fixture/entered"
                self.failure_facts["namespaceCommandMarkerObserved"] = marker.exists() and marker.read_text() == "entered"
                self.failure_facts["namespaceCommandStdoutObserved"] = probe.stdout == b"entered\n"
                need(probe.returncode == 0 and self.failure_facts["namespaceCommandMarkerObserved"] and
                     self.failure_facts["namespaceCommandStdoutObserved"], "private_namespace_command_not_observed")
                self.entry_checked = True
            result = self.run(["/usr/bin/busctl", "--system", "--json=short", "get-property", "org.freedesktop.systemd1",
                               "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "UnitPath"], timeout=3)
            self.failure_facts["managerBusQueryStatus"] = result.returncode
            for name, marker in (("AccessDenied", b"denied"), ("ServiceUnknown", b"not provided"),
                                 ("NoOwner", b"owner"), ("ConnectionRefused", b"refused"),
                                 ("MissingFile", b"No such file"), ("Authentication", b"auth"),
                                 ("UnknownProperty", b"Unknown property"), ("Timeout", b"timed out")):
                self.failure_facts["managerBusQuery" + name] = marker in result.stderr
            return result.returncode == 0 and b'"as"' in result.stdout

        try:
            wait_for(ready, "private_bus_startup_timeout", seconds=20)
        except FixtureFailure:
            self.failure_facts["managerObserved"] = self.pid is not None
            if self.pid is not None:
                result = self.run(["/usr/bin/busctl", "--system", "--json=short", "call", "org.freedesktop.DBus",
                                   "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetId"], timeout=3)
                self.failure_facts["privateBusGetIdSucceeded"] = result.returncode == 0
                result = self.run(["/usr/bin/busctl", "--system", "--json=short", "call", "org.freedesktop.DBus",
                                   "/org/freedesktop/DBus", "org.freedesktop.DBus", "ListNames"], timeout=3)
                self.failure_facts["privateBusListNamesSucceeded"] = result.returncode == 0
                self.failure_facts["privateBusHasManagerName"] = result.returncode == 0 and b'"org.freedesktop.systemd1"' in result.stdout
                result = self.run(["/usr/bin/systemctl", "show", "--no-pager",
                                   "--property=ActiveState,SubState,Result,ExecMainStatus", "dbus.service"], timeout=3)
                self.failure_facts["privateServiceQuerySucceeded"] = result.returncode == 0
                for line in result.stdout.decode("ascii", errors="ignore").splitlines():
                    key, separator, value = line.partition("=")
                    if separator and key in ("ActiveState", "SubState", "Result", "ExecMainStatus") and value.isascii() and len(value) < 32:
                        self.failure_facts["dbus" + key] = value
                raw = (self.root / "manager.log").read_bytes()[:65536]
                for marker in (b"No such file or directory", b"Permission denied", b"Operation not permitted", b"Failed to start", b"Failed to mount"):
                    self.failure_facts["managerReported" + marker.decode().replace(" ", "")] = marker in raw
                dbus_log = self.root / "fixture/dbus.log"
                if dbus_log.exists():
                    raw = dbus_log.read_bytes()[:16384]
                    self.failure_facts["dbusDiagnosticBytes"] = len(raw)
                    for name, marker in (("MissingFile", b"No such file"), ("PermissionDenied", b"Permission denied"),
                                         ("OperationNotPermitted", b"Operation not permitted"), ("Groups", b"group"),
                                         ("Capabilities", b"capabil"), ("AppArmor", b"AppArmor"),
                                         ("UnknownUser", b"UID"), ("ConfigurationError", b"configuration"),
                                         ("InvalidElement", b"element"), ("Unsupported", b"not supported"),
                                         ("MissingDirectory", b"directory"), ("SecurityLabel", b"SELinux"),
                                         ("AuthError", b"auth"), ("FileExists", b"already")):
                        self.failure_facts["dbusReported" + name] = marker in raw
            raise

    def run(self, argv, timeout=90):
        """Enter only the observed private manager's namespaces and filesystem root."""
        current = self.group.stat()
        need((current.st_dev, current.st_ino) == (self.identity.st_dev, self.identity.st_ino), "owned_cgroup_substituted")
        return command(["/usr/bin/nsenter", "--target", str(self.pid), "--user", "--preserve-credentials",
                        "--mount", "--pid", "--net", "--uts", "--cgroup", "--root", "--wdns=/", "--", *argv], timeout=timeout)

    def phase(self, name, case):
        """Require a terminal structured observation from the actual namespaced recipe."""
        result = self.run(["/usr/bin/python3", "-I", "-B", "/qualification/" + Path(__file__).name, "--inside", name, case])
        need(len(result.stdout) <= 16384 and len(result.stderr) <= 4096, "private_phase_output_overflow")
        try:
            value = json.loads(result.stdout)
        except ValueError:
            raise FixtureFailure("private_phase_result_unavailable") from None
        self.failure_facts = value.get("facts", {})
        need(result.returncode == 0 and value.get("outcome") == "passed", value.get("cause", "private_phase_failed"))
        return value["facts"]

    def stop(self):
        """Kill only the proved owned cgroup and require every real descendant empty."""
        current = self.group.stat()
        need((current.st_dev, current.st_ino) == (self.identity.st_dev, self.identity.st_ino), "cleanup_cgroup_substituted")
        try:
            (self.group / "cgroup.kill").write_text("1")
        finally:
            if self.child is not None:
                if self.child.poll() is None:
                    os.killpg(self.child.pid, signal.SIGKILL)
                self.child.wait(timeout=10)
        wait_for(lambda: "populated 0\n" in (self.group / "cgroup.events").read_text(), "cleanup_group_populated", seconds=10)
        current = self.group.stat()
        need((current.st_dev, current.st_ino) == (self.identity.st_dev, self.identity.st_ino), "cleanup_cgroup_substituted")
        for group in descendants(self.group):
            group.rmdir()
        self.pid = None
        self.entry_checked = False
        if hasattr(self, "log") and not self.log.closed:
            self.log.close()


def outer():
    """Run each finite case, proving cleanup even after unavailable setup or a failed case."""
    for case in CASES:
        fixture = None
        root = Path(tempfile.mkdtemp(prefix="openkit-systemd-live-"))
        facts = {}
        failure = None
        try:
            fixture = PrivateManager(root)
            fixture.prepare(case)
            fixture.start()
            facts.update(fixture.phase("prepare", case))
            wait_for(lambda: fixture.run(["/usr/bin/systemctl", "is-active", "--quiet", "dbus.service"], timeout=3).returncode == 0,
                     "reexec_bus_unavailable")
            facts.update(fixture.phase("after-reexec", case))
            fixture.stop()
            # A fresh owned leaf avoids reusing a domain with enabled child controllers.
            fixture.group.rmdir()
            fixture.group = fixture.group.with_name("openkit-p29-live-" + uuid.uuid4().hex)
            fixture.identity = None
            fixture.group.mkdir()
            fixture.identity = fixture.group.stat()
            fixture.start()
            facts.update(fixture.phase("finish", case))
            need((fixture.unrelated.stat().st_ino, fixture.unrelated.read_bytes()) == fixture.unrelated_before,
                 "unrelated_override_changed")
            facts.update(unrelatedOverridePreserved=True)
        except Exception as error:
            failure = str(error) if isinstance(error, FixtureFailure) else "fixture_setup_or_execution_failed"
            if fixture is not None:
                facts.update(fixture.failure_facts)
        finally:
            group_removed = fixture is None
            if fixture is not None and fixture.identity is not None:
                try:
                    fixture.stop()
                    fixture.group.rmdir()
                    facts["ownedCgroupRemoved"] = not fixture.group.exists()
                    group_removed = facts["ownedCgroupRemoved"]
                except Exception:
                    failure = "private_failure_group_cleanup_failed"
            elif fixture is not None:
                group_removed = not fixture.group.exists()
            if group_removed:
                try:
                    shutil.rmtree(root)
                except OSError:
                    failure = "private_root_cleanup_failed"
            facts["privateRootsRemoved"] = not root.exists()
        print(json.dumps({"case": case, "outcome": "failed" if failure else "passed", "cause": failure, "facts": facts}), flush=True)
        if failure:
            return 1
    return 0


if __name__ == "__main__":
    def interrupted(_signal, _frame):
        """Allow outer cleanup to finish after the caller interrupts this fixture."""
        raise FixtureFailure("fixture_interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    if len(sys.argv) == 4 and sys.argv[1] == "--inside":
        try:
            print(json.dumps({"outcome": "passed", "facts": inside(sys.argv[2], sys.argv[3])}))
        except Exception as error:
            facts = {}
            try:
                observed = state()
                facts = {"mainPidAbsent": observed["MainPID"] == "0", "activeState": observed["ActiveState"],
                         "subState": observed["SubState"], "domainEmpty": domain_empty()}
                for name, signature in (("UnitPath", "as"), ("Job", "(uo)"), ("Conditions", "a(sbbsi)")):
                    manager = name == "UnitPath"
                    result = command(["/usr/bin/busctl", "--system", "--json=short", "get-property", "org.freedesktop.systemd1",
                                      "/org/freedesktop/systemd1" if manager else "/org/freedesktop/systemd1/unit/openkit_2dnanohost_2eservice",
                                      "org.freedesktop.systemd1.Manager" if manager else "org.freedesktop.systemd1.Unit", name])
                    if result.returncode == 0:
                        value = json.loads(result.stdout)
                        facts[name + "SignatureMatches"] = value.get("type") == signature
                        body = value.get("data")
                        if type(body) is list:
                            facts[name + "BodyLength"] = len(body)
                            facts[name + "FirstIsArray"] = bool(body) and type(body[0]) is list
                            if body and type(body[0]) is list:
                                facts[name + "ArrayLength"] = len(body[0])
            except Exception:
                pass
            print(json.dumps({"outcome": "failed", "cause": str(error) if isinstance(error, FixtureFailure) else "maintenance_recipe_refused", "facts": facts}))
            sys.exit(1)
    else:
        sys.exit(outer())
