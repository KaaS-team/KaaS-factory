#!/usr/bin/env python3
"""The one resolver for the mechanizable LWP house rules.

  python3 house_rules.py FILE [FILE...]        exits 1 on any violation
  python3 house_rules.py --json FILE           machine-readable
  python3 house_rules.py --rules               print what was parsed, and stop
  python3 house_rules.py --terms FILE [FILE...]   also Rule 12, the standard-term glossary (decks and scenes)
  python3 house_rules.py --vendor              the word and phrase lists and Rule 11 ceilings a repo commits, and stop

WHY THIS EXISTS

`house-rules.md` banned 20 phrases. `check-prose.py` checked 6. Fourteen of them were
enforced by nothing, and nobody could see that, because the doc and the gate were two
independent lists that had to be kept in step by hand. Rules 1, 2, 6 and 7 had no
executable enforcement at all.

So the lists are not restated here. They are PARSED OUT OF `house-rules.md` at import
time. Adding a word to the doc arms it in the same edit, and the two cannot disagree
because there is only one of them. If the doc's shape changes so the parse returns
nothing, that is a hard error rather than a silently empty rule: an empty subject is how
a check passes for the wrong reason.

WHAT IT CHECKS, AND WHAT IT REFUSES TO

  Rule 1  counts in narrative copy         auto
  Rule 2  positional references            auto
  Rule 3  em/en dashes                     auto   (check-prose.py owns the file-level
                                                   machinery for this one; see below)
  Rule 4  **bold** in JSX-bound strings    auto
  Rule 5  AI slop words and phrases        auto
  Rule 6  generic claims                   auto
  Rule 7  sentence case                    auto
  Rule 8  links resolve                    NOT HERE. link_health.py already does it.
  Rule 9  clarity beats cleverness         model-judged, and declared as such
  Rule 10 simple English                   model-judged, and declared as such, except its
                                           `**Banned idioms**` list, which fails with --voice
  Rule 11 one idea per sentence            auto, ONLY with --voice. It is not in CHECKS: the
                                           ceilings fail 102 of 136 blog files and all 15
                                           vault notebooks today, and score_landing.py and
                                           check-prose.py import this module.

  Rule 12 name a thing by its standard   auto, ONLY with --terms. The banned paraphrases are the
          term, never a paraphrase          `- **term**: not "a", "b"` lines under Rule 12, parsed like the
                                           slop lists. They are about slides and drawings, so a blog that
                                           says "a folder" must not fail: it is opt-in, like --voice.

Rules 9 and 10 are the two a regex would get wrong in the expensive direction: it would
either pass every clever headline or fail every good one. They are reported as
`model-judged` so they can never quietly count as clean.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from html import unescape
from pathlib import Path

# Beside the script when a repo vendors it into scripts/kaas/; one level up inside the plugin.
_HERE = Path(__file__).resolve().parent
RULES_DOC = next(
    (d / "house-rules.md" for d in (_HERE, _HERE.parent) if (d / "house-rules.md").is_file()),
    _HERE.parent / "house-rules.md",
)


# --------------------------------------------------------------------------- parsing


def _bullet_list(body: str, label: str) -> list[str]:
    """The `**Banned words**: a, b, c` line under Rule 5, as a list."""
    m = re.search(rf"\*\*{re.escape(label)}\*\*:\s*(.+)", body)
    if not m:
        return []
    items = []
    for raw in m.group(1).split(","):
        item = raw.strip().strip('"').strip("'").strip()
        if item:
            items.append(item.lower())
    return items


def _rule_body(text: str, n: int) -> str:
    """Everything under `## Rule N: ...` up to the next `## ` heading."""
    m = re.search(rf"^## Rule {n}:.*?$(.*?)(?=^## |\Z)", text, re.M | re.S)
    return m.group(1) if m else ""


def _allowlist(text: str) -> set[str]:
    """Rule 7's capitalization allowlist: proper nouns, acronyms, lowercase tool names."""
    body = _rule_body(text, 7)
    out: set[str] = set()
    for label in ("Proper nouns and brands", "Acronyms", "Intentionally lowercase tool names"):
        m = re.search(rf"\*\*{re.escape(label)}\*\*:\s*(.+)", body)
        if not m:
            continue
        for raw in m.group(1).split(","):
            # "HTTP(S)" is written as one entry and means two.
            item = raw.strip().rstrip(".").strip()
            if not item:
                continue
            out.add(item)
            if "(" in item:
                out.add(item.replace("(", "").replace(")", ""))
                out.add(re.sub(r"\(.*?\)", "", item))
    return {w.strip() for w in out if w.strip()}


def _ceiling(body: str, label: str) -> int:
    """The `**Words per sentence**: 28` line under Rule 11, as an int. 0 means not found."""
    m = re.search(rf"\*\*{re.escape(label)}\*\*:\s*(\d+)", body)
    return int(m.group(1)) if m else 0


def _terms(text: str) -> dict[str, list[str]]:
    """Rule 12's `- **worktree**: not "own folder", "its own folder"` lines, as {term: [banned phrase]}."""
    out: dict[str, list[str]] = {}
    for m in re.finditer(r"^- \*\*([^*]+)\*\*: not (.+)$", _rule_body(text, 12), re.M):
        out[m.group(1).strip().lower()] = [p.lower() for p in re.findall(r'"([^"]+)"', m.group(2))]
    return out


def load_rules(path: Path = RULES_DOC) -> dict:
    """Parse house-rules.md. An empty result is an error, never an empty rule."""
    text = path.read_text(encoding="utf-8")
    rule5 = _rule_body(text, 5)
    rule11 = _rule_body(text, 11)
    parsed = {
        "slop_words": _bullet_list(rule5, "Banned words"),
        "slop_phrases": _bullet_list(rule5, "Banned phrases"),
        "allowlist": _allowlist(text),
        "max_words": _ceiling(rule11, "Words per sentence"),
        "max_sentences": _ceiling(rule11, "Sentences per paragraph"),
        "terms": _terms(text),
        "idioms": _bullet_list(_rule_body(text, 10), "Banned idioms"),
    }
    empty = [k for k, v in parsed.items() if not v]
    if empty:
        raise SystemExit(
            f"house_rules: parsed nothing for {', '.join(empty)} from {path}.\n"
            f"The doc's shape changed. Fix the parser rather than shipping an empty rule: "
            f"a check with no subject passes everything."
        )
    return parsed


RULES = load_rules()
SLOP_WORDS: list[str] = RULES["slop_words"]
SLOP_PHRASES: list[str] = RULES["slop_phrases"]
ALLOWLIST: set[str] = RULES["allowlist"]
MAX_WORDS: int = RULES["max_words"]
MAX_SENTENCES: int = RULES["max_sentences"]
TERMS: dict[str, list[str]] = RULES["terms"]
IDIOMS: list[str] = RULES["idioms"]


# ----------------------------------------------------------------------------- checks
# Every regex here is deliberately narrow, and three rules that LOOK mechanizable are not.
#
# The first draft of this file fired 21 times on one real course.ts and every single hit
# was wrong: `// MODULE 1:` is a code comment, "a pipeline that takes 10 seconds" is a
# latency fact, "hoping for the best" is an idiom, "Return to top" is a scroll target, and
# "retrieves the right chunks for one question" is ordinary English. A gate like that earns
# an allowlist entry per firing until it means nothing, which is exactly why
# `audit-blog.ts` ships its sentence-case row as `needs-model-review`.
#
# So the scope was cut until the false-positive rate on real content reached zero. What is
# left is smaller and true. Rule 6 moved to model-judged, and Rule 1 kept only the nouns
# that do not occur in technical prose.

