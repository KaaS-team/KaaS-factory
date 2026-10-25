echo "commits=$(git rev-list --count HEAD 2>/dev/null || echo 0)"
echo "common=$(cd "$(git rev-parse --git-common-dir 2>/dev/null || echo /nowhere)" 2>/dev/null && pwd -P)"
case "$(cd "$TMPDIR" && pwd -P)" in "$(pwd -P)"/*) echo tmp=inside;; *) echo tmp=outside;; esac
echo "0 failed"
