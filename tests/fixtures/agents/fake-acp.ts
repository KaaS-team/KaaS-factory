#!/usr/bin/env bun
// A stand-in ACP server: it asks to edit before it writes any file. Allowed, it writes the stage's
// files; refused, it answers with the reply envelope, as a read-only stage must.
import { appendFileSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const stage = process.env.FACTORY_STAGE!;
const dir = process.env.FACTORY_ARTIFACT_DIR!;
const artifacts: Record<string, [object, string]> = {
  triage: [{ disposition: "proceed", type: "bug", risk: "low", done_when: "tests pass", files_expected: ["src/a.ts"], gate_level: "make check", confidence: 0.9 }, "<!-- factory:triage v1 -->\nlooks good\n"],
  plan: [{ risk: "low", revision: 1, files: ["src/a.ts"], autoApproveEligible: true }, "<!-- factory:plan v1 rev=1 -->\nplan body\n"],
  build: [{ status: "green", gate_line: "make check: 10 pass", rounds: 1 }, "<!-- factory:status v1 -->\nbuilding\n"],
  verify: [{ result: "pass", rounds: 1, findings: [] }, "<!-- factory:verdict v1 -->\npass\n"],
};
const send = (o: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);
const update = (u: object) => send({ method: "session/update", params: { sessionId: "s1", update: u } });
let promptId: number | undefined;

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    if (process.env.FAKE_ACP_EXIT) process.exit(3);
    send({ id: msg.id, result: { protocolVersion: Number(process.env.FAKE_ACP_VERSION ?? 1), agentCapabilities: {} } });
  } else if (msg.method === "session/new") send({ id: msg.id, result: { sessionId: "s1" } });
  else if (msg.method === "session/prompt" && process.argv[2]) {
    // A reply file in argv: answer with it, as a planning agent answers in its message.
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: readFileSync(process.argv[2], "utf8") } });
    send({ id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3 } } });
  } else if (msg.method === "session/prompt") {
    promptId = msg.id;
    // An agent that writes without asking, as a misbehaving one could.
    if (process.env.FAKE_ACP_SNEAK === "new") writeFileSync("sneaked.txt", "x");
    if (process.env.FAKE_ACP_SNEAK === "covered") {
      const s = statSync("notes.txt");
      writeFileSync("notes.txt", "B");
      utimesSync("notes.txt", s.atime, s.mtime);
    }
    update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "README.md", kind: "read", status: "completed" });
    send({
      id: 900,
      method: "session/request_permission",
      params: {
        sessionId: "s1",
        toolCall: { toolCallId: "t2", title: "src/a.ts", kind: "edit" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  } else if (msg.id === 900) {
    const allowed = msg.result?.outcome?.optionId === "yes";
    if (process.env.FAKE_AGENT_LOG) appendFileSync(`${process.env.FAKE_AGENT_LOG}/permissions`, `${stage}=${allowed ? "allow" : "reject"}\n`);
    const [json, comment] = artifacts[stage] ?? [{}, ""];
    if (!allowed) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ artifact: json, comment }) } });
    else if (stage === "pr") writeFileSync(`${dir}/pr-body.md`, `## Summary\nDid the thing.\nCloses #${process.env.FACTORY_ISSUE}\n`);
    else {
      if (stage === "build" && process.env.FAKE_ACP_FIX) {
        const fix = JSON.parse(readFileSync(process.env.FAKE_ACP_FIX, "utf8"));
        writeFileSync(fix.file, readFileSync(fix.file, "utf8").replace(fix.find, fix.replace));
      }
      writeFileSync(`${dir}/${stage}.json`, JSON.stringify(json));
      writeFileSync(`${dir}/${stage === "build" ? "status-comment.md" : `${stage}-comment.md`}`, comment);
    }
    send({ id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 10, cachedReadTokens: 40, totalTokens: 150 } } });
  }
});
