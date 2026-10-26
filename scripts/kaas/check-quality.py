#!/usr/bin/env python3
"""Readable code, held by a ratchet: comment runs, narration comments, file length, banned names.

Usage: check-quality.py [FILE...]   check the named files, or every tracked source file
       check-quality.py --update    lower quality-baseline.json to today's numbers; never adds a file
       check-quality.py --init      list every current offender in quality-baseline.json (adoption only)
Why: docs/decisions/scripts.md#check-qualitypy
"""

import fnmatch
import importlib.util
import io
import json
import re
import subprocess
import sys
import tokenize
from pathlib import Path

JS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"}
HASH = {".py", ".sh", ".bash"}
MAX_RUN, MAX_LINES = 3, 400
BASELINE = Path("quality-baseline.json")
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("check_repo", Path(__file__).resolve().with_name("check-repo.py"))
_repo = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_repo)
METRICS = {"comments", "lines", "names"}
DEFAULT_EXCLUDE = ["*.d.ts", "*.min.js", "*generated*", "scripts/kaas/*", "*/vendor/*", "*/migrations/*"]
TEST = re.compile(r"(\.test\.|\.spec\.|(^|/)(tests?|e2e|__tests__)/|(^|/)test_[^/]*\.py$)")
BANNED = re.compile(r"^(utils?|helpers?|misc|common)$|[a-z](Manager|Handler)$")
DIRECTIVE = re.compile(
    r"^(eslint|@ts-|biome-ignore|prettier-ignore|noqa|type:|pyright:|ruff:|istanbul|c8 |"
    r"/ <reference|!|-\*-|shellcheck|@vitest|@jest|fmt:|pragma)",
    re.I,
)
NARRATION = re.compile(
    r"^(step \d+\b|now,? (we|let'?s)\b|here,? we\b|this (function|method) (does|will|handles|"
    r"returns)\b|(first|next|then|finally),? we\b|(loop|iterate) (over|through)\b|"
    r"increment the\b|initiali[sz]e the\b)",
    re.I,
)
LICENSE = re.compile(r"licen[cs]e|copyright|spdx", re.I)


def js_comments(text: str) -> list[tuple[int, str, bool]]:
    """(line, text, is_api_doc) for each comment line that stands alone on its line."""
    out, i, n, line, state, start_line, block, tags = [], 0, len(text), 1, None, 0, [], False
    code_on_line = False
    while i < n:
        c, nxt = text[i], text[i + 1] if i + 1 < n else ""
        if c == "\n":
            line, code_on_line = line + 1, False
        if state in ("'", '"', "`"):
            if c == "\\":
                i += 1
            elif c == state or (c == "\n" and state != "`"):
                state = None
        elif state == "block":
            if c == "*" and nxt == "/":
                out += [(ln, t, tags) for ln, t in block if t.strip(" */")]
                state, i = None, i + 1
            elif c == "\n":
                block.append((line, ""))
            else:
                ln, t = block[-1]
                block[-1] = (ln, t + c)
                tags = tags or (c == "@" and t.strip(" *") == "")
        elif c == "/" and nxt == "/":
            end = text.find("\n", i)
            end = n if end < 0 else end
            if not code_on_line:
                out.append((line, text[i + 2 : end].strip(), False))
            i = end - 1
        elif c == "/" and nxt == "*":
            state, block, tags, start_line = "block", [(line, "")], False, line
            if code_on_line:
                state = "inline-block"
            i += 1
        elif state == "inline-block":
            if c == "*" and nxt == "/":
                state, i = None, i + 1
        elif c in "'\"`":
            state, code_on_line = c, True
        elif not c.isspace():
            code_on_line = True
        i += 1
    return [(ln, t.strip().lstrip("*").strip(), api) for ln, t, api in out]


def hash_comments(path: Path, text: str) -> list[tuple[int, str, bool]]:
    if path.suffix != ".py":
        return [
            (i, s.lstrip("#").strip(), False) for i, s in enumerate(text.splitlines(), 1) if s.lstrip().startswith("#")
        ]
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(text).readline))
    except (tokenize.TokenError, SyntaxError):
        return []
    lines = text.splitlines()
    return [
        (t.start[0], t.string.lstrip("#").strip(), False)
        for t in toks
        if t.type == tokenize.COMMENT and not lines[t.start[0] - 1][: t.start[1]].strip()
    ]


