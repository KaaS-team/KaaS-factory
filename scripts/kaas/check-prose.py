#!/usr/bin/env python3
"""Check prose against the house rules: no em/en dashes, no AI slop words.

Why: docs/decisions/scripts.md#check-prosepy
"""

import re
import subprocess
import sys
from pathlib import Path

DASHES = {"—": "em dash", "–": "en dash"}

# 🔴 NOT A SECOND LIST. These used to be hardcoded here, and they had drifted: the doc
# banned 20 phrases and this file checked 6, so fourteen of them were enforced by nothing
# and no one could see it. house_rules.py parses both lists out of house-rules.md itself,
# so the doc is the only place either is written down and adding a word arms it.
# A __pycache__ beside the vendored copy was committed in two repos and changed on every run.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from house_rules import (  # noqa: E402
    RULES_DOC,
    SLOP_WORDS,
    SLOP_PHRASES,
    SLOP_CONTEXT_OK,
    phrase_re,
)

# The kit names every banned word and dash in order to ban it, so it never checks itself.
KIT = {Path(__file__).resolve().parent, RULES_DOC.resolve()}

# A space-wrapped en dash is prose; one between two figures is a range and is fine.
# It has to allow the unit that real figures carry, because "$180K–$250K" and
# "0.15% - 0.75%" are ranges and "the plan — which" is not.
TIGHT_RANGE = re.compile(
    r"[\d%KMBkmb)]\s*–\s*[$€£]?\d"  # $180K–$250K, 0.15% – 0.75%
    r"|\d{4}\s*–\s*(?:[A-Z][a-z]{2}\b|\d{4}|[Pp]resent|[Nn]ow)"  # Mar 2022 – Oct 2025, Nov 2016 – Present
)

# Quoted spans, single or double, long enough to be a quotation rather than a term.
QUOTED = re.compile(
    r"'[^']{6,}?'"  # 'a quoted line'
    r"|\\?\"[^\"]{6,}?\\?\""  # "a quoted line", escaped or not
    r"|<q>.*?</q>"  # the tag whose whole meaning is "somebody else said this"
    r"|<blockquote[\s\S]*?</blockquote>",
    re.S,
)

# The deliberate opt-out, mirroring red-moon's `keep-the-old-prefix`. Use it only
# where the character is load-bearing, such as the grep pattern that enforces the
# rule, and say why on the same line.
ALLOW_MARKER = "prose-allow"

# Some text is not ours to rewrite. A stored job posting, a quoted salary line and an
# employer's own job title are evidence: another gate greps quotes against them, so
# editing one to satisfy a style rule falsifies the thing it was kept to prove. A repo
# declares those paths in a .prose-allow file at its root, one per line, with the reason
# on the same line, and optionally the JSON keys that hold the quoted material:
#
#   jds/**                                  verbatim job postings, quoted by validate-capstone
#   data/roles.json :cultureQuote,title     employer text; the rest of the file is still checked
#
# Naming the keys keeps the rest of the file covered, which whole-file exemptions do not.
ALLOW_FILE = ".prose-allow"


def load_allow(root: str) -> list[tuple[str, set]]:
    import fnmatch, os

    path = os.path.join(root, ALLOW_FILE)
    if not os.path.exists(path):
        return []
    rules = []
    for line in open(path, encoding="utf-8"):
        line = line.split("#")[0].strip()
        if not line:
            continue
        glob, _, rest = line.partition(":")
        # The reason lives on the same line, after the glob or after the key list, so both
        # are the FIRST whitespace-delimited token of their half.
        glob = glob.split()[0]
        keys = {k.strip() for k in rest.split()[0].split(",")} if rest.strip() else set()
        rules.append((glob, keys))
    return rules


def allowed(path: str, rules) -> tuple[bool, set]:
    import fnmatch

    for glob, keys in rules:
        if fnmatch.fnmatch(path, glob) or fnmatch.fnmatch(path, "*/" + glob):
            return True, keys
    return False, set()


