#!/usr/bin/env bash
# Deploys the VoltKit Live backend with Docker Compose.
#
#   ./deploy.sh init                     create .env.production with fresh secrets
#   ./deploy.sh [up]                     build, start and wait until healthy; rolls back if the new version fails
#   ./deploy.sh status                   containers and their health
#   ./deploy.sh logs [service]           follow the logs (api, mongo or caddy; default api)
#   ./deploy.sh backup                   dump the bundled MongoDB into ./backups
#   ./deploy.sh down                     stop everything; the database and certificates are kept
#   ./deploy.sh remote user@host [dir]   copy this folder to a server and run `up` there (dir defaults to ~/voltkit-live)
#
# Needs Docker with the compose plugin on the machine that runs the containers.
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE=.env.production
PROJECT=${PROJECT:-voltkit-live}
IMAGE=voltkit-live-api

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

# Reads one value from the env file, without running the file as shell code.
setting() {
  [[ -f $ENV_FILE ]] || return 0
  local line
  line=$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1 || true)
  line=${line#*=}
  line=${line%$'\r'}
  if [[ $line =~ ^\"(.*)\"$ || $line =~ ^\'(.*)\'$ ]]; then line=${BASH_REMATCH[1]}; fi
  printf '%s' "$line"
}

# Replaces one value in the env file, keeping its permissions.
set_setting() {
  local tmp
  tmp=$(mktemp)
  awk -v key="$1" -v value="$2" 'BEGIN { FS = "=" } $1 == key { print key "=" value; next } { print }' "$ENV_FILE" >"$tmp"
  cat "$tmp" >"$ENV_FILE"
  rm -f "$tmp"
}

mongo_bundled() { [[ $1 =~ ^mongodb://([^@/]*@)?mongo(:[0-9]+)?([/?]|$) ]]; }

# --- settings -------------------------------------------------------------------------------------

check_settings() {
  [[ -f $ENV_FILE ]] || die "No $ENV_FILE yet. Run: ./deploy.sh init"
  if grep -q CHANGE_ME "$ENV_FILE"; then die "$ENV_FILE still has CHANGE_ME values. Fill them in, or start again with ./deploy.sh init."; fi

  local key
  for key in MONGODB_URI JWT_SECRET VOLTKIT_RTC_URL VOLTKIT_RTC_SECRET; do
    [[ -n $(setting "$key") ]] || die "$key is empty in $ENV_FILE."
  done
  local jwt
  jwt=$(setting JWT_SECRET)
  ((${#jwt} >= 32)) || die "JWT_SECRET must be at least 32 characters. Make one with: openssl rand -hex 32"

  local uri
  uri=$(setting MONGODB_URI)
  if [[ $uri =~ ^mongodb(\+srv)?://([^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])([:/?]|$) ]]; then
    die "MONGODB_URI points at localhost, which inside the container is the container itself. For a database on this server use host.docker.internal instead."
  fi
  if mongo_bundled "$uri"; then
    local user password
    user=$(setting MONGO_ROOT_USER)
    password=$(setting MONGO_ROOT_PASSWORD)
    [[ -n $password ]] || die "MONGO_ROOT_PASSWORD is empty, and the bundled MongoDB needs it."
    [[ $uri == *"://${user:-voltkit}:$password@"* ]] || die "MONGODB_URI must log in with MONGO_ROOT_USER and MONGO_ROOT_PASSWORD."
  fi

  local domain port
  domain=$(setting DOMAIN)
  [[ $domain != *://* && $domain != */* ]] || die "DOMAIN is a name only, like api.example.com, with no https:// or path."
  port=$(setting API_PORT)
  [[ -z $port || $port =~ ^[0-9]+$ ]] || die "API_PORT must be a number."
}

# Works out what to run from the settings.
plan() {
  DOMAIN=$(setting DOMAIN)
  API_PORT=$(setting API_PORT)
  API_PORT=${API_PORT:-5051}
  local profiles=() trust
  trust=$(setting TRUST_PROXY)
  if mongo_bundled "$(setting MONGODB_URI)"; then profiles+=(mongo); fi
  if [[ -n $DOMAIN ]]; then
    profiles+=(https)
    # Behind Caddy: the API is reached through it, and it trusts Caddy's client address.
    API_PUBLISH=127.0.0.1:$API_PORT
    TRUST_PROXY=${trust:-1}
    PUBLIC_URL=https://$DOMAIN
  else
    API_PUBLISH=$API_PORT
    # Your own proxy in front (nginx, a load balancer): set TRUST_PROXY in .env.production.
    TRUST_PROXY=${trust:-0}
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)
    PUBLIC_URL=http://${ip:-<this-server>}:$API_PORT
  fi
  PROFILES=$(
    IFS=,
    echo "${profiles[*]-}"
  )
}

# --- docker ---------------------------------------------------------------------------------------

SUDO=()
need_docker() {
  command -v docker >/dev/null || die "Docker is not installed. See https://docs.docker.com/engine/install/"
  if ! docker info >/dev/null 2>&1; then
    if command -v sudo >/dev/null && sudo docker info >/dev/null 2>&1; then
      SUDO=(sudo)
    else
      die "Cannot reach Docker. Start it, or add this user to the docker group and log in again."
    fi
  fi
  docker_ compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing ('docker compose')."
}

docker_() { ${SUDO[@]+"${SUDO[@]}"} docker "$@"; }

# `env` carries the settings through sudo, which would otherwise drop them.
compose() {
  ${SUDO[@]+"${SUDO[@]}"} env COMPOSE_PROFILES="$PROFILES" API_PUBLISH="$API_PUBLISH" TRUST_PROXY="$TRUST_PROXY" \
    docker compose -p "$PROJECT" --env-file "$ENV_FILE" "$@"
}

wait_healthy() {
  local id restarts status i
  id=$(compose ps -q api)
  [[ -n $id ]] || return 1
  for ((i = 0; i < 45; i++)); do
    read -r restarts status < <(docker_ inspect -f '{{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo "0 missing")
    case $status in
      healthy) return 0 ;;
      unhealthy | exited | dead | missing) return 1 ;;
    esac
    ((restarts < 2)) || return 1
    sleep 2
  done
  return 1
}

check_public() {
  command -v curl >/dev/null || return 0
  if [[ -n $DOMAIN ]]; then
    say "Waiting for https://$DOMAIN (the first certificate can take a minute)"
    local i
    for ((i = 0; i < 30; i++)); do
      if curl -fsS -m 5 "https://$DOMAIN/health" >/dev/null 2>&1; then
        say "https://$DOMAIN is answering"
        return 0
      fi
      sleep 3
    done
    warn "https://$DOMAIN is not answering yet. Check that its DNS points at this server and ports 80 and 443 are open, then: ./deploy.sh logs caddy"
  else
    curl -fsS -m 5 "http://127.0.0.1:$API_PORT/health" >/dev/null && say "http://127.0.0.1:$API_PORT is answering"
    warn "No DOMAIN set: the API is plain http. Fine for testing; set DOMAIN for real users."
  fi
}

# --- commands -------------------------------------------------------------------------------------

cmd_init() {
  [[ ! -f $ENV_FILE ]] || die "$ENV_FILE already exists. Edit it, or delete it to start again."
  command -v openssl >/dev/null || die "openssl is needed to make the secrets."
  local mongo_password
  mongo_password=$(openssl rand -hex 16)
  (
    umask 077
    sed "s/voltkit:CHANGE_ME@/voltkit:$mongo_password@/" .env.production.example >"$ENV_FILE"
  )
  set_setting MONGO_ROOT_PASSWORD "$mongo_password"
  set_setting JWT_SECRET "$(openssl rand -hex 32)"
  # Taken from the environment when given, e.g. DOMAIN=api.example.com VOLTKIT_RTC_SECRET=sk_... ./deploy.sh init
  if [[ -n ${DOMAIN:-} ]]; then set_setting DOMAIN "$DOMAIN"; fi
  if [[ -n ${VOLTKIT_RTC_SECRET:-} ]]; then set_setting VOLTKIT_RTC_SECRET "$VOLTKIT_RTC_SECRET"; fi

  say "Created $ENV_FILE, readable by you only, with a new JWT secret and MongoDB password."
  [[ -n $(setting VOLTKIT_RTC_SECRET) ]] || echo "    Next: put your VoltKit secret in VOLTKIT_RTC_SECRET."
  [[ -n $(setting DOMAIN) ]] || echo "    For HTTPS: set DOMAIN to a name that points at your server."
  echo "    Then run: ./deploy.sh"
}

cmd_up() {
  check_settings
  plan
  need_docker

  local had_previous=0
  if docker_ image inspect "$IMAGE:latest" >/dev/null 2>&1; then
    docker_ tag "$IMAGE:latest" "$IMAGE:previous"
    had_previous=1
  fi

  say "Building the API image"
  compose build --pull api
  say "Starting api${PROFILES:+ with $PROFILES}"
  compose up -d --remove-orphans

  say "Waiting for the API to report healthy"
  if ! wait_healthy; then
    warn "The new version did not become healthy. Its last log lines:"
    compose logs --tail 60 api >&2 || true
    if ((had_previous)); then
      say "Rolling back to the previous version"
      docker_ tag "$IMAGE:previous" "$IMAGE:latest"
      compose up -d --no-build --force-recreate api
      if wait_healthy; then die "Rolled back: the previous version is running. Fix the problem above and deploy again."; fi
      die "The previous version is not healthy either. See: ./deploy.sh logs"
    fi
    die "Fix the problem above, then run ./deploy.sh again."
  fi
  say "The API is healthy"
  check_public

  cat <<EOF

  Backend: $PUBLIC_URL

  Point the app at it, then build and install it:
    1. In mobile/.env set  EXPO_PUBLIC_API_URL=$PUBLIC_URL
    2. cd mobile && npx expo prebuild --platform android
    3. cd android && ./gradlew app:assembleRelease
    4. adb install -r app/build/outputs/apk/release/app-release.apk

EOF
}

cmd_status() {
  check_settings
  plan
  need_docker
  compose ps
}

cmd_logs() {
  check_settings
  plan
  need_docker
  compose logs -f --tail 100 "${1:-api}"
}

cmd_down() {
  check_settings
  plan
  need_docker
  compose down
  say "Stopped. The database and certificates are kept; ./deploy.sh starts everything again."
}

cmd_backup() {
  check_settings
  plan
  need_docker
  [[ $PROFILES == *mongo* ]] || die "This deploy does not run MongoDB itself. Back it up where it is hosted."
  mkdir -p backups
  local file
  file=backups/mongo-$(date +%Y%m%d-%H%M%S).archive.gz
  compose exec -T mongo sh -c 'exec mongodump --quiet --archive --gzip --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin' >"$file"
  say "Saved $file ($(du -h "$file" | cut -f1))"
  echo "    To restore it:"
  echo "    docker compose -p $PROJECT --env-file $ENV_FILE exec -T mongo sh -c 'exec mongorestore --archive --gzip --drop --username \"\$MONGO_INITDB_ROOT_USERNAME\" --password \"\$MONGO_INITDB_ROOT_PASSWORD\" --authenticationDatabase admin' < $file"
}

cmd_remote() {
  local target=${1:-} dir=${2:-voltkit-live}
  [[ -n $target ]] || die "Usage: ./deploy.sh remote user@host [directory on the server]"
  check_settings
  command -v rsync >/dev/null || die "rsync is needed on this machine and the server."
  say "Copying to $target:$dir"
  ssh "$target" "mkdir -p '$dir'"
  # Your local development .env stays here. .env.production goes, since the server runs from it.
  rsync -az --delete --exclude node_modules --exclude test --exclude backups --exclude .env --exclude .env.test ./ "$target:$dir/"
  say "Deploying on $target"
  ssh -t "$target" "cd '$dir' && ./deploy.sh up"
}

case ${1:-up} in
  init) cmd_init ;;
  up) cmd_up ;;
  status) cmd_status ;;
  logs) cmd_logs "${2:-}" ;;
  backup) cmd_backup ;;
  down) cmd_down ;;
  remote) cmd_remote "${2:-}" "${3:-}" ;;
  -h | --help | help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "Unknown command '$1'. See: ./deploy.sh help" ;;
esac
