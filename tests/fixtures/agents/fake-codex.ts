#!/usr/bin/env bun
// A stand-in for `codex exec --json`: it obeys its own -s flag. Read-only, it
// answers with the reply envelope; workspace-write, it writes the files.
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const sandbox = args[args.indexOf("-s") + 1];
await Bun.stdin.text();
const stage = process.env.FACTORY_STAGE!;
const dir = process.env.FACTORY_ARTIFACT_DIR!;
if (process.env.FAKE_AGENT_LOG) appendFileSync(`${process.env.FAKE_AGENT_LOG}/sandboxes`, `${stage}=${sandbox} ${args.includes("--output-schema") ? "schema" : ""}\n`);

const artifacts: Record<string, [object, string]> = {
  triage: [{ disposition: "proceed", type: "bug", risk: "low", done_when: "tests pass", files_expected: ["src/a.ts"], gate_level: "make check", confidence: 0.9 }, "<!-- factory:triage v1 -->\nlooks good\n"],
  plan: [{ risk: "low", revision: 1, files: ["src/a.ts"], autoApproveEligible: true }, "<!-- factory:plan v1 rev=1 -->\nplan body\n"],
  build: [{ status: "green", gate_line: "make check: 10 pass", rounds: 1 }, "<!-- factory:status v1 -->\nbuilding\n"],
  verify: [{ result: "pass", rounds: 1, findings: [] }, "<!-- factory:verdict v1 -->\npass\n"],
};
const emit = (o: object) => console.log(JSON.stringify(o));
const [json, comment] = artifacts[stage] ?? [{}, ""];
if (sandbox === "read-only") {
  const reply = process.env.FAKE_BAD_REPLY ?? JSON.stringify({ artifact: json, comment });
  emit({ type: "item.completed", item: { type: "agent_message", text: reply } });
} else if (stage === "pr") {
  writeFileSync(`${dir}/pr-body.md`, `## Summary\nDid the thing.\nCloses #${process.env.FACTORY_ISSUE}\n`);
} else {
  writeFileSync(`${dir}/${stage === "build" ? "build" : stage}.json`, JSON.stringify(json));
  writeFileSync(`${dir}/${stage === "build" ? "status-comment.md" : `${stage}-comment.md`}`, comment);
}
emit({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } });
