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
import tempfile
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Set, Tuple

# Capture identity for this invocation before any separately authorized replacement of the installed file.
with open(__file__, "rb") as helper_file:
    HELPER_SHA256 = hashlib.sha256(helper_file.read()).hexdigest()

WORK_COUNT_KEYS = ("runningTurns", "pendingTurns", "queuedAdmissions", "openAttempts", "closingAttempts", "inFlightCommands")

PRODUCTION_CONFIG_PATH = "/etc/openkit/app-update/helper.json"
STDIN_LIMIT_BYTES = 16 * 1024
STDIN_DEADLINE_SECONDS = 10
RECEIPT_LIMIT_BYTES = 64 * 1024
RECEIPT_CAPACITY = 1000
# Current default: ~1.15 GB uncompressed App plus pull/extraction headroom and receipts.
RELEASE_MIN_FREE_BYTES = 3 * 1024 ** 3
# Match the four shipped journals checked by release preflight.
MIGRATION_SCOPES = ("app", "core", "user", "workspace")
MIGRATION_JOURNAL_LIMIT_BYTES = 64 * 1024
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
        "app_update_work_active",
        "app_update_preflight_unsupported",
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
CONTAINER_ID_RE = re.compile(r"^[a-f0-9]{64}$")
TCP_PORT_RE = re.compile(r"^[1-9][0-9]{0,4}$")
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
BOOT_SUBSYSTEM_NAMES = (
    "config",
    "storage",
    "policy",
    "vault",
    "scheduler",
    "llmGateway",
    "knowledgeIndex",
)
CRITICAL_SUBSYSTEM_NAMES = frozenset({"config", "policy", "storage"})
BOOT_STATES = frozenset({"degraded", "failed", "ready"})
APP_UPDATE_SSH_DESTS = (
    "/run/openkit/app-update/id_ed25519",
    "/run/openkit/app-update/known_hosts",
)
GETTING_STARTED_BACKUP_DIR = "/data/openkit.backups"
# Verify the sealed backups with the exact installed App image's storage owner.
GETTING_STARTED_BACKUP_INVENTORY = r"""
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataRootBackupIdSchema } from '@openkit/protocol';
import {
  DATA_ROOT_BACKUP_MANIFEST_FILE,
  verifyDataRootBackupManifest,
} from './dist/storage/data-root-backup.js';

const root = process.argv[1];
if (process.argv[2] === 'initialize') mkdirSync(root, { mode: 0o700, recursive: true });
if (!lstatSync(root).isDirectory()) process.exit(1);
const inventory = createHash('sha256');
for (const id of readdirSync(root).sort()) {
  if (!DataRootBackupIdSchema.safeParse(id).success) continue;
  const backupRoot = join(root, id);
  if (!lstatSync(backupRoot).isDirectory()) process.exit(1);
  const { manifest } = verifyDataRootBackupManifest({ backupRoot });
  if (manifest.id !== id) process.exit(1);
  inventory.update(id).update('\u0000');
  inventory.update(readFileSync(join(backupRoot, DATA_ROOT_BACKUP_MANIFEST_FILE)));
  inventory.update('\u0000');
}
console.log(inventory.digest('hex'));
"""
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
# packages/app-api-schemas/src/inbound-credential-operations.ts and inbound-credentials.ts.
CREDENTIAL_LIST_PATH = "/api/app/operations/credential.list"
CREDENTIAL_LIST_KEYS = frozenset({"items", "canManageServerCredentials"})
CREDENTIAL_KINDS = frozenset({"access-token", "auth-session", "discord-pairing", "worker-run", "nanohost-transport"})
ACCESS_TOKEN_CREDENTIAL_KEYS = frozenset({"kind", "id", "record", "integrationId"})
CONFIG_KEYS = {
    "schemaVersion",
    "containerName",
    "dataRoot",
    "receiptDir",
    "lockPath",
    "sourceRepository",
    "imageRepository",
    "appBaseUrl",
    "helperArgv",
    "webAssetsDir",
    "vaultKeyFile",
    "nanohostCredentialsDir",
    "caddyfile",
    "compatibility",
    "adminTokenFile",
    "appSecretsDirectory",
    "repositoryDirectory",
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
    "imageRepository",
    "appBaseUrl",
    "helperArgv",
    "webAssetsDir",
    "vaultKeyFile",
    "nanohostCredentialsDir",
    "caddyfile",
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
    "approvalSummary",
    "preparedHelperSha256",
    "candidateBoot",
    "candidateImageId",
    "completedAt",
    "error",
    "errorCode",
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

    def http_json(
        self, url: str, headers: Optional[Mapping[str, str]] = None, timeout: Optional[float] = None, method: str = "GET", body: Optional[Any] = None
    ) -> Tuple[int, Any]:
        request_headers = dict(headers or {})
        data = None if body is None else json.dumps(body).encode("utf-8")
        if data is not None:
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout or 15) as response:
                raw = response.read(RECEIPT_LIMIT_BYTES + 1)
                return response.status, _decode_bounded_json(raw)
        except urllib.error.HTTPError as error:
            try:
                raw = error.read(RECEIPT_LIMIT_BYTES + 1)
            except Exception:
                raw = b""
            finally:
                error.close()
            return error.code, _decode_bounded_json(raw)
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
    if argv[1:2] == ["--convert-getting-started"]:
        return convert_getting_started(argv[2:], stdout, effects, now)
    stage_target = argv[1:] == ["--stage-target"]
    try:
        if stage_target:
            # Local operator command. The restricted SSH protocol has no staging operation.
            config = load_config(PRODUCTION_CONFIG_PATH)
            helper = AppUpdateHelper(config, effects, now)
            candidate = helper._acquire_candidate(config["compatibility"]["candidate"])
            result = {"staged": True, "appDigest": candidate["published_digest"]}
        else:
            apply_id, config_path = _parse_argv(argv)
            command = read_command(stdin, now) if apply_id is None else None
            status_only = command is not None and command["op"] == "status"
            config = load_config(config_path, require_compatibility=not status_only)
            helper = AppUpdateHelper(config, effects, now, initialize_receipts=not status_only)
            if apply_id is not None:
                result = helper.apply(apply_id)
            else:
                result = helper.handle(command)
    except HelperError as error:
        result = host_error(error.code, error.message)
    except Exception:
        result = host_error("app_update_unavailable", "App-update helper could not complete.")
    stdout.write(json.dumps(result, separators=(",", ":"), sort_keys=True) + "\n")
    stdout.flush()
    return 1 if stage_target and "error" in result else 0


def convert_getting_started(paths: Sequence[str], stdout: Any, effects: Any, now: Callable[[], float]) -> int:
    """Run the separately authorized local conversion outside the restricted stdin command set."""
    try:
        if len(paths) != len(APP_UPDATE_SSH_DESTS):
            raise HelperError("app_update_invalid_request", "Conversion requires the two protected SSH bind sources.")
        helper = AppUpdateHelper(load_config(PRODUCTION_CONFIG_PATH, require_compatibility=False), effects, now)
        retained = helper.convert_getting_started(paths)
        result = {"converted": True, "retainedContainer": retained}
        exit_code = 0
    except HelperError as error:
        result = host_error(error.code, error.message)
        exit_code = 1
    except Exception:
        result = host_error("app_update_unavailable", "Conversion could not complete. Inspect the original App before retrying.")
        exit_code = 1
    stdout.write(json.dumps(result, separators=(",", ":"), sort_keys=True) + "\n")
    stdout.flush()
    return exit_code


def _decode_bounded_json(raw: bytes, *, parse_number: Optional[Callable[[str], float]] = None) -> Any:
    if not raw or len(raw) > RECEIPT_LIMIT_BYTES:
        return None
    try:
        return json.loads(raw.decode("utf-8"), parse_int=parse_number, parse_float=parse_number)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


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