def check(path: str, rules=()) -> list[str]:
    try:
        text = open(path, encoding="utf-8").read()
    except (OSError, UnicodeDecodeError) as exc:
        return [f"{path}: unreadable ({exc})"]

    skip, keys = allowed(path, rules)
    # ":slop" exempts the wordlist and nothing else, so the dash rule still applies. The
    # wordlist is a heuristic and it is wrong on a paper title ("Efficient and robust
    # approximate nearest neighbor search"), on a posting's own wording quoted back, and on
    # "leverage" used as an ordinary noun. The dash rule is mechanical and stays on.
    skip_slop = "slop" in keys
    if skip_slop:
        keys = keys - {"slop"}
    if skip and not keys and not skip_slop:
        return []
    # 🔴 A JSON FILE IS CHECKED AS VALUES, NOT AS LINES. Its structural quotes interleave
    # with the escaped quotes inside the strings, so a line-based quote scan sees neither
    # correctly: an employer sentence stored as \"...\" read as unquoted prose and the rule
    # fired on somebody else's words. Parsing gives the content on its own.
    if path.endswith(".json") and not skip:
        import json as _json

        try:
            data = _json.loads(text)
        except ValueError:
            pass
        else:
            vals = []

            def collect(node):
                if isinstance(node, str):
                    vals.append(node)
                elif isinstance(node, dict):
                    for v in node.values():
                        collect(v)
                elif isinstance(node, list):
                    for v in node:
                        collect(v)

            collect(data)
            text = "\n".join(vals)
    if skip and keys and path.endswith(".json"):
        # Blank the declared values, then check what is left. The file keeps its coverage
        # everywhere the quoted material is not.
        import json as _json

        try:
            data = _json.loads(text)
        except ValueError:
            pass
        else:
            import fnmatch

            def strip(node):
                if isinstance(node, dict):
                    return {k: ("" if any(fnmatch.fnmatch(k, g) for g in keys) else strip(v)) for k, v in node.items()}
                if isinstance(node, list):
                    return [strip(v) for v in node]
                return node

            vals = []

            def collect(node):
                if isinstance(node, str):
                    vals.append(node)
                elif isinstance(node, dict):
                    for v in node.values():
                        collect(v)
                elif isinstance(node, list):
                    for v in node:
                        collect(v)

            collect(strip(data))
            text = "\n".join(vals)

    problems = []
    for lineno, line in enumerate(text.split("\n"), 1):
        if ALLOW_MARKER in line:
            continue
        # 🔴 A DASH INSIDE A QUOTATION IS NOT OURS. Quoting a job posting, a compensation
        # line or a colleague is not writing an em dash, and rewriting the quote to satisfy
        # a style rule falsifies it. Only look at the parts of the line we wrote.
        outside = QUOTED.sub(lambda m: " " * len(m.group(0)), line)
        for char, name in DASHES.items():
            if char in outside and not (char == "–" and TIGHT_RANGE.search(line)):
                problems.append(f"{path}:{lineno}: {name}: {line.strip()[:70]}")
    # The same rule as the dashes: what somebody else wrote and we stored is not our prose.
    # And the match stays lower case, because "Realm" is a company and "realm" is slop.
    ours = QUOTED.sub(" ", text)
    for word in [] if skip_slop else SLOP_WORDS:
        # Not preceded by a hyphen: "high-leverage" is an adjective somebody else wrote,
        # and the rule is aimed at "leverage the platform".
        m = re.search(r"(?<![-\w])" + re.escape(word) + r"\b", ours)
        if not m:
            continue
        # "landscape and portrait" is the CSS term, "the AI landscape" is the slop.
        ok = SLOP_CONTEXT_OK.get(word)
        if ok and ok.search(ours[max(0, m.start() - 60) : m.end() + 60]):
            continue
        problems.append(f"{path}: slop word: {word}")
    for phrase in [] if skip_slop else SLOP_PHRASES:
        m = phrase_re(phrase).search(ours)
        if not m:
            continue
        # "Role-play as an AI agent" is a prompt; "As an AI, I cannot" is the disclaimer.
        ok = SLOP_CONTEXT_OK.get(phrase)
        if ok and ok.search(ours[max(0, m.start() - 20) : m.end() + 60]):
            continue
        problems.append(f"{path}: slop phrase: {phrase}")
    return problems


def staged_files() -> list[str]:
    out = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout
    return [f for f in out.split("\n") if f.endswith((".md", ".mdx", ".ts", ".tsx"))]


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    paths = staged_files() if args == ["--staged"] else args
    paths = [p for p in paths if not KIT & {Path(p).resolve(), Path(p).resolve().parent}]
    import os

    root = os.environ.get("PROSE_ROOT") or os.getcwd()
    rules = load_allow(root)
    problems = [p for path in paths for p in check(path, rules)]
    for problem in problems:
        print(problem, file=sys.stderr)
    print(f"check-prose: {len(paths)} file(s), {len(problems)} violation(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
