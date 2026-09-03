#!/usr/bin/env bash
set -euo pipefail

# Compares one collected fact object with the exact manifest bytes and emits their identity.
assert_facts() {
  local node_path=$1 manifest_base64=$2 observed_json=$3
  "$node_path" -e '
    const { createHash } = require("node:crypto");
    const manifestBytes = Buffer.from(process.argv[1], "base64");
    const expected = JSON.parse(manifestBytes);
    const observed = JSON.parse(process.argv[2]);
    const equal = (actual, wanted) => { if (actual !== wanted) process.exit(1); };
    equal(observed.architecture, expected.architecture);
    equal(observed.cgroupMode, expected.cgroupMode);
    equal(observed.containerRuntime, expected.containerRuntime);
    equal(observed.initSystem, expected.initSystem);
    equal(observed.kernelRelease, expected.kernelRelease);
    equal(observed.schemaVersion, expected.schemaVersion);
    for (const [name, wanted] of Object.entries(expected.commands)) {
      const actual = observed.commands?.[name];
      equal(actual?.path, wanted.path);
      equal(actual?.version, wanted.version);
      if (wanted.sha256 !== undefined) equal(actual?.sha256, wanted.sha256);
    }
    process.stdout.write(`manifestDigest=${createHash("sha256").update(manifestBytes).digest("hex")}\n`);
  ' "$manifest_base64" "$observed_json"
}

# Collects the live host facts into the comparator's normalized object shape.
collect_remote_facts() {
  /usr/bin/node -e '
    const { spawnSync } = require("node:child_process");
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    const run = (path, args) => {
      const result = spawnSync(path, args, { encoding: "utf8" });
      if (result.status !== 0) process.exit(1);
      return result.stdout.split(/\r?\n/u)[0].trim();
    };
    const versionArgs = { bash: ["--version"], curl: ["--version"], docker: ["--version"], node: ["--version"], sha256sum: ["--version"], slirp4netns: ["--version"], sudo: ["--version"], systemctl: ["--version"], tar: ["--version"], timeout: ["--version"] };
    const commands = {};
    for (const [name, args] of Object.entries(versionArgs)) {
      const path = run("/usr/bin/bash", ["-c", "type -P -- \"$1\"", "bash", name]);
      commands[name] = { path, version: run(path, args) };
      if (name === "slirp4netns") commands[name].sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
    const cgroup = run("/usr/bin/stat", ["-fc", "%T", "/sys/fs/cgroup"]);
    process.stdout.write(JSON.stringify({
      architecture: run("/usr/bin/uname", ["-m"]),
      cgroupMode: cgroup === "cgroup2fs" ? "unified-v2" : cgroup,
      commands,
      containerRuntime: "docker",
      initSystem: run("/usr/bin/ps", ["-p", "1", "-o", "comm="]),
      kernelRelease: run("/usr/bin/uname", ["-r"]),
      schemaVersion: 1,
    }));
  '
}

if [[ $# -eq 1 && $1 == fixture && -n ${OPENKIT_HOST_FIXTURE_ROOT:-} ]]; then
  fixture_root=${OPENKIT_HOST_FIXTURE_ROOT:?fixture root is required}
  fixture_manifest=${OPENKIT_HOST_MANIFEST:?fixture manifest is required}
  source_path="$fixture_root/home/.local/share/mise/installs/node/24.18.0/bin/node"
  target_path="$fixture_root/usr/bin/node"
  [[ -x "$source_path" && -L "$target_path" && "$(readlink "$target_path")" == "$source_path" ]]
  manifest_base64=$(node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]).toString("base64"))' "$fixture_manifest")
  observed_json=$("${OPENKIT_HOST_FIXTURE_OBSERVER:?fixture observer is required}")
  assert_facts "$(command -v node)" "$manifest_base64" "$observed_json"
elif [[ $# -eq 2 && $1 == remote ]]; then
  manifest_base64=${2:?manifest bytes are required}
  assert_facts /usr/bin/node "$manifest_base64" "$(collect_remote_facts)"
else
  script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  manifest_path="$script_root/../../../apps/nanohost/deploy/host-manifest.json"
  source "$script_root/ssh-alias.sh"
  require_ssh_alias "$@" || exit $?
  {
    node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]).toString("base64") + "\n")' "$manifest_path"
    sed -n '1,$p' "$0"
  } | ssh "$ssh_alias" "/usr/bin/bash -c 'IFS= read -r manifest; /usr/bin/bash -s -- remote \"\$manifest\"'"
fi
