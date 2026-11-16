#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  ATEC Outage Operations Portal — Linux installer
#
#  Supported: Ubuntu 22.04 / 24.04 LTS, Debian 12 (64-bit)
#  Run as root (or with sudo) on a fresh VM:
#
#     sudo bash install.sh
#
#  What it does
#    1. Checks the VM (OS, CPU, RAM, disk)
#    2. Installs Docker Engine + Compose, git, openssl, ufw
#    3. Puts the portal in /opt/atec-outage-portal (from this folder, or clones GitHub)
#    4. Creates /opt/atec-outage-portal/.env with freshly generated secrets (never printed)
#    5. Opens the firewall (SSH + HTTPS, or the internal port)
#    6. Builds and starts: database, migrations, web, 2 workers, nightly backups, HTTPS (Caddy)
#    7. Installs a watchdog (every 5 min) and the `atec-portal` admin command
#    8. Waits until the portal reports healthy and tells you where to go next
#
#  Safe to re-run: existing .env, database and backups are kept.
# ─────────────────────────────────────────────────────────────────────────────
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/atec-outage-portal}"
REPO_URL="${REPO_URL:-https://github.com/Megannnx/outage-portal.git}"
BRANCH="${BRANCH:-main}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED=$'\e[31m'; GRN=$'\e[32m'; YEL=$'\e[33m'; BLD=$'\e[1m'; RST=$'\e[0m'
step() { echo; echo "${BLD}==> $*${RST}"; }
ok()   { echo "${GRN}  ✓ $*${RST}"; }
warn() { echo "${YEL}  ! $*${RST}"; }
die()  { echo "${RED}  ✗ $*${RST}" >&2; exit 1; }
trap 'die "Installer stopped at line $LINENO. Fix the problem above and re-run: sudo bash install.sh"' ERR

ask() { # ask "Question" default → $REPLY
  local q="$1" def="${2:-}"
  if [[ -n "${NONINTERACTIVE:-}" ]]; then REPLY="$def"; return; fi
  read -r -p "  $q${def:+ [$def]}: " REPLY </dev/tty || true
  REPLY="${REPLY:-$def}"
}
rand_hex() { openssl rand -hex "$1"; }

# ── 1. Pre-flight ────────────────────────────────────────────────────────────
step "Checking this server"
[[ $EUID -eq 0 ]] || die "Please run as root: sudo bash install.sh"
. /etc/os-release
case "${ID}:${VERSION_ID}" in
  ubuntu:22.04|ubuntu:24.04|debian:12) ok "OS: ${PRETTY_NAME}";;
  *) warn "Untested OS (${PRETTY_NAME}). Supported: Ubuntu 22.04/24.04, Debian 12."; ask "Continue anyway? (y/N)" "N"; [[ "$REPLY" =~ ^[Yy] ]] || exit 1;;
esac
[[ "$(uname -m)" == "x86_64" || "$(uname -m)" == "aarch64" ]] || die "64-bit CPU required"
CPUS=$(nproc); MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
mkdir -p "$(dirname "$APP_DIR")"
DISK_GB=$(df -BG --output=avail "$(dirname "$APP_DIR")" | tail -1 | tr -dc '0-9')
(( CPUS >= 2 ))      && ok "CPU: ${CPUS} cores"       || warn "CPU: ${CPUS} core(s) — 2+ recommended"
(( MEM_MB >= 3500 )) && ok "RAM: ${MEM_MB} MB"        || warn "RAM: ${MEM_MB} MB — 4 GB+ recommended (the build may fail below ~3 GB)"
(( DISK_GB >= 20 ))  && ok "Free disk: ${DISK_GB} GB" || warn "Free disk: ${DISK_GB} GB — 40 GB+ recommended"
if (( MEM_MB < 3500 )) && ! swapon --show | grep -q .; then
  warn "Adding a 2 GB swap file so the build has enough memory"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ── 2. Packages & Docker ─────────────────────────────────────────────────────
step "Installing prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl ufw jq cron >/dev/null
ok "curl, git, openssl, ufw, jq, cron"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  step "Installing Docker Engine (official repository)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1
# Keep container logs from filling the disk.
if [[ ! -f /etc/docker/daemon.json ]]; then
  echo '{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }' > /etc/docker/daemon.json
  systemctl restart docker
