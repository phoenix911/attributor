#!/bin/bash
# attributor setup wizard — D1 + Worker.
# Run from repo root: bash scripts/setup.sh
# Resume anytime — completed steps are skipped automatically.

# NOTE: intentionally no `set -e` so failures are handled gracefully per-step.

# ── colours ────────────────────────────────────────────────────────────────────
BOLD="\033[1m"
DIM="\033[2m"
RED="\033[31m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RESET="\033[0m"

# ── state file (gitignored) ───────────────────────────────────────────────────
STATE_FILE=".setup-state"
touch "$STATE_FILE"

step_done()  { grep -qx "$1" "$STATE_FILE" 2>/dev/null; }
mark_done()  { grep -qx "$1" "$STATE_FILE" 2>/dev/null || echo "$1" >> "$STATE_FILE"; }
skip_step()  { echo -e "  ${GREEN}✓ already done — skipping${RESET}"; }

# ── helpers ───────────────────────────────────────────────────────────────────
header() {
  clear
  echo -e "${BOLD}${CYAN}"
  echo "  ╔══════════════════════════════════════════╗"
  echo "  ║       attributor — setup wizard          ║"
  echo "  ╚══════════════════════════════════════════╝"
  echo -e "${RESET}"
  echo -e "  State file: ${DIM}$STATE_FILE${RESET}  (delete to restart)"
  echo ""
}

step()    { echo ""; echo -e "${BOLD}  Step $1 / 8 — $2${RESET}"; echo -e "  ${DIM}──────────────────────────────────────────${RESET}"; }
info()    { echo -e "  ${CYAN}→${RESET}  $*"; }
success() { echo -e "  ${GREEN}✓${RESET}  $*"; }
warn()    { echo -e "  ${YELLOW}!${RESET}  $*"; }
fail()    { echo -e "  ${RED}✗${RESET}  $*"; echo ""; exit 1; }

ask() {
  local prompt="$1" var="$2" default="${3:-}"
  if [ -n "$default" ]; then
    read -rp "    $prompt [$default]: " "$var" </dev/tty
    [ -z "${!var}" ] && eval "$var=\"$default\""
  else
    read -rp "    $prompt: " "$var" </dev/tty
  fi
}

ask_yn() {
  local answer
  read -rp "    $1 (y/n): " answer </dev/tty
  [[ "$answer" == "y" || "$answer" == "Y" ]]
}

sed_inplace() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$1" "$2"
  else
    sed -i '' "$1" "$2"
  fi
}

show_progress() {
  local steps=("prereqs" "wrangler_toml" "d1" "schema" "domain" "password" "install" "deploy")
  local labels=("Prerequisites" "wrangler.toml" "D1 database" "Apply schema" "Domain (optional)" "Dashboard password" "npm install" "Deploy")
  echo -e "  ${BOLD}Progress:${RESET}"
  for i in "${!steps[@]}"; do
    if step_done "${steps[$i]}"; then
      echo -e "    ${GREEN}✓${RESET}  $((i+1)). ${labels[$i]}"
    else
      echo -e "    ${DIM}○${RESET}  $((i+1)). ${labels[$i]}"
    fi
  done
  echo ""
}

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

cd "$(dirname "$0")/.."
header
show_progress

if ! ask_yn "Continue?"; then
  echo ""
  info "Run again any time to resume."
  exit 0
fi

# ── Step 1 — Prerequisites ────────────────────────────────────────────────────
step 1 "Prerequisites"
if step_done "prereqs"; then skip_step; else
  command -v node >/dev/null 2>&1 || fail "Node.js not found. Install from https://nodejs.org (v18+)"
  NODE_VER=$(node -e "process.stdout.write(process.version.replace('v','').split('.')[0])")
  [ "$NODE_VER" -lt 18 ] && fail "Node.js v$NODE_VER found — v18+ required."
  success "Node.js $(node -v)"

  command -v npm >/dev/null 2>&1 || fail "npm not found."
  success "npm $(npm -v)"

  info "Checking Cloudflare auth..."
  if ! (cd code && npx wrangler whoami >/dev/null 2>&1); then
    warn "Not logged in to Cloudflare. Opening browser..."
    (cd code && npx wrangler login) || fail "wrangler login failed."
  fi
  success "Cloudflare auth OK"
  mark_done "prereqs"
fi

# ── Step 2 — wrangler.toml ────────────────────────────────────────────────────
step 2 "wrangler.toml"
if step_done "wrangler_toml"; then skip_step; else
  if [ ! -f "code/wrangler.toml" ]; then
    cp code/wrangler.example.toml code/wrangler.toml
    success "Copied wrangler.example.toml → code/wrangler.toml"
  else
    success "code/wrangler.toml already exists"
  fi
  mark_done "wrangler_toml"
fi

