#!/usr/bin/env python3
"""Opt-in host-mechanism fixture for the App-update helper.

Not a production helper install and not an A2 product update. One live test
proves systemd job lifetime after the caller exits, live lock concurrency, and
failed-candidate Docker/Web restore. Candidate images follow the current helper
commit path (fetch, ancestor, git archive, build-image.sh). Missing/expired IDs
stay in app-update-helper.test.py.

Enable with OPENKIT_APP_UPDATE_HELPER_LIVE=1 on Linux with git, docker,
systemd-run, and systemctl.
"""

from __future__ import annotations

import hashlib
import importlib.util
import inspect
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple


HELPER_PATH = Path(__file__).with_name("app-update-helper.py").resolve()
REPO_ROOT = HELPER_PATH.parents[2]
PROBE_ROOT = REPO_ROOT / "temp" / "live-tester" / "app-update-host-probe"
LIVE_ENV = "OPENKIT_APP_UPDATE_HELPER_LIVE"
PRODUCTION_CONFIG_PATH = "/etc/openkit/app-update/helper.json"
CURRENT_BOOT = "boot_11111111-1111-4111-8111-111111111111"
CANDIDATE_BOOT = "boot_22222222-2222-4222-8222-222222222222"
MIGRATION = "core_0000_setup"
BUILD_HOLD_SECONDS = 20
HTTP_READY_SECONDS = 30
APPLY_WAIT_SECONDS = 900
PORT_RANGE_START = 18791
LIVE_ENABLED = os.environ.get(LIVE_ENV) == "1"
FIXTURE_BOOT_SUBSYSTEM_NAMES = (
    "config",
    "storage",
    "policy",
    "vault",
    "scheduler",
    "llmGateway",
    "knowledgeIndex",
)


def fixture_current_image_ref(run_id: str) -> str:
    """Docker repository names are lowercase; run_id may keep mixed-case path identity."""

    return "%s:current" % run_id.lower()


def fixture_candidate_image_ref(source_commit: str) -> str:
    """Matches the helper commit-build tag, which is already a lowercase repository."""

    return "openkit/app:staging-%s" % source_commit


def fixture_image_repository(run_id: str) -> str:
    return "ok-upd-fx.invalid/%s" % run_id.lower()


def fixture_current_container_argv(
    *,
    container_name: str,
    data_root: str,
    nanohost: str,
    web_root: str,
    caddy: str,
    vault: str,
    identity: str,
    known_hosts: str,
    port: int,
    run_id: str,
    image: str,
) -> List[str]:
    """Current-container create argv. Always-on tests inspect this; live run executes it."""

    return [
        "docker", "run", "--detach", "--name", container_name,
        "--restart", "unless-stopped", "--network", "host", "--runtime", "runc",
        "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
        "--volume", "%s:/data/openkit" % data_root,
        "--volume", "%s:/run/nanohost-credentials" % nanohost,
        "--mount", "type=bind,src=%s,dst=/srv/web,readonly" % web_root,
        "--mount", "type=bind,src=%s,dst=/etc/caddy/Caddyfile,readonly" % caddy,
        "--mount", "type=bind,src=%s,dst=/run/secrets/openkit-vault.key,readonly" % vault,
        "--mount", "type=bind,src=%s,dst=%s,readonly" % (identity, APP_UPDATE_IDENTITY_DEST),
        "--mount", "type=bind,src=%s,dst=%s,readonly" % (known_hosts, APP_UPDATE_KNOWN_HOSTS_DEST),
        "--env", "OPENKIT_FIXTURE_PORT=%s" % port,
        "--label", "openkit.live-fixture=%s" % run_id,
        image,
    ]


def wait_fixture_auth_tokens(authorized_get, timeout: float = HTTP_READY_SECONDS) -> Dict[str, Any]:
    """Bounded helper GET /api/app/auth/tokens. New observation; not a historical race claim."""

    deadline = time.time() + timeout
    last_status = 0
    last_body: Any = None
    last_error: Optional[str] = "untried"
    while time.time() < deadline:
        last_error = None
        try:
            last_status, last_body = authorized_get("/api/app/auth/tokens")
        except Exception as error:
            last_status = 0
            last_body = None
            last_error = error.__class__.__name__
        if last_status == 200:
            return {"status": last_status, "body": last_body, "error": last_error}
        time.sleep(0.1)
    return {"status": last_status, "body": last_body, "error": last_error}


BUILD_IMAGE_SH = """#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"
tag="${2:?tag required}"
sleep %s
docker build -t "${tag}" .
"""

ENTRYPOINT_PY = r"""#!/usr/bin/env python3
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
if "openkit-app-smoke" in sys.argv:
    raise SystemExit(0)
fixture = json.loads(Path(os.environ.get("OPENKIT_FIXTURE_JSON", "/etc/openkit-fixture.json")).read_text(encoding="utf-8"))
port = int(os.environ["OPENKIT_FIXTURE_PORT"])
class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return
    def _send(self, status, payload=None):
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/diagnostics":
            self._send(200, {"migrations": {"applied": fixture["appliedMigrations"]}})
        elif path == "/api/app/diagnostics":
            self._send(200, {"boot": fixture["boot"]})
        elif path == "/api/app/auth/tokens":
            self._send(200, {"items": [fixture["token"]]})
        elif path == "/api/app/nanohost/runtime-target":
            self._send(404, {"protocolVersion": "0.5.0", "code": "nanohost_runtime_target_not_found", "message": "Configured NanoHost RuntimeTarget is unavailable."})
        elif path == "/api/app/workspaces":
            self._send(403)
        elif path.startswith("/api/app/app-update/") and path.split("/")[-1]:
            self._send(200, {"requestId": path.split("/")[-1]})
        else:
            self._send(404)
HTTPServer(("127.0.0.1", port), Handler).serve_forever()
"""

DOCKERFILE = """FROM python:3.12-alpine
COPY openkit-app-entrypoint /usr/local/bin/openkit-app-entrypoint
COPY fixture.json /etc/openkit-fixture.json
COPY web/ /srv/web/
RUN chmod +x /usr/local/bin/openkit-app-entrypoint
ENTRYPOINT ["/usr/local/bin/openkit-app-entrypoint"]
"""

FIXTURE_TOKEN = {
    "tokenId": "tok_live_fixture",
    "ownerUserId": "user_live_fixture",
    "scope": "server-admin",
    "workspaceIds": [],
    "status": "active",
    "issuedAt": "2026-09-10T00:00:00.000Z",
    "expiresAt": "2027-09-10T00:00:00.000Z",
    "revokedAt": None,
    "predecessorTokenId": None,
    "rotatedGraceExpiresAt": None,
    "lastUsedAt": None,
    "lastUsedChannel": None,
    "lastUsedSource": None,
}