fi
ok "$(docker --version | cut -d, -f1), $(docker compose version | head -1)"

# ── 3. Application files ─────────────────────────────────────────────────────
step "Placing the portal in ${APP_DIR}"
if [[ -f "${SCRIPT_DIR}/docker-compose.yml" && "${SCRIPT_DIR}" != "${APP_DIR}" ]]; then
  mkdir -p "$APP_DIR"
  # Copy the code but never overwrite an existing .env, backups or data.
  tar -C "$SCRIPT_DIR" --exclude=.env --exclude=backups --exclude=node_modules --exclude=.next -cf - . | tar -C "$APP_DIR" -xf -
  ok "Copied from ${SCRIPT_DIR}"
elif [[ -d "${APP_DIR}/.git" ]]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH" && git -C "$APP_DIR" reset -q --hard "origin/${BRANCH}"
  ok "Updated from GitHub (${BRANCH})"
elif [[ -f "${APP_DIR}/docker-compose.yml" ]]; then
  ok "Using existing files"
else
  echo "  The repository is private. Create a GitHub fine-grained token with read-only"
  echo "  'Contents' access to Megannnx/outage-portal (github.com/settings/tokens) and paste it."
  ask "GitHub token (input hidden is not supported here; it is not stored)" ""
  [[ -n "$REPLY" ]] || die "No token given. Alternatively, copy the project folder to the VM and run install.sh from inside it."
  git clone -q --branch "$BRANCH" "https://x-access-token:${REPLY}@${REPO_URL#https://}" "$APP_DIR"
  git -C "$APP_DIR" remote set-url origin "$REPO_URL"   # don't keep the token on disk
  ok "Cloned ${REPO_URL}"
fi
cd "$APP_DIR"
mkdir -p backups && chmod 700 backups

# ── 4. Configuration (.env) ──────────────────────────────────────────────────
step "Configuration"
if [[ -f .env ]]; then
  ok ".env already exists — keeping it (edit ${APP_DIR}/.env to change settings)"
  MODE=$(grep -q '^PORTAL_MODE=internal' .env && echo internal || echo public)
  DOMAIN=$(grep '^PORTAL_DOMAIN=' .env | cut -d= -f2-)
else
  echo "  How will people reach the portal?"
  echo "   1) Public web address, e.g. outages.atec.co.za (recommended — automatic HTTPS;"
  echo "      DNS must already point at this VM and ports 80/443 must be reachable from the internet)"
  echo "   2) Internal network only (http://<vm-ip>:3000 — technicians can't open dispatch links off-site)"
  ask "Choose 1 or 2" "1"
  if [[ "$REPLY" == "2" ]]; then
    MODE=internal
    IP=$(hostname -I | awk '{print $1}')
    DOMAIN="$IP"; BASE="http://${IP}:3000"
  else
    MODE=public
    ask "Domain name for the portal" "outages.atec.co.za"; DOMAIN="$REPLY"
    BASE="https://${DOMAIN}"
  fi
  ask "Email for HTTPS certificate notices / system contact" "it@atec.co.za"; ADMIN_MAIL="$REPLY"
  PGPW=$(rand_hex 24)
  umask 077
  cat > .env <<ENV
# Generated by install.sh on $(date -u +%FT%TZ). Keep this file secret (chmod 600).
PORTAL_MODE=${MODE}
PORTAL_DOMAIN=${DOMAIN}
PUBLIC_BASE_URL=${BASE}
ACME_EMAIL=${ADMIN_MAIL}
WEB_BIND=$([[ $MODE == internal ]] && echo 0.0.0.0 || echo 127.0.0.1)
COOKIE_SECURE=$([[ $MODE == internal ]] && echo false || echo true)
NODE_ENV=production
DISPLAY_TIMEZONE=Africa/Johannesburg

# Database (runs in the 'db' container on this VM)
POSTGRES_PASSWORD=${PGPW}
DATABASE_URL=postgres://portal:${PGPW}@db:5432/portal

# Security keys — generated here, never shown. Back this file up with your passwords.
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
INGEST_TOKEN_NETXMS=$(rand_hex 32)
INGEST_TOKEN_GENERIC=$(rand_hex 32)
BOUNCE_WEBHOOK_TOKEN=$(rand_hex 32)
CLIENT_API_WEBHOOK_SECRET=$(rand_hex 32)
MFA_REQUIRED_ALL=false
TEMPLATE_SELF_APPROVAL=false