# ── Step 3 — D1 database ──────────────────────────────────────────────────────
step 3 "D1 database"
if step_done "d1"; then skip_step; else
  if grep -q "REPLACE_WITH_YOUR_D1_DATABASE_ID" code/wrangler.toml; then
    info "Looking for an existing D1 named 'attribution'..."
    EXISTING_ID=""
    if command -v jq >/dev/null 2>&1; then
      EXISTING_ID=$(cd code && npx wrangler d1 list --json 2>/dev/null | jq -r '.[]? | select(.name=="attribution") | .uuid' | head -1)
    fi
    if [ -n "$EXISTING_ID" ]; then
      info "Found existing D1: $EXISTING_ID"
      DB_ID="$EXISTING_ID"
    else
      info "Creating D1 database 'attribution'..."
      D1_OUT=$(cd code && npx wrangler d1 create attribution 2>&1) || true
      DB_ID=$(echo "$D1_OUT" | grep -oE '"database_id":\s*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
      [ -z "$DB_ID" ] && DB_ID=$(echo "$D1_OUT" | grep -oE 'database_id = "[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
      if [ -z "$DB_ID" ]; then
        warn "Could not auto-extract database_id. Output was:"
        echo "$D1_OUT"
        ask "Paste the database_id manually" DB_ID
      fi
    fi
    [ -z "$DB_ID" ] && fail "No D1 id provided — cannot continue."
    sed_inplace "s|REPLACE_WITH_YOUR_D1_DATABASE_ID|$DB_ID|g" code/wrangler.toml
    success "D1 wired into code/wrangler.toml: $DB_ID"
  else
    success "D1 already configured"
  fi
  mark_done "d1"
fi

# ── Step 4 — Apply schema ─────────────────────────────────────────────────────
step 4 "Apply schema.sql to remote D1"
if step_done "schema"; then skip_step; else
  info "Running schema.sql..."
  (cd code && npx wrangler d1 execute attribution --remote --file=./schema.sql) || fail "Schema apply failed."
  success "Schema applied"
  mark_done "schema"
fi

# ── Step 5 — Domain (optional) ────────────────────────────────────────────────
step 5 "Custom domain (optional)"
if step_done "domain"; then skip_step; else
  if ask_yn "Bind a custom domain now? (you can also do this later in the CF dashboard)"; then
    ask "Enter your domain (e.g. attrs.example.com)" CUSTOM_DOMAIN
    if [ -n "$CUSTOM_DOMAIN" ]; then
      python3 - "$CUSTOM_DOMAIN" <<'PY'
import sys, pathlib
domain = sys.argv[1]
path = pathlib.Path("code/wrangler.toml")
text = path.read_text()
block = f'\n[[routes]]\npattern = "{domain}"\ncustom_domain = true\n'
if "[[routes]]" in text:
    print("[[routes]] already present — leaving as-is.")
else:
    text = text.replace('compatibility_flags = ["nodejs_compat"]\n',
                        'compatibility_flags = ["nodejs_compat"]\n' + block, 1)
    path.write_text(text)
    print(f"Added route for {domain}")
PY
      success "Domain wired (will be activated by `wrangler deploy`)"
    fi
  else
    info "Skipped — bind later via CF dashboard → Workers → attributor → Settings → Domains & Routes"
  fi
  mark_done "domain"
fi

# ── Step 6 — Dashboard password ───────────────────────────────────────────────
step 6 "Dashboard password (DASHBOARD_PASS secret)"
if step_done "password"; then skip_step; else
  if ask_yn "Set DASHBOARD_PASS as a Worker secret now?"; then
    GENERATED=$(openssl rand -base64 24 2>/dev/null || node -e "console.log(require('crypto').randomBytes(18).toString('base64'))")
    info "Generated password: ${BOLD}$GENERATED${RESET}"
    ask "Press enter to use generated, or type your own" DASHBOARD_PASS "$GENERATED"
    echo "DASHBOARD_PASS=$DASHBOARD_PASS" > .env
    echo "$DASHBOARD_PASS" | (cd code && npx wrangler secret put DASHBOARD_PASS) || \
      fail "wrangler secret put failed."
    success "Saved to .env and pushed to Cloudflare as a Worker secret"
  else
    warn "Skipped — /dashboard will return 503 until DASHBOARD_PASS is set."
    info "Set later: wrangler secret put DASHBOARD_PASS  (or the dashboard UI)"
  fi
  mark_done "password"
fi

# ── Step 7 — npm install ──────────────────────────────────────────────────────
step 7 "Install dependencies"
if step_done "install"; then skip_step; else
  info "Running npm install in code/..."
  (cd code && npm install --silent) || fail "npm install failed."
  success "Dependencies installed"
  mark_done "install"
fi

# ── Step 8 — Deploy ───────────────────────────────────────────────────────────
step 8 "Deploy to Cloudflare"
if step_done "deploy"; then
  skip_step
  warn "Already deployed. Run ${BOLD}make deploy${RESET} to redeploy."
else
  if ask_yn "Deploy now?"; then
    (cd code && npx wrangler deploy) || fail "Deploy failed."
    success "Deployed!"
    mark_done "deploy"
  else
    warn "Skipped. Run ${BOLD}make deploy${RESET} when ready."
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║              Setup complete!             ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${RESET}"

echo -e "  ${BOLD}Next:${RESET}"
echo -e "    ${DIM}make secrets${RESET}        — open CF dashboard → Variables & Secrets"
echo -e "    ${DIM}make tail${RESET}           — stream live worker logs"
echo -e "    ${DIM}make db-cleanup${RESET}     — run retention sweep (or wire a cron in wrangler.toml)"
echo ""
echo -e "  ${BOLD}Edit ${DIM}code/wrangler.toml${RESET}${BOLD} to add apps to APPS_CONFIG${RESET} and ALLOWED_ORIGINS, then ${DIM}make deploy${RESET}."
echo ""

if ask_yn "Open Cloudflare dashboard → Variables & Secrets now?"; then
  open "https://dash.cloudflare.com/?to=/:account/workers/services/view/attributor/production/settings" 2>/dev/null || \
    echo "  Open manually: https://dash.cloudflare.com → Workers & Pages → attributor → Settings"
fi