def load_config(path: str, *, require_compatibility: bool = True) -> Dict[str, Any]:
    """Load protected configuration; receipt status alone needs no mutation assessment."""
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
    parsed = {key: value for key, value in parsed.items() if key in CONFIG_KEYS}
    for key in REQUIRED_CONFIG_KEYS:
        if key not in parsed:
            raise HelperError("app_update_unconfigured", "Helper config is incomplete.")
    path_keys = (
        "dataRoot",
        "receiptDir",
        "lockPath",
        "webAssetsDir",
        "vaultKeyFile",
        "nanohostCredentialsDir",
        "caddyfile",
    )
    bridge = "appSecretsDirectory" in parsed
    if bridge:
        path_keys += ("appSecretsDirectory",)
    for key in path_keys:
        if not isinstance(parsed[key], str) or not os.path.isabs(parsed[key]):
            raise HelperError("app_update_unconfigured", "Helper paths must be absolute.")
    if bridge and any(
        mark in parsed[key]
        for key in ("dataRoot", "nanohostCredentialsDir", "appSecretsDirectory")
        for mark in (",", "\n", "\r", "\0")
    ):
        raise HelperError("app_update_unconfigured", "Getting Started bind paths contain a mount delimiter.")
    token = parsed.get("adminTokenFile")
    if token is not None and (not isinstance(token, str) or not os.path.isabs(token)):
        raise HelperError("app_update_unconfigured", "Helper paths must be absolute.")
    repository = parsed.get("repositoryDirectory")
    if repository is not None:
        if not isinstance(repository, str) or not repository or not os.path.isabs(repository):
            raise HelperError("app_update_unconfigured", "Helper paths must be absolute.")
        if any(mark in repository for mark in (",", "\n", "\r", "\0")):
            raise HelperError(
                "app_update_unconfigured",
                "Helper repositoryDirectory contains a mount delimiter.",
            )
    if not isinstance(parsed["helperArgv"], list) or not parsed["helperArgv"]:
        raise HelperError("app_update_unconfigured", "Helper argv must be a non-empty list.")
    if any(not isinstance(item, str) or not item for item in parsed["helperArgv"]):
        raise HelperError("app_update_unconfigured", "Helper argv entries must be strings.")
    if require_compatibility:
        try:
            parsed["compatibility"] = _require_compatibility(parsed.get("compatibility"))
        except HelperError as error:
            raise HelperError(
                "app_update_unconfigured",
                "Helper compatibility assessment must be re-authored for a release candidate. " + error.message,
            ) from error
    else:
        parsed.pop("compatibility", None)
    data_root = os.path.realpath(parsed["dataRoot"])
    for key in ("receiptDir", "lockPath"):
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


def _require_source(value: Any, observed: bool = False) -> Dict[str, Any]:
    """Validate release identity; descriptive readers discard unknown fields."""
    if not isinstance(value, dict):
        raise HelperError("app_update_invalid_request", "Source must be a release object.")
    if not observed and set(value) - {"appDigest", "sourceCommit", "tag"}:
        raise HelperError("app_update_invalid_request", "Release source contains unknown fields.")
    tag = value.get("tag")
    if not isinstance(tag, str) or not TAG_RE.match(tag) or tag == "latest":
        raise HelperError("app_update_invalid_request", "Release tag must be an immutable version.")
    return {
        "appDigest": _require_digest(value.get("appDigest")),
        "sourceCommit": _require_commit(value.get("sourceCommit")),
        "tag": tag,
    }