# Delivery: capture = nothing leaves the system (red banner). Change to live after go-live checks.
DELIVERY_MODE=capture

# Residents — client-base communications API (fill in when known)
CLIENT_API_URL=
CLIENT_API_TOKEN=

# ISPs + internal email — SMTP relay (fill in)
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM="ATEC Network Operations <outages@atec.co.za>"
SMTP_REPLY_TO=support@atec.co.za
SMTP_MESSAGE_ID_DOMAIN=${DOMAIN}
DISPATCH_EMAILS=

# Bounce mailbox (optional, enables the 'bounces' service)
BOUNCE_IMAP_HOST=
BOUNCE_IMAP_USER=
BOUNCE_IMAP_PASSWORD=

# Optional: only accept NetXMS events from this IP
INGEST_ALLOWED_IPS=
# Optional AI cross-check for technical updates
ANTHROPIC_API_KEY=

RUN_MIGRATIONS_ON_START=false
BACKUP_KEEP_DAYS=30
ENV
  chmod 600 .env
  ok ".env created with new secrets (${APP_DIR}/.env)"
fi

# ── 5. Firewall ──────────────────────────────────────────────────────────────
step "Firewall"
ufw allow OpenSSH >/dev/null
if [[ $MODE == public ]]; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ok "Allowed SSH, 80, 443"
else ufw allow 3000/tcp >/dev/null; ok "Allowed SSH, 3000"; fi
ufw --force enable >/dev/null

# ── 6. Build & start ─────────────────────────────────────────────────────────
PROFILES=(--profile backup)
[[ $MODE == public ]] && PROFILES+=(--profile tls)
grep -q '^BOUNCE_IMAP_HOST=.\+' .env && PROFILES+=(--profile bounces)
# Docker Compose reads COMPOSE_PROFILES from .env, so every later command uses the same services.
PROFILE_LIST=$(printf '%s\n' "${PROFILES[@]}" | grep -v -- '--profile' | paste -sd, -)
sed -i '/^COMPOSE_PROFILES=/d' .env && echo "COMPOSE_PROFILES=${PROFILE_LIST}" >> .env
step "Building the portal (first build takes 3–8 minutes)"
docker compose "${PROFILES[@]}" build --pull
step "Starting services"
docker compose "${PROFILES[@]}" up -d --remove-orphans
ok "Containers started"

# ── 7. Admin command & watchdog ──────────────────────────────────────────────
step "Installing the 'atec-portal' command and watchdog"
install -m 0755 "${APP_DIR}/deploy/atec-portal" /usr/local/bin/atec-portal
cat > /etc/cron.d/atec-portal <<CRON
# Every 5 minutes: if the portal is unhealthy, restart services and log to syslog (tag: atec-portal).
*/5 * * * * root /usr/local/bin/atec-portal watchdog >/dev/null 2>&1
CRON
chmod 644 /etc/cron.d/atec-portal
ok "Run 'atec-portal status' any time"

# ── 8. Wait for healthy ──────────────────────────────────────────────────────
step "Waiting for the portal to report healthy"
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"worker":true'; then ok "Healthy"; HEALTHY=1; break; fi
  sleep 5
done
[[ -n "${HEALTHY:-}" ]] || warn "Not healthy yet — check: atec-portal status / atec-portal logs"

URL=$(grep '^PUBLIC_BASE_URL=' .env | cut -d= -f2-)
echo
echo "${BLD}${GRN}Installation complete.${RST}"
echo
echo "  1. Open ${BLD}${URL}/setup${RST} now and create the first administrator"
echo "     (whoever completes it first becomes admin)."
echo "  2. Admin › System health › Integration tokens shows the NetXMS token."
echo "     NetXMS posts to: ${URL}/api/ingest/netxms  (see docs/NETXMS_SETUP.md)"
echo "  3. Fill in SMTP_* and CLIENT_API_* in ${APP_DIR}/.env, then: atec-portal restart"
echo "  4. Monitoring: point NetXMS (or any uptime monitor) at ${URL}/api/health"
echo "     — HTTP 200 = healthy, 503 = database or worker problem."
echo
echo "  Useful: atec-portal status | logs | backup | update | restart"
echo "  Backups: ${APP_DIR}/backups (nightly) — copy them off this VM."
