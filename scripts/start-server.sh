#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

CLI_MOJELEKTRO_API_KEY="${MOJELEKTRO_API_KEY-}"

load_env_file() {
  local env_file="$1"

  if [[ -f "${env_file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
  fi
}

cd "${ROOT_DIR}"

load_env_file "${ROOT_DIR}/.env"
load_env_file "${ROOT_DIR}/.env.local"

if [[ -n "${CLI_MOJELEKTRO_API_KEY}" ]]; then
  export MOJELEKTRO_API_KEY="${CLI_MOJELEKTRO_API_KEY}"
fi

if [[ -z "${MOJELEKTRO_API_KEY:-}" ]]; then
  echo "MOJELEKTRO_API_KEY is missing. Set it in .env.local or export it before starting the server." >&2
  exit 1
fi

exec node server.js
