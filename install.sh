#!/bin/sh
# Quai CLI installer.
#
# Install the latest release:
#   curl -fsSL https://github.com/atinseau/quai/releases/latest/download/install.sh | sh
#
# Install a specific one:
#   curl -fsSL https://github.com/atinseau/quai/releases/download/v0.1.0/install.sh | sh
#
# Both URLs are tied to a release. There is deliberately no install from a
# branch: main is whatever was merged last, not something anyone released, and
# an install run a year from now should do what it did today.
#
# Environment:
#   QUAI_VERSION   a tag such as v0.1.0, defaults to the latest release
#   QUAI_INSTALL   where to put the binary, defaults to ~/.local/bin

set -eu

REPO="${QUAI_REPO:-atinseau/quai}"
INSTALL_DIR="${QUAI_INSTALL:-$HOME/.local/bin}"
BASE="${QUAI_BASE_URL:-https://github.com}"
API="${QUAI_API_URL:-https://api.github.com}"

die() { echo "quai: $1" >&2; exit 1; }

# --- which build fits this machine ---------------------------------------

case "$(uname -s)" in
  Linux)  os="linux" ;;
  Darwin) os="darwin" ;;
  *) die "unsupported system: $(uname -s). Build from source instead: bun build --compile src/cli/main.ts" ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

TARGET="quai-${os}-${arch}"

# --- which release --------------------------------------------------------

if [ -n "${QUAI_VERSION:-}" ]; then
  VERSION="$QUAI_VERSION"
else
  # Resolve the newest tag without needing jq on the user's machine.
  VERSION="$(curl -fsSL "${API}/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name" *: *"\([^"]*\)".*/\\1/p' | head -1)"
  [ -n "$VERSION" ] || die "could not find a published release. Set QUAI_VERSION to install a specific tag."
fi

# Refuse anything that is not a tag, so a branch name cannot slip through.
case "$VERSION" in
  v*) ;;
  *) die "expected a release tag such as v0.1.0, got '$VERSION'" ;;
esac

ASSETS="${BASE}/${REPO}/releases/download/${VERSION}"

# --- download -------------------------------------------------------------

echo "Installing quai ${VERSION} (${TARGET})"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
  die "no prebuilt binary for Intel Macs. Build one with: bun build --compile src/cli/main.ts"
fi

curl -fSL --progress-bar "${ASSETS}/${TARGET}" -o "$TMP/quai" \
  || die "could not download ${TARGET} for ${VERSION} — check that this release has a build for your machine"

# Verify against the published checksums, so a truncated or tampered download
# is caught before it lands on the PATH.
if curl -fsSL "${ASSETS}/checksums.txt" -o "$TMP/checksums.txt" 2>/dev/null; then
  expected="$(sed -n "s/^\([0-9a-f]*\)  *${TARGET}$/\1/p" "$TMP/checksums.txt")"
  if [ -n "$expected" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$TMP/quai" | cut -d" " -f1)"
    else
      actual="$(shasum -a 256 "$TMP/quai" | cut -d" " -f1)"
    fi
    [ "$actual" = "$expected" ] || die "checksum mismatch: the download is not what was published"
    echo "Checksum verified."
  fi
fi

# --- install --------------------------------------------------------------

mkdir -p "$INSTALL_DIR"
chmod +x "$TMP/quai"

# The old binary is moved aside rather than overwritten: on some systems a
# running program cannot have its file replaced underneath it.
if [ -e "$INSTALL_DIR/quai" ]; then
  mv -f "$INSTALL_DIR/quai" "$INSTALL_DIR/quai.old" 2>/dev/null || true
fi
mv "$TMP/quai" "$INSTALL_DIR/quai"
rm -f "$INSTALL_DIR/quai.old" 2>/dev/null || true

echo "Installed to $INSTALL_DIR/quai"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo
    echo "$INSTALL_DIR is not on your PATH. Add it:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

echo
echo "Next:    quai login <user@host> quai.<your-domain>"
echo "Later:   quai update      quai uninstall"
