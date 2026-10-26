#!/usr/bin/env python3
"""Validate repo.json against repo.schema.json; check-affected.py --audit loads it for that and for
the steps a gate command runs.

Usage:  check-repo.py [REPO_JSON]   defaults to the repo's repo.json; exits 1 on a schema miss
        check-repo.py --key KEY      print one top-level key of the repo's repo.json (empty when unset)
Why: docs/decisions/scripts.md#check-affectedpy
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

SCHEMA_PATH = Path(__file__).with_name("repo.schema.json")
# .agents/ is the agent-neutral home; .claude/ is where every repo kept it before 24 Oct 2026.
CONFIG_PATHS = (".agents/repo.json", ".claude/repo.json")


def repo_json(root: Path) -> Path | None:
    """The one place every hook and script finds a repo's config."""
    return next((root / c for c in CONFIG_PATHS if (root / c).is_file()), None)


def load_schema() -> dict | None:
    try:
        return json.loads(SCHEMA_PATH.read_text())
    except (OSError, ValueError):
        return None


# The schema is the one list of stages, in order; this copy is only for a checkout synced before it existed.
STAGES = ((load_schema() or {}).get("$defs", {}).get("stage", {}).get("enum")) or ["stop", "push", "nightly"]
TYPES = {"object": dict, "array": list, "string": str, "integer": int, "boolean": bool}


