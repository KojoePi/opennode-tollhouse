#!/usr/bin/env bash
# One-shot installer for Ubuntu/Debian (same server as your other projects).   Usage: sudo make install
#  - installs Docker if missing, creates the shared network "relayted_edge"
#  - writes .env (secrets generated, chmod 600)
#  - builds and starts web + worker
# The shared edge proxy (HTTPS) lives in its own folder (/opt/relayted-edge, see its README.md). Safe to re-run: an existing .env is kept.
set -euo pipefail
cd "$(dirname "$0")"
say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARNING: %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "Please run as root:  sudo make install"

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"; apt-get update -y && apt-get install -y curl ca-certificates; curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin missing."
systemctl enable --now docker >/dev/null 2>&1 || true
docker network inspect relayted_edge >/dev/null 2>&1 || { say "Creating network relayted_edge"; docker network create relayted_edge >/dev/null; }

ask() { local var="$1" q="$2" def="${3:-}" secret="${4:-}" v
  [ -n "${!var:-}" ] && return
  if [ ! -t 0 ]; then printf -v "$var" '%s' "$def"; return; fi
  if [ -n "$secret" ]; then read -r -s -p "$q: " v; echo; else read -r -p "$q${def:+ [$def]}: " v; fi
  printf -v "$var" '%s' "${v:-$def}"; }
clean() { printf '%s' "$1" | tr -d '"$`\\\r\n'; }

if [ ! -f .env ]; then
  say "Configuration"
  ask DOMAIN "Domain" "newproject.relayted.de"
  ask OPENNODE_API_KEY "OpenNode API key (input hidden)" "" secret
  ask LEGAL_NAME "Name/company for the legal pages (can be filled in later)" ""
  ask LEGAL_ADDRESS "Address" ""
  ask LEGAL_EMAIL "Contact e-mail" ""
  [ -n "$OPENNODE_API_KEY" ] || die "OPENNODE_API_KEY is required."
  cp .env.example .env
  set_env() { sed -i "s|^$1=.*|$1=\"$(clean "$2" | sed 's/[|&]/\\&/g')\"|" .env; }
  set_env DOMAIN "$DOMAIN"; set_env OPENNODE_API_KEY "$OPENNODE_API_KEY"
  set_env WORKER_TOKEN "$(openssl rand -hex 32)"; set_env KEY_PEPPER "$(openssl rand -hex 32)"
  set_env LEGAL_NAME "${LEGAL_NAME:-}"; set_env LEGAL_ADDRESS "${LEGAL_ADDRESS:-}"; set_env LEGAL_EMAIL "${LEGAL_EMAIL:-}"
  chmod 600 .env
  warn "KEY_PEPPER was generated. BACK UP .env - if the pepper is lost or changed, every recovery key stops working."
else
  echo ".env already exists - keeping it."
fi

say "Building and starting (first build can take a few minutes)"
docker compose up -d --build
say "Waiting for the web server"
for _ in $(seq 1 60); do
  if docker compose exec -T web node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then ok=1; break; fi
  sleep 2
done
[ "${ok:-}" = 1 ] || { docker compose logs --tail=50 web; die "Web server did not become healthy."; }
cat <<EOF

Web + worker are running. Next: make sure the shared edge proxy is up (/opt/relayted-edge/README.md),
so that https://$(grep -E '^DOMAIN=' .env | cut -d= -f2- | tr -d '"') is served.

  make status | make doctor | make logs
Fill LEGAL_* in .env and run 'make update' to show your data in the legal pages (public/*.html).
EOF
