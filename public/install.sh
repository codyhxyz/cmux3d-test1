#!/bin/sh
# CMUX3D installer — curl -fsSL https://codingcube.codyh.xyz/install.sh | sh
# Downloads the cube into ~/.cmux3d/app and starts it. No sudo, nothing global.
set -eu

REPO="${CMUX3D_REPO:-codyhxyz/cmux3d-test1}"
BRANCH="${CMUX3D_BRANCH:-main}"
HOME_DIR="${CMUX3D_HOME:-$HOME/.cmux3d}"
APP_DIR="$HOME_DIR/app"

say() { printf '\033[36m›\033[0m %s\n' "$1"; }
die() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js is required. Install it from https://nodejs.org and run this again."
command -v npm  >/dev/null 2>&1 || die "npm is required. It ships with Node.js: https://nodejs.org"

MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$MAJOR" -ge 20 ] || die "Node.js 20 or newer is required (found $(node -v))."

say "Downloading the cube…"
mkdir -p "$APP_DIR"
TARBALL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$TARBALL" | tar -xz -C "$TMP" || die "Could not download $REPO@$BRANCH"
SRC=$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -1)
[ -n "$SRC" ] || die "Downloaded archive looked empty"

# Replace the app but keep ~/.cmux3d/token so paired devices stay paired.
rm -rf "$APP_DIR"
mv "$SRC" "$APP_DIR"

say "Installing dependencies (this builds a native terminal, give it a minute)…"
( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) \
  || die "npm install failed. Run it by hand in $APP_DIR to see why."

# A tiny launcher so restarting later is one word.
mkdir -p "$HOME_DIR/bin"
cat > "$HOME_DIR/bin/cmux3d" <<LAUNCHER
#!/bin/sh
exec node "$APP_DIR/src/server/index.js" "\$@"
LAUNCHER
chmod +x "$HOME_DIR/bin/cmux3d"

say "Starting your shells…"
printf '\n'
exec node "$APP_DIR/src/server/index.js"
