#!/bin/sh
# Installs the factory CLI from a GitHub release. No sudo.
# Env: FACTORY_VERSION (tag, default latest), FACTORY_BIN_DIR (default $HOME/.local/bin),
# FACTORY_BASE_URL (release host, for tests), FACTORY_UNAME_S and FACTORY_UNAME_M (override uname).
set -eu

base="${FACTORY_BASE_URL:-https://github.com/KaaS-team/KaaS-factory}"
bin_dir="${FACTORY_BIN_DIR:-$HOME/.local/bin}"

fail() {
	echo "install: $*" >&2
	exit 1
}

os="${FACTORY_UNAME_S:-$(uname -s)}"
arch="${FACTORY_UNAME_M:-$(uname -m)}"
case "$os" in
Linux) os=linux ;;
Darwin) os=darwin ;;
*) fail "unsupported OS: $os" ;;
esac
case "$arch" in
x86_64 | amd64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) fail "unsupported architecture: $arch" ;;
esac

if [ -n "${FACTORY_VERSION:-}" ]; then
	url="$base/releases/download/$FACTORY_VERSION"
else
	url="$base/releases/latest/download"
fi
name="factory_${os}_${arch}.tar.gz"

if command -v sha256sum >/dev/null 2>&1; then
	sha() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
	sha() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
	fail "need sha256sum or shasum"
fi
command -v curl >/dev/null 2>&1 || fail "need curl"
command -v tar >/dev/null 2>&1 || fail "need tar"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

curl -fsSL -o "$tmp/$name" "$url/$name" || fail "download failed: $url/$name"
curl -fsSL -o "$tmp/checksums.txt" "$url/checksums.txt" || fail "download failed: $url/checksums.txt"

want="$(awk -v n="$name" '$2 == n { print $1 }' "$tmp/checksums.txt")"
[ -n "$want" ] || fail "no checksum listed for $name"
got="$(sha "$tmp/$name")"
[ "$want" = "$got" ] || fail "checksum mismatch for $name, nothing installed"

tar -xzf "$tmp/$name" -C "$tmp" factory || fail "archive does not contain factory"
mkdir -p "$bin_dir"
cp "$tmp/factory" "$bin_dir/factory.new"
chmod 755 "$bin_dir/factory.new"
mv "$bin_dir/factory.new" "$bin_dir/factory"

echo "installed $bin_dir/factory"
case ":$PATH:" in
*":$bin_dir:"*) ;;
*) echo "add $bin_dir to your PATH" ;;
esac
echo "next: factory doctor"