def comment_problems(path: Path, text: str) -> list[str]:
    found = js_comments(text) if path.suffix in JS else hash_comments(path, text)
    found = [(ln, t, api) for ln, t, api in found if not DIRECTIVE.match(t)]
    out, run = [], []
    for item in found + [(-9, "", False)]:
        if run and item[0] == run[-1][0] + 1:
            run.append(item)
            continue
        header = run and run[0][0] <= 2 and any(LICENSE.search(t) for _, t, _ in run)
        if len(run) > MAX_RUN and not header and not any(api for *_, api in run):
            out.append(
                f"line {run[0][0]}: {len(run)} comment lines; keep 3 or fewer, reasoning goes in docs/decisions/"
            )
        run = [item]
    out += [
        f"line {ln}: narrates what the code does (`{t[:40]}`); say why, or delete it"
        for ln, t, _ in found
        if NARRATION.match(t)
    ]
    return out


def measure(path: Path) -> dict[str, list[str]]:
    text = path.read_text(errors="replace")
    lines = text.count("\n") + (not text.endswith("\n") and bool(text))
    return {
        "comments": comment_problems(path, text),
        "lines": [f"{lines} lines; split it below {MAX_LINES}"]
        if lines > MAX_LINES and not TEST.search(path.as_posix())
        else [],
        "names": [f"`{path.stem}` says nothing about what is inside; name the concept"]
        if BANNED.search(path.stem)
        else [],
    }


def score(metric: str, found: list[str]) -> int:
    return int(found[0].split()[0]) if metric == "lines" and found else len(found)


def rel(path: Path) -> Path:
    try:
        return path.resolve().relative_to(Path.cwd().resolve())
    except ValueError:
        return path


def tracked(exclude: list[str]) -> list[Path]:
    out = subprocess.run(["git", "ls-files", "-z"], capture_output=True, text=True, check=True, timeout=60).stdout
    return [
        Path(p)
        for p in out.split("\0")
        if p and Path(p).suffix in JS | HASH and Path(p).is_file() and not any(fnmatch.fnmatch(p, g) for g in exclude)
    ]


def ours(base: dict) -> bool:
    """aeosome keeps its own quality-baseline.json (tool -> rule -> file); two ratchets must not share one file."""
    return set(base) <= METRICS and all(isinstance(v, int) for m in base.values() for v in m.values())


def main() -> int:
    args = sys.argv[1:]
    mode = args[0] if args[:1] in (["--update"], ["--init"]) else "check"
    conf = _repo.repo_json(Path.cwd())
    cfg = json.loads(conf.read_text()).get("quality", {}) if conf else {}
    exclude = DEFAULT_EXCLUDE + cfg.get("exclude", [])
    named = [Path(a) for a in args if not a.startswith("--")]
    files = [rel(p) for p in named if p.suffix in JS | HASH and p.is_file()] if named else tracked(exclude)
    files = [p for p in files if not any(fnmatch.fnmatch(p.as_posix(), g) for g in exclude)]
    base = json.loads(BASELINE.read_text()) if BASELINE.is_file() else {}
    if not ours(base):
        print(f"check-quality  skip  {BASELINE} belongs to another ratchet; it is never read or written here")
        return 0
    now = {m: {} for m in METRICS}
    fails = []
    for path in files:
        for metric, found in measure(path).items():
            key, value, allowed = path.as_posix(), score(metric, found), base.get(metric, {}).get(path.as_posix(), 0)
            if value:
                now[metric][key] = value
            if value > allowed:
                fails += ([f"{key}: {metric} grew from {allowed} to {value}"] if allowed else []) + [
                    f"{key}: {f}" for f in found
                ]
            elif value < allowed and not named:
                fails.append(
                    f"{key}: {metric} fell from {allowed} to {value}; run check-quality.py --update to lock it in"
                )
    if mode == "--update":
        now = {m: {k: v for k, v in now[m].items() if k in base.get(m, {})} for m in now}
    if mode != "check":
        BASELINE.write_text(json.dumps({m: dict(sorted(v.items())) for m, v in now.items()}, indent=2) + "\n")
        print(f"check-quality  wrote  {BASELINE} ({sum(map(len, now.values()))} entries)")
        return 0
    for f in fails:
        print(f"check-quality  FAIL  {f}")
    if not fails:
        print(
            f"check-quality  ok  {len(files)} file(s); no comment run over {MAX_RUN} lines, no narration, "
            f"no new file over {MAX_LINES} lines, no banned name, none past its baseline"
        )
    return int(bool(fails))


if __name__ == "__main__":
    sys.exit(main())