FENCE = re.compile(r"```.*?```", re.S)
LINE_COMMENT = re.compile(r"(?m)^\s*//.*$|(?<=\s)//\s.*$")
BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
# 🔴 MULTI-LINE, NOT JUST INLINE. A course.ts carries whole Python files inside TS
# template literals. A single-line backtick regex left them in, so `schema(**raw_args)`
# read as markdown bold and a `# 2. The Rooted Table` Python comment read as a heading.
# Eleven of the fourteen remaining false positives came from this one gap.
INLINE_CODE = re.compile(r"`(?:[^`\\]|\\.)*`", re.S)


# 🔴 THE BIG ONE. A course.ts stores whole Python files as SINGLE-QUOTED TS STRINGS with
# literal backslash-n escapes, not as template literals and not as markdown fences. So the
# blob sits on one physical line and every code-stripping regex above walks straight past
# it. That is where eleven of the last fourteen false positives came from: `schema(**raw_args)`
# read as markdown bold, and a `# 2. The Rooted Table` Python comment read as a heading.
# A quoted span carrying a literal \n escape is a code blob by construction; a JSX prop is not.
ESCAPED_BLOB = re.compile(r"""(['"])(?:(?!\1)[^\\]|\\.)*?\\n(?:(?!\1)[^\\]|\\.)*?\1""")


def strip_code(text: str) -> str:
    """Comments and code are not content. Rules 1 and 2 apply to what a reader sees."""
    for pat in (FENCE, BLOCK_COMMENT, LINE_COMMENT, INLINE_CODE, ESCAPED_BLOB):
        text = pat.sub(" ", text)
    return text


# Rule 1. Inventory nouns only. `seconds`, `minutes`, `questions`, `steps` and `examples`
# were all in the first draft and all of them appear constantly in correct technical
# writing, so they are gone. What is left is the vocabulary of a curriculum brochure.
# Split, because Rule 1 exempts "structured lists where the count refers to real
# enumerated items that appear on the same page". That exemption covers exactly the
# rhetorical nouns: "Two reasons. First, ... Second, ..." is the sanctioned shape, and
# telling it apart from "two big wins" needs the following paragraph read. The inventory
# nouns have no such exemption, so only they are checked here.
COUNT_NOUNS = r"modules?|tutorials?|lessons?|chapters?|courses?|videos?"
RHETORICAL_NOUNS = "things, ways, reasons, mistakes, tips, takeaways, wins"
# Cut after measuring: `slots?` matched "slot proposal" and "the other 499 seats" is a
# concurrency quiz. They are real Rule 1 nouns in cohort copy ("Ten seats") and ordinary
# words everywhere else, so they cost more than they caught.
AMBIGUOUS_NOUNS = "seats, spots, slots, weeks, articles, posts"
# "one" is dropped: "one question", "one way", "one thing" are ordinary English, not
# inventory. Spelled numbers must also take a PLURAL noun, which "one" never does.
SPELLED = r"two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen"
# (?<![\d,.$]) so the tail of "10,000 seats" and "$499 seats" does not match.
RULE1 = re.compile(rf"(?<![\d,.$])\b(?:\d{{1,3}}\+?|{SPELLED})\s+(?:{COUNT_NOUNS})\b", re.I)

# Rule 2. Positional references, in rendered content only (strip_code runs first).
RULE2 = re.compile(
    r"\b(?:module|lesson|chapter|part|slide|section)\s+\d+\b"
    r"|\b(?:next|previous|prior|last|first|final)\s+"
    r"(?:module|lesson|chapter|part|slide|section|page)\b"
    r"|\b(?:module|lesson|chapter|part|slide|section|page|step)\s+\d+\s+of\s+\d+\b"
    r"|\bas (?:mentioned|discussed|shown) in (?:chapter|module|section|part)\b",
    re.I,
)

# Rule 4. `**bold**` inside a quoted string, which is where a JSX prop lives. Markdown
# prose in a blog body is fine, so this only fires inside quotes.
RULE4 = re.compile(r"""(['"])[^'"\n]*\*\*[^*\n]+\*\*[^'"\n]*\1""")

HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$", re.M)
WORD = re.compile(r"[A-Za-z][A-Za-z0-9'\u2019\-()]*")


def _titlecased(heading: str, allow: set) -> bool:
    """Rule 7. True when a heading looks Title Cased rather than sentence cased.

    Conservative on purpose. Only words that are capitalised, not sentence-initial, not
    directly after a colon, and not in the allowlist count. Three of them is Title Case;
    two is a pair of proper nouns the allowlist has not heard of yet.
    """
    words = WORD.findall(heading)
    if len(words) < 4:
        return False
    starts = {0}
    colon = heading.find(":")
    if colon != -1:
        starts.add(len(WORD.findall(heading[: colon + 1])))
    offenders = [
        w
        for i, w in enumerate(words)
        if i not in starts and w[:1].isupper() and not w.isupper() and w not in allow and w.rstrip(".,:;") not in allow
    ]
    return len(offenders) >= 3


# A banned word is banned as slop, not as a string. "A hero image that swaps art direction
# between landscape and portrait" is the CSS term; "the AI landscape" is the slop. Same
# spirit as check-prose.py's `(?<![-\w])` guard, which keeps "high-leverage" legal.
# Each entry is a regex that, matching near the hit, means the word is being used properly.
SLOP_CONTEXT_OK = {
    "landscape": re.compile(r"portrait|orientation|aspect|viewport|\bmode\b", re.I),
    # "As an AI, I cannot" is the disclaimer the rule bans. "Role-play as an AI agent that
    # has access to two tools" is a prompt in a course on agents, and it is correct.
    "as an ai": re.compile(r"as an AI (?:agent|system|tool|engineer|product|feature|startup|company|model that)", re.I),
}


def _slop_words(text: str) -> list:
    hits = []
    for w in SLOP_WORDS:
        m = re.search(r"(?<![-\w])" + re.escape(w) + r"\b", text, re.I)
        if not m:
            continue
        ok = SLOP_CONTEXT_OK.get(w)
        if ok and ok.search(text[max(0, m.start() - 60) : m.end() + 60]):
            continue
        hits.append(w)
    return hits


def phrase_re(p: str):
    """Word-boundary anchored, whitespace-flexible. `in` matched 'has an AI' as 'as an AI'."""
    return re.compile(r"\b" + re.escape(p).replace(r"\ ", r"\s+") + r"\b", re.I)


def _slop_phrases(text: str) -> list:
    hits = []
    for p in SLOP_PHRASES:
        m = phrase_re(p).search(text)
        if not m:
            continue
        ok = SLOP_CONTEXT_OK.get(p)
        if ok and ok.search(text[max(0, m.start() - 20) : m.end() + 60]):
            continue
        hits.append(p)
    return hits


CHECKS = [
    ("rule1", "counts in narrative copy", lambda t, c, a: [m.group(0) for m in RULE1.finditer(c)]),
    ("rule2", "positional references", lambda t, c, a: [m.group(0) for m in RULE2.finditer(c)]),
    ("rule4", "bold markdown in a quoted string", lambda t, c, a: [m.group(0)[:60] for m in RULE4.finditer(t)]),
    ("rule5w", "AI slop word", lambda t, c, a: _slop_words(c)),
    # 🔴 WORD BOUNDARIES, NOT `in`. A bare substring test read "has an AI-specific trap"
    # as the banned phrase "as an AI" and reported a correct sentence as slop.
    ("rule5p", "AI slop phrase", lambda t, c, a: _slop_phrases(c)),
    ("rule7", "title case heading", lambda t, c, a: [h for h in HEADING.findall(t) if _titlecased(h, a)]),
]

