#!/usr/bin/env python3
"""Local filesystem tests for the App-update host helper."""

from __future__ import annotations

import fcntl
import importlib.util
import io
import json
import os
import subprocess
import tarfile
import tempfile
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

HELPER_PATH = Path(__file__).with_name("app-update-helper.py")
REPO_ROOT = HELPER_PATH.resolve().parents[2]
COMMIT = "a" * 40
PREV_COMMIT = "c" * 40
HOST_OUTPUT_SCHEMA_PARSE = """
import { AppUpdateHostOutputSchema } from '@openkit/app-api-schemas';
import { readFileSync } from 'node:fs';
const parsed = AppUpdateHostOutputSchema.safeParse(JSON.parse(readFileSync(0, 'utf8')));
if (!parsed.success) {
  process.stderr.write(JSON.stringify(parsed.error.issues) + '\\n');
  process.exit(1);
}
"""
_SCHEMA_BUILT = False
DIGEST = "sha256:" + ("b" * 64)
OTHER_DIGEST = "sha256:" + ("d" * 64)
OTHER_COMMIT = "e" * 40
CONTAINER = "openkit-staging"
PREVIOUS = CONTAINER + "-previous"
APP_UPDATE_IDENTITY_DEST = "/run/openkit/app-update/id_ed25519"
APP_UPDATE_KNOWN_HOSTS_DEST = "/run/openkit/app-update/known_hosts"
IMAGE_ENTRYPOINT = ["tini", "--", "/usr/local/bin/openkit-app-entrypoint"]
RELEASE_SOURCE = {
    "appDigest": DIGEST,
    "kind": "release",
    "sourceCommit": COMMIT,
    "tag": "v0.1.0",
}
HTTPS_SAMPLE = "https://openrouter.ai/api/v1"


def token_record(**overrides) -> dict:
    record = {
        "expiresAt": "2027-09-10T00:00:00.000Z",
        "issuedAt": "2026-09-10T00:00:00.000Z",
        "lastUsedAt": None,
        "lastUsedChannel": None,
        "lastUsedSource": None,
        "ownerUserId": "user_admin",
        "predecessorTokenId": None,
        "revokedAt": None,
        "rotatedGraceExpiresAt": None,
        "scope": "server-admin",
        "status": "active",
        "tokenId": "tok_admin",
        "workspaceIds": [],
    }
    record.update(overrides)
    return record


RETAINED_TOKENS = {"items": [token_record(tokenId="tok_b"), token_record(tokenId="tok_a")]}
BOOT_SUBSYSTEM_NAMES = (
    "config",
    "knowledgeIndex",
    "llmGateway",
    "policy",
    "scheduler",
    "storage",
    "vault",
)
CRITICAL_SUBSYSTEM_NAMES = frozenset({"config", "policy", "storage"})
PREVIOUS_BOOT_ID = "boot_11111111-1111-4111-8111-111111111111"
CANDIDATE_BOOT_ID = "boot_22222222-2222-4222-8222-222222222222"


def boot_reason(code: str, message: str, blocks: Optional[List[str]] = None) -> dict:
    return {"blocks": list(blocks or []), "code": code, "message": message}


def ready_boot_subsystems(**overrides) -> dict:
    subsystems = {name: {"reasons": [], "state": "ready"} for name in BOOT_SUBSYSTEM_NAMES}
    subsystems.update(overrides)
    return subsystems


def typed_boot(boot_id: str, accepting: Optional[bool] = None, overall: Optional[str] = None, **subsystem_overrides) -> dict:
    subsystems = ready_boot_subsystems(**subsystem_overrides)
    has_critical = any(
        subsystems[name]["state"] == "failed" for name in CRITICAL_SUBSYSTEM_NAMES
    )
    has_nonready = any(item["state"] != "ready" for item in subsystems.values())
    computed_overall = "failed" if has_critical else ("degraded" if has_nonready else "ready")
    return {
        "acceptingProductWork": (not has_critical) if accepting is None else accepting,
        "bootId": boot_id,
        "overall": computed_overall if overall is None else overall,
        "subsystems": subsystems,
    }


def api_error(code: str, message: str = "NanoHost runtime target is unavailable.") -> dict:
    return {"code": code, "message": message, "protocolVersion": "0.1.0"}


