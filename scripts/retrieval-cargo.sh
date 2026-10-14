#!/usr/bin/env bash
# Verify dictionary supply before any Cargo operation that can invoke Lindera's build script.
set -euo pipefail
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export LINDERA_BUILD_DICTIONARY_CACHE_DIR="${LINDERA_BUILD_DICTIONARY_CACHE_DIR:-${XDG_CACHE_HOME:-${HOME}/.cache}/openkit/lindera}"
python3 "${script_root}/scripts/retrieval-dictionary.py" --cache "${LINDERA_BUILD_DICTIONARY_CACHE_DIR}"
exec cargo "$@"