def glob_re(pattern: str) -> re.Pattern:
    """`**/` spans folders, `*` stays inside one; matched against the whole repo-relative path."""
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif pattern[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(out + "$")


def schema_errors(value, schema: dict, root: dict, at: str = "repo.json") -> list[str]:
    """The subset of JSON Schema repo.schema.json uses: $ref, type, enum, pattern, required, properties,
    additionalProperties, propertyNames, items. Enough to catch a misspelt key or an unknown stage."""
    if "$ref" in schema:
        schema = root["$defs"][schema["$ref"].rsplit("/", 1)[-1]]
    want = TYPES.get(schema.get("type", ""))
    if want and (not isinstance(value, want) or (want is int and isinstance(value, bool))):
        return [f"{at}: expected {schema['type']}"]
    if "enum" in schema and value not in schema["enum"]:
        return [f"{at}: {value!r} is not one of {schema['enum']}"]
    if "pattern" in schema and isinstance(value, str) and not re.search(schema["pattern"], value):
        return [f"{at}: {value!r} does not match {schema['pattern']}"]
    errs = []
    if isinstance(value, dict):
        props = schema.get("properties", {})
        errs += [f"{at}: missing {k}" for k in schema.get("required", []) if k not in value]
        for k, v in value.items():
            if "propertyNames" in schema:
                errs += schema_errors(k, schema["propertyNames"], root, f"{at} key")
            if k in props:
                errs += schema_errors(v, props[k], root, f"{at}.{k}")
            elif schema.get("additionalProperties") is False:
                errs.append(f"{at}: unknown key {k!r}")
            elif isinstance(schema.get("additionalProperties"), dict):
                errs += schema_errors(v, schema["additionalProperties"], root, f"{at}.{k}")
    if isinstance(value, list) and "items" in schema:
        for i, v in enumerate(value):
            errs += schema_errors(v, schema["items"], root, f"{at}[{i}]")
    return errs


NPM_STEP = re.compile(r"^npm (?:run )?(?:(?:-s|--silent) )*([\w:.-]+)(?: .*)?$")
MAKE_STEP = re.compile(r"^(?:make|\$\(MAKE\)) (?:-\S+ )*([\w.-]+)$")
BOOKKEEPING = re.compile(r"check-affected\.py --audit|gate-stamp|^echo |^true$|^:$")


def make_rule(root: Path, target: str) -> tuple[list[str], list[str]]:
    """A Makefile target's prerequisites and recipe lines (`@`/`-` and continuations folded)."""
    try:
        lines = (root / "Makefile").read_text().replace("\\\n", " ").splitlines()
    except OSError:
        return [], []
    for i, line in enumerate(lines):
        head = re.match(rf"^{re.escape(target)}\s*:(?!=)(.*)$", line)
        if not head:
            continue
        recipe = []
        for r in lines[i + 1 :]:
            if not r.startswith("\t"):
                if r.strip():
                    break
                continue
            s = r.strip().lstrip("@-").strip()
            if s and not s.startswith("#"):
                recipe.append(s)
        return head.group(1).split("#")[0].split(), recipe
    return [], []


def gate_steps(root: Path, cmd: str, depth: int = 0) -> list[str]:
    """The steps a gate command runs, one level into npm scripts and make targets, bookkeeping dropped."""
    if BOOKKEEPING.search(cmd) or depth > 3:
        return []
    npm, mk = NPM_STEP.match(cmd), MAKE_STEP.match(cmd)
    if npm and depth == 0:
        try:
            body = json.loads((root / "package.json").read_text()).get("scripts", {}).get(npm.group(1), "")
        except (OSError, ValueError):
            body = ""
        return [s for part in body.split("&&") for s in gate_steps(root, part.strip(), depth + 1)] or [cmd]
    if npm:
        return [npm.group(1)]
    if mk and depth == 0:
        pre, recipe = make_rule(root, mk.group(1))
        steps = [p for p in pre if any(not BOOKKEEPING.search(r) for r in make_rule(root, p)[1])]
        work = [r for r in recipe if not BOOKKEEPING.search(r)]
        if not steps and len(work) == 1 and NPM_STEP.match(work[0]):
            return gate_steps(root, work[0])
        return steps + [s for r in recipe for s in gate_steps(root, r, depth + 1)]
    if mk:
        return [mk.group(1)]
    return [cmd]


def uncovered_steps(root: Path, cfg: dict) -> tuple[list[str], list[str]]:
    """Gate steps no check runs, `covers` or `fullOnly` names; and `fullOnly` entries the gate no longer runs."""
    impact = cfg["impact"]
    steps = gate_steps(root, cfg.get("gate", "make check"))
    said = " ".join(f"{c['run']} {c.get('scoped', '')}" for c in impact["checks"])
    named = {n for c in impact["checks"] for n in c.get("covers", [])} | set(impact.get("fullOnly", []))
    token = lambda s: re.search(rf"(?<![\w:.-]){re.escape(s)}(?![\w:.-])", said)
    missing = [s for s in steps if s not in named and not token(s)]
    return missing, [s for s in impact.get("fullOnly", []) if s not in steps]


def context_errors(root: Path) -> list[str]:
    """AGENTS.md is the one brief every agent reads; CLAUDE.md only imports it, so the two cannot drift."""
    errs = [] if (root / "AGENTS.md").is_file() else ["no AGENTS.md at the root; every agent but one starts blind"]
    claude = root / "CLAUDE.md"
    # A CLAUDE.md symlinked to AGENTS.md is the same brief (ops did this, 25 Oct 2026).
    same = claude.is_symlink() and claude.resolve() == (root / "AGENTS.md").resolve()
    if claude.is_file() and not same and "@AGENTS.md" not in claude.read_text().split():
        errs.append("CLAUDE.md does not import @AGENTS.md, so it is a second brief")
    if all((root / c).is_file() for c in CONFIG_PATHS):
        errs.append(f"both {' and '.join(CONFIG_PATHS)} exist; keep {CONFIG_PATHS[0]}")
    return errs


# sync-vendored.py writes this as every repo's .githooks/pre-push, so the push gate lives in the kit alone.
HOOK_STUB = '#!/bin/sh\n# Written by the kaas kit (scripts/sync-vendored.py); the gate is scripts/kaas/pre-push.sh.\nexec scripts/kaas/pre-push.sh "$@"\n'


def hook_errors(root: Path) -> list[str]:
    """A hand-written hook drifted in five repos before the kit owned it (25 Oct 2026); CI clones never set
    core.hooksPath, so that half is only asked of a checkout someone pushes from."""
    hook = root / ".githooks/pre-push"
    errs = (
        []
        if hook.is_file() and hook.read_text() == HOOK_STUB
        else [
            ".githooks/pre-push is not the kit's stub; run the kaas kit's scripts/sync-vendored.py on this repo "
            "and move any extra push step into repo.json prePush"
        ]
    )
    if not os.environ.get("CI"):
        path = subprocess.run(["git", "config", "core.hooksPath"], cwd=root, capture_output=True, text=True)
        if path.stdout.strip() != ".githooks":
            errs.append("core.hooksPath is not .githooks, so git never runs the push gate; run sync-vendored.py")
    return errs


# The runs-on prefix each ci.runner means; GitHub-hosted minutes are free only for public repos.
RUNNERS = {"github": "ubuntu-", "ubicloud": "ubicloud-"}


# Runners that bill per started minute, per job. A paid job never runs on every commit, and is capped: per-run
# (a pull request, by hand) at 3 minutes, scheduled at 9. 25 Oct 2026: shards on every push spent 464 minutes.
PAID = ("ubicloud-", "self-hosted")
CAP = {"run": 3, "schedule": 9}
# Ubicloud bills only the owners listed here, on its smallest machine; every other owner runs on GitHub. 25 Oct 2026 billed premium at 1.7x standard. Why: docs/decisions/scripts.md.
UBICLOUD = "ubicloud-standard-2"
# An empty set leaves the runner to each repo.
UBICLOUD_OWNERS: set[str] = set()
UBICLOUD_OWNERS |= {"param-harrison", "learnwithparam", "kaas-team"}  # kaas:private


def owner(root: Path) -> str:
    url = subprocess.run(["git", "remote", "get-url", "origin"], cwd=root, capture_output=True, text=True).stdout
    m = re.search(r"github\.com[:/]([^/]+)/", url)
    return m.group(1).lower() if m else ""


def spend_errors(flows: dict[str, str], own: str = "") -> list[str]:
    errs = []
    for name, text in flows.items():
        head, _, body = text.partition("\njobs:\n")
        scheduled = bool(re.search(r"(?m)^  schedule:", head))
        cap = CAP["schedule" if scheduled else "run"]
        jobs = re.findall(r"(?m)^  ([\w-]+):\n((?:    .*\n|[ \t]*\n)*)", body + "\n")
        paid = [
            (j, b) for j, b in jobs if any(k in (re.search(r"(?m)^    runs-on:(.*)$", b) or ["", " "])[1] for k in PAID)
        ]
        if paid and re.search(r"(?m)^  push:", head):
            errs.append(f"{name}: runs on a paid runner on every push; trigger it on pull_request or schedule")
        for job, b in jobs:
            on = (re.search(r"(?m)^    runs-on:\s*(\S+)", b) or ["", ""])[1]
            if on.startswith("ubicloud-") and on != UBICLOUD:
                errs.append(f"{name}: job {job} runs on {on}; Ubicloud jobs run on {UBICLOUD}, the cheapest machine")
            if on.startswith("ubicloud-") and own and UBICLOUD_OWNERS and own not in UBICLOUD_OWNERS:
                errs.append(f"{name}: job {job} runs on Ubicloud, but {own} repos run on GitHub's runners")
        for job, b in paid:
            t = re.search(r"(?m)^    timeout-minutes:\s*(\d+)\s*$", b)
            if not t or int(t.group(1)) > cap:
                errs.append(f"{name}: job {job} needs timeout-minutes of {cap} or less on a paid runner")
    return errs


def ci_errors(root: Path, cfg: dict) -> list[str]:
    """Branch protection requires the `push` job, so exactly one workflow has it, on ci.runner's machine, capped;
    each schedule cron in repo.json is a cron some workflow runs on, so the two cannot drift."""
    flows = {f.name: f.read_text() for f in sorted((root / ".github/workflows").glob("*.y*ml"))}
    crons = {m for t in flows.values() for m in re.findall(r"(?m)^\s*-\s*cron:\s*['\"]?([^'\"\n]+?)['\"]?\s*$", t)}
    errs = spend_errors(flows, owner(root)) + [
        f"schedule.{stage} is {cron!r}, but no workflow runs on that cron; repo.json and the workflow must agree"
        for stage, cron in sorted((cfg.get("schedule") or {}).items())
        if cron not in crons
    ]
    # kaas:private-begin
    if (root / ".lwpr.toml").exists():
        errs.append(".lwpr.toml is left over: the build box runs apps only since 25 Oct 2026; delete it")
    # kaas:private-end
    runner = (cfg.get("ci") or {}).get("runner")
    if not runner:
        return errs
    jobs = []
    for f in sorted((root / ".github/workflows").glob("*.y*ml")):
        _, _, body = f.read_text().partition("\njobs:\n")
        if m := re.search(r"(?m)^  push:\n((?:    .*\n|[ \t]*\n)*)", body):
            jobs.append((f.name, m.group(1)))
    if len(jobs) != 1:
        return errs + [
            f"ci.runner is {runner}, but {len(jobs)} workflows have a `push` job; branch protection needs one"
        ]
    name, job = jobs[0]
    on = re.search(r"(?m)^    runs-on:\s*(\S+)", job)
    if not (on and on.group(1).startswith(RUNNERS[runner])):
        errs.append(f"{name}: the push job runs on {on.group(1) if on else 'nothing'}, not the {runner} runner")
    if not re.search(r"(?m)^    timeout-minutes:\s*\d+\s*$", job):
        errs.append(f"{name}: the push job has no timeout-minutes, so a hung run bills until GitHub kills it")
    return errs


def main() -> int:
    if sys.argv[1:2] == ["--key"] and len(sys.argv) == 3:
        conf = repo_json(Path.cwd())
        print(json.loads(conf.read_text()).get(sys.argv[2], "") if conf else "")
        return 0
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else repo_json(Path.cwd()) or Path(CONFIG_PATHS[0])
    schema = load_schema()
    if schema is None:
        print(f"check-repo  FAIL  no readable {SCHEMA_PATH.name} beside this script; re-sync the kit")
        return 1
    try:
        cfg = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        print(f"check-repo  FAIL  {path}: {e}")
        return 1
    if errs := schema_errors(cfg, schema, schema):
        print(f"check-repo  FAIL  {path} breaks {SCHEMA_PATH.name}:")
        print("\n".join(f"  {e}" for e in errs[:30]))
        return 1
    if errs := ci_errors(path.resolve().parent.parent, cfg):
        print("check-repo  FAIL  " + "; ".join(errs))
        return 1
    print(f"check-repo  ok  {path} fits {SCHEMA_PATH.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
