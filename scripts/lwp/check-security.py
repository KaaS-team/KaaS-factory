#!/usr/bin/env python3
"""Security checks on what a change adds: secrets, insecure patterns, vulnerable or day-old packages, unsafe SQL.

Usage: check-security.py gitleaks              secrets in commits and edits not yet on the base branch
       check-security.py semgrep [FILE...]     scripts/lwp/semgrep.yml on the files; findings the base already had pass
       check-security.py osv-scanner [LOCK...] OSV advisories on the lockfiles, and a package version that
                                               lockfile adds which was published under 3 days ago fails
       check-security.py squawk [SQL...]       Squawk on migration SQL files
A TOOL may be a comma list. With no files a tool takes the files changed since the merge base with origin/main
(LWP_SECURITY_BASE overrides). Exceptions, each line with a reason: .gitleaksignore, .agents/semgrep-baseline.txt
(`rule-id path # reason`), osv-scanner.toml [[IgnoredVulns]], `-- squawk-ignore` in the SQL.
Why: docs/decisions/scripts.md#check-securitypy
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip())
RULES = ROOT / "scripts/lwp/semgrep.yml"
SEMGREP_BASELINE = ROOT / ".agents/semgrep-baseline.txt"
MIN_AGE = timedelta(days=3)
LOCKS = ("package-lock.json", "bun.lock", "uv.lock", "Cargo.lock")
INSTALL = "brew install gitleaks semgrep osv-scanner; npm i -g squawk-cli"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True).stdout


def base() -> str:
    ref = os.environ.get("LWP_SECURITY_BASE", "origin/main")
    return git("merge-base", "HEAD", ref).strip() or git("rev-parse", "HEAD").strip()


def changed(since: str) -> list[str]:
    files = git("diff", "--name-only", "--no-renames", "--diff-filter=d", since).split("\n")
    files += git("ls-files", "-o", "--exclude-standard").split("\n")
    return sorted({f for f in files if f and (ROOT / f).is_file()})


def need(tool: str) -> None:
    if not shutil.which(tool):
        sys.exit(f"security  FAIL  {tool} is not installed: {INSTALL}")


def gitleaks(files: list[str], since: str) -> int:
    """Commits since the base, then the uncommitted diff and new files as one patch on stdin."""
    need("gitleaks")
    flags = ["--no-banner", "--redact", "--exit-code", "1", "--log-level", "warn"]
    rc = subprocess.run(["gitleaks", "git", *flags, f"--log-opts={since}..HEAD", "."], cwd=ROOT).returncode
    patch = git("diff", "HEAD")
    for f in git("ls-files", "-o", "--exclude-standard").split("\n"):
        if f and (ROOT / f).is_file():
            patch += f"\n+++ b/{f}\n" + (ROOT / f).read_text(errors="replace")
    if patch.strip():
        rc |= subprocess.run(["gitleaks", "stdin", *flags], cwd=ROOT, input=patch, text=True).returncode
    return rc


def semgrep_baseline() -> set[tuple[str, str]]:
    if not SEMGREP_BASELINE.is_file():
        return set()
    rows = (l.split("#")[0].split() for l in SEMGREP_BASELINE.read_text().splitlines())
    return {(r[0], r[1]) for r in rows if len(r) == 2}


def semgrep(files: list[str], since: str) -> int:
    need("semgrep")
    if not files:
        return 0
    cmd = ["semgrep", "scan", "--config", str(RULES), "--metrics=off", "--disable-version-check", "--json", "--quiet"]
    out = subprocess.run([*cmd, "--baseline-commit", since, *files], cwd=ROOT, capture_output=True, text=True)
    try:
        found = json.loads(out.stdout).get("results", [])
    except ValueError:
        print(out.stdout[-2000:], out.stderr[-2000:])
        return 1
    known = semgrep_baseline()
    rule = lambda r: r["check_id"].rsplit(".", 1)[-1]
    new = [r for r in found if (rule(r), r["path"]) not in known]
    for r in new:
        print(f"semgrep  {r['path']}:{r['start']['line']}  {rule(r)}: {r['extra']['message'].strip()}")
    if new:
        print(
            f"semgrep  FAIL  {len(new)} finding(s). Fix it, or add `rule-id path # reason` to {SEMGREP_BASELINE.name}"
        )
    return 1 if new else 0


def packages(path: str, text: str) -> set[tuple[str, str, str]]:
    """(ecosystem, name, version) of every registry package a lockfile pins."""
    if not text.strip():
        return set()
    name = Path(path).name
    if name == "package-lock.json":
        pkgs = json.loads(text).get("packages", {})
        return {
            ("npm", k.rsplit("node_modules/", 1)[1], v["version"])
            for k, v in pkgs.items()
            if "node_modules/" in k and v.get("version") and "registry.npmjs.org" in v.get("resolved", "")
        }
    if name == "bun.lock":
        found = re.findall(r'^\s*"[^"]+": \["((?:@[^/"@]+/)?[^@"]+)@(\d[^"]*)"', text, re.M)
        return {("npm", n, v) for n, v in found}
    lock = tomllib.loads(text).get("package", [])
    if name == "uv.lock":
        return {
            ("pypi", p["name"], p["version"]) for p in lock if "pypi.org" in str(p.get("source", {}).get("registry"))
        }
    return {("crates", p["name"], p["version"]) for p in lock if "crates.io-index" in str(p.get("source", ""))}


def published(pkg: tuple[str, str, str]) -> datetime | None:
    eco, name, ver = pkg
    url = {
        "npm": f"https://registry.npmjs.org/{urllib.parse.quote(name, safe='@')}",
        "pypi": f"https://pypi.org/pypi/{name}/{ver}/json",
        "crates": f"https://crates.io/api/v1/crates/{name}/{ver}",
    }[eco]
    req = urllib.request.Request(url, headers={"User-Agent": "lwp-check-security (learnwithparam.com)"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)
    stamp = {
        "npm": lambda: data["time"].get(ver),
        "pypi": lambda: min((u["upload_time_iso_8601"] for u in data["urls"]), default=None),
        "crates": lambda: data["version"]["created_at"],
    }[eco]()
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")) if stamp else None


def too_new(locks: list[str], since: str) -> list[str]:
    added = set()
    for f in locks:
        added |= packages(f, (ROOT / f).read_text()) - packages(f, git("show", f"{since}:{f}"))
    now = datetime.now(timezone.utc)
    with ThreadPoolExecutor(8) as pool:
        times = list(pool.map(published, sorted(added)))
    bad = [
        f"{e}:{n}@{v} published {t:%Y-%m-%d %H:%M}"
        for (e, n, v), t in zip(sorted(added), times)
        if t and now - t < MIN_AGE
    ]
    bad += [f"{e}:{n}@{v} has no publish time on the registry" for (e, n, v), t in zip(sorted(added), times) if not t]
    return bad


def osv(files: list[str], since: str) -> int:
    need("osv-scanner")
    locks = [f for f in files if Path(f).name in LOCKS]
    if not locks:
        return 0
    cmd = ["osv-scanner", "scan", "source", *(a for f in locks for a in ("-L", f))]
    rc = subprocess.run(cmd, cwd=ROOT).returncode
    if rc not in (0, 1):
        print(f"osv-scanner  FAIL  exit {rc}: the scan itself failed (network or a lockfile it cannot read)")
    try:
        bad = too_new(locks, since)
    except OSError as err:
        print(f"release-age  FAIL  a registry did not answer, so the age floor is unproven: {err}")
        return 1
    for b in bad:
        print(f"release-age  {b}; a version under {MIN_AGE.days} days old fails, wait or pin an older one")
    return 1 if rc or bad else 0


def squawk(files: list[str], since: str) -> int:
    need("squawk")
    sql = [f for f in files if f.endswith(".sql")]
    return subprocess.run(["squawk", "--pg-version", "16", *sql], cwd=ROOT).returncode if sql else 0


TOOLS = {"gitleaks": gitleaks, "semgrep": semgrep, "osv-scanner": osv, "squawk": squawk}


def main() -> int:
    if len(sys.argv) < 2 or any(t not in TOOLS for t in sys.argv[1].split(",")):
        print(__doc__)
        return 2
    since = base()
    files = sys.argv[2:] or changed(since)
    rc = 0
    for tool in sys.argv[1].split(","):
        if TOOLS[tool](files, since):
            print(f"security  FAIL  {tool}")
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
