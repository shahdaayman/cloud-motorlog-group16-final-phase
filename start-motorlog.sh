#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"; cd "$ROOT" || exit 1
STATE_DIR="$ROOT/.motorlog"; COMPOSE_MARKER="$STATE_DIR/compose-started"
LOCAL_URL="http://localhost:3000"; FLOCI_URL="http://localhost:4566"
MODE=start; OPEN_BROWSER=false; EMAIL_OVERRIDE=""; TEST_EMAIL=""
REQUIRED_PASSED=0; REQUIRED_FAILED=0; WARNINGS=0
DEPLOYED_FRONTEND_URL=""; API_GATEWAY_URL=""; API_ID=""; API_STAGE=""; CF_ID=""; CF_STATE=""

if [[ -t 1 ]]; then GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; CYAN='\033[36m'; DIM='\033[90m'; RESET='\033[0m'; else GREEN=''; YELLOW=''; RED=''; CYAN=''; DIM=''; RESET=''; fi
required_ok(){ printf "%b[OK]%b   %s\n" "$GREEN" "$RESET" "$1"; REQUIRED_PASSED=$((REQUIRED_PASSED+1)); }
required_fail(){ printf "%b[FAIL]%b %s\n" "$RED" "$RESET" "$1"; REQUIRED_FAILED=$((REQUIRED_FAILED+1)); }
optional_ok(){ printf "%b[OK]%b   %s\n" "$GREEN" "$RESET" "$1"; }
warn(){ printf "%b[WARN]%b %s\n" "$YELLOW" "$RESET" "$1"; WARNINGS=$((WARNINGS+1)); }
info(){ printf "%b[INFO]%b %s\n" "$CYAN" "$RESET" "$1"; }
skip(){ printf "%b[SKIP]%b %s\n" "$DIM" "$RESET" "$1"; }
section(){ printf '\n%s\n' "$1"; }

usage(){ cat <<'EOF'
Usage: bash start-motorlog.sh [OPTIONS]

  (no option)          Start/recover configured services and show deployed URLs
  --status             Read-only service and deployed URL dashboard
  --verify             Run application, SMTP, smoke, and cloud verification
  --open               Open the verified deployed CloudFront frontend after startup
  --setup              Safely provision missing resources with existing project scripts
  --email-mode MODE    Select gmail or local (overrides MOTORLOG_EMAIL_MODE)
  --test-email ADDRESS Send one non-OTP delivery test to an authorized Gmail recipient
  --help               Show this help

Without an explicit mode, a complete smtp.env selects Gmail; otherwise local SES is used.
Routine startup never sends email and never provisions or resets cloud resources.
EOF
}

while (($#)); do
  case "$1" in
    --status) MODE=status ;; --verify) MODE=verify ;; --open) OPEN_BROWSER=true ;; --setup) MODE=setup ;;
    --email-mode) shift; [[ $# -gt 0 ]] || { echo '--email-mode requires gmail or local' >&2; exit 2; }; EMAIL_OVERRIDE="$1" ;;
    --test-email) shift; [[ $# -gt 0 ]] || { echo '--test-email requires an authorized recipient' >&2; exit 2; }; TEST_EMAIL="$1" ;;
    --help|-h) usage; exit 0 ;; *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac; shift
done

command_exists(){ command -v "$1" >/dev/null 2>&1; }
http_ok(){ curl --silent --show-error --fail --max-time "${2:-5}" "$1" >/dev/null 2>&1; }
dotenv_value(){ local key="$1" file="${2:-$ROOT/.env}" line; [[ -f "$file" ]] || return 1; line="$(grep -m1 -E "^[[:space:]]*${key}=" "$file" 2>/dev/null || true)"; [[ -n "$line" ]] || return 1; line="${line#*=}"; line="${line%$'\r'}"; line="${line%\"}"; line="${line#\"}"; printf '%s' "$line"; }
smtp_complete(){ [[ -f "$ROOT/smtp.env" ]] && [[ -n "$(dotenv_value SMTP_EMAIL "$ROOT/smtp.env" 2>/dev/null || true)" ]] && [[ -n "$(dotenv_value SMTP_APP_PASSWORD "$ROOT/smtp.env" 2>/dev/null || true)" ]]; }

configured_mode="${MOTORLOG_EMAIL_MODE:-$(dotenv_value MOTORLOG_EMAIL_MODE 2>/dev/null || true)}"
if [[ -n "$EMAIL_OVERRIDE" ]]; then EMAIL_MODE="$EMAIL_OVERRIDE"; elif [[ -n "$configured_mode" ]]; then EMAIL_MODE="$configured_mode"; elif smtp_complete; then EMAIL_MODE=gmail; else EMAIL_MODE=local; fi
[[ "$EMAIL_MODE" == gmail || "$EMAIL_MODE" == local ]] || { echo 'Email mode must be gmail or local.' >&2; exit 2; }
export AWS_ENDPOINT_URL="$(dotenv_value AWS_ENDPOINT_URL 2>/dev/null || printf '%s' "$FLOCI_URL")"
export AWS_REGION="$(dotenv_value AWS_REGION 2>/dev/null || printf us-east-1)"
export AWS_ACCESS_KEY_ID="$(dotenv_value AWS_ACCESS_KEY_ID 2>/dev/null || printf test)"
export AWS_SECRET_ACCESS_KEY="$(dotenv_value AWS_SECRET_ACCESS_KEY 2>/dev/null || printf test)"
profile="$(dotenv_value AWS_PROFILE 2>/dev/null || true)"; [[ -n "$profile" ]] && export AWS_PROFILE="$profile"; FLOCI_URL="$AWS_ENDPOINT_URL"
aws_local(){ aws --endpoint-url "$FLOCI_URL" --region "$AWS_REGION" "$@"; }
compose_base(){ docker compose -f "$ROOT/infra/floci/docker-compose.yml" "$@"; }
compose_gmail(){ docker compose --env-file "$ROOT/smtp.env" -f "$ROOT/infra/floci/docker-compose.yml" -f "$ROOT/infra/floci/docker-compose.gmail.yml" "$@"; }

header(){ printf '\n==========================================================\n                 MOTORLOG CLOUD MANAGER\n==========================================================\n'; }
check_dependencies(){
  section 'DEPENDENCIES'; local missing=0 tool
  for tool in docker node npm aws curl powershell.exe; do command_exists "$tool" && required_ok "$tool" || { required_fail "Missing dependency: $tool"; missing=1; }; done
  [[ -f "$ROOT/.env" ]] && required_ok 'Application environment (.env)' || { required_fail 'Missing .env — copy .env.example to .env'; missing=1; }
  if [[ "$EMAIL_MODE" == gmail ]]; then smtp_complete && required_ok 'Gmail credentials configured (values hidden)' || { required_fail 'Gmail mode requested but smtp.env is missing or incomplete'; missing=1; }; else optional_ok 'Email mode: local Floci SES capture'; fi
  return "$missing"
}
check_docker(){ docker info >/dev/null 2>&1 && { required_ok 'Docker Desktop daemon'; return 0; }; required_fail 'Docker Desktop unavailable — start it and retry'; return 1; }

start_floci(){
  if http_ok "$FLOCI_URL/_floci/health" 5; then skip 'Floci already healthy; existing container preserved'; return 0; fi
  info "Starting repository Compose stack ($EMAIL_MODE email mode)"; mkdir -p "$STATE_DIR"; printf '%s\n' "$EMAIL_MODE" > "$COMPOSE_MARKER"
  if [[ "$EMAIL_MODE" == gmail ]]; then compose_gmail up -d --build --wait; else compose_base up -d --wait; fi
  [[ $? -eq 0 ]] || { required_fail 'Docker Compose startup failed'; return 1; }
  local attempt; for attempt in {1..30}; do http_ok "$FLOCI_URL/_floci/health" 3 && return 0; sleep 1; done
  required_fail 'Floci did not become ready within 30 seconds'; return 1
}
ensure_smtp_bridge(){
  [[ "$EMAIL_MODE" == gmail ]] || return 0
  local bridge; bridge="$(docker ps --filter label=com.docker.compose.service=motorlog-html-delivery --format '{{.Names}}' | head -n1)"; [[ -n "$bridge" ]] && return 0
  if docker inspect motorlog-floci >/dev/null 2>&1; then info 'Starting missing repository SMTP bridge'; compose_gmail up -d --build --wait motorlog-html-delivery || return 1
  else required_fail 'SMTP bridge stopped while Floci is shared; start both with repository Compose'; return 1; fi
}
ensure_ecs_backend(){
  local values status running desired attempt; values="$(aws_local ecs describe-services --cluster motorlog-cluster --services motorlog-backend-service --query 'services[0].[status,runningCount,desiredCount]' --output text 2>/dev/null || true)"
  status="$(awk '{print $1}' <<<"$values")"; running="$(awk '{print $2}' <<<"$values")"; desired="$(awk '{print $3}' <<<"$values")"; [[ "$status" == ACTIVE ]] || return 1
  if [[ "$desired" =~ ^[0-9]+$ && "$desired" -eq 0 ]]; then info 'Restoring existing ECS backend desired count to 1'; aws_local ecs update-service --cluster motorlog-cluster --service motorlog-backend-service --desired-count 1 >/dev/null || return 1; desired=1; fi
  for attempt in {1..30}; do running="$(aws_local ecs describe-services --cluster motorlog-cluster --services motorlog-backend-service --query 'services[0].runningCount' --output text 2>/dev/null || true)"; [[ "$running" =~ ^[0-9]+$ && "$running" -ge "$desired" && "$running" -ge 1 ]] && return 0; sleep 2; done; return 1
}

discover_deployment(){
  API_ID="$(aws_local apigateway get-rest-apis --limit 500 --query "items[?name=='motorlog-api'].id | [0]" --output text 2>/dev/null || true)"
  if [[ -n "$API_ID" && "$API_ID" != None ]]; then API_STAGE="$(aws_local apigateway get-stages --rest-api-id "$API_ID" --query 'item[0].stageName' --output text 2>/dev/null || true)"; [[ -n "$API_STAGE" && "$API_STAGE" != None ]] && API_GATEWAY_URL="$FLOCI_URL/restapis/$API_ID/$API_STAGE/_user_request_"; fi
  CF_ID="$(aws_local cloudfront list-distributions --query "DistributionList.Items[?Comment=='Motorlog Frontend'].Id | [0]" --output text 2>/dev/null || true)"
  if [[ -n "$CF_ID" && "$CF_ID" != None ]]; then CF_STATE="$(aws_local cloudfront get-distribution --id "$CF_ID" --query 'Distribution.[DistributionConfig.Enabled,Status]' --output text 2>/dev/null || true)"; DEPLOYED_FRONTEND_URL="http://$(printf '%s' "$CF_ID" | tr '[:upper:]' '[:lower:]').cloudfront.localhost.localstack.cloud:4566"; fi
}

check_cloud(){
  section 'CLOUD INFRASTRUCTURE'; http_ok "$FLOCI_URL/_floci/health" 5 && required_ok 'Floci Emulator' || { required_fail 'Floci health endpoint'; return 1; }
  local tables missing=() table pools ses ecs
  tables="$(aws_local dynamodb list-tables --query 'TableNames' --output text 2>/dev/null || true)"; tables="${tables//$'\t'/ }"
  for table in CMLUsers CMLVehicles CMLMaintenance CMLFuel CMLExpenses CMLReminders CMLAudit CMLAuthRateLimits; do [[ " $tables " == *" $table "* ]] || missing+=("$table"); done
  (( ${#missing[@]} == 0 )) && required_ok 'DynamoDB — 8/8 tables' || required_fail "DynamoDB — $((8-${#missing[@]}))/8 tables; run --setup"
  pools="$(aws_local cognito-idp list-user-pools --max-results 60 --query "length(UserPools[?Name=='CML-Group16-Users'])" --output text 2>/dev/null || true)"; [[ "$pools" =~ ^[1-9] ]] && required_ok 'Cognito Authentication' || required_fail 'Cognito pool missing; run --setup'
  ses="$(aws_local sesv2 get-account --query 'SendingEnabled' --output text 2>/dev/null || true)"; [[ -n "$ses" && "$ses" != None ]] && required_ok 'SES Email Service' || required_fail 'SES account unavailable'
  discover_deployment
  [[ -n "$API_GATEWAY_URL" ]] && http_ok "$API_GATEWAY_URL/api/health" 8 && required_ok "API Gateway — stage $API_STAGE" || required_fail 'API Gateway or deployed health route missing; run --setup'
  ecs="$(aws_local ecs describe-services --cluster motorlog-cluster --services motorlog-backend-service --query 'services[0].[status,runningCount,desiredCount]' --output text 2>/dev/null || true)"
  if [[ "$ecs" == ACTIVE* ]]; then local running desired; running="$(awk '{print $2}' <<<"$ecs")"; desired="$(awk '{print $3}' <<<"$ecs")"; [[ "$running" =~ ^[0-9]+$ && "$desired" =~ ^[0-9]+$ && "$running" -ge 1 && "$running" -ge "$desired" ]] && required_ok "ECS Backend — $running/$desired tasks" || required_fail "ECS Backend — ${running:-0}/${desired:-0} tasks"; else required_fail 'ECS backend missing; run --setup'; fi
  aws_local s3api head-bucket --bucket motorlog-frontend >/dev/null 2>&1 && required_ok 'S3 frontend bucket' || required_fail 'S3 frontend bucket missing; run --setup'
  [[ "$CF_STATE" == True* || "$CF_STATE" == true* ]] && [[ "$CF_STATE" == *Deployed* ]] && http_ok "$DEPLOYED_FRONTEND_URL/" 10 && required_ok "CloudFront Distribution — $CF_ID (Deployed)" || required_fail 'CloudFront disabled, not deployed, or unreachable; run --setup'
}

check_email(){
  section 'EMAIL DELIVERY'
  if [[ "$EMAIL_MODE" == local ]]; then optional_ok 'Local Floci SES capture mode'; skip 'Gmail SMTP bridge not required'; return 0; fi
  smtp_complete && required_ok 'Gmail SMTP credentials configured (values hidden)' || required_fail 'Gmail SMTP configuration incomplete'
  local bridge; bridge="$(docker ps --filter label=com.docker.compose.service=motorlog-html-delivery --format '{{.Names}}' | head -n1)"; [[ -n "$bridge" ]] && required_ok "SMTP Bridge — $bridge" || { required_fail 'SMTP Bridge not running'; return 1; }
  if docker exec motorlog-floci getent hosts motorlog-smtp-bridge >/dev/null 2>&1 || docker exec floci getent hosts motorlog-smtp-bridge >/dev/null 2>&1; then required_ok 'Docker SMTP alias — motorlog-smtp-bridge'; else required_fail 'Docker SMTP alias unresolved from Floci'; return 1; fi
  if docker exec motorlog-floci bash -lc "timeout 3 bash -c '</dev/tcp/motorlog-smtp-bridge/1025'" >/dev/null 2>&1 || docker exec floci bash -lc "timeout 3 bash -c '</dev/tcp/motorlog-smtp-bridge/1025'" >/dev/null 2>&1; then required_ok 'SMTP port 1025 reachable from Floci'; else required_fail 'SMTP port 1025 unreachable from Floci'; return 1; fi
  [[ -z "$TEST_EMAIL" ]] && warn 'Actual Gmail message delivery not tested this session'
}

check_application(){
  section 'APPLICATION'; local html="" config=""
  if [[ -n "$DEPLOYED_FRONTEND_URL" ]]; then html="$(curl --silent --show-error --fail --max-time 10 "$DEPLOYED_FRONTEND_URL/" 2>/dev/null || true)"; config="$(curl --silent --show-error --fail --max-time 10 "$DEPLOYED_FRONTEND_URL/js/config.js" 2>/dev/null || true)"; [[ "$html" == *Motorlog* || "$html" == *motorlog* ]] && required_ok 'Deployed frontend serves Motorlog' || required_fail 'CloudFront response is not Motorlog'; [[ -n "$API_GATEWAY_URL" && "$config" == *"$API_GATEWAY_URL"* ]] && required_ok 'Deployed frontend uses discovered API Gateway' || required_fail 'Frontend API config does not match discovered API'; fi
  [[ -n "$API_GATEWAY_URL" ]] && http_ok "$API_GATEWAY_URL/api/health" 8 && required_ok 'Deployed API health check' || required_fail 'Deployed API health check failed'
  http_ok "$LOCAL_URL/api/health" 4 && optional_ok 'Local development backend (secondary)' || warn 'Local development backend not running (optional)'
  http_ok "$FLOCI_URL/_aws/ses" 4 && optional_ok 'Floci SES viewer' || warn 'Floci SES viewer unavailable'
}

start_local_app(){ http_ok "$LOCAL_URL/api/health" 3 && { skip 'Local development server already healthy'; return 0; }; local output; output="$(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ROOT/scripts/manage-dev-server.ps1" start 2>&1)" || { warn "Optional local server failed: $output"; return 1; }; http_ok "$LOCAL_URL/api/health" 5 && optional_ok 'Local development server started' || warn 'Local development server did not become healthy'; }

run_setup(){
  section 'FIRST-TIME SETUP'; info 'Additive provisioning preserves existing volumes, users, and records.'
  local commands=('npm run db:prepare' 'npm run auth:setup' 'node scripts/update-otp-email.js' 'npm run iam:deploy' 'npm run lambda:deploy' 'npm run api:deploy' 'npm run reminders:deploy' 'npm run monitoring:deploy' 'npm run s3:deploy' 'npm run cloudfront:deploy' 'npm run alb:deploy' 'npm run cloud-services:deploy') command
  for command in "${commands[@]}"; do info "$command"; powershell.exe -NoProfile -Command "$command" || { required_fail "Setup failed at: $command"; return 1; }; done
  required_ok 'First-time provisioning completed'
}

send_delivery_test(){
  [[ -z "$TEST_EMAIL" ]] && return 0; [[ "$EMAIL_MODE" == gmail ]] || { required_fail '--test-email requires Gmail mode'; return 1; }; [[ "$TEST_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || { required_fail 'Invalid test recipient'; return 1; }
  local allow_any allowed sender bridge started attempt; allow_any="$(dotenv_value SMTP_ALLOW_ANY_RECIPIENT "$ROOT/smtp.env" 2>/dev/null || printf false)"; allowed="$(dotenv_value SMTP_ALLOWED_RECIPIENTS "$ROOT/smtp.env" 2>/dev/null || true)"
  [[ "$allow_any" == true || ",${allowed,,}," == *",${TEST_EMAIL,,},"* ]] || { required_fail 'Recipient not authorized by SMTP_ALLOWED_RECIPIENTS'; return 1; }
  sender="$(dotenv_value SES_FROM_EMAIL 2>/dev/null || printf no-reply@car-maintenance.local)"; bridge="$(docker ps --filter label=com.docker.compose.service=motorlog-html-delivery --format '{{.Names}}' | head -n1)"; started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  info 'Sending one non-OTP delivery test to the authorized recipient'; aws_local sesv2 send-email --from-email-address "$sender" --destination "ToAddresses=$TEST_EMAIL" --content 'Simple={Subject={Data=Motorlog delivery verification,Charset=UTF-8},Body={Text={Data=Motorlog Gmail delivery verification no OTP included,Charset=UTF-8}}}' >/dev/null || { required_fail 'SES rejected delivery test'; return 1; }
  for attempt in {1..30}; do docker logs "$bridge" --since "$started" 2>&1 | grep -q 'Delivered message via Gmail SMTP' && { required_ok 'Gmail message delivery verified'; return 0; }; sleep 2; done; required_fail 'Gmail delivery not confirmed within 60 seconds'; return 1
}

show_urls(){ printf '\n----------------------------------------------------------\n                      ACCESS URLS\n----------------------------------------------------------\n\nDEPLOYED APPLICATION\n'; [[ -n "$DEPLOYED_FRONTEND_URL" ]] && printf 'Frontend:     %s\n' "$DEPLOYED_FRONTEND_URL" || printf 'Frontend:     unavailable\n'; [[ -n "$API_GATEWAY_URL" ]] && printf 'API Gateway:  %s\n' "$API_GATEWAY_URL" || printf 'API Gateway:  unavailable\n'; printf '\nLOCAL DEVELOPMENT\nWeb App:      %s\nHealth:       %s/api/health\n\nCLOUD UTILITIES\nFloci:        %s\nSES Viewer:   %s/_aws/ses\n' "$LOCAL_URL" "$LOCAL_URL" "$FLOCI_URL" "$FLOCI_URL"; }
summary(){ local total=$((REQUIRED_PASSED+REQUIRED_FAILED)); printf '\n----------------------------------------------------------\n                      FINAL SUMMARY\n----------------------------------------------------------\n\nRequired checks passed: %d/%d\nWarnings: %d\nFailures: %d\n\n' "$REQUIRED_PASSED" "$total" "$WARNINGS" "$REQUIRED_FAILED"; (( REQUIRED_FAILED == 0 )) && printf 'Motorlog deployed environment is ready.\n' || printf 'Motorlog deployed environment is not fully ready.\n'; }
run_verification(){ section 'VERIFICATION'; local result=0; npm run check || result=1; npm run smtp:test || result=1; npm run smoke || result=1; npm run s3:verify || result=1; npm run cloudfront:verify || result=1; npm run cloud-services:verify || result=1; (( result == 0 )) && required_ok 'All requested verification procedures passed' || required_fail 'One or more verification procedures failed'; return "$result"; }

header; check_dependencies || { summary; exit 1; }; check_docker || { summary; exit 1; }
if [[ "$MODE" == verify ]]; then run_verification; summary; (( REQUIRED_FAILED == 0 )); exit $?; fi
if [[ "$MODE" == setup ]]; then
  start_floci || { summary; exit 1; }
  ensure_smtp_bridge || { summary; exit 1; }
  run_setup
  ensure_ecs_backend || true
  start_local_app || true
elif [[ "$MODE" != status ]]; then
  start_floci || true
  ensure_smtp_bridge || true
  ensure_ecs_backend || true
  start_local_app || true
fi
check_cloud; check_email; check_application; send_delivery_test || true; show_urls; summary
if [[ "$OPEN_BROWSER" == true && $REQUIRED_FAILED -eq 0 && -n "$DEPLOYED_FRONTEND_URL" ]]; then info 'Opening verified deployed frontend'; cmd.exe /c start "" "$DEPLOYED_FRONTEND_URL" >/dev/null 2>&1 || warn 'Could not open browser'; fi
(( REQUIRED_FAILED == 0 ))
