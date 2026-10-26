#!/usr/bin/env python3
"""Security checks on what a change adds: secrets, insecure patterns, vulnerable or day-old packages, unsafe SQL.

Usage: check-security.py gitleaks              secrets in commits and edits not yet on the base branch
       check-security.py semgrep [FILE...]     scripts/kaas/semgrep.yml on the files; findings the base already had pass
       check-security.py osv-scanner [LOCK...] OSV advisories on the lockfiles, and a package version that
                                               lockfile adds which was published under 3 days ago fails
       check-security.py squawk [SQL...]       Squawk on migration SQL files
A TOOL may be a comma list. With no files a tool takes the files changed since the merge base with origin/main
(KAAS_SECURITY_BASE overrides). Exceptions, each with a reason: .gitleaksignore, `nosemgrep: rule-id` on the line,
osv-scanner.toml [[IgnoredVulns]], .agents/security-sources.txt (`npm:name # reason` for a package a lockfile takes
from git, a tarball or another registry), `-- squawk-ignore` in the SQL.
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
RULES = ROOT / "scripts/kaas/semgrep.yml"
SOURCES = ROOT / ".agents/security-sources.txt"
MIN_AGE = timedelta(days=3)
LOCKS = ("package-lock.json", "bun.lock", "uv.lock", "Cargo.lock")
INSTALL = "brew install gitleaks semgrep osv-scanner; npm i -g squawk-cli"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True).stdout


def base() -> str:
    """No fallback to HEAD: a diff against HEAD itself is empty, so every check would pass having read nothing."""
    ref = os.environ.get("KAAS_SECURITY_BASE", "origin/main")
    found = git("merge-base", "HEAD", ref).strip()
    if not found:
        sys.exit(f"security  FAIL  no merge base with {ref}; fetch it, or set KAAS_SECURITY_BASE to the base ref")
    return found


def changed(since: str) -> list[str]:
    files = git("diff", "--name-only", "--no-renames", "--diff-filter=d", since).split("\n")
    files += git("ls-files", "-o", "--exclude-standard").split("\n")
    return sorted({f for f in files if f and (ROOT / f).is_file()})


def need(tool: str) -> bool:
    """A missing scanner fails. A CI job whose runner lacks the tools opts out with KAAS_SECURITY_ALLOW_SKIP=1 in the
    workflow, since a scoped CI run reaches the stop-stage checks; the pre-push stop stage still runs them."""
    if shutil.which(tool):
        return True
    if os.environ.get("KAAS_SECURITY_ALLOW_SKIP") == "1":
        print(f"security  SKIP  {tool} is not installed, so this scan did NOT run (KAAS_SECURITY_ALLOW_SKIP=1)")
        return False
    sys.exit(f"security  FAIL  {tool} is not installed: {INSTALL}")


def gitleaks(files: list[str], since: str) -> int:
    """Commits since the base, then the uncommitted diff and new files as one patch on stdin."""
    if not need("gitleaks"):
        return 0
    flags = ["--no-banner", "--redact", "--exit-code", "1", "--log-level", "warn"]
    rc = subprocess.run(["gitleaks", "git", *flags, f"--log-opts={since}..HEAD", "."], cwd=ROOT).returncode
    # Only added lines, found by git's own marker: a removed line still holds the secret it removes, and a
    # prefix test on "+" drops an added line that itself starts with "++". The path headers stay.
    diff = git("diff", "HEAD", "--unified=0", "--no-color", "--no-ext-diff", "--output-indicator-new=>")
    keep = lambda l: l.startswith(("diff --git ", "+++ ")) or l.startswith(">")
    patch = "\n".join(l[1:] if l.startswith(">") else l for l in diff.split("\n") if keep(l))
    for f in git("ls-files", "-o", "--exclude-standard").split("\n"):
        if f and (ROOT / f).is_file():
            patch += f"\n+++ b/{f}\n" + (ROOT / f).read_text(errors="replace")
    if patch.strip():
        rc |= subprocess.run(["gitleaks", "stdin", *flags], cwd=ROOT, input=patch, text=True).returncode
    return rc


def semgrep(files: list[str], since: str) -> int:
    if not need("semgrep"):
        return 0
    if not files:
        return 0
    if not RULES.is_file():
        print(f"semgrep  FAIL  no {RULES.relative_to(ROOT)}; add it to kitExtras and re-sync the kit")
        return 1
    cmd = ["semgrep", "scan", "--config", str(RULES), "--metrics=off", "--disable-version-check", "--json", "--quiet"]
    out = subprocess.run([*cmd, "--baseline-commit", since, "--", *files], cwd=ROOT, capture_output=True, text=True)
    try:
        report = json.loads(out.stdout)
    except ValueError:
        report = None
    # A rules or parse error still exits 0 with no results: an unread file must fail, not pass.
    if out.returncode not in (0, 1) or not report or report.get("errors"):
        print(f"semgrep  FAIL  exit {out.returncode}: the scan did not complete")
        print((json.dumps(report.get("errors"))[:2000] if report else out.stdout[-2000:]), out.stderr[-2000:])
        return 1
    # No file-wide allowlist: a (rule, path) entry would hide every later finding in that file. The base's own
    # findings pass through --baseline-commit; a new false positive takes `nosemgrep: rule-id` on its line.
    new = report.get("results", [])
    rule = lambda r: r["check_id"].rsplit(".", 1)[-1]
    for r in new:
        print(f"semgrep  {r['path']}:{r['start']['line']}  {rule(r)}: {r['extra']['message'].strip()}")
    if new:
        print(
            f"semgrep  FAIL  {len(new)} finding(s). Fix it, or mark a false positive `nosemgrep: rule-id` with a reason"
        )
    return 1 if new else 0


NPM_HOSTS = {"registry.npmjs.org"}
PYPI_HOSTS = {"pypi.org", "files.pythonhosted.org"}
CRATES = {"registry+https://github.com/rust-lang/crates.io-index", "sparse+https://index.crates.io/"}


def on(url: str, hosts: set[str]) -> bool:
    """True only for a canonical https URL on one of the hosts. A parser can be fooled (a backslash, userinfo, a
    space), so the URL must start with the exact `https://host/` prefix, carry none of those characters, and parse
    with no user, password or port. A scoped npm path has `@` after the host, so `@` is refused only before it."""
    if any(c == "\\" or c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url):
        return False
    try:
        u = urllib.parse.urlsplit(url)
        port = u.port
    except ValueError:
        return False
    if "@" in u.netloc or u.username is not None or u.password is not None or port is not None:
        return False
    return any(url.startswith(f"https://{h}/") for h in hosts) and u.hostname in hosts


def pep503(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def pypi_file(url: str, name: str, version: str) -> bool:
    """The sdist or wheel at url is this project at this version, so the age looked up is the age of what installs."""
    file = urllib.parse.unquote(url.rsplit("/", 1)[-1])
    if file.endswith(".whl"):
        parts = file[:-4].split("-")
        dist, ver = (parts[0], parts[1]) if len(parts) >= 5 else ("", "")
    else:
        stem = re.sub(r"\.(tar\.gz|zip|tar\.bz2)$", "", file)
        dist, _, ver = stem.rpartition("-")
    return pep503(dist) == pep503(name) and ver.lower() == version.lower()


def packages(path: str, text: str) -> set[tuple[str, str, str, str]]:
    """(ecosystem, name, version, source) of every package a lockfile pins; source is "" for an allowed registry,
    else where it comes from. Hosts compare exactly: a substring test lets evil.com/registry.npmjs.org/ through."""
    if not text.strip():
        return set()
    name = Path(path).name
    if name == "package-lock.json":
        out = set()
        for k, v in json.loads(text).get("packages", {}).items():
            if "node_modules/" not in k or v.get("link") or v.get("inBundle"):
                continue
            # an alias (node_modules/foo installing bar) carries the real name; the tarball must be that name's
            # own, at that version, or the age looked up is another package's
            pkg, ver, res = (
                v.get("name") or k.rsplit("node_modules/", 1)[1],
                v.get("version", ""),
                v.get("resolved", ""),
            )
            own = f"https://registry.npmjs.org/{pkg}/-/{pkg.rsplit('/', 1)[-1]}-{ver}.tgz"
            src = "" if res == own and on(res, NPM_HOSTS) else res or "no resolved url"
            out.add(("npm", pkg, ver, src))
        return out
    if name == "bun.lock":
        out = set()
        rows = re.findall(r'^\s*"[^"]+": \["((?:@[^/"@]+/)?[^@"]+)@([^"]*)"(?:, "([^"]*)")?', text, re.M)
        for n, spec, reg in rows:
            if spec.startswith("workspace:"):
                continue
            ok = re.match(r"\d", spec) and (reg == "" or on(reg, NPM_HOSTS))
            out.add(("npm", n, spec, "" if ok else reg or spec))
        return out
    lock = tomllib.loads(text).get("package", [])
    if name == "uv.lock":
        out = set()
        for p in lock:
            src = p.get("source", {})
            if "editable" in src or "virtual" in src:
                continue
            # the index alone is not enough: every file the lock downloads must come from PyPI too
            files = [f.get("url", "") for f in [*([p["sdist"]] if "sdist" in p else []), *p.get("wheels", [])]]
            ok = on(str(src.get("registry", "")), PYPI_HOSTS) and all(
                on(u, PYPI_HOSTS) and pypi_file(u, p["name"], p["version"]) for u in files
            )
            out.add(("pypi", p["name"], p["version"], "" if ok else json.dumps(src, sort_keys=True)))
        return out
    # a crate with no source is the workspace's own
    return {
        ("crates", p["name"], p["version"], "" if p["source"] in CRATES else p["source"]) for p in lock if "source" in p
    }


def allowed_sources() -> set[str]:
    if not SOURCES.is_file():
        return set()
    rows = (l.split("#", 1) for l in SOURCES.read_text().splitlines())
    return {r[0].strip() for r in rows if len(r) == 2 and r[0].strip() and r[1].strip()}


def published(pkg: tuple[str, str, str]) -> datetime | None:
    eco, name, ver = pkg[:3]
    url = {
        "npm": f"https://registry.npmjs.org/{urllib.parse.quote(name, safe='@')}",
        "pypi": f"https://pypi.org/pypi/{name}/{ver}/json",
        "crates": f"https://crates.io/api/v1/crates/{name}/{ver}",
    }[eco]
    req = urllib.request.Request(url, headers={"User-Agent": "kaas-check-security"})
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
    # A package from git, a tarball or another registry has no publish time to check, so it must be named.
    allow = allowed_sources()
    bad = [
        f"{e}:{n}@{v} comes from {src}, not its registry; name `{e}:{n} # reason` in {SOURCES.name} if intended"
        for e, n, v, src in sorted(added)
        if src and f"{e}:{n}" not in allow
    ]
    reg = sorted(p[:3] for p in added if not p[3])
    now = datetime.now(timezone.utc)
    with ThreadPoolExecutor(8) as pool:
        times = list(pool.map(published, reg))
    bad += [f"{e}:{n}@{v} published {t:%Y-%m-%d %H:%M}" for (e, n, v), t in zip(reg, times) if t and now - t < MIN_AGE]
    bad += [f"{e}:{n}@{v} has no publish time on the registry" for (e, n, v), t in zip(reg, times) if not t]
    return bad


def osv(files: list[str], since: str) -> int:
    if not need("osv-scanner"):
        return 0
    locks = [f for f in files if Path(f).name in LOCKS]
    if not locks:
        return 0
    cmd = ["osv-scanner", "scan", "source", *(a for f in locks for a in ("-L", f"./{f}"))]
    rc = subprocess.run(cmd, cwd=ROOT).returncode
    if rc not in (0, 1):
        print(f"osv-scanner  FAIL  exit {rc}: the scan itself failed (network or a lockfile it cannot read)")
    try:
        bad = too_new(locks, since)
    except OSError as err:
        print(f"release-age  FAIL  a registry did not answer, so the age floor is unproven: {err}")
        return 1
    for b in bad:
        print(f"release-age  {b}")
    if bad:
        print(
            f"release-age  FAIL  {len(bad)} added package(s): each must be a registry release {MIN_AGE.days}+ days old"
        )
    return 1 if rc or bad else 0


def squawk(files: list[str], since: str) -> int:
    if not need("squawk"):
        return 0
    sql = [f for f in files if f.endswith(".sql")]
    return subprocess.run(["squawk", "--pg-version", "16", "--", *sql], cwd=ROOT).returncode if sql else 0


TOOLS = {"gitleaks": gitleaks, "semgrep": semgrep, "osv-scanner": osv, "squawk": squawk}


def main() -> int:
    if len(sys.argv) < 2 or any(t not in TOOLS for t in sys.argv[1].split(",")):
        print(__doc__)
        return 2
    if flags := [f for f in sys.argv[2:] if f.startswith("-")]:
        print(f"security  FAIL  {flags[0]} starts with '-', so a scanner would read it as an option")
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