def load_helper():
    spec = importlib.util.spec_from_file_location("app_update_helper_live", HELPER_PATH)
    if spec is None or spec.loader is None:
        raise FileNotFoundError(HELPER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_cmd(argv: List[str], cwd: Optional[Path] = None, check: bool = True) -> subprocess.CompletedProcess:
    completed = subprocess.run(argv, cwd=str(cwd) if cwd else None, capture_output=True, text=True, check=False)
    if check and completed.returncode != 0:
        raise RuntimeError("command failed (%s): %s\n%s" % (completed.returncode, " ".join(argv), completed.stderr.strip()))
    return completed


def stdout(argv: List[str], cwd: Optional[Path] = None, check: bool = True) -> str:
    return run_cmd(argv, cwd=cwd, check=check).stdout.strip()


def choose_free_port() -> int:
    for port in range(PORT_RANGE_START, PORT_RANGE_START + 100):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind(("127.0.0.1", port))
            return port
        except OSError:
            continue
        finally:
            sock.close()
    raise RuntimeError("No free 127.0.0.1 fixture port in %s+100." % PORT_RANGE_START)


def fixture_boot_projection(*, boot_id: str, product_ready: bool) -> Dict[str, Any]:
    """Closed /api/app/diagnostics boot object. Candidate fail is typed non-ready, not empty subsystems."""

    subsystems = {name: {"state": "ready", "reasons": []} for name in FIXTURE_BOOT_SUBSYSTEM_NAMES}
    if product_ready:
        return {
            "acceptingProductWork": True,
            "bootId": boot_id,
            "overall": "ready",
            "subsystems": subsystems,
        }
    subsystems["scheduler"] = {
        "state": "degraded",
        "reasons": [
            {
                "blocks": ["product_work"],
                "code": "fixture.candidate_not_ready",
                "message": "Fixture candidate is not ready for product work.",
            }
        ],
    }
    return {
        "acceptingProductWork": True,
        "bootId": boot_id,
        "overall": "degraded",
        "subsystems": subsystems,
    }


def write_source_tree(root: Path, *, accepting: bool, boot_id: str, web_body: str, hold_seconds: int) -> None:
    docker_dir = root / "scripts" / "docker"
    docker_dir.mkdir(parents=True, exist_ok=True)
    web = root / "web"
    web.mkdir(exist_ok=True)
    (web / "index.html").write_text(web_body, encoding="utf-8")
    (root / "openkit-app-entrypoint").write_text(ENTRYPOINT_PY, encoding="utf-8")
    (root / "Dockerfile").write_text(DOCKERFILE, encoding="utf-8")
    (root / "fixture.json").write_text(
        json.dumps(
            {
                "appliedMigrations": [MIGRATION],
                "boot": fixture_boot_projection(boot_id=boot_id, product_ready=accepting),
                "token": FIXTURE_TOKEN,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (docker_dir / "build-image.sh").write_text(BUILD_IMAGE_SH % hold_seconds, encoding="utf-8")
    os.chmod(docker_dir / "build-image.sh", 0o755)


def start_generated_fixture_app(tree: Path, port: int) -> subprocess.Popen:
    """Exec the written openkit-app-entrypoint bytes. py_compile cannot see JSON-null NameError."""

    entry = tree / "openkit-app-entrypoint"
    fixture = tree / "fixture.json"
    env = dict(os.environ)
    env["OPENKIT_FIXTURE_PORT"] = str(port)
    env["OPENKIT_FIXTURE_JSON"] = str(fixture)
    return subprocess.Popen(
        [sys.executable, str(entry)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )


def git_archive_tree(workdir: str, commit: str, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    tar_path = dest.parent / ("%s.tar" % dest.name)
    stdout(["git", "-C", workdir, "archive", "--format=tar", "-o", str(tar_path), commit])
    stdout(["tar", "-xf", str(tar_path), "-C", str(dest)])


def build_tiny_git_fixture(root: Path) -> Dict[str, str]:
    root.mkdir(parents=True, exist_ok=True)
    tree = root / "tree"
    tree.mkdir(exist_ok=True)
    stdout(["git", "init", "-b", "main"], cwd=tree)
    stdout(["git", "config", "user.email", "fixture@openkit.invalid"], cwd=tree)
    stdout(["git", "config", "user.name", "App Update Fixture"], cwd=tree)
    write_source_tree(tree, accepting=True, boot_id=CURRENT_BOOT, web_body="fixture-current-web\n", hold_seconds=0)
    stdout(["git", "add", "-A"], cwd=tree)
    stdout(["git", "commit", "-m", "fixture current app"], cwd=tree)
    current = stdout(["git", "rev-parse", "HEAD"], cwd=tree)
    write_source_tree(tree, accepting=False, boot_id=CANDIDATE_BOOT, web_body="fixture-candidate-web\n", hold_seconds=BUILD_HOLD_SECONDS)
    stdout(["git", "add", "-A"], cwd=tree)
    stdout(["git", "commit", "-m", "fixture failed candidate"], cwd=tree)
    candidate = stdout(["git", "rev-parse", "HEAD"], cwd=tree)
    bare = root / "source.git"
    stdout(["git", "clone", "--bare", str(tree), str(bare)])
    work = root / "source-work"
    stdout(["git", "clone", str(bare), str(work)])
    return {
        "bare": str(bare.resolve()),
        "candidate": candidate,
        "current": current,
        "repository": "file://%s" % bare.resolve(),
        "workdir": str(work.resolve()),
    }


NO_SUCH_OBJECT = re.compile(r"No such (?:object|container|image)\b", re.IGNORECASE)


def inspect_object(kind: str, reference: str) -> Tuple[Optional[str], str]:
    """Returns (id, 'present'|'absent'|'unknown'). Absent is only a known missing object."""

    if kind == "image":
        argv = ["docker", "image", "inspect", "--format", "{{.Id}}", reference]
    else:
        argv = ["docker", "inspect", "--format", "{{.Id}}", reference]
    completed = run_cmd(argv, check=False)
    value = completed.stdout.strip().splitlines()
    identity = value[0].strip() if value else ""
    detail = "%s\n%s" % (completed.stderr, completed.stdout)
    if completed.returncode == 0 and identity:
        return identity, "present"
    if NO_SUCH_OBJECT.search(detail):
        return None, "absent"
    return None, "unknown"


LIVE_UNIT_STATES = frozenset({"active", "activating", "deactivating"})
DEAD_UNIT_STATES = frozenset({"inactive", "failed"})
APP_UPDATE_IDENTITY_DEST = "/run/openkit/app-update/id_ed25519"
APP_UPDATE_KNOWN_HOSTS_DEST = "/run/openkit/app-update/known_hosts"


def docker_container_ids() -> Set[str]:
    completed = run_cmd(["docker", "ps", "-a", "--no-trunc", "--format", "{{.ID}}"], check=False)
    if completed.returncode != 0:
        raise RuntimeError("docker ps failed: %s" % completed.stderr.strip())
    return {line.strip() for line in completed.stdout.splitlines() if line.strip()}


def observe_run_root_mounts(root: Path) -> Tuple[List[Dict[str, str]], Optional[str]]:
    """Returns mounts of run_root, or an error when Docker list/inspect is unobservable."""

    prefix = str(root.resolve())
    listing = run_cmd(["docker", "ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.Names}}"], check=False)
    if listing.returncode != 0:
        return [], "docker ps failed: %s" % (listing.stderr.strip() or listing.stdout.strip() or "no output")
    mounted = []
    for line in listing.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if not parts:
            continue
        container_id = parts[0]
        name = parts[1] if len(parts) > 1 else ""
        inspected = run_cmd(["docker", "inspect", "--format", "{{json .Mounts}}", container_id], check=False)
        raw = inspected.stdout.strip()
        if inspected.returncode != 0 or not raw:
            return [], "docker inspect mounts failed for %s: %s" % (
                container_id,
                inspected.stderr.strip() or "empty inspect",
            )
        try:
            mounts = json.loads(raw)
        except json.JSONDecodeError:
            return [], "docker inspect mounts are not JSON for %s" % container_id
        if not isinstance(mounts, list):
            return [], "docker inspect mounts are not a list for %s" % container_id
        for item in mounts:
            if not isinstance(item, dict):
                return [], "docker inspect mount entry is not an object for %s" % container_id
            source = str(item.get("Source") or "")
            if source == prefix or source.startswith(prefix + os.sep):
                mounted.append(
                    {
                        "destination": str(item.get("Destination") or ""),
                        "id": container_id,
                        "name": name,
                        "source": source,
                    }
                )
    return mounted, None


def observe_unit(unit: str) -> Dict[str, Any]:
    """LoadState/ActiveState, or unobservable. unknown is not treated as stopped."""

    shown = run_cmd(
        ["systemctl", "show", unit, "-p", "LoadState", "-p", "ActiveState", "--no-pager"],
        check=False,
    )
    if shown.returncode != 0:
        return {"error": shown.stderr.strip() or "systemctl show failed", "live": None, "observable": False}
    props: Dict[str, str] = {}
    for line in shown.stdout.splitlines():
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        props[key.strip()] = value.strip()
    load = props.get("LoadState")
    active = props.get("ActiveState")
    if not load or not active:
        return {"error": "systemctl show omitted LoadState or ActiveState", "live": None, "observable": False}
    if load == "not-found":
        return {"active": active, "error": None, "live": False, "load": load, "observable": True}
    if active in LIVE_UNIT_STATES:
        return {"active": active, "error": None, "live": True, "load": load, "observable": True}
    if active in DEAD_UNIT_STATES:
        return {"active": active, "error": None, "live": False, "load": load, "observable": True}
    return {
        "active": active,
        "error": "unrecognized unit status LoadState=%s ActiveState=%s" % (load, active),
        "live": None,
        "load": load,
        "observable": False,
    }


def container_id_running() -> Dict[str, bool]:
    """Exact preexisting identity: container ID plus State.Running."""

    observed: Dict[str, bool] = {}
    for container_id in docker_container_ids():
        inspected = run_cmd(["docker", "inspect", "--format", "{{.State.Running}}", container_id], check=False)
        raw = inspected.stdout.strip()
        if inspected.returncode != 0 or raw not in {"true", "false"}:
            raise RuntimeError(
                "docker inspect Running unobservable for %s: %s"
                % (container_id, inspected.stderr.strip() or raw or "empty inspect")
            )
        observed[container_id] = raw == "true"
    return observed


def invoke_helper(config_path: Path, payload: Dict[str, Any]) -> Dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, str(HELPER_PATH), "--config", str(config_path)],
        input=json.dumps(payload) if payload else "",
        capture_output=True,
        text=True,
        check=False,
    )
    lines = completed.stdout.strip().splitlines()
    if not lines:
        raise RuntimeError("helper produced no stdout: %s" % completed.stderr)
    return json.loads(lines[-1])


class GitAcquireShapeTests(unittest.TestCase):
    """Always-on check that the fixture source matches the helper commit path."""

    def test_tiny_git_archive_contains_exact_commit_build_script(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="ok-upd-fx-git-") as tmp:
            source = build_tiny_git_fixture(Path(tmp))
            self.assertRegex(source["current"], r"^[0-9a-f]{40}$")
            self.assertRegex(source["candidate"], r"^[0-9a-f]{40}$")
            self.assertNotEqual(source["current"], source["candidate"])
            tree = Path(tmp) / "archive-tree"
            git_archive_tree(source["workdir"], source["candidate"], tree)
            build = tree / "scripts" / "docker" / "build-image.sh"
            self.assertTrue(build.is_file())
            self.assertIn("docker build -t", build.read_text(encoding="utf-8"))
            self.assertFalse((tree / "IDENTITY.json").exists())
            self.assertEqual(subprocess.run(["git", "-C", source["workdir"], "merge-base", "--is-ancestor", source["candidate"], "HEAD"]).returncode, 0)
            self.assertRegex(module.digest_tree(str(tree)), r"^sha256:[a-f0-9]{64}$")

    def test_emitted_build_image_sh_foreign_cwd_points_at_existing_dockerfile(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ok-upd-fx-buildcwd-") as tmp:
            root = Path(tmp) / "src"
            foreign = Path(tmp) / "foreign"
            fake_bin = Path(tmp) / "bin"
            capture = Path(tmp) / "capture.txt"
            root.mkdir()
            foreign.mkdir()
            fake_bin.mkdir()
            write_source_tree(
                root,
                accepting=False,
                boot_id=CANDIDATE_BOOT,
                web_body="fixture-candidate-web\n",
                hold_seconds=BUILD_HOLD_SECONDS,
            )
            dockerfile = (root / "Dockerfile").resolve()
            self.assertTrue(dockerfile.is_file())
            self.assertFalse((foreign / "Dockerfile").exists())
            build = root / "scripts" / "docker" / "build-image.sh"
            text = build.read_text(encoding="utf-8")
            self.assertIn('BASH_SOURCE[0]', text)
            self.assertIn("SCRIPT_DIR", text)
            self.assertIn("REPO_ROOT", text)
            (fake_bin / "sleep").write_text(
                '#!/usr/bin/env bash\nprintf \'sleep=%s\\n\' "$*" >>"${CAPTURE_FILE}"\n',
                encoding="utf-8",
            )
            (fake_bin / "docker").write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "{\n"
                '  printf \'pwd=%s\\n\' "$(pwd)"\n'
                '  printf \'args=%s\\n\' "$*"\n'
                '  printf \'dockerfile=%s\\n\' "$(pwd)/Dockerfile"\n'
                '} >>"${CAPTURE_FILE}"\n'
                'test -f "$(pwd)/Dockerfile"\n',
                encoding="utf-8",
            )
            os.chmod(fake_bin / "sleep", 0o755)
            os.chmod(fake_bin / "docker", 0o755)
            env = dict(os.environ)
            env["PATH"] = "%s%s%s" % (fake_bin, os.pathsep, env.get("PATH", ""))
            env["CAPTURE_FILE"] = str(capture)
            capture.write_text("", encoding="utf-8")
            completed = subprocess.run(
                ["bash", str(build), "app", "openkit/app:staging-foreign-cwd"],
                cwd=str(foreign),
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            recorded = capture.read_text(encoding="utf-8")
            self.assertIn("sleep=%s" % BUILD_HOLD_SECONDS, recorded)
            pwd_lines = [line for line in recorded.splitlines() if line.startswith("pwd=")]
            self.assertEqual(len(pwd_lines), 1, recorded)
            captured_pwd = Path(pwd_lines[0].split("=", 1)[1])
            self.assertTrue((captured_pwd / "Dockerfile").is_file())
            self.assertEqual(captured_pwd.resolve(), dockerfile.parent.resolve())
            self.assertNotEqual(captured_pwd.resolve(), foreign.resolve())
            self.assertIn("dockerfile=%s" % (captured_pwd / "Dockerfile"), recorded)
            self.assertIn("-t openkit/app:staging-foreign-cwd", recorded)


class FixtureDockerRefTests(unittest.TestCase):
    """Always-on check that generated Docker refs cannot repeat the uppercase run_id tag failure."""

    def test_generated_docker_refs_are_lowercase(self) -> None:
        run_id = "ok-upd-fx-20260910T072604Z-225540c0"
        commit = "b" * 40
        current = fixture_current_image_ref(run_id)
        candidate = fixture_candidate_image_ref(commit)
        repository = fixture_image_repository(run_id)
        self.assertEqual(current, "ok-upd-fx-20260910t072604z-225540c0:current")
        self.assertEqual(candidate, "openkit/app:staging-%s" % commit)
        self.assertEqual(repository, "ok-upd-fx.invalid/ok-upd-fx-20260910t072604z-225540c0")
        self.assertNotEqual(current, "%s:current" % run_id)
        for ref in (current, candidate, repository):
            self.assertEqual(ref, ref.lower())
            self.assertNotRegex(ref, r"[A-Z]")


class FixtureAdmissionTests(unittest.TestCase):
    """Always-on stand-ins for F1 create argv and F2 preserve-before-cleanup. No docker."""

    def test_live_docker_run_argv_includes_runtime_runc(self) -> None:
        argv = fixture_current_container_argv(
            container_name="ok-upd-fx-standin",
            data_root="/var/tmp/ok-upd-fx-standin/data",
            nanohost="/var/tmp/ok-upd-fx-standin/nanohost",
            web_root="/var/tmp/ok-upd-fx-standin/web",
            caddy="/var/tmp/ok-upd-fx-standin/app.Caddyfile",
            vault="/var/tmp/ok-upd-fx-standin/vault",
            identity="/var/tmp/ok-upd-fx-standin/id_ed25519",
            known_hosts="/var/tmp/ok-upd-fx-standin/known_hosts",
            port=18791,
            run_id="ok-upd-fx-standin",
            image="ok-upd-fx-standin:current",
        )
        self.assertIn("--runtime", argv)
        runtime_at = argv.index("--runtime")
        self.assertEqual(argv[runtime_at : runtime_at + 2], ["--runtime", "runc"])
        self.assertEqual(argv[0:3], ["docker", "run", "--detach"])

    def test_preserve_copies_receipts_and_journals_before_cleanup(self) -> None:
        source = inspect.getsource(AppUpdateHelperLiveTests.tearDown)
        preserve_at = source.find("_preserve_external_report")
        cleanup_at = source.find("_cleanup")
        self.assertNotEqual(preserve_at, -1)
        self.assertNotEqual(cleanup_at, -1)
        self.assertLess(preserve_at, cleanup_at)
        with tempfile.TemporaryDirectory(prefix="ok-upd-fx-adm-") as tmp:
            root = Path(tmp)
            run_root = root / "run"
            report_dir = root / "report"
            receipts = run_root / "receipts"
            receipts.mkdir(parents=True)
            report_dir.mkdir()
            (receipts / "standin-receipt.json").write_text("{}\n", encoding="utf-8")
            case = AppUpdateHelperLiveTests.__new__(AppUpdateHelperLiveTests)
            case.run_root = run_root
            case.report_dir = report_dir
            case.unit_names = {"openkit-app-update-standin.service"}
            case.evidence = {}
            case.container_ids = set()
            case.container_name = "ok-upd-fx-standin"
            case.image_ids = set()
            case.image_tags = set()
            case.original_container_id = None
            case.request_id = None
            for reason in ("first-job-not-live", "unexpected-second-job"):
                case._preserve_external_report({"reasonStandIn": reason}, reason)
                status_path = report_dir / "terminal-status.json"
                receipt_copy = report_dir / "receipts" / "standin-receipt.json"
                journals = list(report_dir.glob("journal-*.txt"))
                self.assertTrue(status_path.is_file(), "missing terminal-status.json for %s" % reason)
                self.assertTrue(receipt_copy.is_file(), "missing receipt copy for %s" % reason)
                self.assertTrue(journals, "missing journal-*.txt for %s" % reason)
                status = json.loads(status_path.read_text(encoding="utf-8"))
                self.assertEqual(status["reason"], reason)
                self.assertIn("journalctl_rc=", journals[0].read_text(encoding="utf-8"))

    def test_fixture_auth_tokens_wait_path_ready_200_and_bounded_non200(self) -> None:
        from http.server import BaseHTTPRequestHandler, HTTPServer

        live_src = inspect.getsource(
            AppUpdateHelperLiveTests.test_job_survives_caller_rejects_concurrency_and_restores_failed_candidate
        )
        self.assertIn("wait_fixture_auth_tokens", live_src)
        self.assertLess(live_src.find("wait_fixture_auth_tokens"), live_src.find('"op": "prepare"'))
        self.assertIn("_preserve_fixture_container_logs", live_src)

        module = load_helper()
        helper = object.__new__(module.AppUpdateHelper)
        helper.effects = module.CommandEffects()
        payload = json.loads(json.dumps({"items": [FIXTURE_TOKEN]}))
        self.assertEqual(helper._auth_store_identity(payload)[0]["tokenId"], FIXTURE_TOKEN["tokenId"])

        token_dir = Path(tempfile.mkdtemp(prefix="ok-fx-auth-"))
        token_path = token_dir / "token"
        token_path.write_text("token-not-a-raw-product-secret\n", encoding="utf-8")

        class Handler(BaseHTTPRequestHandler):
            status_code = 200

            def log_message(self, format, *args):
                return

            def do_GET(self):
                if self.path.split("?", 1)[0] != "/api/app/auth/tokens":
                    self.send_response(404)
                    self.end_headers()
                    return
                if Handler.status_code != 200:
                    self.send_response(Handler.status_code)
                    self.end_headers()
                    return
                body = json.dumps(payload).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        closed = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        closed.bind(("127.0.0.1", 0))
        closed_port = closed.getsockname()[1]
        closed.close()
        helper.config = {"appBaseUrl": "http://127.0.0.1:%s" % closed_port, "adminTokenFile": str(token_path)}
        closed_wait = wait_fixture_auth_tokens(helper._authorized_get, timeout=0.4)
        self.assertEqual(closed_wait["status"], 0)
        self.assertIsNone(closed_wait["body"])

        tree = Path(tempfile.mkdtemp(prefix="ok-fx-entry-"))
        proc = None
        try:
            write_source_tree(
                tree,
                accepting=True,
                boot_id=CURRENT_BOOT,
                web_body="fixture-current-web\n",
                hold_seconds=0,
            )
            written = (tree / "openkit-app-entrypoint").read_text(encoding="utf-8")
            self.assertEqual(written, ENTRYPOINT_PY)
            fixture_text = (tree / "fixture.json").read_text(encoding="utf-8")
            self.assertIn("null", fixture_text)
            self.assertIn("true", fixture_text)
            self.assertNotIn("null", ENTRYPOINT_PY)
            self.assertNotIn("true", ENTRYPOINT_PY)
            self.assertNotIn("false", ENTRYPOINT_PY)
            self.assertIn("/etc/openkit-fixture.json", ENTRYPOINT_PY)
            port = choose_free_port()
            proc = start_generated_fixture_app(tree, port)
            deadline = time.time() + 2
            while proc.poll() is None and time.time() < deadline:
                time.sleep(0.05)
                helper.config = {
                    "appBaseUrl": "http://127.0.0.1:%s" % port,
                    "adminTokenFile": str(token_path),
                }
                ready = wait_fixture_auth_tokens(helper._authorized_get, timeout=0.3)
                if ready["status"] == 200:
                    break
            if proc.poll() is not None:
                err = proc.stderr.read() if proc.stderr else ""
                self.fail("generated entrypoint exited before listen: rc=%s stderr=%s" % (proc.returncode, err))
            self.assertEqual(ready["status"], 200)
            self.assertEqual((ready["body"] or {}).get("items"), [FIXTURE_TOKEN])
            self.assertEqual(helper._auth_store_identity(ready["body"])[0]["tokenId"], FIXTURE_TOKEN["tokenId"])
            import urllib.error
            import urllib.request
            target_url = "http://127.0.0.1:%s/api/app/nanohost/runtime-target" % port
            try:
                urllib.request.urlopen(urllib.request.Request(target_url, method="GET"), timeout=2)
                self.fail("no-NanoHost runtime-target must not be HTTP 200")
            except urllib.error.HTTPError as error:
                self.assertEqual(error.code, 404)
                err_body = json.loads(error.read().decode("utf-8"))
                self.assertEqual(err_body.get("code"), "nanohost_runtime_target_not_found")
                self.assertNotEqual(err_body.get("code"), "nanohost_transport_admin_server_mode_required")
                self.assertEqual(err_body.get("protocolVersion"), "0.5.0")
            diag_status, diag_body = helper._authorized_get("/api/app/diagnostics")
            self.assertEqual(diag_status, 200)
            parsed_ready = helper._parse_boot_readiness(diag_body)
            self.assertIsNotNone(parsed_ready)
            self.assertEqual(parsed_ready["bootId"], CURRENT_BOOT)
            self.assertEqual(parsed_ready["acceptingProductWork"], True)
            self.assertTrue(parsed_ready["noBlockingReadiness"])
            self.assertEqual(
                tuple((diag_body or {}).get("boot", {}).get("subsystems") or {}),
                FIXTURE_BOOT_SUBSYSTEM_NAMES,
            )
            self.assertIsNone(
                helper._parse_boot_readiness(
                    {
                        "boot": {
                            "acceptingProductWork": True,
                            "bootId": CURRENT_BOOT,
                            "overall": "ready",
                            "subsystems": {},
                        }
                    }
                )
            )
        finally:
            if proc is not None:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)
                if proc.stderr:
                    proc.stderr.close()

        cand_tree = Path(tempfile.mkdtemp(prefix="ok-fx-entry-cand-"))
        cand_proc = None
        try:
            write_source_tree(
                cand_tree,
                accepting=False,
                boot_id=CANDIDATE_BOOT,
                web_body="fixture-candidate-web\n",
                hold_seconds=0,
            )
            cand_port = choose_free_port()
            cand_proc = start_generated_fixture_app(cand_tree, cand_port)
            cand_ready: Optional[Dict[str, Any]] = None
            deadline = time.time() + 2
            while cand_proc.poll() is None and time.time() < deadline:
                time.sleep(0.05)
                helper.config = {
                    "appBaseUrl": "http://127.0.0.1:%s" % cand_port,
                    "adminTokenFile": str(token_path),
                }
                cand_ready = wait_fixture_auth_tokens(helper._authorized_get, timeout=0.3)
                if cand_ready["status"] == 200:
                    break
            if cand_proc.poll() is not None:
                err = cand_proc.stderr.read() if cand_proc.stderr else ""
                self.fail("candidate entrypoint exited before listen: rc=%s stderr=%s" % (cand_proc.returncode, err))
            cand_status, cand_diag = helper._authorized_get("/api/app/diagnostics")
            self.assertEqual(cand_status, 200)
            parsed_fail = helper._parse_boot_readiness(cand_diag)
            self.assertIsNotNone(parsed_fail)
            self.assertEqual(parsed_fail["bootId"], CANDIDATE_BOOT)
            self.assertFalse(parsed_fail["noBlockingReadiness"])
            self.assertIn("fixture.candidate_not_ready", parsed_fail["blockingReasons"])
            self.assertEqual(
                tuple((cand_diag or {}).get("boot", {}).get("subsystems") or {}),
                FIXTURE_BOOT_SUBSYSTEM_NAMES,
            )
        finally:
            if cand_proc is not None:
                if cand_proc.poll() is None:
                    cand_proc.kill()
                    cand_proc.wait(timeout=5)
                if cand_proc.stderr:
                    cand_proc.stderr.close()
            shutil.rmtree(cand_tree, ignore_errors=True)

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            Handler.status_code = 401
            helper.config = {
                "appBaseUrl": "http://127.0.0.1:%s" % server.server_address[1],
                "adminTokenFile": str(token_path),
            }
            unauth = wait_fixture_auth_tokens(helper._authorized_get, timeout=0.4)
            self.assertEqual(unauth["status"], 401)
            self.assertIsNone(unauth["body"])
            self.assertNotEqual(closed_wait["status"], unauth["status"])
        finally:
            server.shutdown()
            server.server_close()
            shutil.rmtree(tree, ignore_errors=True)
            shutil.rmtree(token_dir, ignore_errors=True)


@unittest.skipUnless(LIVE_ENABLED, "%s=1 is unset" % LIVE_ENV)
class AppUpdateHelperLiveTests(unittest.TestCase):
    """Real systemd/docker fixture. Never a product-success claim."""

    def setUp(self) -> None:
        if sys.platform != "linux":
            self.skipTest("live host-mechanism fixture requires Linux")
        for name in ("git", "docker", "systemd-run", "systemctl"):
            if shutil.which(name) is None:
                self.fail("live fixture requires %s on PATH" % name)
        self.run_id = "ok-upd-fx-%s-%s" % (time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()), uuid.uuid4().hex[:8])
        self.run_root = Path("/var/tmp") / self.run_id
        self.report_dir = PROBE_ROOT / "runs" / self.run_id
        self.report_dir.mkdir(parents=True)
        if self.run_root.exists():
            self.fail("run root already exists: %s" % self.run_root)
        self.container_name = self.run_id
        self.container_ids: Set[str] = set()
        self.image_ids: Set[str] = set()
        self.image_tags: Set[str] = set()
        self.unit_names: Set[str] = set()
        self.request_id: Optional[str] = None
        self.original_container_id: Optional[str] = None
        self.containers_before_apply: Set[str] = set()
        self.preexisting: Dict[str, bool] = {}
        self.module = load_helper()
        self.evidence: Dict[str, Any] = {"kind": "host-mechanism-fixture", "productUpdate": False, "a2Touched": False, "runId": self.run_id}

    def tearDown(self) -> None:
        if not getattr(self, "run_root", None):
            return
        status: Dict[str, Any] = {}
        try:
            config_path = self.run_root / "helper.json"
            if self.request_id and config_path.is_file():
                status = invoke_helper(config_path, {"op": "status", "requestId": self.request_id})
        except Exception as error:
            status = {"preserveStatusError": str(error)}
        try:
            self._preserve_external_report(status, "before-cleanup")
        except Exception as error:
            self.evidence["preserveCopyError"] = str(error)
            try:
                self._write_report()
            except Exception:
                pass
        errors = self._cleanup()
        if errors:
            raise RuntimeError("fixture cleanup failed: " + "; ".join(errors))

    def test_job_survives_caller_rejects_concurrency_and_restores_failed_candidate(self) -> None:
        self.run_root.mkdir(mode=0o700)
        port = choose_free_port()
        source = build_tiny_git_fixture(self.run_root / "git")
        current_tag = fixture_current_image_ref(self.run_id)
        current_ctx = self.run_root / "current-src"
        git_archive_tree(source["workdir"], source["current"], current_ctx)
        stdout(["bash", str(current_ctx / "scripts" / "docker" / "build-image.sh"), "app", current_tag], cwd=current_ctx)
        current_image, image_state = inspect_object("image", current_tag)
        self.assertEqual(image_state, "present", "current fixture image inspect is %s" % image_state)
        if not current_image:
            self.fail("current fixture image id is missing")
        self._note_image(current_image, current_tag)
        candidate_tag = fixture_candidate_image_ref(source["candidate"])
        self.image_tags.add(candidate_tag)
        self._write_report()

        data_root = (self.run_root / "data").resolve()
        web_root = (self.run_root / "web").resolve()
        receipts = (self.run_root / "receipts").resolve()
        staged = (self.run_root / "staged").resolve()
        secrets = (self.run_root / "secrets").resolve()
        nanohost = secrets / "nanohost"
        vault = secrets / "openkit-vault.key"
        caddy = (self.run_root / "app.Caddyfile").resolve()
        lock_path = (self.run_root / "update.lock").resolve()
        token = (self.run_root / "token").resolve()
        for path in (data_root, receipts, staged, nanohost, web_root, data_root / "retained"):
            path.mkdir(parents=True)
        sentinel = "sentinel-%s\n" % self.run_id
        (data_root / "retained" / "marker.txt").write_text(sentinel, encoding="utf-8")
        previous_web = web_root / source["current"]
        previous_web.mkdir()
        (previous_web / "index.html").write_text("fixture-current-web\n", encoding="utf-8")
        (web_root / "current").symlink_to(source["current"])
        vault.write_text("vault-placeholder\n", encoding="utf-8")
        caddy.write_text("http://127.0.0.1:%s {\n}\n" % port, encoding="utf-8")
        lock_path.write_bytes(b"")
        token.write_text("token-not-a-raw-product-secret\n", encoding="utf-8")
        protected = (self.run_root / "protected").resolve()
        protected.mkdir(mode=0o700)
        identity = protected / "id_ed25519"
        known_hosts = protected / "known_hosts"
        identity.write_text("fixture-app-update-identity\n", encoding="utf-8")
        known_hosts.write_text("fixture-app-update-known-hosts\n", encoding="utf-8")
        os.chmod(identity, 0o600)
        os.chmod(known_hosts, 0o600)
        self.assertTrue(identity.is_file() and not identity.is_symlink())
        self.assertTrue(known_hosts.is_file() and not known_hosts.is_symlink())
        self.assertFalse(str(identity).startswith(str(data_root) + os.sep))
        self.assertFalse(str(identity).startswith(str(nanohost) + os.sep))
        self.evidence["appUpdateBinds"] = {
            "idEd25519": {"dest": APP_UPDATE_IDENTITY_DEST, "readonly": True, "source": str(identity)},
            "knownHosts": {"dest": APP_UPDATE_KNOWN_HOSTS_DEST, "readonly": True, "source": str(known_hosts)},
        }
        web_before = self.module.digest_tree(str(previous_web))
        config_path = self.run_root / "helper.json"
        config = {
            "schemaVersion": 1,
            "containerName": self.container_name,
            "dataRoot": str(data_root),
            "receiptDir": str(receipts),
            "lockPath": str(lock_path),
            "sourceRepository": source["repository"],
            "sourceBranch": "main",
            "sourceWorkDir": source["workdir"],
            "stagedSourceDir": str(staged),
            "imageRepository": fixture_image_repository(self.run_id),
            "appBaseUrl": "http://127.0.0.1:%s" % port,
            "helperArgv": [sys.executable, str(HELPER_PATH), "--config", str(config_path)],
            "adminTokenFile": str(token),
            "webAssetsDir": str(web_root),
            "vaultKeyFile": str(vault),
            "nanohostCredentialsDir": str(nanohost),
            "caddyfile": str(caddy),
            "jobTimeoutSeconds": APPLY_WAIT_SECONDS,
            "compatibility": {
                "appliedMigrations": [MIGRATION],
                "candidate": {"kind": "commit", "sourceCommit": source["candidate"]},
                "currentImageId": current_image,
            },
        }
        self.assertNotEqual(str(data_root), "/data/openkit")
        self.assertNotEqual(self.container_name, "openkit-staging")
        config_path.write_text(json.dumps(config), encoding="utf-8")
        os.chmod(config_path, 0o600)
        self.assertNotEqual(str(config_path), PRODUCTION_CONFIG_PATH)

        self.preexisting = container_id_running()
        stdout(
            fixture_current_container_argv(
                container_name=self.container_name,
                data_root=str(data_root),
                nanohost=str(nanohost),
                web_root=str(web_root),
                caddy=str(caddy),
                vault=str(vault),
                identity=str(identity),
                known_hosts=str(known_hosts),
                port=port,
                run_id=self.run_id,
                image=current_tag,
            )
        )
        original_id, original_state = inspect_object("container", self.container_name)
        self.assertEqual(original_state, "present", "current fixture container inspect is %s" % original_state)
        if not original_id:
            self.fail("current fixture container id is missing")
        self.original_container_id = original_id
        self.container_ids.add(self.original_container_id)
        self.containers_before_apply = docker_container_ids()
        self._write_report()
        http_helper = object.__new__(self.module.AppUpdateHelper)
        http_helper.effects = self.module.CommandEffects()
        http_helper.config = config
        observed = wait_fixture_auth_tokens(http_helper._authorized_get)
        self.evidence["fixtureHttpReady"] = observed
        self._write_report()
        if observed["status"] != 200:
            self._preserve_fixture_container_logs()
            self._preserve_external_report({"httpWait": observed}, "fixture-http-not-ready")
            self.fail("fixture HTTP not ready: %s" % json.dumps(observed, default=str))
        identity = http_helper._auth_store_identity(observed["body"])
        self.assertEqual((observed["body"] or {}).get("items"), [FIXTURE_TOKEN])
        self.assertEqual(identity[0]["tokenId"], FIXTURE_TOKEN["tokenId"])

        prepared = invoke_helper(config_path, {"op": "prepare", "expectedCurrentImageId": current_image, "source": {"kind": "commit", "sourceCommit": source["candidate"]}})
        self.assertIsNone(prepared.get("error"), prepared)
        self.request_id = prepared["requestId"]
        start_proc = subprocess.Popen(
            [sys.executable, str(HELPER_PATH), "--config", str(config_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        stdout_text, stderr = start_proc.communicate(
            json.dumps({"maintenanceConsent": True, "op": "start", "requestId": self.request_id}),
            timeout=30,
        )
        self.assertIsNotNone(start_proc.returncode)
        started = json.loads(stdout_text.strip().splitlines()[-1])
        self.assertIsNone(started.get("error"), {"started": started, "stderr": stderr})
        job_id = started["jobId"]
        self.assertTrue(job_id)
        self.unit_names.add(job_id)
        self.evidence.update({"jobId": job_id, "requestId": self.request_id, "port": port, "sourceCommit": source["candidate"]})
        self._write_report()
        job_obs = observe_unit(job_id)
        if not job_obs.get("observable") or not job_obs.get("live"):
            self._preserve_external_report({"jobObs": job_obs}, "first-job-not-live")
        self.assertTrue(job_obs.get("observable"), "job status unobservable after caller exit: %s" % job_obs)
        self.assertTrue(job_obs.get("live"), "job did not remain live after caller exit: %s" % job_obs)
        self._wait_first_applying_build(config_path)

        busy = invoke_helper(config_path, {"op": "prepare", "expectedCurrentImageId": current_image, "source": {"kind": "commit", "sourceCommit": source["candidate"]}})
        self.assertIsNone(busy.get("error"), busy)
        concurrent = invoke_helper(config_path, {"maintenanceConsent": True, "op": "start", "requestId": busy["requestId"]})
        concurrent_error = concurrent.get("error")
        concurrent_job = concurrent.get("jobId")
        if concurrent_job:
            self.unit_names.add(str(concurrent_job))
        self.evidence["concurrentStart"] = {
            "errorCode": concurrent_error.get("code") if isinstance(concurrent_error, dict) else concurrent_error,
            "jobId": concurrent_job,
            "requestId": concurrent.get("requestId"),
            "stage": concurrent.get("stage"),
        }
        self._write_report()
        busy_code = concurrent_error.get("code") if isinstance(concurrent_error, dict) else None
        if busy_code != "app_update_busy":
            self._preserve_external_report(concurrent, "unexpected-second-job")
        self.assertEqual(busy_code, "app_update_busy", concurrent)

        deadline = time.time() + APPLY_WAIT_SECONDS
        status: Dict[str, Any] = {}
        while time.time() < deadline:
            status = invoke_helper(config_path, {"op": "status", "requestId": self.request_id})
            if status.get("stage") in {"failed", "recovery_required", "unknown", "succeeded"}:
                break
            time.sleep(2)
        collect_errors = self._collect_owned_containers()
        self.assertEqual(collect_errors, [], collect_errors)
        if status.get("candidateImageId"):
            self._note_image(str(status["candidateImageId"]), candidate_tag)
        self.evidence.update({"stage": status.get("stage"), "previousAppRestored": status.get("previousAppRestored"), "helperSha256": hashlib.sha256(HELPER_PATH.read_bytes()).hexdigest()})
        self._write_report()
        self.assertEqual(status.get("stage"), "failed", status)
        self.assertNotEqual(status.get("stage"), "succeeded")
        self.assertTrue(status.get("previousAppRestored"), status)
        restored_id, restored_state = inspect_object("container", self.container_name)
        self.assertEqual(restored_state, "present", "restored container inspect is %s" % restored_state)
        self.assertEqual(restored_id, self.original_container_id)
        running = json.loads(stdout(["docker", "inspect", "--format", "{{json .}}", self.container_name]))
        self.assertEqual(running.get("State", {}).get("Running"), True)
        self.assertEqual(running.get("Image"), current_image)
        self.assertEqual((data_root / "retained" / "marker.txt").read_text(encoding="utf-8"), sentinel)
        self.assertEqual(str((web_root / "current").readlink()), source["current"])
        self.assertEqual(self.module.digest_tree(str((web_root / "current").resolve())), web_before)
        after = container_id_running()
        self.evidence["preexistingBefore"] = {key: value for key, value in sorted(self.preexisting.items())}
        self.evidence["preexistingAfter"] = {key: after.get(key) for key in sorted(self.preexisting)}
        self._write_report()
        missing = sorted(set(self.preexisting) - set(after))
        self.assertEqual(missing, [], "preexisting containers disappeared: %s" % missing)
        changed = sorted(
            container_id
            for container_id, running in self.preexisting.items()
            if after.get(container_id) != running
        )
        self.assertEqual(changed, [], "preexisting container Running changed: %s" % changed)
        leaked = sorted((set(after) - set(self.preexisting)) - self.container_ids)
        self.assertEqual(leaked, [], "unowned new container IDs: %s" % leaked)

    def _preserve_fixture_container_logs(self) -> None:
        """Keep docker logs when fixture HTTP stays unavailable so status 0 vs 401 is decidable."""

        target = self.original_container_id or self.container_name
        try:
            logs = run_cmd(["docker", "logs", "--timestamps", str(target)], check=False)
            log_rc = logs.returncode
            log_err = logs.stderr
            log_out = logs.stdout
        except FileNotFoundError:
            log_rc = 127
            log_err = "docker missing"
            log_out = ""
        path = self.report_dir / "fixture-container-logs.txt"
        path.write_text("target=%s\ndocker_logs_rc=%s\n%s\n%s" % (target, log_rc, log_err, log_out), encoding="utf-8")
        self.evidence["fixtureContainerLogs"] = {"path": str(path), "rc": log_rc, "target": target}

    def _preserve_external_report(self, status: Dict[str, Any], reason: str) -> None:
        """Copy receipts and unit journals to report_dir before run-root cleanup."""

        (self.report_dir / "terminal-status.json").write_text(
            json.dumps({"reason": reason, "status": status}, indent=2) + "\n",
            encoding="utf-8",
        )
        receipts = self.run_root / "receipts"
        dest = self.report_dir / "receipts"
        copied = []
        if receipts.is_dir():
            dest.mkdir(exist_ok=True)
            for path in sorted(receipts.iterdir()):
                if path.is_file() and not path.is_symlink() and path.suffix == ".json":
                    shutil.copy2(path, dest / path.name)
                    copied.append(path.name)
        journals = {}
        for unit in sorted(self.unit_names):
            try:
                journal = run_cmd(["journalctl", "-u", unit, "--no-pager", "-o", "short-iso"], check=False)
                journal_rc = journal.returncode
                journal_err = journal.stderr
                journal_out = journal.stdout
            except FileNotFoundError:
                journal_rc = 127
                journal_err = "journalctl missing"
                journal_out = ""
            safe = unit.replace("/", "_")
            (self.report_dir / ("journal-%s.txt" % safe)).write_text(
                "journalctl_rc=%s\n%s\n%s" % (journal_rc, journal_err, journal_out),
                encoding="utf-8",
            )
            journals[unit] = journal_rc
        self.evidence["failurePreserve"] = {
            "journalctlRc": journals,
            "reason": reason,
            "receiptsCopied": copied,
            "reportDir": str(self.report_dir),
            "status": status,
        }
        self._write_report()

    def _wait_first_applying_build(self, config_path: Path) -> Dict[str, Any]:
        """Wait until applying persists past instant admission fail; build hold is 20s."""

        deadline = time.time() + BUILD_HOLD_SECONDS + 10
        last: Dict[str, Any] = {}
        applying_since: Optional[float] = None
        while time.time() < deadline:
            last = invoke_helper(config_path, {"op": "status", "requestId": self.request_id})
            stage = last.get("stage")
            if stage in {"failed", "recovery_required", "unknown", "succeeded"}:
                self._preserve_external_report(last, "first-job-terminal-before-build")
                self.fail("first job exited before apply/build: %s" % last)
            if stage == "applying":
                if applying_since is None:
                    applying_since = time.time()
                elif time.time() - applying_since >= 1:
                    return last
            else:
                applying_since = None
            time.sleep(0.2)
        self._preserve_external_report(last, "first-job-did-not-reach-applying")
        self.fail("first job did not reach applying/build within bound: %s" % last)

    def _owned_names(self) -> Set[str]:
        names = {self.container_name, "%s-previous" % self.container_name}
        if self.request_id:
            prefix = self.request_id.split("-")[0]
            names.add("%s.failed-%s" % (self.container_name, prefix))
            names.add("%s-previous-pre-%s" % (self.container_name, prefix))
        return names

    def _note_image(self, image_id: str, tag: Optional[str] = None) -> None:
        if image_id:
            self.image_ids.add(image_id)
        if tag:
            self.image_tags.add(tag)

    def _collect_owned_containers(self) -> List[str]:
        errors: List[str] = []
        for name in self._owned_names():
            container_id, state = inspect_object("container", name)
            if state == "unknown":
                errors.append("inspect %s unobservable" % name)
            elif state == "present" and container_id:
                self.container_ids.add(container_id)
        for tag in list(self.image_tags):
            image_id, state = inspect_object("image", tag)
            if state == "unknown":
                errors.append("inspect image %s unobservable" % tag)
            elif state == "present" and image_id:
                self.image_ids.add(image_id)
        try:
            extra_ids = docker_container_ids() - self.containers_before_apply
        except RuntimeError as error:
            errors.append("container list unobservable: %s" % error)
            return errors
        owned_images = set(self.image_ids)
        for container_id in extra_ids:
            inspected = run_cmd(
                ["docker", "inspect", "--format", "{{.Image}} {{.Name}}", container_id],
                check=False,
            )
            raw = inspected.stdout.strip()
            detail = "%s\n%s" % (inspected.stderr, inspected.stdout)
            if inspected.returncode != 0:
                if NO_SUCH_OBJECT.search(detail):
                    continue
                errors.append("inspect extra %s unobservable: %s" % (container_id, inspected.stderr.strip() or "failed inspect"))
                continue
            if not raw:
                errors.append("inspect extra %s unobservable: empty inspect" % container_id)
                continue
            parts = raw.split(None, 1)
            image = parts[0]
            name = parts[1].lstrip("/") if len(parts) > 1 else ""
            if image in owned_images or name in self._owned_names():
                self.container_ids.add(container_id)
        return errors

    def _remove_recorded(self, kind: str, reference: str, rm_argv: List[str]) -> Optional[str]:
        identity, state = inspect_object(kind, reference)
        if state == "unknown":
            return "%s %s inspect unobservable" % (kind, reference)
        if state == "absent":
            return None
        removed = run_cmd(rm_argv, check=False)
        identity_after, state_after = inspect_object(kind, reference)
        if state_after == "unknown":
            return "%s %s unobservable after rm rc=%s %s" % (
                kind,
                reference,
                removed.returncode,
                removed.stderr.strip(),
            )
        if state_after == "present":
            return "%s %s still present after rm rc=%s %s (id=%s)" % (
                kind,
                reference,
                removed.returncode,
                removed.stderr.strip(),
                identity_after or identity,
            )
        return None

    def _cleanup(self) -> List[str]:
        errors = self._stop_units()
        blocked = False
        for unit in sorted(self.unit_names):
            observation = observe_unit(unit)
            if not observation.get("observable"):
                errors.append(
                    "refusing docker and root deletion; unit %s status unobservable: %s"
                    % (unit, observation.get("error"))
                )
                blocked = True
            elif observation.get("live"):
                errors.append(
                    "refusing docker and root deletion while unit %s is live (%s/%s)"
                    % (unit, observation.get("load"), observation.get("active"))
                )
                blocked = True
        if blocked:
            self._write_report()
            return errors
        collect_errors = self._collect_owned_containers()
        if collect_errors:
            errors.extend(collect_errors)
            errors.append("refusing docker and root deletion; owned-object discovery unobservable")
            self._write_report()
            return errors
        recorded_gone = True
        for container_id in sorted(self.container_ids):
            removal_error = self._remove_recorded(
                "container",
                container_id,
                ["docker", "rm", "-f", container_id],
            )
            if removal_error:
                errors.append(removal_error)
                recorded_gone = False
        if not recorded_gone:
            errors.append("refusing image and root deletion; recorded containers not proven absent")
            self._write_report()
            return errors
        if self.run_root.exists():
            mounted, mount_error = observe_run_root_mounts(self.run_root)
            if mount_error:
                errors.append("refusing root deletion; mounts unobservable: %s" % mount_error)
                self._write_report()
                return errors
            if mounted:
                errors.append("refusing root deletion; mounts remain: %s" % json.dumps(mounted))
                self._write_report()
                return errors
        images_gone = True
        for tag in sorted(self.image_tags):
            removal_error = self._remove_recorded("image", tag, ["docker", "image", "rm", "-f", tag])
            if removal_error:
                errors.append(removal_error)
                images_gone = False
        for image_id in sorted(self.image_ids):
            removal_error = self._remove_recorded("image", image_id, ["docker", "image", "rm", "-f", image_id])
            if removal_error:
                errors.append(removal_error)
                images_gone = False
        if not images_gone:
            errors.append("refusing root deletion; recorded images not proven absent")
            self._write_report()
            return errors
        if self.run_root.exists():
            mounted, mount_error = observe_run_root_mounts(self.run_root)
            if mount_error:
                errors.append("refusing root deletion; mounts unobservable before rmtree: %s" % mount_error)
                self._write_report()
                return errors
            if mounted:
                errors.append("refusing root deletion; mounts remain before rmtree: %s" % json.dumps(mounted))
                self._write_report()
                return errors
            try:
                shutil.rmtree(self.run_root)
            except OSError as error:
                errors.append("run root delete failed: %s" % error)
        self._write_report()
        return errors

    def _write_report(self) -> None:
        payload = dict(self.evidence)
        payload.update(
            {
                "containerIds": sorted(self.container_ids),
                "containerName": self.container_name,
                "imageIds": sorted(self.image_ids),
                "imageTags": sorted(self.image_tags),
                "originalContainerId": self.original_container_id,
                "reportDir": str(self.report_dir),
                "runRoot": str(self.run_root),
                "unitNames": sorted(self.unit_names),
            }
        )
        (self.report_dir / "evidence.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    def _stop_units(self) -> List[str]:
        errors = []
        for unit in sorted(self.unit_names):
            stop = run_cmd(["systemctl", "stop", unit], check=False)
            deadline = time.time() + 60
            last = observe_unit(unit)
            while time.time() < deadline:
                last = observe_unit(unit)
                if last.get("observable") and last.get("live") is False:
                    break
                time.sleep(0.5)
            else:
                errors.append(
                    "unit %s not observably stopped (stop rc=%s stderr=%s observation=%s)"
                    % (unit, stop.returncode, stop.stderr.strip(), last)
                )
                continue
            reset = run_cmd(["systemctl", "reset-failed", unit], check=False)
            if reset.returncode != 0 and "not loaded" not in reset.stderr.lower() and "not-found" not in reset.stderr.lower():
                errors.append("reset-failed %s rc=%s %s" % (unit, reset.returncode, reset.stderr.strip()))
        return errors


if __name__ == "__main__":
    unittest.main()
