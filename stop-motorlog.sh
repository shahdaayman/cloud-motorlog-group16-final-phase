#!/usr/bin/env bash

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT" || exit 1
STATE_DIR="$ROOT/.motorlog"
COMPOSE_MARKER="$STATE_DIR/compose-started"
MODE=stop

if [[ -t 1 ]]; then C_OK='\033[32m'; C_WARN='\033[33m'; C_INFO='\033[36m'; C_DIM='\033[90m'; C_RESET='\033[0m'; else C_OK=''; C_WARN=''; C_INFO=''; C_DIM=''; C_RESET=''; fi
stopped(){ printf "%b[STOPPED]%b %s\n" "$C_OK" "$C_RESET" "$1"; }
ok(){ printf "%b[OK]%b      %s\n" "$C_OK" "$C_RESET" "$1"; }
warn(){ printf "%b[WARN]%b    %s\n" "$C_WARN" "$C_RESET" "$1"; }
info(){ printf "%b[INFO]%b    %s\n" "$C_INFO" "$C_RESET" "$1"; }
skip(){ printf "%b[SKIP]%b    %s\n" "$C_DIM" "$C_RESET" "$1"; }

usage(){ cat <<'EOF'
Usage: bash stop-motorlog.sh [OPTION]

  (no option)  Stop only processes and Compose services recorded as Motorlog-managed
  --status     Show which Motorlog services are running without changing anything
  --help       Show this help

Persistent volumes, cloud resources, images, networks, .env files, unrelated containers,
and unowned Node.js processes are never removed.
EOF
}

case "${1:-}" in '') ;; --status) MODE=status ;; --help|-h) usage; exit 0 ;; *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;; esac

header(){ printf '\n==================================================\n              MOTORLOG SHUTDOWN\n==================================================\n\n'; }
process_status(){ powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ROOT/scripts/manage-dev-server.ps1" status 2>/dev/null || true; }

header
if [[ "$MODE" == status ]]; then
  state="$(process_status)"
  case "$state" in managed-running*) ok "Managed Motorlog web server ($state)" ;; unmanaged-running*) warn 'Healthy web server on port 3000 is not owned by this manager' ;; *) info 'Motorlog web server is stopped' ;; esac
  if [[ -f "$COMPOSE_MARKER" ]]; then
    info 'Repository Compose stack is recorded as Motorlog-managed'
    email_mode="$(tr -d '\r\n' < "$COMPOSE_MARKER")"
    if [[ "$email_mode" == gmail && -f "$ROOT/smtp.env" ]]; then
      docker compose --env-file "$ROOT/smtp.env" -f "$ROOT/infra/floci/docker-compose.yml" -f "$ROOT/infra/floci/docker-compose.gmail.yml" ps 2>/dev/null || true
    else
      docker compose -f "$ROOT/infra/floci/docker-compose.yml" ps 2>/dev/null || true
    fi
  elif docker info >/dev/null 2>&1; then
    skip 'No Motorlog-owned Compose marker; shared Docker services will not be managed'
  else warn 'Docker Desktop is unavailable'; fi
  exit 0
fi

state="$(process_status)"
if [[ "$state" == managed-running* ]]; then
  output="$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ROOT/scripts/manage-dev-server.ps1" stop 2>&1)"
  [[ $? -eq 0 ]] && stopped "Motorlog frontend/backend ($output)" || warn "Could not stop managed web server: $output"
elif [[ "$state" == unmanaged-running* ]]; then
  skip 'Port 3000 server was not started by this manager and was left running'
else
  skip 'Motorlog frontend/backend already stopped'
fi

if [[ -f "$COMPOSE_MARKER" ]]; then
  email_mode="$(tr -d '\r\n' < "$COMPOSE_MARKER")"
  if ! docker info >/dev/null 2>&1; then warn 'Docker Desktop unavailable; managed containers could not be stopped'
  elif [[ "$email_mode" == gmail && -f "$ROOT/smtp.env" ]]; then
    if docker compose --env-file "$ROOT/smtp.env" -f "$ROOT/infra/floci/docker-compose.yml" -f "$ROOT/infra/floci/docker-compose.gmail.yml" stop; then stopped 'SMTP bridge and Floci Compose services'; rm -f "$COMPOSE_MARKER"; else warn 'Compose stop reported an error'; fi
  else
    if docker compose -f "$ROOT/infra/floci/docker-compose.yml" stop; then stopped 'Floci Compose service'; rm -f "$COMPOSE_MARKER"; else warn 'Compose stop reported an error'; fi
  fi
else
  skip 'Floci/SMTP containers were not started by this manager and were left running'
fi

skip 'Shared ECS, Lambda, API Gateway, and AWS-compatible resources left intact'
ok 'Persistent Docker volumes and application data preserved'
ok 'Unrelated containers and Node.js processes unaffected'
printf '\n--------------------------------------------------\n                 FINAL STATUS\n--------------------------------------------------\n\n'
printf 'Motorlog-managed services stopped where ownership was verified.\nPersistent volumes preserved. Unrelated services unaffected.\n'
