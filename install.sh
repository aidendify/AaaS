#!/usr/bin/env bash
# AIdentify installer and updater.
#
#   Install:  curl -fsSL https://raw.githubusercontent.com/aidendify/AaaS/main/install.sh | bash
#   Update:   ./install.sh --update        (or: npm run update)  run inside your AIdentify folder
#
# Options / environment:
#   --dir <path>      AIDENTIFY_DIR   install folder (default: ~/aidentify)
#   --version <tag>   AIDENTIFY_VERSION  a release tag such as v1.2.0 (default: the latest release)
#   --update          update an existing install to the latest release, keeping .env and data/
#   --no-npm          skip npm install
# Your .env and data/ folder are never overwritten.
set -euo pipefail

REPO="aidendify/AaaS"
DIR="${AIDENTIFY_DIR:-$HOME/aidentify}"
VERSION="${AIDENTIFY_VERSION:-}"
MODE="install"
NPM=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --update) MODE="update"; shift ;;
    --no-npm) NPM=0; shift ;;
    -h|--help) sed -n '2,13p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---- prerequisites ----
have curl || die "curl is required."
if ! have node; then
  die "Node.js 20 or newer is required. Install it from https://nodejs.org (or: curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 20), then run this again."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $NODE_MAJOR found; AIdentify needs Node.js 20 or newer (https://nodejs.org)."
have npm || die "npm is required (it ships with Node.js)."

latest_tag() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1
}
[ -n "$VERSION" ] || VERSION="$(latest_tag || true)"
REF="${VERSION:-main}"
[ -n "$VERSION" ] || warn "No published release found; using the main branch."

# Download a release (or branch) tarball into $1, without .env or data/.
fetch_tarball() {
  local dest="$1" tmp; tmp="$(mktemp -d)"
  local url="https://codeload.github.com/$REPO/tar.gz/${REF}"
  say "Downloading $REPO@$REF"
  curl -fsSL "$url" | tar -xz -C "$tmp" || die "Download failed: $url"
  local src; src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  mkdir -p "$dest"
  # copy everything except user data
  (cd "$src" && tar --exclude=./.env --exclude=./data -cf - .) | (cd "$dest" && tar -xf -)
  rm -rf "$tmp"
}

npm_install() {
  [ "$NPM" = 1 ] || return 0
  say "Installing dependencies (npm)"
  if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
  else npm install --omit=dev --no-audit --no-fund; fi
}

if [ "$MODE" = "update" ]; then
  # run from inside the install folder, or from --dir
  if [ -f ./server.js ] && [ -f ./package.json ] && grep -q '"aidentify"' ./package.json; then DIR="$(pwd)"; fi
  [ -f "$DIR/server.js" ] || die "No AIdentify install found in $DIR (use --dir)."
  cd "$DIR"
  OLD="$(node -p 'require("./package.json").version' 2>/dev/null || echo unknown)"
  if [ -d .git ] && have git; then
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then die "You have local code changes in $DIR. Commit or stash them first (git stash), then update."; fi
    say "Fetching releases"
    if [ -n "$VERSION" ]; then
      git fetch --quiet --force origin "refs/tags/$VERSION:refs/tags/$VERSION"
      git -c advice.detachedHead=false checkout --quiet "tags/$VERSION"
    else
      git fetch --quiet origin main && git checkout --quiet -B main FETCH_HEAD
    fi
  else
    fetch_tarball "$DIR"
  fi
  npm_install
  NEW="$(node -p 'require("./package.json").version')"
  say "AIdentify updated: $OLD -> $NEW. Your .env and data/ were kept."
  echo "   Restart the server to use it (stop it, then: npm start)."
  [ -f CHANGELOG.md ] && echo "   What's new: CHANGELOG.md or https://github.com/$REPO/releases"
  exit 0
fi

# ---- install ----
if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  [ -f "$DIR/server.js" ] && die "AIdentify is already installed in $DIR. To update: cd $DIR && ./install.sh --update"
  die "$DIR exists and is not empty. Choose another folder with --dir."
fi
if have git; then
  say "Cloning $REPO@$REF into $DIR"
  git -c advice.detachedHead=false clone --quiet --depth 50 --branch "$REF" "https://github.com/$REPO.git" "$DIR"
else
  warn "git not found; downloading a tarball instead (updates will re-download)."
  fetch_tarball "$DIR"
fi
cd "$DIR"
chmod +x install.sh start.sh 2>/dev/null || true
npm_install
if [ ! -f .env ]; then
  cp .env.example .env && chmod 600 .env
  # a random session secret so sign-in tokens are safe from the first start
  if have openssl; then S="$(openssl rand -hex 32)"; else S="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"; fi
  sed -i.bak "s/^SESSION_SECRET=.*/SESSION_SECRET=$S/" .env && rm -f .env.bak
  say "Created .env (with a random SESSION_SECRET)"
fi

have google-chrome || have google-chrome-stable || have chromium || warn "Optional: Google Chrome or Chromium is not installed. The Browser and Research agents need it (or run: npx playwright install chromium)."

cat <<NEXT

AIdentify $(node -p 'require("./package.json").version') is installed in $DIR

Next steps:
  1. Add an AI key to $DIR/.env: OPENROUTER_API_KEY=... (or ANTHROPIC_API_KEY=...)
     and change ADMIN_PASSWORD / TEAM_PASSWORD before anyone else can reach the server.
  2. Start it:   cd $DIR && npm start
  3. Open http://localhost:3000 and create your account; onboarding sets up your first agents.

Update later:  cd $DIR && npm run update
Docs:          https://github.com/$REPO#readme
NEXT
