#!/bin/sh
# Installs the factory CLI from a GitHub release. No sudo.
# Env: FACTORY_VERSION (tag, default latest), FACTORY_BIN_DIR (default $HOME/.local/bin),
# FACTORY_BASE_URL (release host, for tests), FACTORY_UNAME_S and FACTORY_UNAME_M (override uname).
# Flags --version, --dir and --uninstall win over their env twins.
set -eu

usage() {
	cat <<'EOF'
Usage: install.sh [--version <tag>] [--dir <path>] [--uninstall] [--help]

  --version <tag>  install a release, for example v9.1.0 or 9.1.0 (default: latest)
  --dir <path>     where to put the factory binary (default: $HOME/.local/bin)
  --uninstall      remove <dir>/factory and nothing else
  --help           show this text
EOF
}

uninstall=0
flag_version=""
flag_dir=""
while [ $# -gt 0 ]; do
	case $1 in
	--version)
		[ $# -ge 2 ] || { echo "install: --version needs a tag" >&2; exit 2; }
		flag_version=$2
		shift 2
		;;
	--dir)
		[ $# -ge 2 ] || { echo "install: --dir needs a path" >&2; exit 2; }
		flag_dir=$2
		shift 2
		;;
	--uninstall)
		uninstall=1
		shift
		;;
	--help | -h)
		usage
		exit 0
		;;
	*)
		usage >&2
		echo "install: unknown option: $1" >&2
		exit 2
		;;
	esac
done

base="${FACTORY_BASE_URL:-https://github.com/KaaS-team/KaaS-factory}"
bin_dir="${flag_dir:-${FACTORY_BIN_DIR:-${HOME:?install: no home directory, pass --dir}/.local/bin}}"
if [ -n "$flag_version" ]; then
	FACTORY_VERSION="v${flag_version#v}"
fi

fail() {
	echo "install: $*" >&2
	exit 1
}

if [ "$uninstall" = 1 ]; then
	rm -f "$bin_dir/factory"
	echo "removed $bin_dir/factory"
	exit 0
fi

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
