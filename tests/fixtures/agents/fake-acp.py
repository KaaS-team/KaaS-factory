#!/usr/bin/env python3
# A second ACP stand-in, unlike fake-acp.ts in every way the protocol allows: Python, it never asks
# permission, it splits its reply across chunks, and it reports no usage. Read-only, it only replies.
import json, os, sys

stage, out = os.environ["FACTORY_STAGE"], os.environ["FACTORY_ARTIFACT_DIR"]
ARTIFACTS = {
    "triage": ({"disposition": "proceed", "type": "bug", "risk": "low", "done_when": "tests pass", "files_expected": ["src/a.ts"], "gate_level": "make check", "confidence": 0.9}, "<!-- factory:triage v1 -->\nlooks good\n"),
    "plan": ({"risk": "low", "revision": 1, "files": ["src/a.ts"], "autoApproveEligible": True}, "<!-- factory:plan v1 rev=1 -->\nplan body\n"),
    "build": ({"status": "green", "gate_line": "make check: 10 pass", "rounds": 1}, "<!-- factory:status v1 -->\nbuilding\n"),
    "verify": ({"result": "pass", "rounds": 1, "findings": []}, "<!-- factory:verdict v1 -->\npass\n"),
}


def send(o):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", **o}) + "\n")
    sys.stdout.flush()


def chunk(text):
    send({"method": "session/update", "params": {"sessionId": "py", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}})


for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"id": msg["id"], "result": {"protocolVersion": 1, "agentCapabilities": {"loadSession": False}}})
    elif method == "session/new":
        send({"id": msg["id"], "result": {"sessionId": "py"}})
    elif method == "session/prompt" and len(sys.argv) > 1:
        # A reply file in argv: answer with it, as a planning agent answers in its message.
        chunk(open(sys.argv[1]).read())
        send({"id": msg["id"], "result": {"stopReason": "end_turn"}})
    elif method == "session/prompt":
        art, comment = ARTIFACTS.get(stage, ({}, ""))
        if stage in ("triage", "plan", "verify"):
            reply = json.dumps({"artifact": art, "comment": comment})
            half = len(reply) // 2
            chunk(reply[:half])
            chunk(reply[half:])
        elif stage == "pr":
            open(f"{out}/pr-body.md", "w").write(f"## Summary\nDid the thing.\nCloses #{os.environ['FACTORY_ISSUE']}\n")
        else:
            fix = os.environ.get("FAKE_ACP_FIX")
            if fix:
                f = json.load(open(fix))
                src = open(f["file"]).read()
                open(f["file"], "w").write(src.replace(f["find"], f["replace"]))
            open(f"{out}/build.json", "w").write(json.dumps(art))
            open(f"{out}/status-comment.md", "w").write(comment)
        send({"id": msg["id"], "result": {"stopReason": "end_turn"}})