def _require_compatibility(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise HelperError("app_update_unconfigured", "Helper compatibility assessment is missing.")
    if {"appliedMigrations", "candidate", "currentImageId"} - set(value):
        raise HelperError("app_update_unconfigured", "Helper compatibility assessment is incomplete.")
    applied = value.get("appliedMigrations")
    if not isinstance(applied, list) or not applied or any(not isinstance(item, str) or not item for item in applied):
        raise HelperError("app_update_unconfigured", "Helper compatibility appliedMigrations is invalid.")
    return {
        "appliedMigrations": [str(item) for item in applied],
        "candidate": _require_source(value.get("candidate"), observed=True),
        "currentImageId": _require_digest(value.get("currentImageId")),
    }


class AppUpdateHelper:
    """Filesystem receipts plus mocked-or-real host effects."""

    def __init__(
        self, config: Mapping[str, Any], effects: Any, now: Callable[[], float], *, initialize_receipts: bool = True
    ) -> None:
        self.config = dict(config)
        self.effects = effects
        self.now = now
        # A status probe must observe a missing receipt store, not initialize it.
        if initialize_receipts:
            os.makedirs(self.config["receiptDir"], mode=0o700, exist_ok=True)

    def handle(self, command: Mapping[str, Any]) -> Dict[str, Any]:
        op = command["op"]
        if op == "prepare":
            return self.prepare(command)
        if op == "start":
            return self.start(command["requestId"])
        return self.status(command["requestId"])

    def convert_getting_started(self, ssh_paths: Sequence[str]) -> str:
        """Recreate the published three-bind App with the same image and persistent backups."""
        if self._busy_with_other(""):
            raise HelperError("app_update_busy", "An App update is already running for this target.")
        with self._acquire_lock():
            name = self.config["containerName"]
            retained = name + "-before-update-helper"
            previous = self._inspect_container(name)
            original_id = str(previous.get("Id") or "")
            if not CONTAINER_ID_RE.fullmatch(original_id) or (previous.get("State") or {}).get("Running") is not True:
                raise HelperError("app_update_invalid_request", "Conversion requires the exact running original App.")
            image = self._image_identity(str(previous.get("Image") or ""))
            publications = self._assert_configured_deployment_bindings(previous, image, legacy_bridge=True)
            ssh_binds = []
            for dest, source in zip(APP_UPDATE_SSH_DESTS, ssh_paths):
                if any(mark in source for mark in (",", "\n", "\r", "\0")):
                    raise HelperError("app_update_invalid_request", "An App-update SSH source contains a mount delimiter.")
                mount = {"Destination": dest, "Source": source, "Type": "bind", "RW": False}
                self._assert_app_update_ssh_bind(mount, dest)
                ssh_binds.append(mount)
            names = self._conversion_docker(["ps", "-a", "--format", "{{.Names}}"], "App container names are unavailable.")
            backup = self._bridge_mounts()[GETTING_STARTED_BACKUP_DIR][0]
            if retained in names.splitlines() or os.path.lexists(backup):
                raise HelperError("app_update_invalid_request", "The retained container name or host backup directory already exists.")

            host = previous["HostConfig"]
            logging = (host.get("LogConfig") or {}).get("Config") or {}
            converted = {
                **previous,
                "HostConfig": {**host, "LogConfig": {"Config": {
                    "max-size": logging.get("max-size") or "10m",
                    "max-file": logging.get("max-file") or "5",
                }}},
                "Mounts": [*previous["Mounts"], *ssh_binds],
            }
            # Create first so recovery can act on the exact candidate container ID after start fails.
            create = self._replacement_argv(converted, image["id"], None, publications, create_only=True)
            before = self._observe_boot(image["id"], None)
            if before is None or before[0]["acceptingProductWork"] is not True:
                raise HelperError("app_update_unavailable", "The original App boot is unavailable for conversion.")
            backup_before = self._conversion_backup_inventory(original_id, initialize=True)
            self._assert_exclusive_dataroot_users({name})
            self._idle_preflight()

            candidate_id = None
            backup_created = False
            start_attempted = False
            try:
                self._conversion_docker(["stop", "--time", "60", original_id], "Could not confirm that the original App stopped.")
                self._assert_exclusive_dataroot_users(set())
                os.mkdir(backup, mode=0o700)
                backup_created = True
                self._conversion_docker(
                    ["cp", "--archive", "%s:%s/." % (original_id, GETTING_STARTED_BACKUP_DIR), backup],
                    "Could not copy the original App backups.", self.config["jobTimeoutSeconds"],
                )
                self._conversion_docker(["rename", original_id, retained], "Could not retain the original App.")
                created = self._conversion_docker(create[1:], "Could not create the converted App.").strip()
                if not CONTAINER_ID_RE.fullmatch(created) or created == original_id:
                    raise HelperError("app_update_recovery_required", "The converted App container identity is unknown.")
                candidate_id = created
                start_attempted = True
                self._conversion_docker(["start", candidate_id], "Could not start the converted App.")
                self._verify_conversion_boot(name, candidate_id, image, before[0]["bootId"])
                if self._conversion_backup_inventory(candidate_id) != backup_before:
                    raise HelperError("app_update_unavailable", "The converted App backup inventory differs from the original.")
            except Exception as error:
                try:
                    restarted = self._restore_conversion(name, original_id, image["id"], retained, candidate_id)
                    if backup_created and not start_attempted:
                        _rmtree(backup)
                except Exception as restore_error:
                    raise HelperError(
                        "app_update_recovery_required", "Conversion could not confirm restoration. Inspect both App containers and the backup directory."
                    ) from restore_error
                message = error.message if isinstance(error, HelperError) else "Conversion failed."
                recovery = "Original App restarted and is healthy." if restarted else "Original App is healthy."
                raise HelperError("app_update_unavailable", message + " " + recovery) from error
            return retained

    def _conversion_docker(self, args: Sequence[str], message: str, timeout: float = 120) -> str:
        """Observe Docker without publishing output that can contain protected bind paths."""
        code, stdout, _ = self.effects.run(["docker", *args], timeout=timeout)
        if code != 0:
            raise HelperError("app_update_unavailable", message)
        return stdout

    def _conversion_backup_inventory(self, container_id: str, *, initialize: bool = False) -> str:
        """Verify every sealed backup against its manifest and return a bounded inventory identity."""
        output = self._conversion_docker(
            [
                "exec", "--workdir", "/app/nanocore", container_id,
                "node", "--input-type=module", "--eval", GETTING_STARTED_BACKUP_INVENTORY,
                "--", GETTING_STARTED_BACKUP_DIR, "initialize" if initialize else "verify",
            ],
            "Could not verify the App backup inventory.", self.config["jobTimeoutSeconds"],
        ).strip()
        if not re.fullmatch(r"[a-f0-9]{64}", output):
            raise HelperError("app_update_unavailable", "The App backup inventory identity is malformed.")
        return output

    def _verify_conversion_boot(self, name: str, candidate_id: str, image: Mapping[str, Any], previous_boot: str) -> None:
        """Confirm the exact same-image App is healthy and now passes strict update binding admission."""
        timeout = int(self.config["readyTimeoutSeconds"])
        for attempt in range(timeout + 1):
            current = self._inspect_container(name)
            if current.get("Id") != candidate_id or current.get("Image") != image["id"]:
                raise HelperError("app_update_recovery_required", "The converted App identity does not match the original image.")
            state = current.get("State") or {}
            if state.get("Running") is True and (state.get("Health") or {}).get("Status") == "healthy":
                observed = self._observe_boot(image["id"], None)
                if observed and observed[0]["bootId"] != previous_boot and observed[0]["acceptingProductWork"] is True:
                    self._assert_configured_deployment_bindings(current, image)
                    return
            if attempt < timeout:
                self._sleep(1)
        raise HelperError("app_update_unavailable", "The converted App did not become healthy.")

    def _restore_conversion(
        self, name: str, original_id: str, image_id: str, retained: str, candidate_id: Optional[str]
    ) -> bool:
        """Prove the original App's state before restart and confirm it becomes healthy."""
        original = self._inspect_container(original_id)
        original_name = original.get("Name")
        running = (original.get("State") or {}).get("Running")
        if (
            original.get("Id") != original_id or original.get("Image") != image_id
            or original_name not in ("/" + name, "/" + retained) or not isinstance(running, bool)
        ):
            raise HelperError("app_update_recovery_required", "The original App state could not be confirmed.")
        if running:
            if candidate_id is not None or original_name != "/" + name:
                raise HelperError("app_update_recovery_required", "The original App is running in an unexpected state.")
            self._assert_exclusive_dataroot_users({name})
        else:
            if candidate_id is not None:
                if (self._inspect_container(candidate_id).get("State") or {}).get("Running") is True:
                    self._conversion_docker(["stop", "--time", "30", candidate_id], "Could not stop the converted App.")
                self._conversion_docker(["rm", candidate_id], "Could not release the original App name.")
            self._assert_exclusive_dataroot_users(set())
            if original_name == "/" + retained:
                self._conversion_docker(["rename", original_id, name], "Could not restore the original App name.")
            self._conversion_docker(["start", original_id], "Could not restart the original App.")

        timeout = int(self.config["readyTimeoutSeconds"])
        for attempt in range(timeout + 1):
            current = self._inspect_container(original_id)
            state = current.get("State") or {}
            if (
                current.get("Id") != original_id or current.get("Image") != image_id
                or current.get("Name") != "/" + name or state.get("Running") is not True
            ):
                break
            if (state.get("Health") or {}).get("Status") == "healthy":
                return not running
            if attempt < timeout:
                self._sleep(1)
        raise HelperError("app_update_recovery_required", "The original App did not return to a healthy state.")

    def prepare(self, command: Mapping[str, Any]) -> Dict[str, Any]:
        self._refuse_fresh_root_release(command["source"])
        self._assert_capacity()
        inspect = self._inspect_container(self.config["containerName"])
        current_identity = self._image_identity(str(inspect.get("Image") or ""))
        self._assert_configured_deployment_bindings(inspect, current_identity)
        request_id = str(uuid.uuid4())
        prepared_at = isoformat(self.now())
        receipt = _blank_receipt(
            request_id=request_id,
            source=command["source"],
            expected_current_image_id=command["expectedCurrentImageId"],
            prepared_at=prepared_at,
        )
        preflight = self._idle_preflight()
        self._assert_migration_free(inspect, self._local_candidate_image_id(command["source"]))
        receipt["preparedHelperSha256"] = HELPER_SHA256
        receipt["approvalSummary"] = {
            "targetRelease": dict(command["source"]),
            "expectedCurrentImageId": command["expectedCurrentImageId"],
            "observedCurrentImageId": current_identity["id"],
            "interruptionScope": "NanoCore, Web and active client connections on this deployment are interrupted. NanoHost may keep its process or be restarted by its service supervisor during replacement (#934).",
            "safetyEvidence": {"deploymentBindings": True, "preflight": preflight},
            "recoveryLimitations": [
                "Restoration requires the configured migration-free assessment; apply rechecks it before stopping.",
                "No automatic rollback across data migrations.",
                "No automatic resume or replay of interrupted product work.",
                "The final preflight is not an admission barrier; work may arrive before shutdown closes admission.",
                "Published release attribution, smoke, retained-auth and NanoHost verification remain apply-time checks.",
            ],
        }
        self._write_receipt(receipt, exclusive=True)
        return project_status(receipt)

    @staticmethod
    def _refuse_fresh_root_release(source: Mapping[str, Any]) -> None:
        """The exact storage cutover is an operator reinstall with paired host recovery."""
        if source["tag"] == "v0.2.0":
            raise HelperError("app_update_invalid_request", "Release v0.2.0 requires a fresh Data Root installation and paired predecessor recovery.")

    def start(self, request_id: str) -> Dict[str, Any]:
        receipt = self._load_receipt(request_id, missing_code="app_update_recovery_required")
        self._refuse_fresh_root_release(receipt["source"])
        receipt = self._maybe_mark_unknown(receipt)
        if receipt["stage"] != "prepared":
            return project_status(receipt)
        self._assert_unexpired_prepare(receipt, self.now())
        if self._busy_with_other(request_id):
            raise HelperError("app_update_busy", "An App update is already running for this target.")
        # A receipt prepared by an older helper does not prove the target journals were checked.
        inspect = self._inspect_container(self.config["containerName"])
        self._assert_migration_free(inspect, self._local_candidate_image_id(receipt["source"]))
        # Docker reads can take time. Observe any launch that happened during the check.
        receipt = self._maybe_mark_unknown(self._load_receipt(request_id, missing_code="app_update_recovery_required"))
        if receipt["stage"] != "prepared":
            return project_status(receipt)
        if self._busy_with_other(request_id):
            raise HelperError("app_update_busy", "An App update is already running for this target.")
        started_at = self.now()
        self._assert_unexpired_prepare(receipt, started_at)
        job_id = "openkit-app-update-%s.service" % request_id
        set_stage(receipt, "launching")
        receipt["startedAt"] = isoformat(started_at)
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

    def _assert_unexpired_prepare(self, receipt: Mapping[str, Any], observed_at: float) -> None:
        """Require recent preparation at the actual launch intent time."""
        age = observed_at - _parse_iso(receipt["preparedAt"])
        if age > float(self.config["prepareTtlSeconds"]):
            raise HelperError("app_update_expired", "Prepared App-update receipt expired.")

    def status(self, request_id: str) -> Dict[str, Any]:
        receipt = self._load_receipt(request_id, missing_code="app_update_not_found")
        receipt = self._maybe_mark_unknown(receipt)
        return project_status(receipt)

    def apply(self, request_id: str) -> Dict[str, Any]:
        lock_handle = self._acquire_lock()
        try:
            receipt = self._load_receipt(request_id, missing_code="app_update_recovery_required")
            if receipt["stage"] in TERMINAL_STAGES:
                return project_status(receipt)
            self._refuse_fresh_root_release(receipt["source"])
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
                bridge_publications = self._assert_configured_deployment_bindings(inspect, current_identity)
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
                previous = self._observe_boot(current_identity["id"], None)
                if previous is None:
                    raise HelperError(
                        "app_update_unavailable",
                        "Previous App boot observation is missing or malformed.",
                    )
                receipt["previousBoot"], previous_readiness = previous
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
                self._assert_migration_free(inspect, candidate["image_id"])
                receipt["candidateLocalImageId"] = candidate["image_id"]
                receipt["candidateImageId"] = candidate["published_digest"]
                receipt["candidateRef"] = candidate["ref"]
                receipt["sourceImageMap"] = {
                    "imageId": candidate["image_id"],
                    "publishedDigest": candidate["published_digest"],
                    "sourceCommit": candidate["source_commit"],
                }
                self._write_receipt(receipt)
                self._smoke(candidate["ref"])
                web_plan = None if bridge_publications else self._stage_web_assets(candidate)
                retained = "%s-previous" % self.config["containerName"]
                receipt["retainedContainerName"] = retained
                if web_plan is not None:
                    receipt["previousWebAssets"] = web_plan["previous"]
                    receipt["candidateWebAssets"] = web_plan["candidate"]
                    receipt["webPreviousDigest"] = web_plan["previous_digest"]
                    receipt["webStagedDigest"] = web_plan["staged_digest"]
                self._write_receipt(receipt)
                self._assert_exclusive_dataroot_users({self.config["containerName"]})
                try:
                    self._idle_preflight()
                except Exception:
                    # A refused pre-stop recheck must not leave a staged Web tree behind.
                    if web_plan is not None and os.path.lexists(web_plan["partial"]):
                        _rmtree(web_plan["partial"])
                    raise
                # Retained names change only after the work recheck has admitted interruption.
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
                if web_plan is not None:
                    receipt["webLiveDigest"] = self._publish_web_assets(web_plan)
                run_argv = self._replacement_argv(inspect, candidate["ref"], candidate["source_commit"], bridge_publications)
                code, _, stderr = self.effects.run(run_argv, timeout=60)
                if code != 0:
                    raise HelperError("app_update_unavailable", stderr or "Candidate App failed to start.")
                set_stage(receipt, "verifying")
                self._write_receipt(receipt)
                boot = self._verify(receipt, candidate, previous_readiness)
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
        receipt["errorCode"] = error.code if isinstance(error, HelperError) else "app_update_unavailable"
        try:
            self._write_receipt(receipt)
        except Exception:
            # A failed durable write cannot replace the original cause or invent a terminal observation.
            if isinstance(error, HelperError):
                raise error
            raise HelperError("app_update_unavailable", message) from error
        if isinstance(error, HelperError) and error.code in {"app_update_capacity", "app_update_work_active", "app_update_preflight_unsupported"}:
            raise error
        return project_status(receipt)

    def _idle_preflight(self) -> Dict[str, Any]:
        """Require a content-free current observation; unsupported older Apps refuse without fallback."""
        status, body = self._authorized_json("/api/app/operations/app-update.preflight", method="POST", body={})
        if status == 404:
            raise HelperError(
                "app_update_preflight_unsupported",
                "Running App predates the content-free App-update preflight; this update procedure cannot establish maintenance safety.",
            )
        if status != 200 or not isinstance(body, dict):
            raise HelperError("app_update_unavailable", "Deployment work preflight is unavailable.")
        body = parse_work_preflight(body)
        idle = body["state"] == "idle"
        if not idle:
            raise HelperError("app_update_work_active", "Deployment work is active; running, pending, queued or in-flight work prevents the App update.")
        return body

    def _local_candidate_image_id(self, source: Mapping[str, Any]) -> str:
        """Resolve the staged digest within the short prepare/start SSH deadline."""
        reference = "%s@%s" % (self.config["imageRepository"], source["appDigest"])
        try:
            identity = self._image_identity(reference)
        except HelperError as error:
            raise HelperError(
                "app_update_unavailable",
                "Target image is unavailable locally. Ask the host operator to run the installed App-update helper with --stage-target before preparing or starting.",
            ) from error
        if source["appDigest"] not in identity["repo_digest_ids"]:
            raise HelperError("app_update_invalid_request", "Local image RepoDigests do not contain the published release digest.")
        return identity["id"]

    def _assert_migration_free(self, current: Mapping[str, Any], candidate_image_id: str) -> None:
        """Require identical shipped journals before any replacement can start."""
        current_id = str(current.get("Id") or "")
        if not CONTAINER_ID_RE.fullmatch(current_id) or (current.get("State") or {}).get("Running") is not True:
            raise HelperError("app_update_unavailable", "Cannot identify the running App for the migration journal check.")
        code, output, _ = self.effects.run(
            ["docker", "create", "--pull", "never", "--network", "none", candidate_image_id], timeout=15,
        )
        candidate_id = output.strip()
        if code != 0 or not CONTAINER_ID_RE.fullmatch(candidate_id) or candidate_id == current_id:
            raise HelperError("app_update_unavailable", "Could not create the stopped target journal inspection container.")
        try:
            with tempfile.TemporaryDirectory(prefix="openkit-app-journals-") as directory:
                for scope in MIGRATION_SCOPES:
                    running = self._copy_migration_journal(
                        current_id, scope, os.path.join(directory, scope + "-running"),
                    )
                    target = self._copy_migration_journal(
                        candidate_id, scope, os.path.join(directory, scope + "-target"),
                    )
                    if target != running:
                        raise HelperError(
                            "app_update_invalid_request",
                            "Target %s migration journal differs from the running App. Use the stopped-App forward migration procedure. Make a verified cold Data Root backup before starting the target." % scope,
                        )
        finally:
            code, _, _ = self.effects.run(["docker", "rm", "-v", candidate_id], timeout=15)
        if code != 0:
            raise HelperError("app_update_unavailable", "Could not remove the stopped target journal inspection container.")

    def _copy_migration_journal(self, container_id: str, scope: str, path: str) -> str:
        """Read one shipped journal and canonicalize object keys while preserving entry order."""
        remote = "%s:/app/nanocore/drizzle/%s/meta/_journal.json" % (container_id, scope)
        message = "Could not read the %s migration journal." % scope
        code, _, _ = self.effects.run(["docker", "cp", remote, path], timeout=15)
        if code != 0:
            raise HelperError("app_update_unavailable", message)
        try:
            metadata = os.lstat(path)
            if not stat.S_ISREG(metadata.st_mode) or not 0 < metadata.st_size <= MIGRATION_JOURNAL_LIMIT_BYTES:
                raise HelperError("app_update_unavailable", message)
            with open(path, "rb") as journal:
                raw = journal.read(MIGRATION_JOURNAL_LIMIT_BYTES + 1)
            # Release preflight treats all JSON numbers as JavaScript numbers, including signed zero.
            def parse_number(value: str) -> float:
                return float(value) or 0.0

            data = _decode_bounded_json(raw, parse_number=parse_number)
            if not isinstance(data, dict) or not isinstance(data.get("entries"), list) or not data["entries"]:
                raise HelperError("app_update_unavailable", message)
            return json.dumps(data, sort_keys=True, separators=(",", ":"), allow_nan=False)
        except (OSError, ValueError, RecursionError) as error:
            raise HelperError("app_update_unavailable", message) from error

    def _acquire_candidate(self, source: Mapping[str, Any]) -> Dict[str, Any]:
        """Pull the verified published digest only after checking host capacity."""
        self._refuse_fresh_root_release(source)
        verified_commit = self._verify_release_attribution(source)
        self._assert_pull_capacity()
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
            "ref": ref,
            "source_commit": verified_commit,
        }

    def _assert_pull_capacity(self) -> None:
        """Check Docker storage and receipt storage before pulling or interrupting the App."""
        code, stdout, stderr = self.effects.run(
            ["docker", "info", "--format", "{{.DockerRootDir}}"], timeout=30,
        )
        docker_root = (stdout or "").strip()
        if code != 0 or not os.path.isabs(docker_root):
            raise HelperError("app_update_unavailable", stderr or "Docker data root could not be observed.")
        for name, path in (("Docker data root", docker_root), ("receipt directory", self.config["receiptDir"])):
            try:
                usage = os.statvfs(path)
            except OSError as error:
                raise HelperError("app_update_unavailable", "%s free bytes could not be observed." % name) from error
            free_bytes = usage.f_bavail * usage.f_frsize
            if free_bytes < RELEASE_MIN_FREE_BYTES:
                raise HelperError(
                    "app_update_capacity",
                    "%s has %s free bytes; requires at least %s bytes before release pull."
                    % (name, free_bytes, RELEASE_MIN_FREE_BYTES),
                )

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
            "env": list(config.get("Env") or []),
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

    def _assert_json_file_log_retention(self, inspect: Mapping[str, Any]) -> None:
        """Name a non-json-file driver or each missing retention option."""
        log = (inspect.get("HostConfig") or {}).get("LogConfig") or {}
        log_type = log.get("Type") or "json-file"
        log_cfg = log.get("Config") or {}
        if log_type != "json-file":
            raise HelperError(
                "app_update_invalid_request",
                "App log driver is %s; json-file is required." % log_type,
            )
        missing = [name for name in ("max-size", "max-file") if name not in log_cfg]
        if missing:
            raise HelperError(
                "app_update_invalid_request",
                "App log option %s is missing." % ", ".join(missing),
            )

    def _assert_configured_deployment_bindings(
        self, inspect: Mapping[str, Any], image: Mapping[str, Any], *, legacy_bridge: bool = False
    ) -> List[str]:
        """Require the configured bindings and return the validated Getting Started publications."""
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
        bridge = "appSecretsDirectory" in self.config
        if legacy_bridge and not bridge:
            raise HelperError("app_update_unconfigured", "Conversion requires the configured Getting Started bridge layout.")
        publications: List[str] = []
        if bridge:
            publications = self._bridge_publications(inspect)
        else:
            if host.get("NetworkMode") != "host":
                raise HelperError("app_update_invalid_request", "App network mode must be host when appSecretsDirectory is absent.")
            if host.get("PortBindings"):
                raise HelperError("app_update_invalid_request", "App port bindings are unsupported on host network.")
        restart = (host.get("RestartPolicy") or {}).get("Name")
        if restart != "unless-stopped":
            raise HelperError("app_update_invalid_request", "App restart policy must be unless-stopped.")
        if not legacy_bridge:
            self._assert_json_file_log_retention(inspect)
        entrypoint = list(config.get("Entrypoint") or [])
        cmd = list(config.get("Cmd") or [])
        if entrypoint != image["entrypoint"] or cmd != image["cmd"]:
            raise HelperError("app_update_invalid_request", "App entrypoint/cmd is not the image default.")
        mounts = {item.get("Destination"): item for item in inspect.get("Mounts") or [] if isinstance(item, dict)}
        expected = self._bridge_mounts() if bridge else {
            "/data/openkit": (self.config["dataRoot"], True),
            "/data/openkit.backups": ("%s.backups" % self.config["dataRoot"], True),
            "/run/nanohost-credentials": (self.config["nanohostCredentialsDir"], True),
            "/srv/web": (self.config["webAssetsDir"], False),
            "/etc/caddy/Caddyfile": (self.config["caddyfile"], False),
            "/run/secrets/openkit-vault.key": (self.config["vaultKeyFile"], False),
        }
        if legacy_bridge:
            del expected[GETTING_STARTED_BACKUP_DIR]
        required = set(expected)
        if not legacy_bridge:
            required.update(APP_UPDATE_SSH_DESTS)
        directory = self.config.get("repositoryDirectory")
        if directory:
            if bridge:
                raise HelperError("app_update_invalid_request", "Getting Started does not mount a host repository directory.")
            required.add("/srv/repos")
            expected["/srv/repos"] = (directory, True)
            try:
                meta = os.lstat(directory)
            except OSError as error:
                raise HelperError(
                    "app_update_invalid_request",
                    "Configured repositoryDirectory is missing.",
                ) from error
            if stat.S_ISLNK(meta.st_mode) or not stat.S_ISDIR(meta.st_mode):
                raise HelperError(
                    "app_update_invalid_request",
                    "Configured repositoryDirectory must be a non-linked directory.",
                )
        if set(mounts) != required:
            raise HelperError(
                "app_update_invalid_request",
                "App mounts do not match the configured Getting Started deployment set."
                if bridge else
                "App mounts do not match the configured deployment set: Data Root, backup, sink, Web, Caddyfile, Vault key, and App-update SSH.",
            )
        if directory and str((mounts["/srv/repos"] or {}).get("Type") or "") != "bind":
            raise HelperError("app_update_invalid_request", "App mount /srv/repos must be a bind.")
        for dest, (source, writable) in expected.items():
            item = mounts[dest]
            if bridge and item.get("Type") != "bind":
                raise HelperError("app_update_invalid_request", "App mount %s must be a bind." % dest)
            if str(item.get("Source") or "") != source or bool(item.get("RW")) != writable:
                raise HelperError("app_update_invalid_request", "App mount %s does not match helper config." % dest)
        if not legacy_bridge:
            for dest in APP_UPDATE_SSH_DESTS:
                self._assert_app_update_ssh_bind(mounts[dest], dest)
        data_rw = [
            item
            for item in mounts.values()
            if item.get("Destination") == "/data/openkit" and item.get("RW") is True
        ]
        if len(data_rw) != 1:
            raise HelperError("app_update_invalid_request", "App must have exactly one RW Data Root mount.")
        return publications

    def _bridge_mounts(self) -> Dict[str, Tuple[str, bool]]:
        """Return the persistent Getting Started binds before SSH setup."""
        return {
            "/data/openkit": (self.config["dataRoot"], True),
            GETTING_STARTED_BACKUP_DIR: ("%s.backups" % self.config["dataRoot"], True),
            "/run/openkit-secrets": (self.config["appSecretsDirectory"], False),
            "/run/openkit-enrollment": (self.config["nanohostCredentialsDir"], True),
        }

    def _bridge_publications(self, inspect: Mapping[str, Any]) -> List[str]:
        """Admit only the two explicit TCP loopback publications on Docker's default bridge."""
        host = inspect.get("HostConfig") or {}
        networks = (inspect.get("NetworkSettings") or {}).get("Networks") or {}
        if host.get("NetworkMode") not in ("bridge", "default") or set(networks) != {"bridge"}:
            raise HelperError("app_update_invalid_request", "Getting Started requires Docker's default bridge network.")
        bindings = host.get("PortBindings") or {}
        if host.get("PublishAllPorts") or len(bindings) != 2 or "8080/tcp" not in bindings:
            raise HelperError("app_update_invalid_request", "Getting Started requires separate App and NanoHost TCP publications.")
        publications = []
        for target, entries in sorted(bindings.items()):
            port = target.removesuffix("/tcp")
            if target != port + "/tcp" or not TCP_PORT_RE.fullmatch(port) or int(port) > 65535:
                raise HelperError("app_update_invalid_request", "Getting Started requires valid TCP container ports.")
            if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
                raise HelperError("app_update_invalid_request", "Getting Started requires one loopback bind per published TCP port.")
            entry = entries[0]
            published = entry.get("HostPort")
            if (
                entry.get("HostIp") != "127.0.0.1"
                or not isinstance(published, str)
                or not TCP_PORT_RE.fullmatch(published)
                or int(published) > 65535
            ):
                raise HelperError("app_update_invalid_request", "Getting Started requires explicit IPv4 loopback port publications.")
            if port == "8080":
                if self.config["appBaseUrl"].rstrip("/") != "http://127.0.0.1:" + published:
                    raise HelperError("app_update_invalid_request", "Helper App URL must match the published loopback App port.")
            elif published != port:
                raise HelperError("app_update_invalid_request", "Getting Started requires equal host and container NanoHost ports.")
            publications.append("127.0.0.1:%s:%s" % (published, port))
        return publications

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

    def _replacement_argv(
        self, inspect: Mapping[str, Any], image_ref: str, source_commit: Optional[str],
        bridge_publications: Sequence[str] = (), *, create_only: bool = False,
    ) -> List[str]:
        """Preserve validated bindings when starting the exact replacement image."""
        host = inspect.get("HostConfig") or {}
        config = inspect.get("Config") or {}
        log_cfg = (host.get("LogConfig") or {}).get("Config") or {}
        argv = ["docker", "create"] if create_only else ["docker", "run", "--detach"]
        argv.extend([
            "--name",
            self.config["containerName"],
            "--restart",
            "unless-stopped",
            "--runtime",
            "runc",
            "--network",
            "bridge" if bridge_publications else "host",
        ])
        if bridge_publications:
            for publication in bridge_publications:
                argv.extend(["--publish", publication])
            for destination, (source, writable) in self._bridge_mounts().items():
                bind = "type=bind,src=%s,dst=%s" % (source, destination)
                argv.extend(["--mount", bind if writable else bind + ",readonly"])
        else:
            argv.extend(
                [
                    "--volume",
                    "%s:/data/openkit" % self.config["dataRoot"],
                    "--volume",
                    "%s.backups:/data/openkit.backups" % self.config["dataRoot"],
                    "--volume",
                    "%s:/run/nanohost-credentials" % self.config["nanohostCredentialsDir"],
                    "--mount",
                    "type=bind,src=%s,dst=/srv/web,readonly" % self.config["webAssetsDir"],
                    "--mount",
                    "type=bind,src=%s,dst=/etc/caddy/Caddyfile,readonly" % self.config["caddyfile"],
                    "--mount",
                    "type=bind,src=%s,dst=/run/secrets/openkit-vault.key,readonly" % self.config["vaultKeyFile"],
                ]
            )
        directory = self.config.get("repositoryDirectory")
        if directory:
            argv.extend(["--mount", "type=bind,src=%s,dst=/srv/repos" % directory])
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
                "--log-driver",
                "json-file",
                "--log-opt",
                "max-size=%s" % log_cfg["max-size"],
                "--log-opt",
                "max-file=%s" % log_cfg["max-file"],
            ]
        )
        if source_commit is not None:
            argv.extend(["--label", "org.openkit.staging.commit=%s" % source_commit])
        health = config.get("Healthcheck") or {}
        test = health.get("Test") or []
        if test and test[0] == "CMD-SHELL" and len(test) >= 2:
            argv.extend(["--health-cmd", test[1]])
        # Docker merges image defaults into container Config.Env. Replay only differences.
        previous_image = self._image_identity(str(inspect.get("Image") or ""))
        defaults = set(previous_image["env"])
        for env in config.get("Env") or []:
            if env not in defaults:
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
        status, body = self._authorized_json("/api/diagnostics")
        if status != 200 or not isinstance(body, dict):
            raise HelperError("app_update_unavailable", "Live applied migrations could not be read.")
        applied = ((body.get("migrations") or {}) if isinstance(body.get("migrations"), dict) else {}).get("applied")
        if not isinstance(applied, list) or any(not isinstance(item, str) or not item for item in applied):
            raise HelperError("app_update_unavailable", "Live applied migrations are not a string list.")
        return [str(item) for item in applied]

    def _stage_web_assets(self, candidate: Mapping[str, Any]) -> Dict[str, str]:
        """Extracts Web assets and decides live-target reuse before App interruption."""
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
        staged_digest = digest_tree(staged_dir)
        if os.path.realpath(os.path.join(root, commit)) == os.path.realpath(current):
            # A repeated commit may reuse live bytes, but must never replace them in place.
            _rmtree(staged_dir)
            if staged_digest != previous_digest:
                raise HelperError(
                    "app_update_unavailable",
                    "Candidate Web directory is the live current target but its staged digest differs.",
                )
        return {
            "candidate": commit,
            "partial": staged_dir,
            "previous": previous,
            "previous_digest": previous_digest,
            "staged_digest": staged_digest,
        }

    def _publish_web_assets(self, web_plan: Mapping[str, str]) -> str:
        """Publishes a different Web target or verifies the prepared live-target no-op."""
        root = self.config["webAssetsDir"]
        final_dir = os.path.join(root, web_plan["candidate"])
        live_current = os.path.join(root, "current")
        live_target = os.path.realpath(live_current) if os.path.lexists(live_current) else ""
        # Staging already assessed identical live assets; leave their directory and pointer intact.
        if os.path.realpath(final_dir) != live_target:
            if os.path.lexists(final_dir):
                _rmtree(final_dir)
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
        """Restores the retained App after candidate handling and a running-writer check."""
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
        # Nonzero listing exits keep candidate handling; timeouts require explicit host recovery as elsewhere.
        code, stdout, _ = self.effects.run(["docker", "ps", "-a", "--format", "{{.Names}}"], timeout=15)
        candidate_exists = code != 0 or name in (stdout or "").splitlines()
        if candidate_exists:
            code, _, stderr = self.effects.run(["docker", "stop", "--time", "30", name], timeout=60)
            if code != 0:
                raise HelperError(
                    "app_update_recovery_required",
                    _redact(stderr or "Failed to stop the candidate App before restoring the previous App.")[:512],
                )
        self._assert_exclusive_dataroot_users(set())
        if candidate_exists:
            failed = "%s.failed-%s" % (name, str(receipt.get("requestId") or "x").split("-")[0])
            self.effects.run(["docker", "rename", name, failed], timeout=30)
        if retained:
            self._run_required(["docker", "rename", str(retained), name], "Failed to restore the previous App name.")
            self._run_required(["docker", "start", name], "Failed to start the previous App.")

    def _active_dataroot_users(self) -> List[str]:
        """Lists observed writable users, refusing failed inspections or invalid JSON."""
        code, stdout, stderr = self.effects.run(
            ["docker", "ps", "--filter", "status=running", "--format", "{{.Names}}"],
            timeout=15,
        )
        if code != 0:
            raise HelperError("app_update_unavailable", stderr or "Running container list failed.")
        users = []
        for name in [line.strip() for line in (stdout or "").splitlines() if line.strip()]:
            inspect_code, raw, inspect_error = self.effects.run(
                ["docker", "inspect", "--format", "{{json .}}", name],
                timeout=30,
            )
            if inspect_code != 0:
                raise HelperError(
                    "app_update_unavailable",
                    "Running container inspect failed: %s" % (inspect_error or name),
                )
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError as error:
                raise HelperError("app_update_unavailable", "Running container inspect is not JSON.") from error
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

    def _parse_boot_readiness(self, body: Any) -> Optional[Dict[str, Any]]:
        """Parses the typed boot projection and fail-closes on malformed or inconsistent state."""
        if not isinstance(body, dict):
            return None
        boot = body.get("boot")
        if not isinstance(boot, dict):
            return None
        if set(boot) != {"acceptingProductWork", "bootId", "overall", "subsystems"}:
            return None
        boot_id = boot.get("bootId")
        if not isinstance(boot_id, str) or not BOOT_ID_RE.match(boot_id):
            return None
        accepting = boot.get("acceptingProductWork")
        if not isinstance(accepting, bool):
            return None
        overall = boot.get("overall")
        if overall not in BOOT_STATES:
            return None
        subsystems = boot.get("subsystems")
        if not isinstance(subsystems, dict) or set(subsystems) != set(BOOT_SUBSYSTEM_NAMES):
            return None
        codes: List[str] = []
        readiness_blocks: Set[Tuple[str, str, str]] = set()
        failed_subsystems: Set[str] = set()
        has_nonready = False
        for name in BOOT_SUBSYSTEM_NAMES:
            item = subsystems[name]
            if not isinstance(item, dict) or set(item) != {"reasons", "state"}:
                return None
            state = item.get("state")
            if state not in BOOT_STATES:
                return None
            if state != "ready":
                has_nonready = True
            if state == "failed":
                failed_subsystems.add(name)
            reasons = item.get("reasons")
            if not isinstance(reasons, list):
                return None
            if state in {"degraded", "failed"} and not reasons:
                return None
            for reason in reasons:
                if not isinstance(reason, dict) or set(reason) != {"blocks", "code", "message"}:
                    return None
                code = reason.get("code")
                message = reason.get("message")
                blocks = reason.get("blocks")
                if not isinstance(code, str) or not code or len(code) > 128:
                    return None
                if not isinstance(message, str) or not message:
                    return None
                if not isinstance(blocks, list) or any(
                    not isinstance(entry, str) or not entry for entry in blocks
                ):
                    return None
                readiness_blocks.update((name, code, block) for block in blocks)
                if len(codes) >= 32:
                    return None
                codes.append(code)
        has_critical_failure = not CRITICAL_SUBSYSTEM_NAMES.isdisjoint(failed_subsystems)
        expected_overall = "failed" if has_critical_failure else ("degraded" if has_nonready else "ready")
        if overall != expected_overall:
            return None
        if accepting != (not has_critical_failure):
            return None
        return {
            "acceptingProductWork": accepting,
            "blockingReasons": codes,
            "bootId": boot_id,
            "failedSubsystems": failed_subsystems,
            "readinessBlocks": readiness_blocks,
        }

    def _observe_boot(
        self, image_id: Optional[str], source_commit: Optional[str]
    ) -> Optional[Tuple[Dict[str, Any], Dict[str, Any]]]:
        status, body = self._authorized_json("/api/app/operations/diagnostics.app", method="POST", body={})
        if status != 200:
            return None
        parsed = self._parse_boot_readiness(body)
        if parsed is None:
            return None
        if image_id is not None and not DIGEST_RE.match(str(image_id)):
            return None
        return (
            {
                "acceptingProductWork": parsed["acceptingProductWork"],
                "blockingReasons": list(parsed["blockingReasons"]),
                "bootId": parsed["bootId"],
                "imageId": image_id,
                "sourceCommit": source_commit,
            },
            parsed,
        )

    def _positive_int(self, value: Any) -> Optional[int]:
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            return None
        return value

    def _typed_nanohost_absent(self, status: int, body: Any) -> bool:
        return (
            status == 404
            and isinstance(body, dict)
            and body.get("code") == "nanohost_runtime_target_not_found"
        )

    def _snapshot_nanohost(self, receipt: Dict[str, Any]) -> None:
        status, body = self._authorized_json("/api/app/operations/nanohost.runtime-target", method="POST", body={})
        if self._typed_nanohost_absent(status, body):
            receipt["previousNanoHost"] = None
            return
        if status != 200 or not isinstance(body, dict):
            raise HelperError(
                "app_update_unavailable",
                "Previous NanoHost observation is missing or malformed.",
            )
        identity = body.get("identityId")
        deployment = body.get("deploymentId")
        generation = self._positive_int(body.get("connectionGeneration"))
        ready = body.get("ready")
        if (
            not isinstance(identity, str)
            or not identity
            or not isinstance(deployment, str)
            or not deployment
            or generation is None
            or not isinstance(ready, bool)
        ):
            raise HelperError(
                "app_update_unavailable",
                "Previous NanoHost observation is missing or malformed.",
            )
        receipt["previousNanoHost"] = {
            "connectionGeneration": generation,
            "deploymentId": deployment,
            "identityId": identity,
            "ready": ready is True,
        }
        if receipt["previousNanoHost"]["ready"] is not True:
            raise HelperError(
                "app_update_unavailable",
                "Configured NanoHost is not ready.",
            )

    def _snapshot_retained_auth(self, receipt: Dict[str, Any]) -> None:
        status, body = self._authorized_json(CREDENTIAL_LIST_PATH, method="POST", body={})
        if status != 200:
            raise HelperError("app_update_unavailable", "Retained auth-store identity could not be read.")
        receipt["retainedAuthSnapshot"] = self._auth_store_identity(body)

    def _auth_store_identity(self, body: Any) -> List[Dict[str, Any]]:
        """Project the access-token rows of the administrator credential.list inventory."""
        if (
            not isinstance(body, dict)
            or set(body) != CREDENTIAL_LIST_KEYS
            or not isinstance(body["items"], list)
            or not isinstance(body["canManageServerCredentials"], bool)
        ):
            raise HelperError(
                "app_update_unavailable",
                "Retained auth-store identity is not the public credential list.",
            )
        # Only the administrator inventory lists every retained access token.
        if not body["canManageServerCredentials"]:
            raise HelperError(
                "app_update_unavailable",
                "Retained auth-store identity needs the administrator credential inventory.",
            )
        rows = []
        for item in body["items"]:
            if not isinstance(item, dict) or item.get("kind") not in CREDENTIAL_KINDS:
                raise HelperError(
                    "app_update_unavailable",
                    "Retained auth-store identity is not the public credential list.",
                )
            if item["kind"] != "access-token":
                continue
            integration_id = item.get("integrationId")
            if (
                set(item) != ACCESS_TOKEN_CREDENTIAL_KEYS
                or not isinstance(item["record"], dict)
                or item["id"] != item["record"].get("tokenId")
                or (integration_id is not None and (not isinstance(integration_id, str) or not integration_id))
            ):
                raise HelperError(
                    "app_update_unavailable",
                    "Retained auth-store identity is not the public Token list.",
                )
            rows.append(self._token_identity_projection(item["record"]))
        if not rows:
            raise HelperError("app_update_unavailable", "Retained auth-store identity is empty.")
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
        status, body = self._authorized_json(CREDENTIAL_LIST_PATH, method="POST", body={})
        if status != 200:
            return False
        try:
            observed = self._auth_store_identity(body)
        except HelperError:
            return False
        return observed == receipt.get("retainedAuthSnapshot")

    def _verify(
        self, receipt: Dict[str, Any], candidate: Mapping[str, Any], previous_readiness: Mapping[str, Any]
    ) -> Dict[str, Any]:
        """Require candidate identity, retained data and readiness without new capability blocks."""
        previous = receipt.get("previousBoot")
        previous_boot_id = (
            previous.get("bootId")
            if isinstance(previous, dict) and BOOT_ID_RE.match(str(previous.get("bootId") or ""))
            else None
        )
        boot = None
        parsed: Optional[Dict[str, Any]] = None
        running_identity: Optional[Dict[str, Any]] = None
        timeout = int(self.config["readyTimeoutSeconds"])
        for attempt in range(timeout + 1):
            running = self._inspect_container(self.config["containerName"])
            running_identity = self._image_identity(str(running.get("Image") or ""))
            observed = self._observe_boot(running_identity["id"], candidate["source_commit"])
            if (
                observed
                and observed[0]["bootId"] != previous_boot_id
                and BOOT_ID_RE.match(str(observed[0]["bootId"]))
            ):
                boot, parsed = observed
                break
            if attempt < timeout:
                self._sleep(1)
        if boot is None or parsed is None or running_identity is None:
            raise RuntimeError("candidate boot observation is missing")
        receipt["candidateBoot"] = boot
        image_match = candidate["published_digest"] in running_identity["repo_digest_ids"]
        mapped = receipt.get("sourceImageMap") if isinstance(receipt.get("sourceImageMap"), dict) else {}
        source_match = (
            COMMIT_RE.match(str(candidate["source_commit"])) is not None
            and mapped.get("sourceCommit") == candidate["source_commit"]
            and mapped.get("imageId") == candidate["image_id"]
            and running_identity["id"] == candidate["image_id"]
        )
        source_match = source_match and image_match
        retained_ok = self._retained_auth_read(receipt)
        previous_nanohost = receipt.get("previousNanoHost")
        nanohost_ok: Optional[bool]
        if previous_nanohost:
            status, body = self._authorized_json("/api/app/operations/nanohost.runtime-target", method="POST", body={})
            nanohost_ok = self._nanohost_successor_ready(previous_nanohost, status, body)
        else:
            nanohost_ok = None
        helper_status, helper_body = self._authorized_json("/api/app/operations/app-update.status", method="POST", body={"requestId": receipt["requestId"]})
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
        accepting = boot["acceptingProductWork"] is True
        predicates = {
            "acceptingProductWork": accepting,
            "helperReachable": helper_ok,
            "imageMatch": image_match,
            "nanohostReady": nanohost_ok,
            "newBoot": previous_boot_id is not None and boot["bootId"] != previous_boot_id,
            "noBlockingReadiness": (
                accepting
                and parsed["readinessBlocks"].issubset(previous_readiness["readinessBlocks"])
                and parsed["failedSubsystems"].issubset(previous_readiness["failedSubsystems"])
            ),
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

    def _nanohost_successor_ready(self, previous: Mapping[str, Any], status: int, body: Any) -> bool:
        if status != 200 or not isinstance(body, dict) or not isinstance(previous, Mapping):
            return False
        generation = self._positive_int(body.get("connectionGeneration"))
        previous_generation = self._positive_int(previous.get("connectionGeneration"))
        if generation is None or previous_generation is None:
            return False
        return (
            body.get("ready") is True
            and body.get("identityId") == previous.get("identityId")
            and body.get("deploymentId") == previous.get("deploymentId")
            and generation > previous_generation
        )

    def _authorized_json(self, path: str, method: str = "GET", body: Optional[Any] = None) -> Tuple[int, Any]:
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
        return self.effects.http_json(url, headers=headers, timeout=15, method=method, body=body)

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
        directory = self.config["receiptDir"]
        path = os.path.join(directory, "%s.json" % request_id)
        try:
            metadata = os.lstat(path)
        except FileNotFoundError as error:
            if missing_code == "app_update_not_found":
                try:
                    with os.scandir(directory):
                        pass
                except OSError as directory_error:
                    raise HelperError("app_update_recovery_required", "App-update receipt directory is unavailable.") from directory_error
            raise HelperError(missing_code, "App-update receipt is missing.") from error
        except OSError as error:
            raise HelperError("app_update_recovery_required", "App-update receipt could not be inspected.") from error
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
            source = _require_source(parsed.get("source"), observed=True)
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
        if parsed.get("errorCode") is not None and (not isinstance(parsed["errorCode"], str) or parsed["errorCode"] not in ERROR_CODES):
            raise HelperError("app_update_recovery_required", "Retained App-update error code is unsupported.")
        if parsed.get("preparedHelperSha256") is not None and not re.fullmatch(r"[a-f0-9]{64}", str(parsed["preparedHelperSha256"])):
            raise HelperError("app_update_recovery_required", "Retained helper identity is malformed.")
        if parsed.get("approvalSummary") is not None:
            summary = project_approval_summary(parsed["approvalSummary"])
            if summary["targetRelease"] != source or summary["expectedCurrentImageId"] != expected:
                raise HelperError("app_update_recovery_required", "Retained approval summary contradicts the prepared binding.")
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
    return {"helperSha256": HELPER_SHA256, "error": {"code": code, "message": text}}


def collapse_outcome(stage: str) -> str:
    return "running" if stage in IN_PROGRESS_STAGES else stage


def set_stage(receipt: Dict[str, Any], stage: str) -> None:
    receipt["stage"] = stage
    receipt["outcome"] = collapse_outcome(stage)


def parse_work_preflight(body: Any) -> Dict[str, Any]:
    """Read the closed work-count core and discard unrelated descriptive additions."""
    if not isinstance(body, dict):
        raise HelperError("app_update_unavailable", "Deployment work preflight is malformed.")
    counts = body.get("counts")
    if (
        not isinstance(counts, dict) or set(counts) != set(WORK_COUNT_KEYS)
        or any(type(value) is not int or value < 0 for value in counts.values())
        or type(body.get("workspaceCount")) is not int or body["workspaceCount"] < 0
        or not isinstance(body.get("observedAt"), str)
        or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", body["observedAt"]) is None
        or body.get("state") not in {"idle", "busy"}
    ):
        raise HelperError("app_update_unavailable", "Deployment work preflight is malformed.")
    try:
        _parse_iso(body["observedAt"])
    except (ValueError, TypeError, OverflowError):
        raise HelperError("app_update_unavailable", "Deployment work preflight observation time is malformed.")
    idle = all(value == 0 for value in counts.values())
    if (body["state"] == "idle") != idle:
        raise HelperError("app_update_unavailable", "Deployment work preflight state contradicts its counts.")
    return {key: body[key] for key in ("observedAt", "workspaceCount", "counts", "state")}


def project_approval_summary(summary: Any) -> Dict[str, Any]:
    """Validate retained preparation evidence and emit only the current review core."""
    try:
        source = _require_source(summary["targetRelease"], observed=True)
        expected = _require_digest(summary["expectedCurrentImageId"])
        observed = _require_digest(summary["observedCurrentImageId"])
        scope = summary["interruptionScope"]
        limitations = summary["recoveryLimitations"]
        if not isinstance(scope, str) or not 1 <= len(scope) <= 512:
            raise ValueError()
        if not isinstance(limitations, list) or not 1 <= len(limitations) <= 16 or any(
            not isinstance(item, str) or not 1 <= len(item) <= 512 for item in limitations
        ):
            raise ValueError()
        if _redact(scope) != scope or any(_redact(item) != item for item in limitations):
            raise ValueError()
        evidence = summary["safetyEvidence"]
        if evidence["deploymentBindings"] is not True:
            raise ValueError()
        preflight = parse_work_preflight(evidence["preflight"])
        if preflight["state"] != "idle":
            raise ValueError()
        return {
            "targetRelease": source, "expectedCurrentImageId": expected, "observedCurrentImageId": observed,
            "interruptionScope": scope,
            "safetyEvidence": {"deploymentBindings": True, "preflight": preflight},
            "recoveryLimitations": limitations,
        }
    except (KeyError, TypeError, ValueError, HelperError) as error:
        raise HelperError("app_update_recovery_required", "Retained App-update approval summary is malformed.") from error


def project_status(receipt: Mapping[str, Any]) -> Dict[str, Any]:
    stage = str(receipt.get("stage") or "")
    status = {key: receipt.get(key, None) for key in PUBLIC_STATUS_KEYS}
    status["helperSha256"] = HELPER_SHA256
    if receipt.get("approvalSummary") is not None:
        status["approvalSummary"] = project_approval_summary(receipt["approvalSummary"])
    status["stage"] = stage
    status["outcome"] = collapse_outcome(stage)
    for key in ("candidateBoot", "previousBoot"):
        boot = status[key]
        if isinstance(boot, dict):
            status[key] = {name: boot.get(name) for name in ("acceptingProductWork", "blockingReasons", "bootId", "imageId", "sourceCommit")}
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


def digest_tree(path: str) -> str:
    """Hashes Web file names and contents under path."""
    digest = hashlib.sha256()
    root = os.path.realpath(path)
    for current, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
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