# Declared, not silently absent. A rule nothing checks must say so out loud, or a clean
# report reads as "all ten rules hold" when it means "the five I can do hold".
MODEL_JUDGED = {
    "rule3": "em/en dashes: check-prose.py owns this, with the quoted-span and "
    "numeric-range exemptions it already got right. Run it too.",
    "rule1b": "counts before a rhetorical noun (" + RHETORICAL_NOUNS + "): Rule 1 exempts "
    "a count whose items are enumerated on the same page, so 'Two reasons. "
    "First... Second...' is legal and 'two big wins' is not. Telling them apart "
    "needs the next paragraph read.",
    "rule1c": "counts before an ambiguous noun (" + AMBIGUOUS_NOUNS + "): each is Rule 1 "
    "vocabulary in cohort copy and an ordinary word in technical prose.",
    "rule6": "generic claims: not mechanizable. 'hoping for the best' is an idiom, "
    "'Return to top' is a scroll target and 'the top five chunks' is a "
    "retrieval fact. Matching the bare words fired on all three.",
    "rule8": "links resolve: link_health.py owns this.",
    "rule9": "clarity beats cleverness in headlines: model-judged.",
    "rule10": "simple English in body copy: model-judged.",
    "rule12b": "resolve the name: code, then deck 1, then the workbook concept index, then industry "
    "vocabulary. Only the banned paraphrases in the Rule 12 glossary are checked, with --terms.",
    "rule11b": "name the action, not the concept: model-judged, see the Rule 11 note below. "
    "The sentence and paragraph ceilings are checked, with --voice.",
}


def check_text(text: str, allow=None) -> list:
    a = ALLOWLIST if allow is None else allow
    code_free = strip_code(text)
    # Rules 4 and 7 need the raw quotes and heading markers, but not the code blobs.
    blob_free = ESCAPED_BLOB.sub(" ", INLINE_CODE.sub(" ", FENCE.sub(" ", text)))
    out = []
    for rule, label, fn in CHECKS:
        for hit in fn(blob_free, code_free, a):
            out.append({"rule": rule, "label": label, "hit": hit})
    return out


def check_file(path: str) -> list:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [{"rule": "io", "label": "unreadable", "hit": str(exc), "file": path}]
    if Path(path).suffix == ".ipynb":
        # The raw file is JSON, where every markdown line is a quoted string and rule 4 misfires.
        # The course title is the notebook's H1 and names its audience; rule 7 is for section headings.
        text = re.sub(r"^# .*$", "", _voice_source(path), flags=re.M)
    return [{**v, "file": path} for v in check_text(text)]


# ------------------------------------------------------------------- Rule 11: voice
# Opt-in through --voice and deliberately absent from CHECKS. Measured 2026-09-20 on 9,213
# website sentences and 974 vault sentences: 3.3% and 19.5% run past the ceiling, in 102 of
# 136 blog files and all 15 vault notebooks, so arming it in CHECKS would fail
# score_landing.py and every check-prose.py caller on day one.
#
# Only the ceilings are checked. A regex for "name the action, not the concept" was measured
# and dropped: a curated list of weak phrases fired 3 times in those sentences, and the
# generic `the <noun>tion of` pattern fired 48 times, nearly all on ordinary nouns such as
# "a sequence of" and "a collection of". That half stays model-judged.

LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s")
SKIP_LINE = re.compile(r"^\s*(?:#|\||>|<|!\[|\{|---)")
FRONTMATTER = re.compile(r"\A---\n.*?\n---\n", re.S)
LINK_TARGET = re.compile(r"\]\([^)]*\)")
SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'(\[])")
HTML_SKIP = re.compile(r"<(script|style|svg|pre|head)\b.*?</\1>|<!--.*?-->", re.S | re.I)
HTML_CODE = re.compile(r"<code\b[^>]*>.*?</code>", re.S | re.I)
HTML_BLOCK_END = re.compile(
    r"</(p|li|dt|dd|th|td|h[1-6]|div|section|article|tr|figure|figcaption|blockquote|ul|ol|table)>|<br\s*/?>", re.I
)
HTML_TAG = re.compile(r"<[^>]+>")


