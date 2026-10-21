#!/usr/bin/env bash
# AaaS installer and updater.
#
# The repository is private: you need access to aidendify/AaaS and a signed-in git (GitHub CLI, SSH key or token).
#
#   Install:  gh repo clone aidendify/AaaS aidentify && cd aidentify && ./install.sh
#             (or: git clone git@github.com:aidendify/AaaS.git aidentify && cd aidentify && ./install.sh)
#   Update:   ./install.sh --update        (or: npm run update)  run inside your AaaS folder
#
# Options / environment:
#   --dir <path>      AIDENTIFY_DIR   install folder (default: ~/aidentify)
#   --version <tag>   AIDENTIFY_VERSION  a release tag such as v1.2.0 (default: the latest release)
#   --update          update an existing install to the latest release, keeping .env and data/
#   --no-npm          skip npm install
#   AIDENTIFY_GIT_URL  clone URL when the installer clones for you (default: gh repo clone, else https)
#   GITHUB_TOKEN       used for the release lookup and tarball download when git is not available
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
    -h|--help) sed -n '2,18p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---- prerequisites ----
have git || have curl || die "git (recommended) or curl is required."
if ! have node; then
  die "Node.js 20 or newer is required. Install it from https://nodejs.org (or: curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 20), then run this again."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $NODE_MAJOR found; AaaS needs Node.js 20 or newer (https://nodejs.org)."
have npm || die "npm is required (it ships with Node.js)."

# Newest vX.Y.Z tag. Private repo: ask git (uses your existing git sign-in), then gh, then the API with GITHUB_TOKEN.
latest_tag() {
  local remote="${1:-}" t=""
  if have git; then
    if [ -n "$remote" ]; then t="$(git ls-remote --tags --refs "$remote" 'v*' 2>/dev/null | sed 's#.*refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n1)"; fi
  fi
  if [ -z "$t" ] && have gh && gh auth status >/dev/null 2>&1; then t="$(gh release view -R "$REPO" --json tagName -q .tagName 2>/dev/null || true)"; fi
  if [ -z "$t" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
    t="$(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)"
  fi
  printf '%s' "$t"
}

# Download a release (or branch) tarball into $1, without .env or data/.
fetch_tarball() {
  local dest="$1" tmp; tmp="$(mktemp -d)"
  [ -n "${GITHUB_TOKEN:-}" ] || die "The repository is private. Install git (recommended) or set GITHUB_TOKEN to a token with access to $REPO."
  local url="https://api.github.com/repos/$REPO/tarball/${REF}"
  say "Downloading $REPO@$REF"
  curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" "$url" | tar -xz -C "$tmp" || die "Download failed for $REPO@$REF (check that GITHUB_TOKEN can read the repo)."
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
  [ -f "$DIR/server.js" ] || die "No AaaS install found in $DIR (use --dir)."
  cd "$DIR"
  OLD="$(node -p 'require("./package.json").version' 2>/dev/null || echo unknown)"
  if [ -d .git ] && have git; then
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then die "You have local code changes in $DIR. Commit or stash them first (git stash), then update."; fi
    say "Fetching releases (uses your git sign-in; the repository is private)"
    [ -n "$VERSION" ] || VERSION="$(latest_tag origin)"
    if [ -n "$VERSION" ]; then
      git fetch --quiet --force origin "refs/tags/$VERSION:refs/tags/$VERSION" || die "Could not fetch $VERSION. Check your access to $REPO (gh auth login, an SSH key or a token)."
      git -c advice.detachedHead=false checkout --quiet "tags/$VERSION"
    else
      warn "No release tag found; using the main branch."
      git fetch --quiet origin main || die "Could not fetch from origin. Check your access to $REPO (gh auth login, an SSH key or a token)."
      git checkout --quiet -B main FETCH_HEAD
    fi
  else
    [ -n "$VERSION" ] || VERSION="$(latest_tag)"; REF="${VERSION:-main}"
    fetch_tarball "$DIR"
  fi
  npm_install
  NEW="$(node -p 'require("./package.json").version')"
  say "AaaS updated: $OLD -> $NEW. Your .env and data/ were kept."
  echo "   Restart the server to use it (stop it, then: npm start)."
  [ -f CHANGELOG.md ] && echo "   What's new: CHANGELOG.md or https://github.com/$REPO/releases"
  exit 0
fi

# ---- install ----
if [ -f ./server.js ] && [ -f ./package.json ] && grep -q '"aidentify"' ./package.json; then
  DIR="$(pwd)"; say "Setting up the AaaS folder you cloned: $DIR"   # usual path: gh repo clone, then ./install.sh
else
  if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    [ -f "$DIR/server.js" ] && die "AaaS is already installed in $DIR. To update: cd $DIR && ./install.sh --update"
    die "$DIR exists and is not empty. Choose another folder with --dir."
  fi
  if [ -n "${AIDENTIFY_GIT_URL:-}" ] && have git; then
    say "Cloning $AIDENTIFY_GIT_URL into $DIR"; git clone --quiet "$AIDENTIFY_GIT_URL" "$DIR" || die "Clone failed. The repository is private: check your access."
  elif have gh && gh auth status >/dev/null 2>&1; then
    say "Cloning $REPO into $DIR (GitHub CLI)"; gh repo clone "$REPO" "$DIR" -- --quiet || die "Clone failed. Check that your GitHub account can see $REPO."
  elif have git; then
    say "Cloning $REPO into $DIR"; git clone --quiet "https://github.com/$REPO.git" "$DIR" || die "Clone failed. The repository is private: sign in first (gh auth login), or use AIDENTIFY_GIT_URL=git@github.com:$REPO.git with an SSH key."
  else
    REF="${VERSION:-$(latest_tag)}"; REF="${REF:-main}"
    warn "git not found; downloading a tarball instead (updates will re-download)."
    fetch_tarball "$DIR"
  fi
  if [ -d "$DIR/.git" ]; then
    T="${VERSION:-$(cd "$DIR" && latest_tag origin)}"
    if [ -n "$T" ]; then (cd "$DIR" && git -c advice.detachedHead=false checkout --quiet "tags/$T") && say "Using release $T"; fi
  fi
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

AaaS $(node -p 'require("./package.json").version') is installed in $DIR

Next steps:
  1. Add an AI key to $DIR/.env: OPENROUTER_API_KEY=... (or ANTHROPIC_API_KEY=...)
  2. Start it:   cd $DIR && npm start
  3. Open http://localhost:3000/setup and create the admin account. There is no default password:
     use the one-time setup code printed in the server log (or set a strong ADMIN_PASSWORD in .env first).

Update later:  cd $DIR && npm run update
Docs:          https://github.com/$REPO#readme
NEXT