def load_helper():
    spec = importlib.util.spec_from_file_location("app_update_helper", HELPER_PATH)
    if spec is None or spec.loader is None:
        raise FileNotFoundError(HELPER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RecordingEffects:
    """Captures argv and returns canned Docker/systemd/git results."""

    def __init__(self) -> None:
        self.calls: List[List[str]] = []
        self.http_calls: List[str] = []
        self.active_units: Dict[str, str] = {}
        self.image_id = DIGEST
        self.pull_digest = DIGEST
        self.inspect_image = DIGEST
        self.repo_digests = ["ghcr.io/example/openkit-app@" + DIGEST]
        self.container_running = True
        self.nanohost_ready = True
        self.nanohost_identity = "staging-nanohost-a2"
        self.nanohost_deployment = "staging-a2"
        self.nanohost_generation = 7
        self.nanohost_identity_after: Optional[str] = None
        self.nanohost_generation_after: Optional[int] = None
        self.nanohost_ready_after: Optional[bool] = None
        self.nanohost_http: Optional[Tuple[int, Any]] = None
        self.boot_id = PREVIOUS_BOOT_ID
        self.accepting_product_work = True
        self.accepting_product_work_after: Optional[bool] = None
        self.blocking_reasons: List[dict] = []
        self.boot_payload_before: Optional[dict] = None
        self.boot_payload_after: Optional[dict] = None
        self.diagnostics_status = 200
        self.applied_migrations = ["core_0000_setup"]
        self.tokens = json.loads(json.dumps(RETAINED_TOKENS))
        self.status_probe: Optional[dict] = None
        self.fail_commands: Dict[str, int] = {}
        self.ancestor_ok = True
        self.replaced = False
        self.candidate_boot_id = CANDIDATE_BOOT_ID
        self.pull_error: Optional[str] = None
        self.privileged = False
        self.runtime = "runc"
        self.devices: List[dict] = []
        self.extract_empty = False
        self.containers: Set[str] = {CONTAINER}
        self.running: Set[str] = {CONTAINER}
        self.root: Optional[Path] = None
        self.data_root = "/tmp/data"
        self.web_root = "/tmp/web"
        self.vault_key = "/tmp/vault.key"
        self.nanohost_dir = "/tmp/nanohost"
        self.caddyfile = "/tmp/app.Caddyfile"
        self.ssh_identity = "/tmp/id_ed25519"
        self.ssh_known_hosts = "/tmp/known_hosts"
        self.omit_app_update_ssh = False
        self.ssh_rw = False
        self.release_tag_digest = DIGEST
        self.release_version_digest = DIGEST
        self.release_sha_digest = DIGEST
        self.ls_remote_commit = COMMIT
        self.rev_parse_commit = COMMIT
        self.real_ls_remote = False
        self.fail_restore_stop = False
        self.diagnostics_payloads: List[dict] = []
        self.tokens_after: Optional[dict] = None

    def bind(self, root: Path) -> None:
        self.root = root
        self.data_root = str(root / "data")
        self.web_root = str(root / "web")
        self.vault_key = str(root / "secrets" / "openkit-vault.key")
        self.nanohost_dir = str(root / "secrets" / "nanohost")
        self.caddyfile = str(root / "app.Caddyfile")
        self.ssh_identity = str(root / "secrets" / "app-update" / "id_ed25519")
        self.ssh_known_hosts = str(root / "secrets" / "app-update" / "known_hosts")
        self.containers = {CONTAINER}
        self.running = {CONTAINER}

    def sleep(self, seconds: float) -> None:
        return None

    def _container_payload(self) -> dict:
        image = self.image_id if self.replaced else self.inspect_image
        payload = {
            "Id": "ctr-current",
            "Name": "/" + CONTAINER,
            "Image": image,
            "State": {"Running": self.container_running},
            "Config": {
                "Cmd": [],
                "Entrypoint": IMAGE_ENTRYPOINT,
                "Env": [
                    "OPENKIT_CORE_MODE=server",
                    "OPENKIT_DATA_ROOT=/data/openkit",
                    "CADDY_HTTP_PORT=7080",
                    "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318",
                ],
                "Healthcheck": {
                    "Test": [
                        "CMD-SHELL",
                        'curl -fsS -H "Host: ai.simonxu.net" http://127.0.0.1:7080/ | grep -Fq "<div id=\\"root\\"></div>"',
                    ]
                },
            },
            "HostConfig": {
                "CapAdd": None,
                "CapDrop": None,
                "Devices": self.devices,
                "LogConfig": {"Type": "json-file", "Config": {"max-file": "5", "max-size": "10m"}},
                "NetworkMode": "host",
                "PidMode": "",
                "PortBindings": {},
                "Privileged": self.privileged,
                "RestartPolicy": {"MaximumRetryCount": 0, "Name": "unless-stopped"},
                "Runtime": self.runtime,
            },
            "Mounts": [
                {"Destination": "/data/openkit", "RW": True, "Source": self.data_root, "Type": "bind"},
                {
                    "Destination": "/run/nanohost-credentials",
                    "RW": True,
                    "Source": self.nanohost_dir,
                    "Type": "bind",
                },
                {"Destination": "/srv/web", "RW": False, "Source": self.web_root, "Type": "bind"},
                {
                    "Destination": "/etc/caddy/Caddyfile",
                    "RW": False,
                    "Source": self.caddyfile,
                    "Type": "bind",
                },
                {
                    "Destination": "/run/secrets/openkit-vault.key",
                    "RW": False,
                    "Source": self.vault_key,
                    "Type": "bind",
                },
            ],
        }
        if not self.omit_app_update_ssh:
            payload["Mounts"].extend(
                [
                    {
                        "Destination": APP_UPDATE_IDENTITY_DEST,
                        "RW": bool(self.ssh_rw),
                        "Source": self.ssh_identity,
                        "Type": "bind",
                    },
                    {
                        "Destination": APP_UPDATE_KNOWN_HOSTS_DEST,
                        "RW": bool(self.ssh_rw),
                        "Source": self.ssh_known_hosts,
                        "Type": "bind",
                    },
                ]
            )
        return payload

    def _image_payload(self) -> dict:
        return {
            "Config": {"Cmd": [], "Entrypoint": IMAGE_ENTRYPOINT},
            "Id": self.image_id,
            "RepoDigests": list(self.repo_digests),
        }

    def run(self, argv: List[str], timeout: Optional[float] = None) -> Tuple[int, str, str]:
        self.calls.append(list(argv))
        if argv and argv[0] in self.fail_commands:
            return self.fail_commands[argv[0]], "", "failed"
        joined = " ".join(argv)
        if argv[:1] == ["systemd-run"]:
            unit = _flag_value(argv, "--unit")
            if unit:
                self.active_units[unit if unit.endswith(".service") else unit + ".service"] = (
                    "activating"
                )
            return 0, "", ""
        if argv[:2] == ["systemctl", "is-active"]:
            unit = argv[-1]
            return (0, self.active_units.get(unit, "inactive") + "\n", "")
        if argv[:3] == ["docker", "image", "inspect"]:
            return 0, json.dumps(self._image_payload()), ""
        if argv[:3] == ["docker", "buildx", "imagetools"]:
            reference = argv[4] if len(argv) > 4 else ""
            if ":sha-" in reference:
                return 0, self.release_sha_digest + "\n", ""
            if reference.endswith(":0.1.0") or reference.rsplit(":", 1)[-1] == RELEASE_SOURCE["tag"][1:]:
                return 0, self.release_version_digest + "\n", ""
            return 0, self.release_tag_digest + "\n", ""
        if argv[:2] == ["docker", "ps"]:
            return 0, "\n".join(sorted(self.running)) + ("\n" if self.running else ""), ""
        if argv[:2] == ["docker", "inspect"]:
            name = argv[-1]
            if name not in self.containers:
                return 1, "", "No such object"
            return 0, json.dumps(self._container_payload()), ""
        if argv[:2] == ["docker", "pull"]:
            if self.pull_error:
                return 1, "", self.pull_error
            return 0, self.pull_digest, ""
        if argv[:2] == ["docker", "create"]:
            return 0, "extract-ctr\n", ""
        if argv[:2] == ["docker", "cp"]:
            dest = Path(argv[-1])
            dest.mkdir(parents=True, exist_ok=True)
            if not self.extract_empty:
                (dest / "index.html").write_text('<div id="root"></div>\n', encoding="utf-8")
            return 0, "", ""
        if argv[:2] == ["docker", "run"] and "--rm" in argv:
            return 0, "smoke-ok\n", ""
        if argv[:2] == ["docker", "rename"] and len(argv) >= 4:
            source, dest = argv[2], argv[3]
            if source not in self.containers:
                return 1, "", "No such container"
            if dest in self.containers:
                return 1, "", "Conflict. The container name is already in use"
            self.containers.discard(source)
            self.containers.add(dest)
            if source in self.running:
                self.running.discard(source)
                self.running.add(dest)
            return 0, "", ""
        if argv[:2] == ["docker", "stop"]:
            name = argv[-1]
            if self.fail_restore_stop and len(argv) >= 4 and argv[3] == "30":
                return 1, "", "candidate stop failed"
            self.running.discard(name)
            return 0, "", ""
        if argv[:2] == ["docker", "rm"]:
            name = argv[-1]
            self.running.discard(name)
            self.containers.discard(name)
            return 0, "", ""
        if argv[:2] == ["docker", "start"]:
            self.running.add(argv[-1])
            self.containers.add(argv[-1])
            return 0, "", ""
        if argv[:2] == ["docker", "run"] and "--detach" in argv:
            self.replaced = True
            self.containers.add(CONTAINER)
            self.running.add(CONTAINER)
            return 0, "new-container\n", ""
        if "ls-remote" in argv:
            if self.real_ls_remote:
                completed = subprocess.run(
                    list(argv),
                    capture_output=True,
                    text=True,
                    timeout=timeout or 60,
                    check=False,
                )
                return completed.returncode, completed.stdout, completed.stderr
            tag_ref = argv[-1]
            return 0, "%s\t%s\n" % (self.ls_remote_commit, tag_ref), ""
        if "rev-parse" in argv:
            return 0, self.rev_parse_commit + "\n", ""
        if "archive" in argv:
            return self._write_git_archive(argv)
        if "fetch" in argv:
            return 0, "", ""
        if "merge-base" in argv:
            return (0, "", "") if self.ancestor_ok else (1, "", "not ancestor")
        if "build-image.sh" in joined:
            return 0, "", ""
        return 0, "", ""

    def _write_git_archive(self, argv: List[str]) -> Tuple[int, str, str]:
        output = _flag_value(argv, "-o")
        if not output:
            return 1, "", "git archive requires -o"
        dest = Path(output)
        dest.parent.mkdir(parents=True, exist_ok=True)
        script = b"#!/bin/sh\n"
        with tarfile.open(dest, "w") as archive:
            info = tarfile.TarInfo(name="scripts/docker/build-image.sh")
            info.size = len(script)
            archive.addfile(info, io.BytesIO(script))
        return 0, "", ""

    def http_get(self, url: str, headers: Optional[dict] = None, timeout: Optional[float] = None):
        self.http_calls.append(url)
        if url.endswith("/api/app/diagnostics"):
            if self.diagnostics_status != 200:
                return self.diagnostics_status, None
            if self.replaced and self.boot_payload_after is not None:
                boot = self.boot_payload_after
            elif not self.replaced and self.boot_payload_before is not None:
                boot = self.boot_payload_before
            else:
                accepting = self.accepting_product_work
                if self.replaced and self.accepting_product_work_after is not None:
                    accepting = self.accepting_product_work_after
                boot_id = self.candidate_boot_id if self.replaced else self.boot_id
                subsystems = ready_boot_subsystems(
                    storage={"reasons": list(self.blocking_reasons), "state": "ready"}
                )
                boot = {
                    "acceptingProductWork": accepting,
                    "bootId": boot_id,
                    "overall": "ready",
                    "subsystems": subsystems,
                }
            payload = {"boot": boot}
            self.diagnostics_payloads.append(payload)
            return 200, payload
        if url.endswith("/api/diagnostics"):
            return 200, {"migrations": {"applied": list(self.applied_migrations)}}
        if url.endswith("/api/app/workspaces"):
            return 403, None
        if url.endswith("/api/app/auth/tokens"):
            if self.replaced and self.tokens_after is not None:
                return 200, self.tokens_after
            return 200, self.tokens
        if url.endswith("/api/app/nanohost/runtime-target"):
            if self.nanohost_http is not None:
                return self.nanohost_http
            identity = self.nanohost_identity
            generation = self.nanohost_generation
            ready = self.nanohost_ready
            if self.replaced:
                if self.nanohost_identity_after is not None:
                    identity = self.nanohost_identity_after
                if self.nanohost_generation_after is not None:
                    generation = self.nanohost_generation_after
                elif identity is not None:
                    generation = self.nanohost_generation + 1
                if self.nanohost_ready_after is not None:
                    ready = self.nanohost_ready_after
            if identity is None:
                return 404, api_error("nanohost_runtime_target_not_found")
            return 200, {
                "connectionGeneration": generation,
                "deploymentId": self.nanohost_deployment,
                "freshEmpty": True,
                "identityId": identity,
                "observedAt": "2026-09-10T00:00:00.000Z",
                "predecessorFenced": True,
                "ready": ready,
            }
        if "/api/app/app-update/" in url:
            return 200, self.status_probe or {"requestId": url.rsplit("/", 1)[-1]}
        return 200, {"status": "ok"}


def _flag_value(argv: List[str], flag: str) -> Optional[str]:
    if flag in argv:
        index = argv.index(flag)
        if index + 1 < len(argv):
            return argv[index + 1]
    prefix = flag + "="
    for item in argv:
        if item.startswith(prefix):
            return item[len(prefix) :]
    return None


def write_config(root: Path, **overrides) -> Path:
    data_root = root / "data"
    receipts = root / "receipts"
    staged = root / "staged"
    source = root / "src"
    secrets = root / "secrets"
    web = root / "web"
    previous_web = web / PREV_COMMIT
    data_root.mkdir(exist_ok=True)
    (data_root / "config").mkdir(exist_ok=True)
    (data_root / "config" / "server.jsonc").write_text(
        '{ // keep https intact\n  "baseUrl": "%s"\n}\n' % HTTPS_SAMPLE,
        encoding="utf-8",
    )
    receipts.mkdir(exist_ok=True)
    staged.mkdir(exist_ok=True)
    source.mkdir(exist_ok=True)
    secrets.mkdir(exist_ok=True)
    (secrets / "nanohost").mkdir(exist_ok=True)
    (secrets / "openkit-vault.key").write_text("vault-placeholder\n", encoding="utf-8")
    app_update_secrets = secrets / "app-update"
    app_update_secrets.mkdir(exist_ok=True)
    (app_update_secrets / "id_ed25519").write_bytes(b"test-ed25519-placeholder\n")
    (app_update_secrets / "known_hosts").write_text("github.com ssh-ed25519 AAAA\n", encoding="utf-8")
    (root / "app.Caddyfile").write_text("http://127.0.0.1:7080 {\n}\n", encoding="utf-8")
    previous_web.mkdir(parents=True, exist_ok=True)
    (previous_web / "index.html").write_text("previous-web\n", encoding="utf-8")
    current = web / "current"
    if current.exists() or current.is_symlink():
        current.unlink()
    current.symlink_to(PREV_COMMIT)
    (root / "update.lock").write_bytes(b"")
    config = {
        "schemaVersion": 1,
        "containerName": CONTAINER,
        "dataRoot": str(data_root),
        "receiptDir": str(receipts),
        "lockPath": str(root / "update.lock"),
        "sourceRepository": "https://example.invalid/openkit.git",
        "sourceBranch": "main",
        "sourceWorkDir": str(source),
        "stagedSourceDir": str(staged),
        "imageRepository": "ghcr.io/example/openkit-app",
        "appBaseUrl": "http://127.0.0.1:4317",
        "helperArgv": ["/usr/bin/python3", str(HELPER_PATH)],
        "adminTokenFile": str(root / "token"),
        "webAssetsDir": str(web),
        "vaultKeyFile": str(secrets / "openkit-vault.key"),
        "nanohostCredentialsDir": str(secrets / "nanohost"),
        "caddyfile": str(root / "app.Caddyfile"),
        "compatibility": {
            "appliedMigrations": ["core_0000_setup"],
            "candidate": RELEASE_SOURCE,
            "currentImageId": DIGEST,
        },
    }
    config.update(overrides)
    (root / "token").write_text("token-not-a-raw-product-secret\n", encoding="utf-8")
    path = root / "helper.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    os.chmod(path, 0o600)
    return path


def invoke(
    module,
    payload: dict,
    config_path: Path,
    effects: Optional[RecordingEffects] = None,
    now: Optional[Callable[[], float]] = None,
    stdin_bytes: Optional[bytes] = None,
    extra_argv: Optional[List[str]] = None,
    environ: Optional[dict] = None,
) -> Tuple[int, dict]:
    stdout = io.StringIO()
    argv = ["app-update-helper.py", "--config", str(config_path)]
    if extra_argv:
        argv.extend(extra_argv)
    raw = stdin_bytes if stdin_bytes is not None else (json.dumps(payload) + "\n").encode("utf-8")
    code = module.main(
        argv=argv,
        stdin=io.BytesIO(raw),
        stdout=stdout,
        effects=effects or RecordingEffects(),
        now=now or (lambda: 1_000_000.0),
        environ=environ or {},
    )
    text = stdout.getvalue()
    body = json.loads(text) if text else {}
    assert_closed_host_output(module, body)
    return code, body


def _ensure_fresh_app_api_schemas() -> None:
    global _SCHEMA_BUILT
    if _SCHEMA_BUILT:
        return
    completed = subprocess.run(
        ["pnpm", "--filter", "@openkit/app-api-schemas...", "build"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(
            "failed to build @openkit/app-api-schemas: %s"
            % ((completed.stderr or completed.stdout).strip(),)
        )
    _SCHEMA_BUILT = True


def assert_closed_host_output(module, body: dict) -> None:
    if "okt_" in json.dumps(body):
        raise AssertionError("host output leaked a raw secret shape")
    _ensure_fresh_app_api_schemas()
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", HOST_OUTPUT_SCHEMA_PARSE],
        input=json.dumps(body),
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(
            "host output failed AppUpdateHostOutputSchema: %s body=%s"
            % (completed.stderr.strip() or completed.stdout.strip(), body)
        )
    if isinstance(body.get("error"), dict) and set(body) == {"error"}:
        return
    expected = "running" if body["stage"] in module.IN_PROGRESS_STAGES else body["stage"]
    if body["outcome"] != expected:
        raise AssertionError("outcome %s does not collapse from %s" % (body["outcome"], body["stage"]))
    if body["stage"] in {"prepared", "launching", "applying"} and body.get("predicates") is not None:
        raise AssertionError("predicates must be JSON null before verification: %s" % body.get("predicates"))


def _prepare(module, root: Path, source=None, expected=DIGEST, now=None, effects=None, **config):
    source = source or RELEASE_SOURCE
    config.setdefault(
        "compatibility",
        {
            "appliedMigrations": ["core_0000_setup"],
            "candidate": source,
            "currentImageId": expected,
        },
    )
    config_path = write_config(root, **config)
    effects = effects or RecordingEffects()
    effects.bind(root)
    code, body = invoke(
        module,
        {
            "expectedCurrentImageId": expected,
            "op": "prepare",
            "source": source,
        },
        config_path,
        effects=effects,
        now=now,
    )
    return config_path, effects, code, body


class PrepareReceiptTests(unittest.TestCase):
    def test_prepare_writes_host_uuid_receipt_pinning_source_and_current_image(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            config_path = write_config(root)
            effects = RecordingEffects()
            code, body = invoke(
                module,
                {
                    "expectedCurrentImageId": DIGEST,
                    "op": "prepare",
                    "source": RELEASE_SOURCE,
                },
                config_path,
                effects=effects,
            )

            self.assertEqual(code, 0)
            self.assertEqual(body["stage"], "prepared")
            self.assertEqual(body["outcome"], "prepared")
            self.assertEqual(body["source"], RELEASE_SOURCE)
            self.assertEqual(body["expectedCurrentImageId"], DIGEST)
            self.assertIsNone(body["jobId"])
            uuid.UUID(body["requestId"])
            receipt = root / "receipts" / (body["requestId"] + ".json")
            self.assertTrue(receipt.is_file())
            self.assertFalse(receipt.is_symlink())
            stored = json.loads(receipt.read_text(encoding="utf-8"))
            self.assertEqual(stored["schemaVersion"], 1)
            self.assertEqual(stored["source"], RELEASE_SOURCE)
            self.assertEqual(stored["expectedCurrentImageId"], DIGEST)
            self.assertEqual(effects.calls, [])


class ClosedStdinTests(unittest.TestCase):
    def test_rejects_unknown_fields_shell_fragments_and_stage_verb(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            config_path = write_config(Path(tmp))
            cases = [
                {
                    "command": "docker restart",
                    "expectedCurrentImageId": DIGEST,
                    "op": "prepare",
                    "source": {"kind": "commit", "sourceCommit": COMMIT},
                },
                {"op": "stage", "sourceCommit": COMMIT},
                {"op": "apply", "requestId": "11111111-1111-4111-8111-111111111111"},
                {"op": "start", "requestId": "11111111-1111-4111-8111-111111111111"},
                {"op": "status", "requestId": "req_not_a_host_uuid"},
            ]
            for payload in cases:
                _code, body = invoke(module, payload, config_path)
                self.assertEqual(body["error"]["code"], "app_update_invalid_request", payload)

    def test_ignores_ssh_original_command_and_rejects_oversized_stdin(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            config_path = write_config(root)
            _code, body = invoke(
                module,
                {
                    "expectedCurrentImageId": DIGEST,
                    "op": "prepare",
                    "source": RELEASE_SOURCE,
                },
                config_path,
                environ={"SSH_ORIGINAL_COMMAND": "rm -rf /; docker restart"},
            )
            self.assertEqual(body["stage"], "prepared")
            oversized = b"{" + (b"x" * (16 * 1024))
            _code, body = invoke(module, {}, config_path, stdin_bytes=oversized)
            self.assertEqual(body["error"]["code"], "app_update_invalid_request")
            self.assertRegex(body["error"]["message"], r"16 KiB")

    def test_stdin_deadline_expires_before_a_closed_object_arrives(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            ticks = {"n": 0}

            def now() -> float:
                ticks["n"] += 1
                return 0.0 if ticks["n"] == 1 else 20.0

            _code, body = invoke(
                module,
                {},
                write_config(Path(tmp)),
                stdin_bytes=b"",
                now=now,
            )
            self.assertEqual(body["error"]["code"], "app_update_invalid_request")
            self.assertRegex(body["error"]["message"], r"10 second")


class ReceiptLifecycleTests(unittest.TestCase):
    def test_start_missing_is_recovery_required_and_status_missing_is_unavailable(self) -> None:
        module = load_helper()
        missing = "11111111-1111-4111-8111-111111111111"
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            config_path = write_config(Path(tmp))
            _code, start_body = invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": missing,
                },
                config_path,
            )
            _code, status_body = invoke(module, {"op": "status", "requestId": missing}, config_path)
            self.assertEqual(start_body["error"]["code"], "app_update_recovery_required")
            self.assertEqual(status_body["error"]["code"], "app_update_unavailable")

    def test_expired_prepare_cannot_start_and_does_not_recreate_a_receipt(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            clock = {"t": 1_000_000.0}
            config_path, effects, _code, prepared = _prepare(module, root, now=lambda: clock["t"])
            clock["t"] += 601
            _code, body = invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
                now=lambda: clock["t"],
            )
            self.assertEqual(body["error"]["code"], "app_update_expired")
            self.assertEqual(effects.calls, [])
            self.assertTrue((root / "receipts" / (prepared["requestId"] + ".json")).is_file())

    def test_start_launches_systemd_job_and_repeat_does_not_recreate_it(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            config_path, effects, _code, prepared = _prepare(module, root)
            first = invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )[1]
            self.assertEqual(first["stage"], "launching")
            self.assertEqual(first["outcome"], "running")
            self.assertTrue(first["jobId"].startswith("openkit-app-update-"))
            self.assertTrue(any(call[:1] == ["systemd-run"] for call in effects.calls))
            self.assertTrue(any("--apply" in call for call in effects.calls))
            before = list(effects.calls)
            second = invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )[1]
            self.assertEqual(second["requestId"], first["requestId"])
            self.assertEqual(second["stage"], "launching")
            self.assertEqual(effects.calls, before)

    def test_launch_intent_without_a_live_job_becomes_terminal_unknown(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            clock = {"t": 1_000_000.0}
            config_path, effects, _code, prepared = _prepare(module, root, now=lambda: clock["t"])
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
                now=lambda: clock["t"],
            )
            effects.active_units.clear()
            clock["t"] += 31
            body = invoke(
                module,
                {"op": "status", "requestId": prepared["requestId"]},
                config_path,
                effects=effects,
                now=lambda: clock["t"],
            )[1]
            self.assertEqual(body["stage"], "unknown")
            self.assertEqual(body["outcome"], "unknown")
            resume = invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
                now=lambda: clock["t"],
            )[1]
            self.assertEqual(resume["stage"], "unknown")
            self.assertEqual(sum(1 for call in effects.calls if call[:1] == ["systemd-run"]), 1)

    def test_symlink_corrupt_and_contradictory_receipts_require_recovery(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            config_path, _effects, _code, prepared = _prepare(module, root)
            receipt = root / "receipts" / (prepared["requestId"] + ".json")
            payload = json.loads(receipt.read_text(encoding="utf-8"))
            payload["stage"] = "succeeded"
            payload["outcome"] = "succeeded"
            payload["candidateBoot"] = None
            receipt.write_text(json.dumps(payload), encoding="utf-8")
            body = invoke(
                module,
                {"op": "status", "requestId": prepared["requestId"]},
                config_path,
            )[1]
            self.assertEqual(body["error"]["code"], "app_update_recovery_required")

            other = "22222222-2222-4222-8222-222222222222"
            target = root / "receipts" / "outside.txt"
            target.write_text("nope", encoding="utf-8")
            link = root / "receipts" / (other + ".json")
            link.symlink_to(target)
            body = invoke(module, {"op": "status", "requestId": other}, config_path)[1]
            self.assertEqual(body["error"]["code"], "app_update_recovery_required")

    def test_prepare_refuses_a_full_receipt_directory(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            config_path = write_config(root)
            receipts = root / "receipts"
            for index in range(1000):
                (receipts / ("%s.json" % index)).write_text("{}", encoding="utf-8")
            body = invoke(
                module,
                {
                    "expectedCurrentImageId": DIGEST,
                    "op": "prepare",
                    "source": RELEASE_SOURCE,
                },
                config_path,
            )[1]
            self.assertEqual(body["error"]["code"], "app_update_capacity")

    def test_unconfigured_helper_reports_unconfigured(self) -> None:
        module = load_helper()
        stdout = io.StringIO()
        code = module.main(
            argv=["app-update-helper.py", "--config", "/tmp/missing-openkit-helper.json"],
            stdin=io.BytesIO(
                b'{"op":"status","requestId":"11111111-1111-4111-8111-111111111111"}\n'
            ),
            stdout=stdout,
            effects=RecordingEffects(),
            now=lambda: 1.0,
            environ={},
        )
        body = json.loads(stdout.getvalue())
        self.assertEqual(code, 0)
        self.assertEqual(body["error"]["code"], "app_update_unconfigured")


class ApplyJobTests(unittest.TestCase):
    def test_release_apply_uses_a2_shape_stages_web_before_stop_and_leaves_config(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            config_path, effects, _code, prepared = _prepare(module, root)
            config_before = (root / "data" / "config" / "server.jsonc").read_text(encoding="utf-8")
            start = invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )[1]
            effects.status_probe = {"requestId": prepared["requestId"]}
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "succeeded", body)
            self.assertEqual(body["outcome"], "succeeded")
            self.assertEqual(body["candidateImageId"], DIGEST)
            self.assertEqual(body["previousAppRestored"], False)
            self.assertEqual(body["candidateBoot"]["sourceCommit"], COMMIT)
            self.assertTrue(body["predicates"]["imageMatch"])
            self.assertTrue(body["predicates"]["sourceMatch"])
            self.assertTrue(body["predicates"]["webAssets"])
            self.assertTrue(body["predicates"]["nanohostReady"])
            docker = [call for call in effects.calls if call and call[0] == "docker"]
            self.assertTrue(any(call[:2] == ["docker", "pull"] and DIGEST in call[2] for call in docker))
            create_index = next(i for i, call in enumerate(docker) if call[:2] == ["docker", "create"])
            cp_index = next(i for i, call in enumerate(docker) if call[:2] == ["docker", "cp"])
            stop_index = next(
                i for i, call in enumerate(docker) if call[:2] == ["docker", "stop"] and CONTAINER in call
            )
            run = [call for call in docker if call[:2] == ["docker", "run"] and "--detach" in call][0]
            run_index = docker.index(run)
            self.assertLess(create_index, stop_index)
            self.assertLess(cp_index, stop_index)
            self.assertLess(stop_index, run_index)
            self.assertIn("--network", run)
            self.assertIn("host", run)
            self.assertTrue(any(item.startswith(effects.data_root + ":/data/openkit") for item in run))
            self.assertTrue(any("/run/secrets/openkit-vault.key" in item for item in run))
            self.assertTrue(any("/run/nanohost-credentials" in item for item in run))
            self.assertIn(
                "type=bind,src=%s,dst=%s,readonly" % (effects.ssh_identity, APP_UPDATE_IDENTITY_DEST),
                run,
            )
            self.assertIn(
                "type=bind,src=%s,dst=%s,readonly" % (effects.ssh_known_hosts, APP_UPDATE_KNOWN_HOSTS_DEST),
                run,
            )
            self.assertIn("--log-opt", run)
            self.assertIn("--runtime", run)
            self.assertEqual(run[run.index("--runtime") + 1], "runc")
            self.assertFalse(any(call[:1] == ["systemctl"] and "nanohost" in " ".join(call).lower() for call in effects.calls))
            self.assertEqual(str((root / "web" / "current").readlink()), COMMIT)
            self.assertTrue((root / "web" / COMMIT / "index.html").is_file())
            self.assertEqual(
                (root / "data" / "config" / "server.jsonc").read_text(encoding="utf-8"),
                config_before,
            )
            self.assertIn(HTTPS_SAMPLE, config_before)
            self.assertEqual(start["jobId"], body["jobId"])
            self.assertTrue(any(url.endswith("/api/app/auth/tokens") for url in effects.http_calls))
            self.assertFalse(any(url.endswith("/api/app/workspaces") for url in effects.http_calls))
            self.assertTrue(body["predicates"]["retainedAuthRead"])

    def test_app_update_ssh_rw_or_missing_refuses_before_stop(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.omit_app_update_ssh = True
            config_path, effects, _code, prepared = _prepare(module, root, effects=effects)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed", body)
            self.assertRegex(body["error"] or "", r"App-update SSH")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.ssh_rw = True
            config_path, effects, _code, prepared = _prepare(module, root, effects=effects)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed", body)
            self.assertRegex(body["error"] or "", r"readonly")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

    def test_commit_source_uses_configured_branch_or_staged_archive(self) -> None:
        module = load_helper()
        commit_source = {"kind": "commit", "sourceCommit": COMMIT}
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.ancestor_ok = False
            config_path, effects, _code, prepared = _prepare(
                module, root, source=commit_source, effects=effects
            )
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed")
            self.assertRegex(body["error"] or "", r"reachable|staged")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            config_path, effects, _code, prepared = _prepare(
                module, root, source=commit_source, effects=effects
            )
            _write_staged_archive(module, root, COMMIT)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            effects.status_probe = {"requestId": prepared["requestId"]}
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "succeeded", body)
            self.assertTrue(any("build-image.sh" in " ".join(call) for call in effects.calls))
            self.assertFalse(any(call[:2] == ["docker", "pull"] for call in effects.calls))

    def test_verify_failure_restores_previous_app_and_exact_web_assets(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            config_path, effects, _code, prepared = _prepare(module, root)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            effects.accepting_product_work_after = False
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed")
            self.assertEqual(body["previousAppRestored"], True)
            self.assertTrue(
                any(call[:2] == ["docker", "start"] and call[-1] == CONTAINER for call in effects.calls)
            )
            self.assertEqual(str((root / "web" / "current").readlink()), PREV_COMMIT)

    def test_assessment_mismatch_refuses_before_stop(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            config_path, effects, _code, prepared = _prepare(module, root)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            effects.applied_migrations = ["core_0000_setup", "core_0001_extra"]
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed")
            self.assertNotEqual(body.get("previousAppRestored"), True)
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))
            self.assertEqual(str((root / "web" / "current").readlink()), PREV_COMMIT)

    def test_privileged_or_device_hostconfig_refuses_before_stop(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.privileged = True
            config_path, effects, _code, prepared = _prepare(module, root, effects=effects)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

    def test_standard_runc_is_admitted_and_custom_runtime_refuses_before_stop(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.runtime = "runc"
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "succeeded", body)
            run = [call for call in effects.calls if call[:2] == ["docker", "run"] and "--detach" in call][0]
            self.assertIn("--runtime", run)
            self.assertEqual(run[run.index("--runtime") + 1], "runc")

        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.runtime = "sysbox-runc"
            config_path, effects, _code, prepared = _prepare(module, root, effects=effects)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed", body)
            self.assertRegex(body["error"] or "", r"runtime is unsupported")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.runtime = ""
            config_path, effects, _code, prepared = _prepare(module, root, effects=effects)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed", body)
            self.assertRegex(body["error"] or "", r"runtime is unsupported")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

    def test_empty_web_extract_refuses_before_stop(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.extract_empty = True
            config_path, effects, _code, prepared = _prepare(module, root, effects=effects)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))
            self.assertEqual(str((root / "web" / "current").readlink()), PREV_COMMIT)

    def test_os_lock_reports_busy_instead_of_stacking_jobs(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            config_path, effects, _code, first = _prepare(module, root)
            second = invoke(
                module,
                {
                    "expectedCurrentImageId": DIGEST,
                    "op": "prepare",
                    "source": RELEASE_SOURCE,
                },
                config_path,
                effects=effects,
            )[1]
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": first["requestId"],
                },
                config_path,
                effects=effects,
            )
            lock = open(root / "update.lock", "a+b")
            self.addCleanup(lock.close)
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            body = invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": second["requestId"],
                },
                config_path,
                effects=effects,
            )[1]
            self.assertEqual(body["error"]["code"], "app_update_busy")

    def test_published_digest_and_current_image_mismatches_leave_the_app_running(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.repo_digests = ["ghcr.io/example/openkit-app@" + OTHER_DIGEST]
            config_path, effects, _code, prepared = _prepare(module, root, effects=effects)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.inspect_image = OTHER_DIGEST
            effects.image_id = OTHER_DIGEST
            effects.repo_digests = ["ghcr.io/example/openkit-app@" + OTHER_DIGEST]
            config_path, effects, _code, prepared = _prepare(module, root, effects=effects)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

    def test_redacts_secret_shaped_command_errors_in_receipts(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            config_path, effects, _code, prepared = _prepare(module, root)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            effects.pull_error = "registry denied okt_should_not_leak"
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed")
            self.assertNotIn("okt_", body["error"] or "")
            self.assertIn("[redacted]", body["error"] or "")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))


def _start_apply(module, root: Path, source=None, effects=None, **config):
    config_path, effects, _code, prepared = _prepare(module, root, source=source, effects=effects, **config)
    invoke(
        module,
        {
            "maintenanceConsent": True,
            "op": "start",
            "requestId": prepared["requestId"],
        },
        config_path,
        effects=effects,
    )
    effects.status_probe = {"requestId": prepared["requestId"]}
    body = invoke(
        module,
        {},
        config_path,
        effects=effects,
        extra_argv=["--apply", prepared["requestId"]],
        stdin_bytes=b"",
    )[1]
    return config_path, effects, prepared, body


def _write_staged_archive(module, root: Path, commit: str) -> Path:
    staged = root / "staged" / commit
    staged.mkdir(parents=True)
    (staged / "scripts" / "docker").mkdir(parents=True)
    (staged / "scripts" / "docker" / "build-image.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    digest = module.digest_tree(str(staged), exclude=("IDENTITY.json",))
    (staged / "IDENTITY.json").write_text(
        json.dumps({"contentDigest": digest, "sourceCommit": commit}),
        encoding="utf-8",
    )
    os.chmod(staged / "IDENTITY.json", 0o444)
    return staged


class ContractCorrectionTests(unittest.TestCase):
    def test_prepare_and_start_emit_json_null_predicates(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            config_path, effects, _code, prepared = _prepare(module, root)
            self.assertIsNone(prepared["predicates"])
            started = invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )[1]
            self.assertEqual(started["stage"], "launching")
            self.assertIsNone(started["predicates"])

    def test_succeeded_source_commit_is_verified_acquisition_not_diagnostics(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            _config_path, effects, _prepared, body = _start_apply(module, root)
            self.assertEqual(body["stage"], "succeeded", body)
            self.assertTrue(effects.diagnostics_payloads)
            for payload in effects.diagnostics_payloads:
                self.assertNotIn("sourceCommit", payload)
                self.assertNotIn("sourceCommit", payload.get("boot") or {})
            self.assertTrue(any("ls-remote" in call for call in effects.calls))
            self.assertTrue(any(call[:3] == ["docker", "buildx", "imagetools"] for call in effects.calls))
            self.assertEqual(body["candidateBoot"]["sourceCommit"], effects.ls_remote_commit)
            self.assertEqual(body["candidateBoot"]["imageId"], DIGEST)
            receipt = json.loads(
                (root / "receipts" / (body["requestId"] + ".json")).read_text(encoding="utf-8")
            )
            self.assertEqual(receipt["sourceImageMap"]["sourceCommit"], effects.ls_remote_commit)
            self.assertEqual(receipt["sourceImageMap"]["imageId"], DIGEST)

    def test_release_sha_tag_mismatch_is_not_tag_self_equality(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.release_sha_digest = OTHER_DIGEST
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "failed")
            self.assertRegex(body["error"] or "", r"attribution|source-revision|sha-")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

    def test_fetch_builds_clean_archive_not_dirty_source_workdir(self) -> None:
        module = load_helper()
        commit_source = {"kind": "commit", "sourceCommit": COMMIT}
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            dirty = root / "src" / "dirty-uncommitted.txt"
            config_path, effects, _code, prepared = _prepare(module, root, source=commit_source)
            dirty.write_text("not part of the commit\n", encoding="utf-8")
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            effects.status_probe = {"requestId": prepared["requestId"]}
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "succeeded", body)
            self.assertTrue(any("archive" in call for call in effects.calls))
            builds = [call for call in effects.calls if any("build-image.sh" in item for item in call)]
            self.assertTrue(builds)
            build_context = Path(builds[0][1]).parents[2]
            self.assertNotEqual(build_context.resolve(), (root / "src").resolve())
            self.assertFalse((build_context / "dirty-uncommitted.txt").exists())
            self.assertEqual(body["candidateBoot"]["sourceCommit"], effects.rev_parse_commit)

    def test_staged_content_digest_mismatch_refuses_before_stop(self) -> None:
        module = load_helper()
        commit_source = {"kind": "commit", "sourceCommit": COMMIT}
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            staged = root / "staged" / COMMIT
            staged.mkdir(parents=True)
            (staged / "IDENTITY.json").write_text(
                json.dumps({"contentDigest": DIGEST, "sourceCommit": COMMIT}),
                encoding="utf-8",
            )
            (staged / "scripts" / "docker").mkdir(parents=True)
            (staged / "scripts" / "docker" / "build-image.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            _config_path, effects, _prepared, body = _start_apply(
                module, root, source=commit_source
            )
            self.assertEqual(body["stage"], "failed")
            self.assertRegex(body["error"] or "", r"content digest|contentDigest")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

    def test_running_previous_dataroot_user_refuses_before_stop(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            config_path, effects, _code, prepared = _prepare(module, root, effects=effects)
            effects.containers.add(PREVIOUS)
            effects.running.add(PREVIOUS)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed")
            self.assertRegex(body["error"] or "", r"Data Root|writable")
            self.assertFalse(
                any(call[:2] == ["docker", "stop"] and call[-1] == CONTAINER for call in effects.calls)
            )

    def test_aside_name_collision_refuses_before_rename(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            config_path, effects, _code, prepared = _prepare(module, root, effects=effects)
            aside = "%s-pre-%s" % (PREVIOUS, prepared["requestId"].split("-")[0])
            effects.containers.update({PREVIOUS, aside})
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed")
            self.assertRegex(body["error"] or "", r"aside|already exists|collision")
            self.assertFalse(any(call[:2] == ["docker", "rename"] for call in effects.calls))
            self.assertFalse(
                any(call[:2] == ["docker", "stop"] and call[-1] == CONTAINER for call in effects.calls)
            )

    def test_failed_candidate_stop_requires_recovery_without_second_writer(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.fail_restore_stop = True
            effects.accepting_product_work_after = False
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "recovery_required")
            self.assertNotEqual(body.get("previousAppRestored"), True)
            self.assertFalse(any(call[:2] == ["docker", "start"] for call in effects.calls))

    def test_retained_auth_uses_token_metadata_not_workspaces(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.tokens_after = {
                "items": [
                    token_record(tokenId="tok_b", ownerUserId="user_other"),
                    token_record(tokenId="tok_a"),
                ]
            }
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "failed")
            self.assertRegex(body["error"] or "", r"retained")
            self.assertIn("retainedAuthRead", (body.get("predicates") or {}))
            self.assertIs(body["predicates"]["retainedAuthRead"], False)
            self.assertTrue(any(url.endswith("/api/app/auth/tokens") for url in effects.http_calls))
            self.assertFalse(any(url.endswith("/api/app/workspaces") for url in effects.http_calls))

        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.tokens_after = {
                "items": [
                    token_record(
                        lastUsedAt="2026-09-10T01:00:00.000Z",
                        lastUsedChannel="app-api",
                        lastUsedSource="127.0.0.1",
                        tokenId="tok_b",
                    ),
                    token_record(
                        lastUsedAt="2026-09-10T01:02:00.000Z",
                        lastUsedChannel="app-api",
                        lastUsedSource="127.0.0.1",
                        tokenId="tok_a",
                    ),
                ]
            }
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "succeeded", body)
            self.assertTrue(body["predicates"]["retainedAuthRead"])
            self.assertTrue(any(url.endswith("/api/app/auth/tokens") for url in effects.http_calls))
            self.assertFalse(any(url.endswith("/api/app/workspaces") for url in effects.http_calls))

        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.tokens = {"items": []}
            config_path, effects, _code, prepared = _prepare(module, root, effects=effects)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed", body)
            self.assertRegex(body["error"] or "", r"empty")
            self.assertTrue(any(url.endswith("/api/app/auth/tokens") for url in effects.http_calls))
            self.assertFalse(any(url.endswith("/api/app/workspaces") for url in effects.http_calls))
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            malformed = token_record(tokenId="tok_a")
            del malformed["ownerUserId"]
            effects.tokens = {"items": [malformed, token_record(tokenId="tok_b")]}
            config_path, effects, _code, prepared = _prepare(module, root, effects=effects)
            invoke(
                module,
                {
                    "maintenanceConsent": True,
                    "op": "start",
                    "requestId": prepared["requestId"],
                },
                config_path,
                effects=effects,
            )
            body = invoke(
                module,
                {},
                config_path,
                effects=effects,
                extra_argv=["--apply", prepared["requestId"]],
                stdin_bytes=b"",
            )[1]
            self.assertEqual(body["stage"], "failed", body)
            self.assertRegex(body["error"] or "", r"public Token")
            self.assertTrue(any(url.endswith("/api/app/auth/tokens") for url in effects.http_calls))
            self.assertFalse(any(url.endswith("/api/app/workspaces") for url in effects.http_calls))
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

    def test_annotated_tag_peels_to_commit_and_refuses_mismatch(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            origin = root / "origin.git"
            peeled, tag_object = _init_annotated_release_repo(origin, "v0.1.0")
            self.assertNotEqual(peeled, tag_object)
            suppressed = subprocess.run(
                ["git", "ls-remote", "--refs", str(origin), "refs/tags/v0.1.0^{}"],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(suppressed.stdout.strip(), "")
            source = {
                "appDigest": DIGEST,
                "kind": "release",
                "sourceCommit": peeled,
                "tag": "v0.1.0",
            }
            effects = RecordingEffects()
            effects.real_ls_remote = True
            _config_path, effects, _prepared, matched = _start_apply(
                module,
                root,
                source=source,
                effects=effects,
                sourceRepository=str(origin),
            )
            self.assertEqual(matched["stage"], "succeeded", matched)
            self.assertEqual(matched["candidateBoot"]["sourceCommit"], peeled)
            self.assertTrue(
                any(call[:2] == ["git", "ls-remote"] and "--refs" not in call for call in effects.calls)
            )
            self.assertFalse(any("--refs" in call for call in effects.calls if "ls-remote" in call))

            mismatch_source = dict(source)
            mismatch_source["sourceCommit"] = OTHER_COMMIT
            effects_mismatch = RecordingEffects()
            effects_mismatch.real_ls_remote = True
            _config_path, effects_mismatch, _prepared, mismatched = _start_apply(
                module,
                root,
                source=mismatch_source,
                effects=effects_mismatch,
                sourceRepository=str(origin),
            )
            self.assertEqual(mismatched["stage"], "failed")
            self.assertRegex(mismatched["error"] or "", r"commit|source")
            self.assertEqual(mismatched.get("candidateBoot", {}).get("sourceCommit") if mismatched.get("candidateBoot") else None, None)
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects_mismatch.calls))
            self.assertFalse(any(call[:2] == ["docker", "pull"] for call in effects_mismatch.calls))


class OwnerAmendmentTests(unittest.TestCase):
    def test_missing_previous_boot_refuses_before_stop(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.boot_payload_before = {}
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "failed", body)
            self.assertRegex(body["error"] or "", r"Previous App boot")
            self.assertFalse(body.get("previousBoot"))
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

    def test_malformed_previous_boot_refuses_before_stop(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.boot_payload_before = {
                "acceptingProductWork": True,
                "bootId": PREVIOUS_BOOT_ID,
                "overall": "ready",
                "subsystems": {
                    "storage": {
                        "reasons": [{"code": "storage.index-rebuilt", "message": "Rebuilt."}],
                        "state": "ready",
                    }
                },
            }
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "failed", body)
            self.assertRegex(body["error"] or "", r"Previous App boot")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

    def test_nonempty_blocks_fail_closed_and_retain_reason_code(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.nanohost_generation_after = 8
            effects.boot_payload_after = typed_boot(
                CANDIDATE_BOOT_ID,
                vault={
                    "reasons": [
                        boot_reason("vault.locked", "Vault is locked.", ["vault.read"]),
                    ],
                    "state": "degraded",
                },
            )
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "failed", body)
            self.assertIs(body["predicates"]["noBlockingReadiness"], False)
            self.assertIn("vault.locked", body["candidateBoot"]["blockingReasons"])
            self.assertNotIn("blocks", body["candidateBoot"])
            self.assertTrue(any(call[:2] == ["docker", "stop"] for call in effects.calls))

    def test_malformed_candidate_reasons_fail_closed(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.nanohost_generation_after = 8
            effects.boot_payload_after = typed_boot(CANDIDATE_BOOT_ID)
            effects.boot_payload_after["subsystems"]["scheduler"] = {
                "reasons": ["scheduler.checkpoint_recovery_required"],
                "state": "degraded",
            }
            effects.boot_payload_after["overall"] = "degraded"
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "failed", body)
            self.assertRegex(body["error"] or "", r"boot observation is missing|noBlockingReadiness|malformed")
            self.assertTrue(any(call[:2] == ["docker", "stop"] for call in effects.calls))

    def test_nonblocking_warning_is_retained_without_admitted_codes(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.nanohost_generation_after = 8
            effects.boot_payload_after = typed_boot(
                CANDIDATE_BOOT_ID,
                scheduler={
                    "reasons": [
                        boot_reason(
                            "scheduler.checkpoint_recovery_required",
                            "Scheduler checkpoint recovery is required.",
                        )
                    ],
                    "state": "degraded",
                },
                storage={
                    "reasons": [boot_reason("storage.index-rebuilt", "Storage index was rebuilt.")],
                    "state": "degraded",
                },
            )
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "succeeded", body)
            self.assertTrue(body["predicates"]["noBlockingReadiness"])
            self.assertTrue(body["predicates"]["acceptingProductWork"])
            self.assertEqual(
                body["candidateBoot"]["blockingReasons"],
                ["storage.index-rebuilt", "scheduler.checkpoint_recovery_required"],
            )
            self.assertNotIn("overall", body["candidateBoot"])
            self.assertNotIn("blocks", body["candidateBoot"])

    def test_critical_failed_cannot_pass(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.nanohost_generation_after = 8
            effects.boot_payload_after = typed_boot(
                CANDIDATE_BOOT_ID,
                accepting=True,
                overall="ready",
                storage={
                    "reasons": [
                        boot_reason(
                            "storage.migration_failed",
                            "Storage migration failed.",
                            ["product_work"],
                        )
                    ],
                    "state": "failed",
                },
            )
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "failed", body)
            self.assertTrue(any(call[:2] == ["docker", "stop"] for call in effects.calls))
            predicates = body.get("predicates") or {}
            self.assertFalse(
                predicates.get("noBlockingReadiness") is True and predicates.get("acceptingProductWork") is True
            )

    def test_nanohost_equal_generation_fails(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.nanohost_generation_after = 7
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "failed", body)
            self.assertIs(body["predicates"]["nanohostReady"], False)

    def test_nanohost_lower_generation_fails(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.nanohost_generation_after = 6
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "failed", body)
            self.assertIs(body["predicates"]["nanohostReady"], False)

    def test_nanohost_different_identity_fails(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.nanohost_generation_after = 8
            effects.nanohost_identity_after = "other-nanohost"
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "failed", body)
            self.assertIs(body["predicates"]["nanohostReady"], False)

    def test_nanohost_successor_generation_passes(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.nanohost_generation_after = 8
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "succeeded", body)
            self.assertTrue(body["predicates"]["nanohostReady"])
            self.assertFalse(
                any(call[:1] == ["systemctl"] and "nanohost" in " ".join(call).lower() for call in effects.calls)
            )


class ReviewFindingTests(unittest.TestCase):
    def test_httperror_parses_bounded_json_body(self) -> None:
        module = load_helper()
        payload = api_error("nanohost_runtime_target_not_found")
        url, closer = _serve_json(404, payload)
        try:
            status, body = module.CommandEffects().http_get(url, timeout=2)
        finally:
            closer()
        self.assertIsInstance(body, dict)
        self.assertEqual(status, 404)
        self.assertEqual(body.get("code"), "nanohost_runtime_target_not_found")

    def test_typed_nanohost_absence_is_null_ready(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.nanohost_identity = None
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "succeeded", body)
            self.assertIsNone(body["predicates"]["nanohostReady"])
            self.assertTrue(any(call[:2] == ["docker", "stop"] for call in effects.calls))

    def test_non_server_mode_404_fails_before_stop(self) -> None:
        self._assert_nanohost_fails_before_stop(
            404, api_error("nanohost_transport_admin_server_mode_required")
        )

    def test_forbidden_nanohost_fails_before_stop(self) -> None:
        self._assert_nanohost_fails_before_stop(403, api_error("nanohost_transport_admin_forbidden"))

    def test_unavailable_nanohost_fails_before_stop(self) -> None:
        self._assert_nanohost_fails_before_stop(503, api_error("nanohost_transport_storage_unavailable"))

    def test_transport_failure_fails_before_stop(self) -> None:
        self._assert_nanohost_fails_before_stop(0, None)

    def test_malformed_200_nanohost_fails_before_stop(self) -> None:
        self._assert_nanohost_fails_before_stop(200, None)

    def test_integer_ready_fails_before_stop(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.nanohost_http = (
                200,
                {
                    "connectionGeneration": 7,
                    "deploymentId": "staging-a2",
                    "freshEmpty": True,
                    "identityId": "staging-nanohost-a2",
                    "observedAt": "2026-09-10T00:00:00.000Z",
                    "predecessorFenced": True,
                    "ready": 1,
                },
            )
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "failed", body)
            self.assertRegex(body["error"] or "", r"NanoHost")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

    def test_silent_degraded_previous_boot_fails_before_stop(self) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.boot_payload_before = typed_boot(
                PREVIOUS_BOOT_ID,
                vault={"reasons": [], "state": "degraded"},
            )
            _config_path, effects, _prepared, body = _start_apply(module, root, effects=effects)
            self.assertEqual(body["stage"], "failed", body)
            self.assertRegex(body["error"] or "", r"Previous App boot")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))

    def _assert_nanohost_fails_before_stop(self, status: int, body: Any) -> None:
        module = load_helper()
        with tempfile.TemporaryDirectory(prefix="openkit-app-update-") as tmp:
            root = Path(tmp)
            effects = RecordingEffects()
            effects.nanohost_http = (status, body)
            _config_path, effects, _prepared, result = _start_apply(module, root, effects=effects)
            self.assertEqual(result["stage"], "failed", result)
            self.assertRegex(result["error"] or "", r"NanoHost")
            self.assertFalse(any(call[:2] == ["docker", "stop"] for call in effects.calls))


def _serve_json(status: int, payload: Optional[dict]) -> Tuple[str, Callable[[], None]]:
    raw = b"" if payload is None else json.dumps(payload).encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            if raw:
                self.wfile.write(raw)

        def log_message(self, format: str, *args: Any) -> None:
            return

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()
    host, port = server.server_address

    def closer() -> None:
        thread.join(timeout=2)
        server.server_close()

    return "http://%s:%s/" % (host, port), closer


def _init_annotated_release_repo(repo: Path, tag: str) -> Tuple[str, str]:
    repo.mkdir(parents=True)
    env = {
        "GIT_AUTHOR_DATE": "2026-09-10T00:00:00",
        "GIT_AUTHOR_EMAIL": "dev@openkit.invalid",
        "GIT_AUTHOR_NAME": "OpenKit",
        "GIT_COMMITTER_DATE": "2026-09-10T00:00:00",
        "GIT_COMMITTER_EMAIL": "dev@openkit.invalid",
        "GIT_COMMITTER_NAME": "OpenKit",
        "HOME": str(repo),
        "PATH": os.environ.get("PATH", ""),
    }
    subprocess.run(["git", "init", "--initial-branch=main"], cwd=repo, check=True, capture_output=True, env=env)
    subprocess.run(["git", "config", "user.email", "dev@openkit.invalid"], cwd=repo, check=True, capture_output=True, env=env)
    subprocess.run(["git", "config", "user.name", "OpenKit"], cwd=repo, check=True, capture_output=True, env=env)
    (repo / "README").write_text("annotated-release\n", encoding="utf-8")
    subprocess.run(["git", "add", "README"], cwd=repo, check=True, capture_output=True, env=env)
    subprocess.run(["git", "commit", "-m", "annotated release"], cwd=repo, check=True, capture_output=True, env=env)
    subprocess.run(["git", "tag", "-a", tag, "-m", "annotated %s" % tag], cwd=repo, check=True, capture_output=True, env=env)
    peeled = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True, env=env
    ).stdout.strip()
    tag_object = subprocess.run(
        ["git", "rev-parse", tag], cwd=repo, check=True, capture_output=True, text=True, env=env
    ).stdout.strip()
    return peeled, tag_object


if __name__ == "__main__":
    unittest.main()