def _voice_source(path: str) -> str:
    """Markdown prose only. A notebook is its markdown cells; other file types are skipped."""
    p = Path(path)
    if p.suffix == ".ipynb":
        cells = json.loads(p.read_text(encoding="utf-8")).get("cells", [])
        return "\n\n".join("".join(c.get("source", [])) for c in cells if c.get("cell_type") == "markdown")
    if p.suffix in (".md", ".mdx"):
        return FRONTMATTER.sub("", p.read_text(encoding="utf-8"))
    if p.suffix == ".html":
        return _html_prose(p.read_text(encoding="utf-8"))
    return ""


def _html_prose(html: str) -> str:
    """A manuscript is running text between tags. Blocks that are not prose are dropped whole."""
    html = HTML_CODE.sub(
        "Code", HTML_SKIP.sub(" ", html)
    )  # inline code is one capitalised word, so a sentence that starts with it still splits
    html = HTML_BLOCK_END.sub("\n\n", html)
    return unescape(HTML_TAG.sub("", html))


def _prose_blocks(text: str):
    """Paragraphs of running prose. A list item or a heading ends the block rather than joining it."""
    text = FENCE.sub(" ", text)
    text = INLINE_CODE.sub("code", text)  # one word, so the count stays honest
    text = LINK_TARGET.sub("]", text)
    block: list[str] = []
    for line in text.split("\n"):
        if not line.strip() or SKIP_LINE.match(line) or LIST_ITEM.match(line):
            if block:
                yield " ".join(block)
                block = []
            continue
        block.append(line.strip())
    if block:
        yield " ".join(block)


def idiom_check_text(text: str) -> list:
    """Rule 10's named idioms, in prose outside code. Opt-in with --voice, like the ceilings."""
    body = strip_code(text)
    return [
        {"rule": "rule10i", "label": "idiom, say the literal point", "hit": f'"{m.group(0)}"'}
        for p in IDIOMS
        if (m := phrase_re(p).search(body))
    ]


def voice_check_text(text: str) -> list:
    out = idiom_check_text(text)
    for para in _prose_blocks(text):
        sentences = [s for s in SENTENCE_END.split(para) if s.strip()]
        if len(sentences) > MAX_SENTENCES:
            out.append(
                {
                    "rule": "rule11p",
                    "label": f"paragraph over {MAX_SENTENCES} sentences",
                    "hit": f"{len(sentences)} sentences: {para[:60]}",
                }
            )
        for s in sentences:
            n = len(s.split())
            if n > MAX_WORDS:
                out.append(
                    {"rule": "rule11w", "label": f"sentence over {MAX_WORDS} words", "hit": f"{n} words: {s[:70]}"}
                )
    return out


def voice_check_file(path: str) -> list:
    try:
        text = _voice_source(path)
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        return [{"rule": "io", "label": "unreadable", "hit": str(exc), "file": path}]
    return [{**v, "file": path} for v in voice_check_text(text)]


# ------------------------------------------------------------------ Rule 12: terms
# Opt-in through --terms, absent from CHECKS for the same reason as --voice: the glossary is
# about slides and drawings, and "a folder" is fine English in a blog post. The lists are
# parsed out of house-rules.md, so a phrase added there is armed in the same edit.


def terms_check_text(text: str) -> list:
    body = strip_code(text)
    out = []
    for term, banned in TERMS.items():
        for phrase in banned:
            m = phrase_re(phrase).search(body)
            if m:
                out.append({"rule": "rule12", "label": f'say "{term}", the standard term', "hit": f'"{m.group(0)}"'})
    return out


def terms_check_file(path: str) -> list:
    try:
        text = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [{"rule": "io", "label": "unreadable", "hit": str(exc), "file": path}]
    return [{**v, "file": path} for v in terms_check_text(text)]


