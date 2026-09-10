#!/usr/bin/env python3
"""Installed host helper for closed NanoCore/Web App-update commands."""

from __future__ import annotations

import fcntl
import hashlib
import io
import json
import os
import re
import select
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Set, Tuple

PRODUCTION_CONFIG_PATH = "/etc/openkit/app-update/helper.json"
STDIN_LIMIT_BYTES = 16 * 1024
STDIN_DEADLINE_SECONDS = 10
RECEIPT_LIMIT_BYTES = 64 * 1024
RECEIPT_CAPACITY = 1000
PREPARE_TTL_SECONDS = 600
LAUNCH_UNKNOWN_AFTER_SECONDS = 30
JOB_TIMEOUT_SECONDS = 1800
READY_TIMEOUT_SECONDS = 45
SCHEMA_VERSION = 1
IN_PROGRESS_STAGES = frozenset({"launching", "applying", "verifying"})
TERMINAL_STAGES = frozenset({"succeeded", "failed", "unknown", "recovery_required"})
ALLOWED_OPS = frozenset({"prepare", "start", "status"})
ERROR_CODES = frozenset(
    {
        "app_update_busy",
        "app_update_capacity",
        "app_update_expired",
        "app_update_invalid_request",
        "app_update_not_found",
        "app_update_recovery_required",
        "app_update_unconfigured",
        "app_update_unavailable",
    }
)
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
TAG_RE = re.compile(
    r"^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$"
)
BOOT_ID_RE = re.compile(
    r"^boot_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
SHELL_FRAGMENT_RE = re.compile(r"[;`|&$]|\$\(|\$\{")
SECRET_RE = re.compile(
    r"(^|[^A-Za-z0-9_])(sk-[A-Za-z0-9_-]+|hf_[A-Za-z0-9_-]+|ghp_[A-Za-z0-9_-]+|okt_[A-Za-z0-9_-]+)"
)
ADMITTED_NONBLOCKING = frozenset({"storage.index-rebuilt"})
REQUIRED_MOUNT_DESTS = (
    "/data/openkit",
    "/run/nanohost-credentials",
    "/srv/web",
    "/etc/caddy/Caddyfile",
    "/run/secrets/openkit-vault.key",
    "/run/openkit/app-update/id_ed25519",
    "/run/openkit/app-update/known_hosts",
)
APP_UPDATE_SSH_DESTS = (
    "/run/openkit/app-update/id_ed25519",
    "/run/openkit/app-update/known_hosts",
)
TOKEN_IDENTITY_KEYS = frozenset(
    {
        "expiresAt",
        "issuedAt",
        "ownerUserId",
        "predecessorTokenId",
        "revokedAt",
        "rotatedGraceExpiresAt",
        "scope",
        "status",
        "tokenId",
        "workspaceIds",
    }
)
TOKEN_LAST_USED_KEYS = frozenset({"lastUsedAt", "lastUsedChannel", "lastUsedSource"})
TOKEN_SCOPES = frozenset({"server-admin", "workspace", "workspace-readonly"})
TOKEN_STATUSES = frozenset({"active", "expired", "revoked", "rotated"})
CONFIG_KEYS = {
    "schemaVersion",
    "containerName",
    "dataRoot",
    "receiptDir",
    "lockPath",
    "sourceRepository",
    "sourceBranch",
    "sourceWorkDir",
    "stagedSourceDir",
    "imageRepository",
    "appBaseUrl",
    "helperArgv",
    "webAssetsDir",
    "vaultKeyFile",
    "nanohostCredentialsDir",
    "caddyfile",
    "compatibility",
    "adminTokenFile",
    "jobTimeoutSeconds",
    "prepareTtlSeconds",
    "launchUnknownAfterSeconds",
    "readyTimeoutSeconds",
}
REQUIRED_CONFIG_KEYS = (
    "containerName",
    "dataRoot",
    "receiptDir",
    "lockPath",
    "sourceRepository",
    "sourceBranch",
    "sourceWorkDir",
    "stagedSourceDir",
    "imageRepository",
    "appBaseUrl",
    "helperArgv",
    "webAssetsDir",
    "vaultKeyFile",
    "nanohostCredentialsDir",
    "caddyfile",
    "compatibility",
)
PREDICATE_KEYS = (
    "acceptingProductWork",
    "helperReachable",
    "imageMatch",
    "nanohostReady",
    "newBoot",
    "noBlockingReadiness",
    "retainedAuthRead",
    "sourceMatch",
    "webAssets",
)
PUBLIC_STATUS_KEYS = (
    "candidateBoot",
    "candidateImageId",
    "completedAt",
    "error",
    "expectedCurrentImageId",
    "jobId",
    "outcome",
    "predicates",
    "preparedAt",
    "previousAppRestored",
    "previousBoot",
    "previousImageId",
    "requestId",
    "source",
    "stage",
    "startedAt",
)


class HelperError(Exception):
    """Coded helper failure written to stdout."""

    def __init__(self, code: str, message: str) -> None:
        if code not in ERROR_CODES:
            code = "app_update_unavailable"
        super().__init__(message)
        self.code = code
        self.message = _redact(message)[:512] or "App-update helper failed."


class CommandEffects:
    """Default host-command and HTTP seam."""

    def run(self, argv: Sequence[str], timeout: Optional[float] = None) -> Tuple[int, str, str]:
        completed = subprocess.run(
            list(argv),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return completed.returncode, completed.stdout, completed.stderr

    def sleep(self, seconds: float) -> None:
        import time

        time.sleep(seconds)

    def http_get(
        self, url: str, headers: Optional[Mapping[str, str]] = None, timeout: Optional[float] = None
    ) -> Tuple[int, Any]:
        request = urllib.request.Request(url, headers=dict(headers or {}), method="GET")
        try:
            with urllib.request.urlopen(request, timeout=timeout or 15) as response:
                raw = response.read(RECEIPT_LIMIT_BYTES)
                if not raw:
                    return response.status, None
                return response.status, json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as error:
            return error.code, None
        except Exception:
            return 0, None


def main(
    argv: Optional[Sequence[str]] = None,
    stdin: Optional[Any] = None,
    stdout: Optional[Any] = None,
    effects: Optional[Any] = None,
    now: Optional[Callable[[], float]] = None,
    environ: Optional[Mapping[str, str]] = None,
) -> int:
    """Runs one helper invocation and writes a closed stdout envelope."""

    argv = list(sys.argv if argv is None else argv)
    stdin = sys.stdin.buffer if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    effects = CommandEffects() if effects is None else effects
    now = time_now if now is None else now
    environ = os.environ if environ is None else environ
    try:
        apply_id, config_path = _parse_argv(argv)
        config = load_config(config_path)
        helper = AppUpdateHelper(config, effects, now)
        if apply_id is not None:
            result = helper.apply(apply_id)
        else:
            command = read_command(stdin, now)
            result = helper.handle(command)
    except HelperError as error:
        result = host_error(error.code, error.message)
    except Exception:
        result = host_error("app_update_unavailable", "App-update helper could not complete.")
    stdout.write(json.dumps(result, separators=(",", ":"), sort_keys=True) + "\n")
    stdout.flush()
    return 0


def time_now() -> float:
    return datetime.now(timezone.utc).timestamp()


def isoformat(timestamp: float) -> str:
    return (
        datetime.fromtimestamp(timestamp, timezone.utc)
        .replace(microsecond=0)
        .strftime("%Y-%m-%dT%H:%M:%S.000Z")
    )


def _parse_argv(argv: Sequence[str]) -> Tuple[Optional[str], str]:
    apply_id = None
    config_path = PRODUCTION_CONFIG_PATH
    items = list(argv[1:])
    while items:
        item = items.pop(0)
        if item == "--apply":
            if not items:
                raise HelperError("app_update_invalid_request", "Apply requires a request id.")
            apply_id = items.pop(0)
            if not UUID_RE.match(apply_id):
                raise HelperError("app_update_invalid_request", "Apply request id is not a UUID.")
        elif item == "--config":
            if not items:
                raise HelperError("app_update_unconfigured", "Helper config path is missing.")
            config_path = items.pop(0)
            if not os.path.isabs(config_path):
                raise HelperError("app_update_unconfigured", "Helper config path must be absolute.")
        else:
            raise HelperError("app_update_invalid_request", "Helper argv is not a closed command.")
    return apply_id, config_path


def load_config(path: str) -> Dict[str, Any]:
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise HelperError(
            "app_update_unconfigured",
            "App update is disabled because deployment configuration is absent.",
        ) from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise HelperError("app_update_unconfigured", "Helper config must be a regular file.")
    try:
        with open(path, "rb") as handle:
            raw = handle.read(RECEIPT_LIMIT_BYTES + 1)
    except OSError as error:
        raise HelperError("app_update_unconfigured", "Helper config could not be read.") from error
    if len(raw) > RECEIPT_LIMIT_BYTES:
        raise HelperError("app_update_unconfigured", "Helper config exceeds the receipt limit.")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HelperError("app_update_unconfigured", "Helper config is not valid JSON.") from error
    if not isinstance(parsed, dict) or parsed.get("schemaVersion") != SCHEMA_VERSION:
        raise HelperError("app_update_unconfigured", "Helper config schema is unsupported.")
    extra = set(parsed) - CONFIG_KEYS
    if extra:
        raise HelperError("app_update_unconfigured", "Helper config contains unknown fields.")
    for key in REQUIRED_CONFIG_KEYS:
        if key not in parsed:
            raise HelperError("app_update_unconfigured", "Helper config is incomplete.")
    path_keys = (
        "dataRoot",
        "receiptDir",
        "lockPath",
        "sourceWorkDir",
        "stagedSourceDir",
        "webAssetsDir",
        "vaultKeyFile",
        "nanohostCredentialsDir",
        "caddyfile",
    )
    for key in path_keys:
        if not isinstance(parsed[key], str) or not os.path.isabs(parsed[key]):
            raise HelperError("app_update_unconfigured", "Helper paths must be absolute.")
    token = parsed.get("adminTokenFile")
    if token is not None and (not isinstance(token, str) or not os.path.isabs(token)):
        raise HelperError("app_update_unconfigured", "Helper paths must be absolute.")
    if not isinstance(parsed["helperArgv"], list) or not parsed["helperArgv"]:
        raise HelperError("app_update_unconfigured", "Helper argv must be a non-empty list.")
    if any(not isinstance(item, str) or not item for item in parsed["helperArgv"]):
        raise HelperError("app_update_unconfigured", "Helper argv entries must be strings.")
    try:
        parsed["compatibility"] = _require_compatibility(parsed.get("compatibility"))
    except HelperError as error:
        raise HelperError("app_update_unconfigured", error.message) from error
    data_root = os.path.realpath(parsed["dataRoot"])
    for key in ("receiptDir", "lockPath", "stagedSourceDir"):
        candidate = os.path.realpath(parsed[key]) if os.path.exists(parsed[key]) else parsed[key]
        if _path_inside(candidate, data_root):
            raise HelperError(
                "app_update_unconfigured",
                "Helper receipts and lock must stay outside Data Root.",
            )
    parsed.setdefault("jobTimeoutSeconds", JOB_TIMEOUT_SECONDS)
    parsed.setdefault("prepareTtlSeconds", PREPARE_TTL_SECONDS)
    parsed.setdefault("launchUnknownAfterSeconds", LAUNCH_UNKNOWN_AFTER_SECONDS)
    parsed.setdefault("readyTimeoutSeconds", READY_TIMEOUT_SECONDS)
    parsed.setdefault("adminTokenFile", None)
    return parsed


def read_command(stdin: Any, now: Callable[[], float]) -> Dict[str, Any]:
    raw, reason = _read_stdin(stdin, now)
    if reason == "timeout":
        raise HelperError("app_update_invalid_request", "Helper stdin exceeded the 10 second deadline.")
    if reason == "oversized":
        raise HelperError("app_update_invalid_request", "Helper stdin exceeds the 16 KiB limit.")
    if not raw:
        raise HelperError("app_update_invalid_request", "Helper stdin is empty.")
    if SHELL_FRAGMENT_RE.search(raw.decode("utf-8", errors="replace")):
        raise HelperError("app_update_invalid_request", "Helper stdin contains a shell fragment.")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HelperError("app_update_invalid_request", "Helper stdin is not valid JSON.") from error
    if not isinstance(parsed, dict):
        raise HelperError("app_update_invalid_request", "Helper stdin must be one JSON object.")
    op = parsed.get("op")
    if op not in ALLOWED_OPS:
        raise HelperError(
            "app_update_invalid_request",
            "App-update host command is not a closed prepare, start, or status request.",
        )
    if op == "prepare":
        allowed = {"expectedCurrentImageId", "op", "source"}
    elif op == "start":
        allowed = {"maintenanceConsent", "op", "requestId"}
    else:
        allowed = {"op", "requestId"}
    extra = set(parsed) - allowed
    if extra:
        raise HelperError("app_update_invalid_request", "Helper request contains unknown fields.")
    if "path" in parsed or "host" in parsed or "command" in parsed:
        raise HelperError("app_update_invalid_request", "Request data cannot choose a host path.")
    if op == "prepare":
        return {
            "op": "prepare",
            "expectedCurrentImageId": _require_digest(parsed.get("expectedCurrentImageId")),
            "source": _require_source(parsed.get("source")),
        }
    request_id = parsed.get("requestId")
    if not isinstance(request_id, str) or not UUID_RE.match(request_id):
        raise HelperError("app_update_invalid_request", "Request id must be a host UUID.")
    if op == "start" and parsed.get("maintenanceConsent") is not True:
        raise HelperError("app_update_invalid_request", "Start requires explicit maintenance consent.")
    command: Dict[str, Any] = {"op": op, "requestId": request_id.lower()}
    if op == "start":
        command["maintenanceConsent"] = True
    return command


def _read_stdin(stdin: Any, now: Callable[[], float]) -> Tuple[bytes, Optional[str]]:
    start = now()
    chunks: List[bytes] = []
    total = 0
    fileno = getattr(stdin, "fileno", None)
    can_select = False
    if callable(fileno):
        try:
            os.fstat(fileno())
            can_select = True
        except (OSError, ValueError, AttributeError, io.UnsupportedOperation):
            can_select = False
    while True:
        remaining = STDIN_DEADLINE_SECONDS - (now() - start)
        if remaining <= 0:
            return b"", "timeout"
        if can_select:
            ready, _, _ = select.select([stdin], [], [], remaining)
            if not ready:
                return b"", "timeout"
            chunk = os.read(fileno(), min(4096, STDIN_LIMIT_BYTES + 1 - total))
        else:
            chunk = stdin.read(min(4096, STDIN_LIMIT_BYTES + 1 - total))
            if isinstance(chunk, str):
                chunk = chunk.encode("utf-8")
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > STDIN_LIMIT_BYTES:
            return b"", "oversized"
    return b"".join(chunks), None


def _require_digest(value: Any) -> str:
    if not isinstance(value, str) or not DIGEST_RE.match(value):
        raise HelperError("app_update_invalid_request", "Image digest must be a sha256 identity.")
    return value


def _require_commit(value: Any) -> str:
    if not isinstance(value, str) or not COMMIT_RE.match(value):
        raise HelperError("app_update_invalid_request", "Git commit id must be 40 lowercase hex characters.")
    return value


def _require_source(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict) or "kind" not in value:
        raise HelperError("app_update_invalid_request", "Source must be a closed release or commit object.")
    kind = value["kind"]
    if kind == "release":
        extra = set(value) - {"appDigest", "kind", "sourceCommit", "tag"}
        if extra:
            raise HelperError("app_update_invalid_request", "Release source contains unknown fields.")
        tag = value.get("tag")
        if not isinstance(tag, str) or not TAG_RE.match(tag) or tag == "latest":
            raise HelperError("app_update_invalid_request", "Release tag must be an immutable version.")
        return {
            "appDigest": _require_digest(value.get("appDigest")),
            "kind": "release",
            "sourceCommit": _require_commit(value.get("sourceCommit")),
            "tag": tag,
        }
    if kind == "commit":
        extra = set(value) - {"kind", "sourceCommit"}
        if extra:
            raise HelperError("app_update_invalid_request", "Commit source contains unknown fields.")
        return {"kind": "commit", "sourceCommit": _require_commit(value.get("sourceCommit"))}
    raise HelperError("app_update_invalid_request", "Source kind is not admitted.")


def _require_compatibility(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise HelperError("app_update_unconfigured", "Helper compatibility assessment is missing.")
    extra = set(value) - {"appliedMigrations", "candidate", "currentImageId"}
    if extra or {"appliedMigrations", "candidate", "currentImageId"} - set(value):
        raise HelperError("app_update_unconfigured", "Helper compatibility assessment is not a closed object.")
    applied = value.get("appliedMigrations")
    if not isinstance(applied, list) or not applied or any(not isinstance(item, str) or not item for item in applied):
        raise HelperError("app_update_unconfigured", "Helper compatibility appliedMigrations is invalid.")
    return {
        "appliedMigrations": [str(item) for item in applied],
        "candidate": _require_source(value.get("candidate")),
        "currentImageId": _require_digest(value.get("currentImageId")),
    }


class AppUpdateHelper:
    """Filesystem receipts plus mocked-or-real host effects."""

    def __init__(self, config: Mapping[str, Any], effects: Any, now: Callable[[], float]) -> None:
        self.config = dict(config)
        self.effects = effects
        self.now = now
        os.makedirs(self.config["receiptDir"], mode=0o700, exist_ok=True)

    def handle(self, command: Mapping[str, Any]) -> Dict[str, Any]:
        op = command["op"]
        if op == "prepare":
            return self.prepare(command)
        if op == "start":
            return self.start(command["requestId"])
        return self.status(command["requestId"])

    def prepare(self, command: Mapping[str, Any]) -> Dict[str, Any]:
        self._assert_capacity()
        request_id = str(uuid.uuid4())
        prepared_at = isoformat(self.now())
        receipt = _blank_receipt(
            request_id=request_id,
            source=command["source"],
            expected_current_image_id=command["expectedCurrentImageId"],
            prepared_at=prepared_at,
        )
        self._write_receipt(receipt, exclusive=True)
        return project_status(receipt)

    def start(self, request_id: str) -> Dict[str, Any]:
        receipt = self._load_receipt(request_id, missing_code="app_update_recovery_required")
        receipt = self._maybe_mark_unknown(receipt)
        if receipt["stage"] != "prepared":
            return project_status(receipt)
        age = self.now() - _parse_iso(receipt["preparedAt"])
        if age > float(self.config["prepareTtlSeconds"]):
            raise HelperError("app_update_expired", "Prepared App-update receipt expired.")
        if self._busy_with_other(request_id):
            raise HelperError("app_update_busy", "An App update is already running for this target.")
        job_id = "openkit-app-update-%s.service" % request_id
        set_stage(receipt, "launching")
        receipt["startedAt"] = isoformat(self.now())
        receipt["jobId"] = job_id
        self._write_receipt(receipt)
        code, _, stderr = self.effects.run(
            [
                "systemd-run",
                "--collect",
                "--unit=openkit-app-update-%s" % request_id,
                "--property=Type=oneshot",
                "--property=TimeoutStartSec=%s" % int(self.config["jobTimeoutSeconds"]),
                "--no-block",
                "--",
                *list(self.config["helperArgv"]),
                "--apply",
                request_id,
            ],
            timeout=15,
        )
        if code != 0:
            set_stage(receipt, "unknown")
            receipt["completedAt"] = isoformat(self.now())
            receipt["error"] = _redact(stderr or "systemd-run failed to launch the update job.")[:512]
            self._write_receipt(receipt)
            return project_status(receipt)
        return project_status(receipt)

    def status(self, request_id: str) -> Dict[str, Any]:
        receipt = self._load_receipt(request_id, missing_code="app_update_unavailable")
        receipt = self._maybe_mark_unknown(receipt)
        return project_status(receipt)

    def apply(self, request_id: str) -> Dict[str, Any]:
        lock_handle = self._acquire_lock()
        try:
            receipt = self._load_receipt(request_id, missing_code="app_update_recovery_required")
            if receipt["stage"] in TERMINAL_STAGES:
                return project_status(receipt)
            if receipt["stage"] not in {"launching", "applying", "verifying", "prepared"}:
                raise HelperError("app_update_recovery_required", "Receipt lifecycle is contradictory.")
            set_stage(receipt, "applying")
            if receipt.get("startedAt") is None:
                receipt["startedAt"] = isoformat(self.now())
            if receipt.get("jobId") is None:
                receipt["jobId"] = "openkit-app-update-%s.service" % request_id
            self._write_receipt(receipt)
            try:
                inspect = self._inspect_container(self.config["containerName"])
                current_identity = self._image_identity(str(inspect.get("Image") or ""))
                if not identity_matches(receipt["expectedCurrentImageId"], current_identity):
                    raise HelperError(
                        "app_update_invalid_request",
                        "Running App image does not match the prepared current image.",
                    )
                self._assert_a2_shape(inspect, current_identity)
                if not identity_matches(self.config["compatibility"]["currentImageId"], current_identity):
                    raise HelperError(
                        "app_update_invalid_request",
                        "Running App image does not match the configured compatibility current image.",
                    )
                if receipt["source"] != self.config["compatibility"]["candidate"]:
                    raise HelperError(
                        "app_update_invalid_request",
                        "Prepared source does not match the configured compatibility candidate.",
                    )
                receipt["previousImageId"] = current_identity["id"]
                receipt["previousBoot"] = self._boot_from_diagnostics(current_identity["id"], None)
                self._snapshot_nanohost(receipt)
                self._snapshot_retained_auth(receipt)
                applied = self._live_applied_migrations()
                receipt["appliedMigrations"] = applied
                if applied != self.config["compatibility"]["appliedMigrations"]:
                    raise HelperError(
                        "app_update_invalid_request",
                        "Live applied migrations do not match the configured migration-free assessment.",
                    )
                self._write_receipt(receipt)
                candidate = self._acquire_candidate(receipt["source"])
                receipt["candidateLocalImageId"] = candidate["image_id"]
                receipt["candidateImageId"] = candidate["record_id"]
                receipt["candidateRef"] = candidate["ref"]
                receipt["sourceImageMap"] = {
                    "imageId": candidate["image_id"],
                    "publishedDigest": candidate["published_digest"],
                    "sourceCommit": candidate["source_commit"],
                }
                self._write_receipt(receipt)
                self._smoke(candidate["ref"])
                web_plan = self._stage_web_assets(candidate)
                retained = "%s-previous" % self.config["containerName"]
                receipt["retainedContainerName"] = retained
                receipt["previousWebAssets"] = web_plan["previous"]
                receipt["candidateWebAssets"] = web_plan["candidate"]
                receipt["webPreviousDigest"] = web_plan["previous_digest"]
                receipt["webStagedDigest"] = web_plan["staged_digest"]
                self._write_receipt(receipt)
                self._assert_exclusive_dataroot_users({self.config["containerName"]})
                self._aside_existing_previous(retained, request_id)
                self._run_required(
                    ["docker", "stop", "--time", "60", self.config["containerName"]],
                    "Failed to stop the running App.",
                )
                receipt["appStopped"] = True
                self._write_receipt(receipt)
                self._run_required(
                    ["docker", "rename", self.config["containerName"], retained],
                    "Failed to retain the previous App.",
                )
                live_digest = self._publish_web_assets(web_plan)
                receipt["webLiveDigest"] = live_digest
                run_argv = self._replacement_argv(inspect, candidate["ref"], candidate["source_commit"])
                code, _, stderr = self.effects.run(run_argv, timeout=60)
                if code != 0:
                    raise HelperError("app_update_unavailable", stderr or "Candidate App failed to start.")
                set_stage(receipt, "verifying")
                self._write_receipt(receipt)
                boot = self._verify(receipt, candidate)
                receipt["candidateBoot"] = boot
                if not isinstance(boot, dict) or not BOOT_ID_RE.match(str(boot.get("bootId") or "")):
                    raise HelperError(
                        "app_update_recovery_required",
                        "Succeeded App-update status requires the candidate boot identity.",
                    )
                if not COMMIT_RE.match(str(boot.get("sourceCommit") or "")):
                    raise HelperError(
                        "app_update_recovery_required",
                        "Succeeded App-update status requires an observed source identity.",
                    )
                set_stage(receipt, "succeeded")
                receipt["previousAppRestored"] = False
                receipt["completedAt"] = isoformat(self.now())
                receipt["error"] = None
                self._write_receipt(receipt)
                return project_status(receipt)
            except Exception as error:
                return self._fail_or_restore(receipt, error)
        finally:
            lock_handle.close()

    def _fail_or_restore(self, receipt: Dict[str, Any], error: Exception) -> Dict[str, Any]:
        if isinstance(error, HelperError):
            message = error.message
        else:
            message = _redact(str(error) or error.__class__.__name__)[:512]
        restored = False
        if receipt.get("appStopped"):
            try:
                self._restore_previous(receipt)
                restored = True
                set_stage(receipt, "failed")
            except Exception:
                restored = False
                set_stage(receipt, "recovery_required")
        else:
            set_stage(receipt, "failed")
        receipt["previousAppRestored"] = restored
        receipt["completedAt"] = isoformat(self.now())
        receipt["error"] = message
        self._write_receipt(receipt)
        return project_status(receipt)

    def _acquire_candidate(self, source: Mapping[str, Any]) -> Dict[str, Any]:
        if source["kind"] == "release":
            verified_commit = self._verify_release_attribution(source)
            ref = "%s@%s" % (self.config["imageRepository"], source["appDigest"])
            code, _, stderr = self.effects.run(["docker", "pull", ref], timeout=600)
            if code != 0:
                raise HelperError("app_update_unavailable", stderr or "Published digest pull failed.")
            identity = self._image_identity(ref)
            if source["appDigest"] not in identity["repo_digest_ids"]:
                raise HelperError(
                    "app_update_invalid_request",
                    "Pulled image RepoDigests do not contain the published release digest.",
                )
            return {
                "image_id": identity["id"],
                "published_digest": source["appDigest"],
                "record_id": source["appDigest"],
                "ref": ref,
                "source_commit": verified_commit,
                "tag": source["tag"],
            }
        resolved = self._resolve_commit_source(source["sourceCommit"])
        try:
            context = resolved["context"]
            tag = "openkit/app:staging-%s" % resolved["source_commit"]
            build = os.path.join(context, "scripts", "docker", "build-image.sh")
            code, _, stderr = self.effects.run(["bash", build, "app", tag], timeout=1800)
            if code != 0:
                raise HelperError("app_update_unavailable", stderr or "Exact-commit image build failed.")
            identity = self._image_identity(tag)
            return {
                "image_id": identity["id"],
                "published_digest": None,
                "record_id": identity["id"],
                "ref": tag,
                "source_commit": resolved["source_commit"],
            }
        finally:
            scratch = resolved.get("scratch")
            if scratch:
                _rmtree(scratch)

    def _verify_release_attribution(self, source: Mapping[str, Any]) -> str:
        """Verifies fixed-repo tag, source-revision, and digest attribution."""
        tag = source["tag"]
        repository = self.config["imageRepository"]
        verified = self._ls_remote_tag_commit(tag)
        if verified != source["sourceCommit"]:
            raise HelperError(
                "app_update_invalid_request",
                "Release tag commit does not match the independently verified source.",
            )
        version = tag[1:] if tag.startswith("v") else tag
        tag_digest = self._registry_digest("%s:%s" % (repository, tag))
        version_digest = self._registry_digest("%s:%s" % (repository, version))
        sha_digest = self._registry_digest("%s:sha-%s" % (repository, verified[:12]))
        published = source["appDigest"]
        if tag_digest != published or version_digest != published or sha_digest != published:
            raise HelperError(
                "app_update_invalid_request",
                "Published release source-revision attribution does not match the App digest.",
            )
        return verified

    def _ls_remote_tag_commit(self, tag: str) -> str:
        """Resolves a release tag to its peeled commit without `--refs` suppression."""
        tag_ref = "refs/tags/%s" % tag
        peeled_ref = "%s^{}" % tag_ref
        code, stdout, stderr = self.effects.run(
            ["git", "ls-remote", self.config["sourceRepository"], peeled_ref, tag_ref],
            timeout=60,
        )
        if code != 0:
            raise HelperError("app_update_unavailable", stderr or "Release tag lookup failed.")
        peeled = None
        fallback = None
        for line in (stdout or "").splitlines():
            text = line.strip()
            if not text:
                continue
            parts = text.split()
            if len(parts) < 2:
                continue
            sha, ref = parts[0], parts[1]
            if not COMMIT_RE.match(sha):
                continue
            if ref.endswith("^{}"):
                peeled = sha
            elif fallback is None:
                fallback = sha
        verified = peeled or fallback
        if not verified:
            raise HelperError(
                "app_update_invalid_request",
                "Release tag does not resolve to an independently verified Git commit.",
            )
        return verified

    def _registry_digest(self, reference: str) -> str:
        code, stdout, stderr = self.effects.run(
            [
                "docker",
                "buildx",
                "imagetools",
                "inspect",
                reference,
                "--format",
                "{{.Manifest.Digest}}",
            ],
            timeout=60,
        )
        digest = (stdout or "").strip()
        if code != 0 or not DIGEST_RE.match(digest):
            raise HelperError(
                "app_update_unavailable",
                stderr or "Published release digest inspect failed.",
            )
        return digest

    def _resolve_commit_source(self, commit: str) -> Dict[str, Optional[str]]:
        staged = os.path.join(self.config["stagedSourceDir"], commit)
        identity_path = os.path.join(staged, "IDENTITY.json")
        if os.path.lexists(identity_path):
            if os.path.islink(staged) or os.path.islink(identity_path):
                raise HelperError("app_update_recovery_required", "Staged source must not be a symbolic link.")
            metadata = os.lstat(identity_path)
            if not stat.S_ISREG(metadata.st_mode):
                raise HelperError("app_update_recovery_required", "Staged source identity is not a regular file.")
            with open(identity_path, "r", encoding="utf-8") as handle:
                identity = json.loads(handle.read())
            recorded = str(identity.get("contentDigest", ""))
            if identity.get("sourceCommit") != commit or not DIGEST_RE.match(recorded):
                raise HelperError("app_update_invalid_request", "Staged source identity does not match the commit.")
            observed = digest_tree(staged, exclude=("IDENTITY.json",))
            if observed != recorded:
                raise HelperError(
                    "app_update_invalid_request",
                    "Staged source content digest does not match the recorded identity.",
                )
            if os.path.realpath(staged) == os.path.realpath(self.config["sourceWorkDir"]):
                raise HelperError(
                    "app_update_invalid_request",
                    "Staged source must not be the configured source workdir.",
                )
            return {"context": staged, "scratch": None, "source_commit": commit}
        workdir = self.config["sourceWorkDir"]
        code, _, stderr = self.effects.run(
            [
                "git",
                "-C",
                workdir,
                "fetch",
                "--no-tags",
                self.config["sourceRepository"],
                self.config["sourceBranch"],
            ],
            timeout=300,
        )
        if code != 0:
            raise HelperError("app_update_unavailable", stderr or "Configured source fetch failed.")
        ancestor = [
            "git",
            "-C",
            workdir,
            "merge-base",
            "--is-ancestor",
            commit,
            "FETCH_HEAD",
        ]
        code, _, _ = self.effects.run(ancestor, timeout=30)
        if code != 0:
            raise HelperError(
                "app_update_invalid_request",
                "Commit is not reachable from the configured branch and is not a staged source.",
            )
        parsed = self.effects.run(
            ["git", "-C", workdir, "rev-parse", "--verify", "%s^{commit}" % commit],
            timeout=30,
        )
        verified = (parsed[1] or "").strip()
        if parsed[0] != 0 or not COMMIT_RE.match(verified):
            raise HelperError("app_update_unavailable", parsed[2] or "Exact-commit identity could not be verified.")
        parent = tempfile.mkdtemp(prefix="openkit-app-update-src-")
        tar_path = os.path.join(parent, "source.tar")
        context = os.path.join(parent, "tree")
        os.makedirs(context, mode=0o755)
        try:
            code, _, stderr = self.effects.run(
                ["git", "-C", workdir, "archive", "--format=tar", "-o", tar_path, verified],
                timeout=120,
            )
            if code != 0:
                raise HelperError("app_update_unavailable", stderr or "Exact-commit archive failed.")
            with tarfile.open(tar_path, "r") as archive:
                archive.extractall(context)
            return {"context": context, "scratch": parent, "source_commit": verified}
        except Exception:
            _rmtree(parent)
            raise

    def _image_identity(self, reference: str) -> Dict[str, Any]:
        code, stdout, stderr = self.effects.run(
            ["docker", "image", "inspect", "--format", "{{json .}}", reference],
            timeout=30,
        )
        if code != 0:
            raise HelperError("app_update_unavailable", stderr or "Image inspect failed.")
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError as error:
            raise HelperError("app_update_unavailable", "Image inspect is not JSON.") from error
        digest = str(payload.get("Id") or "").strip()
        if not DIGEST_RE.match(digest):
            raise HelperError("app_update_unavailable", "Image identity is not a sha256 digest.")
        config = payload.get("Config") or {}
        return {
            "cmd": list(config.get("Cmd") or []),
            "entrypoint": list(config.get("Entrypoint") or []),
            "id": digest,
            "repo_digest_ids": repo_digest_ids(payload.get("RepoDigests") or []),
        }

    def _inspect_container(self, name: str) -> Dict[str, Any]:
        code, stdout, stderr = self.effects.run(
            ["docker", "inspect", "--format", "{{json .}}", name],
            timeout=30,
        )
        if code != 0:
            raise HelperError("app_update_unavailable", stderr or "Current App inspect failed.")
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError as error:
            raise HelperError("app_update_unavailable", "Current App inspect is not JSON.") from error
        if not isinstance(payload, dict):
            raise HelperError("app_update_unavailable", "Current App inspect is not an object.")
        return payload

    def _assert_a2_shape(self, inspect: Mapping[str, Any], image: Mapping[str, Any]) -> None:
        name = self.config["containerName"]
        if "nanohost" in name.lower():
            raise HelperError("app_update_invalid_request", "App update must not target NanoHost.")
        host = inspect.get("HostConfig") or {}
        config = inspect.get("Config") or {}
        if host.get("Privileged") is True:
            raise HelperError("app_update_invalid_request", "Privileged App containers are unsupported.")
        for key in ("Devices", "DeviceRequests", "CapAdd", "CapDrop"):
            if host.get(key):
                raise HelperError("app_update_invalid_request", "App HostConfig %s is unsupported." % key)
        if host.get("PidMode") not in (None, "", "host"):
            raise HelperError("app_update_invalid_request", "App pid namespace is unsupported.")
        if host.get("Runtime") != "runc":
            raise HelperError("app_update_invalid_request", "App runtime is unsupported.")
        if host.get("NetworkMode") != "host":
            raise HelperError("app_update_invalid_request", "App network mode must be host.")
        if host.get("PortBindings"):
            raise HelperError("app_update_invalid_request", "App port bindings are unsupported on host network.")
        restart = (host.get("RestartPolicy") or {}).get("Name")
        if restart != "unless-stopped":
            raise HelperError("app_update_invalid_request", "App restart policy must be unless-stopped.")
        log = host.get("LogConfig") or {}
        log_type = log.get("Type") or "json-file"
        log_cfg = log.get("Config") or {}
        if log_type != "json-file" or "max-size" not in log_cfg or "max-file" not in log_cfg:
            raise HelperError("app_update_invalid_request", "App log retention settings are missing.")
        entrypoint = list(config.get("Entrypoint") or [])
        cmd = list(config.get("Cmd") or [])
        if entrypoint != image["entrypoint"] or cmd != image["cmd"]:
            raise HelperError("app_update_invalid_request", "App entrypoint/cmd is not the image default.")
        mounts = {item.get("Destination"): item for item in inspect.get("Mounts") or [] if isinstance(item, dict)}
        expected = {
            "/data/openkit": (self.config["dataRoot"], True),
            "/run/nanohost-credentials": (self.config["nanohostCredentialsDir"], True),
            "/srv/web": (self.config["webAssetsDir"], False),
            "/etc/caddy/Caddyfile": (self.config["caddyfile"], False),
            "/run/secrets/openkit-vault.key": (self.config["vaultKeyFile"], False),
        }
        extra = set(mounts) - set(REQUIRED_MOUNT_DESTS)
        missing = set(REQUIRED_MOUNT_DESTS) - set(mounts)
        if extra or missing:
            raise HelperError(
                "app_update_invalid_request",
                "App mounts are not the fixed A2 Data Root, sink, Web, Caddyfile, Vault key, and App-update SSH set.",
            )
        for dest, (source, writable) in expected.items():
            item = mounts[dest]
            if str(item.get("Source") or "") != source or bool(item.get("RW")) != writable:
                raise HelperError("app_update_invalid_request", "App mount %s does not match helper config." % dest)
        for dest in APP_UPDATE_SSH_DESTS:
            self._assert_app_update_ssh_bind(mounts[dest], dest)
        data_rw = [
            item
            for item in mounts.values()
            if item.get("Destination") == "/data/openkit" and item.get("RW") is True
        ]
        if len(data_rw) != 1:
            raise HelperError("app_update_invalid_request", "App must have exactly one RW Data Root mount.")

    def _assert_app_update_ssh_bind(self, item: Mapping[str, Any], dest: str) -> None:
        if str(item.get("Type") or "") != "bind":
            raise HelperError("app_update_invalid_request", "App mount %s must be a bind." % dest)
        if item.get("RW") is not False:
            raise HelperError("app_update_invalid_request", "App mount %s must be readonly." % dest)
        source = str(item.get("Source") or "")
        if not source or not os.path.isabs(source):
            raise HelperError(
                "app_update_invalid_request",
                "App-update SSH source for %s must be an absolute path." % dest,
            )
        try:
            meta = os.lstat(source)
        except OSError as error:
            raise HelperError(
                "app_update_invalid_request",
                "App-update SSH source for %s is missing." % dest,
            ) from error
        if stat.S_ISLNK(meta.st_mode) or not stat.S_ISREG(meta.st_mode):
            raise HelperError(
                "app_update_invalid_request",
                "App-update SSH source for %s must be a non-linked regular file." % dest,
            )
        data_root = os.path.realpath(self.config["dataRoot"])
        sink = os.path.realpath(self.config["nanohostCredentialsDir"])
        real = os.path.realpath(source)
        if _path_inside(real, data_root) or _path_inside(real, sink):
            raise HelperError(
                "app_update_invalid_request",
                "App-update SSH source for %s must stay outside Data Root and the NanoHost sink." % dest,
            )

    def _replacement_argv(self, inspect: Mapping[str, Any], image_ref: str, source_commit: str) -> List[str]:
        host = inspect.get("HostConfig") or {}
        config = inspect.get("Config") or {}
        log_cfg = (host.get("LogConfig") or {}).get("Config") or {}
        argv = [
            "docker",
            "run",
            "--detach",
            "--name",
            self.config["containerName"],
            "--restart",
            "unless-stopped",
            "--runtime",
            "runc",
            "--network",
            "host",
            "--volume",
            "%s:/data/openkit" % self.config["dataRoot"],
            "--volume",
            "%s:/run/nanohost-credentials" % self.config["nanohostCredentialsDir"],
            "--mount",
            "type=bind,src=%s,dst=/srv/web,readonly" % self.config["webAssetsDir"],
            "--mount",
            "type=bind,src=%s,dst=/etc/caddy/Caddyfile,readonly" % self.config["caddyfile"],
            "--mount",
            "type=bind,src=%s,dst=/run/secrets/openkit-vault.key,readonly" % self.config["vaultKeyFile"],
        ]
        mounts = {item.get("Destination"): item for item in inspect.get("Mounts") or [] if isinstance(item, dict)}
        for dest in APP_UPDATE_SSH_DESTS:
            argv.extend(
                [
                    "--mount",
                    "type=bind,src=%s,dst=%s,readonly" % (str((mounts[dest] or {}).get("Source") or ""), dest),
                ]
            )
        argv.extend(
            [
                "--log-opt",
                "max-size=%s" % log_cfg["max-size"],
                "--log-opt",
                "max-file=%s" % log_cfg["max-file"],
                "--label",
                "org.openkit.staging.commit=%s" % source_commit,
            ]
        )
        health = config.get("Healthcheck") or {}
        test = health.get("Test") or []
        if test and test[0] == "CMD-SHELL" and len(test) >= 2:
            argv.extend(["--health-cmd", test[1]])
        for env in config.get("Env") or []:
            argv.extend(["--env", str(env)])
        argv.append(image_ref)
        return argv

    def _smoke(self, image_ref: str) -> None:
        code, _, stderr = self.effects.run(
            ["docker", "run", "--rm", image_ref, "openkit-app-smoke"],
            timeout=300,
        )
        if code != 0:
            raise HelperError("app_update_unavailable", stderr or "Candidate image smoke failed.")

    def _live_applied_migrations(self) -> List[str]:
        status, body = self._authorized_get("/api/diagnostics")
        if status != 200 or not isinstance(body, dict):
            raise HelperError("app_update_unavailable", "Live applied migrations could not be read.")
        applied = ((body.get("migrations") or {}) if isinstance(body.get("migrations"), dict) else {}).get("applied")
        if not isinstance(applied, list) or any(not isinstance(item, str) or not item for item in applied):
            raise HelperError("app_update_unavailable", "Live applied migrations are not a string list.")
        return [str(item) for item in applied]

    def _stage_web_assets(self, candidate: Mapping[str, Any]) -> Dict[str, str]:
        root = self.config["webAssetsDir"]
        current = os.path.join(root, "current")
        if not os.path.islink(current):
            raise HelperError("app_update_invalid_request", "External Web current pointer is missing.")
        previous = os.path.basename(os.path.realpath(current))
        if not previous or not os.path.isdir(os.path.join(root, previous)):
            raise HelperError("app_update_invalid_request", "External Web current target is missing.")
        previous_digest = digest_tree(os.path.realpath(current))
        commit = candidate["source_commit"]
        staged_dir = os.path.join(root, ".%s.partial" % commit)
        if os.path.lexists(staged_dir):
            _rmtree(staged_dir)
        os.makedirs(staged_dir, mode=0o755)
        code, stdout, stderr = self.effects.run(["docker", "create", candidate["ref"]], timeout=60)
        if code != 0:
            raise HelperError("app_update_unavailable", stderr or "Candidate Web extract container failed.")
        assets_id = (stdout or "").strip().split("\n")[0].strip()
        try:
            self._run_required(
                ["docker", "cp", "%s:/srv/web/." % assets_id, staged_dir],
                "Failed to copy candidate Web assets.",
            )
        finally:
            self.effects.run(["docker", "rm", assets_id], timeout=30)
        with os.scandir(staged_dir) as entries:
            if not any(entries):
                raise HelperError("app_update_unavailable", "Candidate Web extract is empty.")
        return {
            "candidate": commit,
            "partial": staged_dir,
            "previous": previous,
            "previous_digest": previous_digest,
            "staged_digest": digest_tree(staged_dir),
        }

    def _publish_web_assets(self, web_plan: Mapping[str, str]) -> str:
        root = self.config["webAssetsDir"]
        final_dir = os.path.join(root, web_plan["candidate"])
        live_current = os.path.join(root, "current")
        live_target = os.path.realpath(live_current) if os.path.lexists(live_current) else ""
        if os.path.lexists(final_dir) and os.path.realpath(final_dir) != live_target:
            _rmtree(final_dir)
        elif os.path.lexists(final_dir) and os.path.realpath(final_dir) == live_target:
            raise HelperError(
                "app_update_unavailable",
                "Candidate Web directory is the live current target; refusing to replace it.",
            )
        os.rename(web_plan["partial"], final_dir)
        self._switch_web_current(web_plan["candidate"])
        pointer = os.readlink(os.path.join(root, "current"))
        if os.path.basename(pointer.rstrip(os.sep)) != web_plan["candidate"]:
            raise HelperError("app_update_unavailable", "Web current pointer is not the candidate identity.")
        live_digest = digest_tree(os.path.realpath(os.path.join(root, "current")))
        if live_digest != web_plan["staged_digest"]:
            raise HelperError(
                "app_update_unavailable",
                "Live Web assets digest does not match the staged candidate tree.",
            )
        return live_digest

    def _switch_web_current(self, candidate: str) -> None:
        current = os.path.join(self.config["webAssetsDir"], "current")
        tmp = current + ".next"
        if os.path.lexists(tmp):
            os.unlink(tmp)
        os.symlink(candidate, tmp)
        os.replace(tmp, current)

    def _aside_existing_previous(self, retained: str, request_id: str) -> None:
        code, _, _ = self.effects.run(["docker", "inspect", retained], timeout=15)
        if code != 0:
            return
        aside = "%s-pre-%s" % (retained, request_id.split("-")[0])
        exists, _, _ = self.effects.run(["docker", "inspect", aside], timeout=15)
        if exists == 0:
            raise HelperError(
                "app_update_invalid_request",
                "Previous App aside name collision already exists.",
            )
        self._run_required(["docker", "rename", retained, aside], "Failed to move the existing previous App aside.")

    def _restore_previous(self, receipt: Mapping[str, Any]) -> None:
        name = self.config["containerName"]
        retained = receipt.get("retainedContainerName")
        previous_web = receipt.get("previousWebAssets")
        if previous_web:
            self._switch_web_current(str(previous_web))
            restored = digest_tree(os.path.realpath(os.path.join(self.config["webAssetsDir"], "current")))
            expected = receipt.get("webPreviousDigest")
            if expected and restored != expected:
                raise HelperError(
                    "app_update_recovery_required",
                    "Restored Web assets digest does not match the previous tree.",
                )
        code, _, stderr = self.effects.run(["docker", "stop", "--time", "30", name], timeout=60)
        if code != 0:
            raise HelperError(
                "app_update_recovery_required",
                _redact(stderr or "Failed to stop the candidate App before restoring the previous App.")[:512],
            )
        if name in self._active_dataroot_users():
            raise HelperError(
                "app_update_recovery_required",
                "Candidate App is still a writable Data Root user after stop.",
            )
        failed = "%s.failed-%s" % (name, str(receipt.get("requestId") or "x").split("-")[0])
        self.effects.run(["docker", "rename", name, failed], timeout=30)
        if retained:
            self._run_required(["docker", "rename", str(retained), name], "Failed to restore the previous App name.")
            self._run_required(["docker", "start", name], "Failed to start the previous App.")

    def _active_dataroot_users(self) -> List[str]:
        code, stdout, stderr = self.effects.run(
            ["docker", "ps", "--filter", "status=running", "--format", "{{.Names}}"],
            timeout=15,
        )
        if code != 0:
            raise HelperError("app_update_unavailable", stderr or "Running container list failed.")
        users = []
        for name in [line.strip() for line in (stdout or "").splitlines() if line.strip()]:
            inspect_code, raw, _ = self.effects.run(
                ["docker", "inspect", "--format", "{{json .}}", name],
                timeout=30,
            )
            if inspect_code != 0:
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue
            for item in payload.get("Mounts") or []:
                if not isinstance(item, dict):
                    continue
                if (
                    item.get("Destination") == "/data/openkit"
                    and item.get("RW") is True
                    and str(item.get("Source") or "") == self.config["dataRoot"]
                ):
                    users.append(name)
                    break
        return users

    def _assert_exclusive_dataroot_users(self, expected: Set[str]) -> None:
        users = set(self._active_dataroot_users())
        if users != expected:
            raise HelperError(
                "app_update_invalid_request",
                "Active writable Data Root users do not match the configured App.",
            )

    def _boot_from_diagnostics(self, image_id: Optional[str], source_commit: Optional[str]) -> Optional[Dict[str, Any]]:
        """Projects boot readiness plus independently verified image/source identities."""
        status, body = self._authorized_get("/api/app/diagnostics")
        if status != 200 or not isinstance(body, dict):
            return None
        boot = body.get("boot") or {}
        boot_id = boot.get("bootId") if isinstance(boot, dict) else None
        if not isinstance(boot_id, str) or not BOOT_ID_RE.match(boot_id):
            return None
        reasons = []
        subsystems = boot.get("subsystems") or {}
        if isinstance(subsystems, dict):
            for item in subsystems.values():
                if not isinstance(item, dict):
                    continue
                for reason in item.get("reasons") or []:
                    code = reason.get("code") if isinstance(reason, dict) else None
                    if code:
                        reasons.append(str(code)[:128])
        if image_id is not None and not DIGEST_RE.match(str(image_id)):
            return None
        return {
            "acceptingProductWork": bool(boot.get("acceptingProductWork")),
            "blockingReasons": reasons[:32],
            "bootId": boot_id,
            "imageId": image_id,
            "sourceCommit": source_commit,
        }

    def _snapshot_nanohost(self, receipt: Dict[str, Any]) -> None:
        status, body = self._authorized_get("/api/app/nanohost/runtime-target")
        if status == 404 or not isinstance(body, dict) or not body.get("identityId"):
            receipt["previousNanoHost"] = None
            return
        receipt["previousNanoHost"] = {
            "connectionGeneration": body.get("connectionGeneration"),
            "identityId": body.get("identityId"),
            "ready": body.get("ready") is True,
        }

    def _snapshot_retained_auth(self, receipt: Dict[str, Any]) -> None:
        status, body = self._authorized_get("/api/app/auth/tokens")
        if status != 200:
            raise HelperError("app_update_unavailable", "Retained auth-store identity could not be read.")
        receipt["retainedAuthSnapshot"] = self._auth_store_identity(body)

    def _auth_store_identity(self, body: Any) -> List[Dict[str, Any]]:
        if not isinstance(body, dict) or not isinstance(body.get("items"), list):
            raise HelperError(
                "app_update_unavailable",
                "Retained auth-store identity is not the public Token list.",
            )
        if not body["items"]:
            raise HelperError("app_update_unavailable", "Retained auth-store identity is empty.")
        rows = []
        for item in body["items"]:
            rows.append(self._token_identity_projection(item))
        rows.sort(key=lambda row: row["tokenId"])
        return rows

    def _token_identity_projection(self, item: Any) -> Dict[str, Any]:
        if not isinstance(item, dict):
            raise HelperError(
                "app_update_unavailable",
                "Retained auth-store identity is not the public Token list.",
            )
        extra = set(item) - TOKEN_IDENTITY_KEYS - TOKEN_LAST_USED_KEYS
        missing = (TOKEN_IDENTITY_KEYS | TOKEN_LAST_USED_KEYS) - set(item)
        if extra or missing:
            raise HelperError(
                "app_update_unavailable",
                "Retained auth-store identity is not the public Token list.",
            )
        token_id = item["tokenId"]
        owner = item["ownerUserId"]
        scope = item["scope"]
        status = item["status"]
        issued_at = item["issuedAt"]
        expires_at = item["expiresAt"]
        workspace_ids = item["workspaceIds"]
        if (
            not isinstance(token_id, str)
            or not token_id
            or not isinstance(owner, str)
            or not owner
            or scope not in TOKEN_SCOPES
            or status not in TOKEN_STATUSES
            or not isinstance(issued_at, str)
            or not issued_at
            or not isinstance(expires_at, str)
            or not expires_at
            or not isinstance(workspace_ids, list)
            or any(not isinstance(entry, str) or not entry for entry in workspace_ids)
        ):
            raise HelperError(
                "app_update_unavailable",
                "Retained auth-store identity is not the public Token list.",
            )
        for key in ("predecessorTokenId", "revokedAt", "rotatedGraceExpiresAt") + tuple(TOKEN_LAST_USED_KEYS):
            value = item[key]
            if value is not None and (not isinstance(value, str) or not value):
                raise HelperError(
                    "app_update_unavailable",
                    "Retained auth-store identity is not the public Token list.",
                )
        return {
            "expiresAt": expires_at,
            "issuedAt": issued_at,
            "ownerUserId": owner,
            "predecessorTokenId": item["predecessorTokenId"],
            "revokedAt": item["revokedAt"],
            "rotatedGraceExpiresAt": item["rotatedGraceExpiresAt"],
            "scope": scope,
            "status": status,
            "tokenId": token_id,
            "workspaceIds": list(workspace_ids),
        }

    def _retained_auth_read(self, receipt: Mapping[str, Any]) -> bool:
        status, body = self._authorized_get("/api/app/auth/tokens")
        if status != 200:
            return False
        try:
            observed = self._auth_store_identity(body)
        except HelperError:
            return False
        return observed == receipt.get("retainedAuthSnapshot")

    def _verify(self, receipt: Dict[str, Any], candidate: Mapping[str, Any]) -> Dict[str, Any]:
        previous = receipt.get("previousBoot") or {}
        boot = None
        running_identity: Optional[Dict[str, Any]] = None
        timeout = int(self.config["readyTimeoutSeconds"])
        for attempt in range(timeout + 1):
            running = self._inspect_container(self.config["containerName"])
            running_identity = self._image_identity(str(running.get("Image") or ""))
            observed = self._boot_from_diagnostics(running_identity["id"], candidate["source_commit"])
            if (
                observed
                and observed["bootId"] != previous.get("bootId")
                and BOOT_ID_RE.match(str(observed["bootId"]))
            ):
                boot = observed
                break
            if attempt < timeout:
                self._sleep(1)
        if boot is None or running_identity is None:
            raise RuntimeError("candidate boot observation is missing")
        admitted = ADMITTED_NONBLOCKING
        blocking = [item for item in boot["blockingReasons"] if item not in admitted]
        image_match = self._running_matches_candidate(running_identity, candidate)
        mapped = receipt.get("sourceImageMap") if isinstance(receipt.get("sourceImageMap"), dict) else {}
        source_match = (
            COMMIT_RE.match(str(candidate["source_commit"])) is not None
            and mapped.get("sourceCommit") == candidate["source_commit"]
            and mapped.get("imageId") == candidate["image_id"]
            and running_identity["id"] == candidate["image_id"]
        )
        if candidate["published_digest"]:
            source_match = source_match and candidate["published_digest"] in running_identity["repo_digest_ids"]
            image_match = candidate["published_digest"] in running_identity["repo_digest_ids"]
        retained_ok = self._retained_auth_read(receipt)
        previous_nanohost = receipt.get("previousNanoHost")
        nanohost_ok: Optional[bool]
        if previous_nanohost:
            status, body = self._authorized_get("/api/app/nanohost/runtime-target")
            nanohost_ok = (
                status == 200
                and isinstance(body, dict)
                and body.get("ready") is True
                and body.get("identityId") == previous_nanohost.get("identityId")
                and body.get("connectionGeneration") == previous_nanohost.get("connectionGeneration")
            )
        else:
            nanohost_ok = None
        helper_status, helper_body = self._authorized_get("/api/app/app-update/%s" % receipt["requestId"])
        helper_ok = (
            helper_status == 200
            and isinstance(helper_body, dict)
            and helper_body.get("requestId") == receipt["requestId"]
        )
        web_ok: Optional[bool]
        if receipt.get("webStagedDigest"):
            live = os.path.join(self.config["webAssetsDir"], "current")
            web_ok = digest_tree(os.path.realpath(live)) == receipt.get("webStagedDigest")
        else:
            web_ok = None
        predicates = {
            "acceptingProductWork": boot["acceptingProductWork"] is True,
            "helperReachable": helper_ok,
            "imageMatch": image_match,
            "nanohostReady": nanohost_ok,
            "newBoot": True,
            "noBlockingReadiness": not blocking,
            "retainedAuthRead": retained_ok,
            "sourceMatch": source_match,
            "webAssets": web_ok,
        }
        receipt["predicates"] = predicates
        required = [
            predicates["acceptingProductWork"],
            predicates["helperReachable"],
            predicates["imageMatch"],
            predicates["newBoot"],
            predicates["noBlockingReadiness"],
            predicates["retainedAuthRead"],
            predicates["sourceMatch"],
        ]
        if nanohost_ok is not None:
            required.append(nanohost_ok)
        if web_ok is not None:
            required.append(web_ok)
        if not all(required):
            failed = [key for key, value in predicates.items() if value is False]
            raise RuntimeError("candidate verification failed: %s" % ",".join(failed))
        if not COMMIT_RE.match(str(boot.get("sourceCommit") or "")):
            raise RuntimeError("candidate source identity is unknown")
        return boot

    def _running_matches_candidate(self, running: Mapping[str, Any], candidate: Mapping[str, Any]) -> bool:
        if candidate["published_digest"]:
            return candidate["published_digest"] in running["repo_digest_ids"]
        return running["id"] == candidate["image_id"]

    def _authorized_get(self, path: str) -> Tuple[int, Any]:
        headers = {}
        token_file = self.config.get("adminTokenFile")
        if token_file:
            try:
                with open(token_file, "r", encoding="utf-8") as handle:
                    token = handle.read().strip()
            except OSError:
                token = ""
            if token:
                headers["Authorization"] = "Bearer %s" % token
        url = self.config["appBaseUrl"].rstrip("/") + path
        return self.effects.http_get(url, headers=headers, timeout=15)

    def _sleep(self, seconds: float) -> None:
        sleeper = getattr(self.effects, "sleep", None)
        if callable(sleeper):
            sleeper(seconds)

    def _run_required(self, argv: Sequence[str], message: str) -> None:
        code, _, stderr = self.effects.run(list(argv), timeout=120)
        if code != 0:
            raise HelperError("app_update_unavailable", _redact(stderr or message)[:512])

    def _maybe_mark_unknown(self, receipt: Dict[str, Any]) -> Dict[str, Any]:
        if receipt["stage"] not in IN_PROGRESS_STAGES:
            return receipt
        launch_at = receipt.get("startedAt")
        if not launch_at:
            return receipt
        if self.now() - _parse_iso(launch_at) < float(self.config["launchUnknownAfterSeconds"]):
            return receipt
        if self._job_live(receipt.get("jobId")):
            return receipt
        set_stage(receipt, "unknown")
        receipt["completedAt"] = isoformat(self.now())
        receipt["error"] = "Launch intent has no live job after 30 seconds."
        self._write_receipt(receipt)
        return receipt

    def _job_live(self, job_id: Optional[str]) -> bool:
        if not job_id:
            return False
        code, stdout, _ = self.effects.run(["systemctl", "is-active", job_id], timeout=10)
        state = (stdout or "").strip()
        return state in {"active", "activating"} or (code == 0 and state not in {"inactive", "failed", "unknown"})

    def _busy_with_other(self, request_id: str) -> bool:
        if self._lock_held_by_other():
            return True
        for path in self._receipt_files():
            try:
                receipt = self._read_receipt_file(path)
            except HelperError:
                continue
            if receipt["requestId"] == request_id:
                continue
            if receipt.get("stage") in IN_PROGRESS_STAGES and (
                self._job_live(receipt.get("jobId"))
                or (
                    receipt.get("startedAt")
                    and self.now() - _parse_iso(receipt["startedAt"])
                    < float(self.config["launchUnknownAfterSeconds"])
                )
            ):
                return True
        return False

    def _lock_held_by_other(self) -> bool:
        try:
            handle = open(self.config["lockPath"], "a+b")
        except OSError:
            return False
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            return False
        except BlockingIOError:
            return True
        finally:
            handle.close()

    def _acquire_lock(self) -> Any:
        handle = open(self.config["lockPath"], "a+b")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            handle.close()
            raise HelperError("app_update_busy", "An App update is already running for this target.") from error
        return handle

    def _assert_capacity(self) -> None:
        if len(self._receipt_files()) >= RECEIPT_CAPACITY:
            raise HelperError("app_update_capacity", "App-update receipt directory is full.")

    def _receipt_files(self) -> List[str]:
        names = []
        try:
            entries = os.listdir(self.config["receiptDir"])
        except OSError as error:
            raise HelperError("app_update_unconfigured", "Receipt directory could not be read.") from error
        for name in entries:
            if not name.endswith(".json"):
                continue
            path = os.path.join(self.config["receiptDir"], name)
            try:
                metadata = os.lstat(path)
            except OSError:
                continue
            if stat.S_ISREG(metadata.st_mode):
                names.append(path)
        return names

    def _load_receipt(self, request_id: str, missing_code: str) -> Dict[str, Any]:
        path = os.path.join(self.config["receiptDir"], "%s.json" % request_id)
        try:
            metadata = os.lstat(path)
        except OSError as error:
            raise HelperError(missing_code, "App-update receipt is missing.") from error
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise HelperError("app_update_recovery_required", "App-update receipt is not a regular file.")
        if metadata.st_size > RECEIPT_LIMIT_BYTES:
            raise HelperError("app_update_recovery_required", "App-update receipt exceeds the 64 KiB limit.")
        return self._read_receipt_file(path)

    def _read_receipt_file(self, path: str) -> Dict[str, Any]:
        try:
            with open(path, "rb") as handle:
                raw = handle.read(RECEIPT_LIMIT_BYTES + 1)
        except OSError as error:
            raise HelperError("app_update_recovery_required", "App-update receipt could not be read.") from error
        if len(raw) > RECEIPT_LIMIT_BYTES:
            raise HelperError("app_update_recovery_required", "App-update receipt exceeds the 64 KiB limit.")
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise HelperError("app_update_recovery_required", "App-update receipt is malformed.") from error
        return self._validate_receipt(parsed, os.path.basename(path))

    def _validate_receipt(self, parsed: Any, filename: str) -> Dict[str, Any]:
        if not isinstance(parsed, dict):
            raise HelperError("app_update_recovery_required", "App-update receipt is malformed.")
        if parsed.get("schemaVersion") != SCHEMA_VERSION:
            raise HelperError("app_update_recovery_required", "App-update receipt schema is unsupported.")
        request_id = parsed.get("requestId")
        expected_name = "%s.json" % request_id
        if not isinstance(request_id, str) or filename != expected_name:
            raise HelperError("app_update_recovery_required", "App-update receipt identity is contradictory.")
        try:
            source = _require_source(parsed.get("source"))
            expected = _require_digest(parsed.get("expectedCurrentImageId"))
        except HelperError as error:
            raise HelperError("app_update_recovery_required", error.message) from error
        stage = parsed.get("stage")
        expected_outcome = collapse_outcome(stage) if isinstance(stage, str) else None
        if stage not in {
            "prepared",
            "launching",
            "applying",
            "verifying",
            "succeeded",
            "failed",
            "unknown",
            "recovery_required",
        } or parsed.get("outcome") not in {None, expected_outcome}:
            raise HelperError("app_update_recovery_required", "App-update receipt lifecycle is contradictory.")
        candidate_boot = parsed.get("candidateBoot")
        if stage == "succeeded" and (
            not isinstance(candidate_boot, dict)
            or not BOOT_ID_RE.match(str(candidate_boot.get("bootId") or ""))
            or not COMMIT_RE.match(str(candidate_boot.get("sourceCommit") or ""))
        ):
            raise HelperError("app_update_recovery_required", "Succeeded receipt is missing the candidate boot.")
        parsed["source"] = source
        parsed["expectedCurrentImageId"] = expected
        parsed["outcome"] = expected_outcome
        return parsed

    def _write_receipt(self, receipt: Mapping[str, Any], exclusive: bool = False) -> None:
        directory = self.config["receiptDir"]
        path = os.path.join(directory, "%s.json" % receipt["requestId"])
        if exclusive and os.path.lexists(path):
            raise HelperError("app_update_recovery_required", "App-update receipt id already exists.")
        payload = json.dumps(dict(receipt), separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(payload) > RECEIPT_LIMIT_BYTES:
            raise HelperError("app_update_recovery_required", "App-update receipt exceeds the 64 KiB limit.")
        fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=directory)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)


def host_error(code: str, message: str) -> Dict[str, Any]:
    if code not in ERROR_CODES:
        code = "app_update_unavailable"
    text = _redact(message)[:512] or "App-update helper failed."
    return {"error": {"code": code, "message": text}}


def collapse_outcome(stage: str) -> str:
    return "running" if stage in IN_PROGRESS_STAGES else stage


def set_stage(receipt: Dict[str, Any], stage: str) -> None:
    receipt["stage"] = stage
    receipt["outcome"] = collapse_outcome(stage)


def project_status(receipt: Mapping[str, Any]) -> Dict[str, Any]:
    stage = str(receipt.get("stage") or "")
    status = {key: receipt.get(key, None) for key in PUBLIC_STATUS_KEYS}
    status["stage"] = stage
    status["outcome"] = collapse_outcome(stage)
    if stage in {"prepared", "launching", "applying"} or not isinstance(receipt.get("predicates"), dict):
        status["predicates"] = None
    else:
        predicates = receipt["predicates"]
        status["predicates"] = {key: predicates.get(key) for key in PREDICATE_KEYS}
    if status["error"]:
        status["error"] = _redact(str(status["error"]))[:512]
        if not status["error"]:
            status["error"] = "App-update helper failed."
    if stage == "succeeded":
        boot = status.get("candidateBoot")
        if not isinstance(boot, dict) or not BOOT_ID_RE.match(str(boot.get("bootId") or "")):
            raise HelperError(
                "app_update_recovery_required",
                "Succeeded App-update status requires the candidate boot identity.",
            )
        if not COMMIT_RE.match(str(boot.get("sourceCommit") or "")):
            raise HelperError(
                "app_update_recovery_required",
                "Succeeded App-update status requires an observed source identity.",
            )
    return status


def _blank_receipt(
    request_id: str,
    source: Mapping[str, Any],
    expected_current_image_id: str,
    prepared_at: str,
) -> Dict[str, Any]:
    receipt = {
        "schemaVersion": SCHEMA_VERSION,
        "requestId": request_id,
        "source": dict(source),
        "expectedCurrentImageId": expected_current_image_id,
        "preparedAt": prepared_at,
        "startedAt": None,
        "completedAt": None,
        "jobId": None,
        "candidateImageId": None,
        "previousImageId": None,
        "candidateBoot": None,
        "previousBoot": None,
        "previousAppRestored": None,
        "error": None,
        "predicates": None,
        "appStopped": False,
    }
    set_stage(receipt, "prepared")
    return receipt


def identity_matches(expected: str, identity: Mapping[str, Any]) -> bool:
    return expected == identity.get("id") or expected in (identity.get("repo_digest_ids") or [])


def repo_digest_ids(values: Sequence[Any]) -> List[str]:
    ids = []
    for item in values:
        text = str(item)
        if "@" in text:
            digest = text.split("@", 1)[1]
            if DIGEST_RE.match(digest):
                ids.append(digest)
        elif DIGEST_RE.match(text):
            ids.append(text)
    return ids


def digest_tree(path: str, exclude: Sequence[str] = ()) -> str:
    """Hashes file names and contents under path, skipping optional root names."""
    digest = hashlib.sha256()
    root = os.path.realpath(path)
    for current, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            if current == root and name in exclude:
                continue
            full = os.path.join(current, name)
            relative = os.path.relpath(full, root).replace(os.sep, "/")
            digest.update(relative.encode("utf-8"))
            digest.update(b"\0")
            if os.path.islink(full):
                digest.update(os.readlink(full).encode("utf-8"))
                continue
            with open(full, "rb") as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _rmtree(path: str) -> None:
    if os.path.islink(path) or os.path.isfile(path):
        os.unlink(path)
        return
    for current, dirnames, filenames in os.walk(path, topdown=False):
        for name in filenames:
            os.unlink(os.path.join(current, name))
        for name in dirnames:
            os.rmdir(os.path.join(current, name))
    os.rmdir(path)


def _parse_iso(value: str) -> float:
    text = value.replace("Z", "+00:00")
    return datetime.fromisoformat(text).timestamp()


def _path_inside(path: str, root: str) -> bool:
    path = os.path.abspath(path)
    root = os.path.abspath(root)
    return path == root or path.startswith(root + os.sep)


def _redact(text: str) -> str:
    return SECRET_RE.sub(lambda match: match.group(1) + "[redacted]", text)


if __name__ == "__main__":
    sys.exit(main())
