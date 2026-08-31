#!/bin/sh
# Quai CLI installer.
#
#   curl -fsSL https://raw.githubusercontent.com/atinseau/quai/main/install.sh | sh
#
# Downloads the binary for this machine and puts it on the PATH. The CLI is
# compiled standalone, so nothing else has to be installed first.
#
# Environment:
#   QUAI_VERSION   a tag such as v0.1.0, defaults to the latest release
#   QUAI_INSTALL   where to put the binary, defaults to ~/.local/bin

set -eu

REPO="${QUAI_REPO:-atinseau/quai}"
INSTALL_DIR="${QUAI_INSTALL:-$HOME/.local/bin}"

die() { echo "quai: $1" >&2; exit 1; }

# --- which build fits this machine ---------------------------------------

case "$(uname -s)" in
  Linux)  os="linux" ;;
  Darwin) os="darwin" ;;
  *) die "unsupported system: $(uname -s). Build from source instead: bun build --compile src/cli/main.ts" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

TARGET="quai-${os}-${arch}"

# --- which version --------------------------------------------------------

if [ -n "${QUAI_VERSION:-}" ]; then
  VERSION="$QUAI_VERSION"
else
  # Resolve the latest tag without needing jq on the user's machine.
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name" *: *"\([^"]*\)".*/\\1/p' | head -1)"
  [ -n "$VERSION" ] || die "could not find a release. Set QUAI_VERSION to install a specific tag."
fi

URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARGET}"

# --- download -------------------------------------------------------------

echo "Installing quai ${VERSION} (${TARGET})"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fSL --progress-bar "$URL" -o "$TMP/quai" \
  || die "could not download $URL — check that ${VERSION} has a ${TARGET} build"

# Verify against the published checksums when they exist, so a truncated or
# tampered download is caught before it lands on the PATH.
if curl -fsSL "https://github.com/${REPO}/releases/download/${VERSION}/checksums.txt" \
     -o "$TMP/checksums.txt" 2>/dev/null; then
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
mv "$TMP/quai" "$INSTALL_DIR/quai"

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
echo "Next: quai login <user@host> quai.<your-domain>"
