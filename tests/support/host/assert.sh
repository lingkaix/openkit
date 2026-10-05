#!/usr/bin/env bash
set -euo pipefail

# The live observer is the checksum-verified archive installer; no repository profile is sent remotely.
if [[ $# -eq 2 && $1 == remote ]]; then
  bundle=$2
  [[ $bundle == /* && $bundle != *$'\n'* && $bundle != *$'\r'* ]] || exit 65
  cd -- "$bundle"
  exec /bin/sh ./install.sh --check-host
fi

script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [[ $# -eq 1 && $1 == fixture && -n ${OPENKIT_HOST_FIXTURE_ROOT:-} ]]; then
  # The fixture replaces only observation collection, exercising the installer's real comparator and integrity path.
  python3 -I -B - "$script_root/../../../apps/nanohost/deploy/install.sh" "${OPENKIT_HOST_FIXTURE_ROOT:?}" "${OPENKIT_HOST_FIXTURE_OBSERVER:?}" <<'PY'
import json, pathlib, subprocess, sys
source = pathlib.Path(sys.argv[1]).read_text().split("<<'HOST_CHECK_PY'\n")[1].split('\nHOST_CHECK_PY')[0].split('# HOST_CHECK_MAIN')[0]
exec(compile(source, 'bundled-host-checker', 'exec'))
root = Path(sys.argv[2]) / 'bundle'
observations = json.loads(subprocess.check_output([sys.argv[3]], timeout=5))
original_read = read_regular
def fixture_read(path, limit=MAX_OUTPUT):
    return original_read(root / 'machine-id' if str(path) == '/etc/machine-id' else path, limit)
read_regular = fixture_read
result = check(root, lambda entry, *_: observations['requirements'][entry['id']], lambda _: observations['recommendation'])
print(compact(result))
sys.exit(0 if result['hardVerdict'] == 'requirements-met' else 1)
PY
else
  source "$script_root/ssh-alias.sh"
  require_ssh_alias "$@" || exit $?
  bundle=${OPENKIT_HOST_BUNDLE:?an exact extracted NanoHost bundle path is required}
  [[ $bundle == /* && $bundle != *$'\n'* && $bundle != *$'\r'* ]] || exit 65
  {
    printf '%s\n' "$bundle"
    sed -n '1,$p' "$0"
  } | ssh "$ssh_alias" "/usr/bin/bash -c 'IFS= read -r bundle; /usr/bin/bash -s -- remote \"\$bundle\"'"
fi
