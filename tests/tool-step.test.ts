// A `tool` step calls one MCP tool with no agent: the runner speaks MCP over stdio to the server
// .factory/mcp.json names, and a `report` step ends the workflow without a PR.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflowText } from "../src/engine/workflows";
import { toolEnv } from "../src/mcp-call";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(() => {
  delete process.env.GH_TOKEN;
  delete process.env.SECRET_FIXTURE;
  removeEngineDirs();
});

// A stdio MCP server: answers initialize, then records the tools/call it gets and echoes it back.
const SERVER = `
const out = process.argv[2];
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (msg.method === "initialize")
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "kb", version: "1" } } }));
    if (msg.method === "tools/call") {
      await Bun.write(out, JSON.stringify({ ...msg.params, env: Object.keys(process.env).filter((k) => k.endsWith("TOKEN") || k === "SECRET_FIXTURE") }));
      const fail = msg.params.arguments.q === "fail";
      console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { isError: fail, content: [{ type: "text", text: "found " + msg.params.arguments.q }] } }));
    }
  }
}
`;

const WORKFLOW = (q: string) => `
name: lookup
steps:
  lookup:
    uses: tool
    label: factory:looking-up
    tool: kb/search
    env: [CALL_LOG, GH_TOKEN]
    retries: 1
    with: { q: "${q}" }
    next: done
  done:
    uses: report
    label: factory:reporting
`;

function run(q: string) {
  const parsed = parseWorkflowText(WORKFLOW(q));
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  const base = {
    "server.ts": SERVER,
    ".factory/mcp.json": JSON.stringify({
      mcpServers: { kb: { command: process.execPath, args: ["server.ts", "${CALL_LOG}"] } },
    }),
  };
  const e = engine(parsed.workflow, 0, base);
  process.env.CALL_LOG = join(e.deps.cloneDir, "call.json");
  process.env.GH_TOKEN = "gh-secret";
  process.env.SECRET_FIXTURE = "never-passed";
  return e;
}

describe("deterministic tool step", () => {
  test("a tool server never sees a runner secret, even one its step declares", () => {
    const { vars, child } = toolEnv(
      { PATH: "/bin", GH_TOKEN: "t", FACTORY_X: "f", OPENAI_API_KEY: "k", DOCS: "d", OTHER: "o" },
      ["GH_TOKEN", "OPENAI_API_KEY", "DOCS"],
      { TOKEN: "${GH_TOKEN}", URL: "${DOCS}/${OTHER}" },
    );
    expect(vars).toEqual({ DOCS: "d" });
    expect(child).toEqual({ PATH: "/bin", TOKEN: "", URL: "d/" });
  });

  test("a tool step calls one MCP tool with its arguments and no agent, then report closes the issue", async () => {
    const e = run("{{issue.title}}");
    expect(await e.run()).toBe("shipped");
    const call = JSON.parse(readFileSync(join(e.deps.cloneDir, "call.json"), "utf8"));
    expect(call).toEqual({ name: "search", arguments: { q: e.github.issues.get(1)!.title }, env: [] });
    expect(e.executor.pinned).toHaveLength(0);
    expect(e.github.closed).toContain(1);
    expect(e.github.createdPrs).toHaveLength(0);
  });

  test("a tool that keeps erroring parks the issue failed with its answer", async () => {
    const e = run("fail");
    expect(await e.run()).toBe("failed");
    expect(e.github.issues.get(1)!.comments.at(-1)!.body).toContain("found fail");
  });
});
