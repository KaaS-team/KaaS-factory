// The factory as an MCP server: an agent speaking JSON-RPC on stdio starts, reads and approves
// tasks, and each write lands on the tracker as the same signed command a human would post.
import { describe, expect, test } from "bun:test";
import { parseChatOps } from "../src/chatops";
import { LABEL } from "../src/labels";
import { createMcpServer, serveStdio } from "../src/mcp-server";
import { TrackerGitHub } from "./remote-plane";

type Result = { capabilities?: unknown; tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean };
type Reply = { id: number; result?: Result; error?: { code: number } };

function lines(msgs: readonly object[]): ReadableStream<Uint8Array> {
  const text = `${msgs.map((m) => JSON.stringify(m)).join("\n")}\n`;
  return new Response(text).body!;
}

describe("factory mcp", () => {
  test("an agent on stdio starts, reads and approves a task, signed on the tracker", async () => {
    const github = new TrackerGitHub();
    github.labels[9] = LABEL.awaitingApproval;
    const server = createMcpServer({ github, repo: "acme/widgets", by: "@ana" });
    const out: string[] = [];
    const call = (id: number, name: string, args: object) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    await serveStdio(
      server,
      lines([
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        call(3, "start_task", { title: "Add CSV export", body: "for the reports page" }),
        call(4, "read_task", { issue: 9 }),
        call(5, "approve_plan", { issue: 9 }),
        call(6, "approve_plan", { issue: 12 }),
        { jsonrpc: "2.0", id: 7, method: "nope" },
      ]),
      (l) => out.push(l),
    );
    const replies = out.map((l) => JSON.parse(l) as Reply);
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(replies[0]!.result!.capabilities).toEqual({ tools: {} });
    expect(replies[1]!.result!.tools!.map((t) => t.name)).toEqual([
      "list_tasks",
      "read_task",
      "start_task",
      "approve_plan",
    ]);

    expect(github.created).toEqual([
      { title: "Add CSV export", body: expect.stringContaining("@ana"), labels: [LABEL.ready] },
    ]);
    expect(JSON.parse(replies[3]!.result!.content![0]!.text)).toMatchObject({
      issue: 9,
      labels: [LABEL.awaitingApproval],
    });

    expect(github.posted).toHaveLength(1);
    expect(github.posted[0]!.issue).toBe(9);
    expect(github.posted[0]!.body).toContain("@ana");
    expect(parseChatOps(github.posted[0]!.body).type).toBe("approve");
    expect(replies[5]!.result!.isError).toBe(true);
    expect(replies[6]!.error!.code).toBe(-32601);
  });
});