def selftest() -> list:
    """Every banned phrase must fire on its own, and a standard term must pass. Run by check-skills.py."""
    problems = []
    for term, banned in TERMS.items():
        for phrase in banned:
            if not terms_check_text(f"The run gets {phrase} here."):
                problems.append(f'house_rules: Rule 12 phrase "{phrase}" (for "{term}") does not fire')
    for clean in ("Each task gets a worktree with sandbox limits.", "The Guardrails agent turns it away."):
        if terms_check_text(clean):
            problems.append(f"house_rules: Rule 12 flags a standard term: {clean}")
    for idiom in IDIOMS:
        if not idiom_check_text(f"The run {idiom} here."):
            problems.append(f'house_rules: Rule 10 idiom "{idiom}" does not fire')
    if idiom_check_text("The runner opens one tmux window per running issue."):
        problems.append("house_rules: Rule 10 flags plain English")
    for idiom in ("in flight", "tails its"):
        if idiom not in IDIOMS:
            problems.append(f'house_rules: Rule 10 lost the idiom "{idiom}"; the doc changed shape')
    # Each of these got past review once. Deleting a row would otherwise disarm it and stay green.
    for term in (
        "worktree",
        "holdout tests",
        "guardrails agent",
        "error agent",
        "cold reader",
        "triage",
        "claim",
        "human in the loop",
        "step",
    ):
        if not TERMS.get(term):
            problems.append(
                f'house_rules: Rule 12 has no banned phrases for "{term}"; a row was deleted or the doc changed shape'
            )
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("files", nargs="*")
    ap.add_argument("--json", action="store_true")
    ap.add_argument(
        "--voice",
        action="store_true",
        help="also check Rule 11 (sentence and paragraph ceilings); opt-in, see the source",
    )
    ap.add_argument(
        "--terms",
        action="store_true",
        help="also check Rule 12 (standard terms, no paraphrases); opt-in, see the source",
    )
    ap.add_argument("--selftest", action="store_true", help="prove every Rule 12 phrase fires, and stop")
    ap.add_argument("--rules", action="store_true", help="print the parsed rules and stop")
    ap.add_argument(
        "--vendor",
        action="store_true",
        help="print the word and phrase lists and Rule 11 ceilings a repo commits, and stop",
    )
    args = ap.parse_args()

    if args.rules:
        print(
            json.dumps(
                {
                    "source": str(RULES_DOC),
                    "slop_words": SLOP_WORDS,
                    "slop_phrases": SLOP_PHRASES,
                    "allowlist": sorted(ALLOWLIST),
                    "terms": TERMS,
                    "model_judged": MODEL_JUDGED,
                },
                indent=2,
            )
        )
        return 0

    if args.vendor:
        print(
            json.dumps(
                {
                    "words": SLOP_WORDS,
                    "phrases": SLOP_PHRASES,
                    "max_words": MAX_WORDS,
                    "max_sentences": MAX_SENTENCES,
                    "terms": TERMS,
                },
                indent=2,
            )
        )
        return 0

    if args.selftest:
        bad = selftest()
        for p in bad:
            print(p)
        return 1 if bad else 0

    if not args.files:
        ap.error("give at least one file, or --rules")

    problems = [p for f in args.files for p in check_file(f)]
    if args.voice:
        problems += [p for f in args.files for p in voice_check_file(f)]
    if args.terms:
        problems += [p for f in args.files for p in terms_check_file(f)]
    if args.json:
        print(json.dumps({"violations": problems, "model_judged": MODEL_JUDGED}, indent=2))
    else:
        for p in problems:
            print(f"{p['file']}: {p['label']}: {p['hit']}", file=sys.stderr)
        print(
            f"house-rules: {len(args.files)} file(s), {len(problems)} violation(s); "
            f"{len(MODEL_JUDGED)} rule(s) not machine-checkable ({', '.join(MODEL_JUDGED)})"
        )
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
