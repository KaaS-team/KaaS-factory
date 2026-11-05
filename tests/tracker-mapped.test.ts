// The generic tracker: a mapping file drives list, read and update through an MCP server, and
// `factory tools` reports which mapped calls work. The server here is a fake that keeps its issues in a file.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MappedTracker, McpTransport, probeMapped } from "../src/adapters/trackers/mapped";
import { makeMappedTracker } from "../src/adapters/trackers/mapped-make";
import { fillTemplate, mappingProblems, parseMapping } from "../src/adapters/trackers/mapping";
import { configProblems } from "../src/config";
import { makeTracker } from "../src/scm";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SERVER = `
const db = process.argv[2];
const read = () => JSON.parse(require("node:fs").readFileSync(db, "utf8"));
const answer = (id, text, isError = false) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { isError, content: [{ type: "text", text }] } }));
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (msg.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }));
    if (msg.method !== "tools/call") continue;
    const { name, arguments: a } = msg.params;
    const issues = read();
    if (name === "search") answer(msg.id, JSON.stringify({ data: { items: issues.filter((i) => (!a.label || i.tags.includes(a.label)) && a.project === "ACME") } }));
    else if (name === "fetch") {
      const i = issues.find((x) => x.key === "ACME-" + a.id);
      i ? answer(msg.id, JSON.stringify(i)) : answer(msg.id, "no such issue", true);
    } else if (name === "patch") {
      const i = issues.find((x) => x.key === "ACME-" + a.id);
      Object.assign(i, { tags: a.labels, status: a.state, text: a.body });
      require("node:fs").writeFileSync(db, JSON.stringify(issues));
      answer(msg.id, "{}");
    } else answer(msg.id, "unknown tool " + name, true);
  }
}
`;

const MAPPING = {
  server: "tracker",
  env: ["FAKE_DB"],
  calls: {
    list: { tool: "search", args: { project: "{{project}}", label: "{{label}}" }, items: "data.items" },
    read: { tool: "fetch", args: { id: "{{number}}" } },
    update: { tool: "patch", args: { id: "{{number}}", labels: "{{labels}}", state: "{{state}}", body: "{{body}}" } },
  },
  fields: { number: "key", title: "name", body: "text", labels: "tags", state: "status" },
  states: { open: "Open", closed: "Done" },
};
const ISSUES = [
  { key: "ACME-1", name: "first", text: "do it", tags: ["factory:ready", "bug"], status: "Open" },
  { key: "ACME-2", name: "second", text: "", tags: ["other"], status: "Open" },
  { key: "ACME-3", name: "third", text: "", tags: ["factory:ready"], status: "Done" },
];

// A repo checkout with the fake server, its mcp.json and the mapping, and the tracker built from them.
function setup(mapping: object = MAPPING) {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "mapped-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".factory/trackers"), { recursive: true });
  const db = join(dir, "db.json");
  writeFileSync(db, JSON.stringify(ISSUES));
  writeFileSync(join(dir, "server.ts"), SERVER);
  writeFileSync(
    join(dir, ".factory/mcp.json"),
    JSON.stringify({ mcpServers: { tracker: { command: process.execPath, args: ["server.ts", "${FAKE_DB}"] } } }),
  );
  writeFileSync(join(dir, ".factory/trackers/acme.json"), JSON.stringify(mapping));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_DB: db };
  const transport = new McpTransport(dir, "tracker", env, ["FAKE_DB"]);
  const tracker = new MappedTracker(parseMapping(mapping), transport, "ACME");
  return { dir, db, env, tracker, stored: () => JSON.parse(readFileSync(db, "utf8")) as typeof ISSUES };
}

describe("a mapping file", () => {
  test("says how to list, read and update, and a missing call is named", () => {
    expect(mappingProblems(MAPPING)).toEqual([]);
    const { update: _, ...calls } = MAPPING.calls;
    expect(mappingProblems({ ...MAPPING, calls })).toContain("calls.update: required");
  });

  test("names one transport and the call shape that transport needs", () => {
    expect(mappingProblems({ ...MAPPING, cli: "x" }).join()).toContain('exactly one of "server"');
    expect(mappingProblems({ ...MAPPING, server: undefined, cli: "x" }).join()).toContain(
      'a "cli" mapping names "argv"',
    );
    expect(mappingProblems({ ...MAPPING, fields: { number: "key" } }).join()).toContain("fields.title: required");
  });

  test("fills a whole-string template with the value itself and others with its text", () => {
    expect(
      fillTemplate({ a: "{{labels}}", b: "id-{{number}}", c: ["{{number}}"] }, { labels: ["x"], number: 4 }),
    ).toEqual({
      a: ["x"],
      b: "id-4",
      c: [4],
    });
  });

  test("ships examples for three trackers, each valid", () => {
    const dir = join(import.meta.dir, "..", "docs", "tracker-mappings");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual(["jira.json", "linear.json", "plane.json"]);
    for (const f of files) expect(mappingProblems(JSON.parse(readFileSync(join(dir, f), "utf8")))).toEqual([]);
  });
});

describe("the generic tracker over a fake MCP server", () => {
  test("list: open issues, all or by label, in the mapped shape", async () => {
    const { tracker } = setup();
    const open = await tracker.listOpenIssues();
    expect(open.map((i) => i.number)).toEqual([1, 2]);
    expect(open[0]).toMatchObject({
      title: "first",
      body: "do it",
      state: "OPEN",
      labels: [{ name: "factory:ready" }, { name: "bug" }],
    });
    expect((await tracker.listIssuesByLabel("", "factory:ready")).map((i) => i.number)).toEqual([1]);
  });

  test("read: one issue by number, and a server error names the call", async () => {
    const { tracker } = setup();
    expect(await tracker.getIssue("", 2)).toMatchObject({ number: 2, title: "second" });
    await expect(tracker.getIssue("", 9)).rejects.toThrow("tracker/fetch returned an error: no such issue");
  });

  test("update: labels, state and body reach the server through the one update call", async () => {
    const { tracker, stored } = setup();
    await tracker.addLabels("", 2, ["factory:planning"]);
    expect(stored()[1]!.tags).toEqual(["other", "factory:planning"]);
    await tracker.setStateLabel("", 2, ["factory:planning"], "factory:building");
    expect(stored()[1]!.tags).toEqual(["other", "factory:building"]);
    await tracker.removeLabels("", 2, ["other"]);
    expect(stored()[1]!.tags).toEqual(["factory:building"]);
    await tracker.editIssueBody("", 2, "new body");
    expect(stored()[1]).toMatchObject({ text: "new body", status: "Open" });
    await tracker.closeIssue("", 2);
    expect(stored()[1]!.status).toBe("Done");
    expect((await tracker.getIssue("", 2)).state).toBe("CLOSED");
    await tracker.reopenIssue("", 2);
    expect(stored()[1]!.status).toBe("Open");
  });

  test("a call the mapping does not have is refused by name", async () => {
    const { tracker } = setup();
    await expect(tracker.commentIssue("", 1, "hi")).rejects.toThrow('the mapping has no "comment" call');
  });

  test("a mapped tracker config is built by makeTracker through the registry, from the repo's mapping", async () => {
    const { dir, env } = setup();
    expect(configProblems({ tracker: { kind: "mapped", mapping: "acme", project: "ACME" } })).toEqual([]);
    expect(JSON.stringify(configProblems({ tracker: { kind: "mapped" } }))).toContain("tracker.mapping: required");
    const t = makeMappedTracker({ kind: "mapped", mapping: "acme", project: "ACME" }, dir, env as never);
    expect((await t.listOpenIssues()).map((i) => i.number)).toEqual([1, 2]);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const viaRegistry = makeTracker({ kind: "mapped", mapping: "acme", project: "ACME" }, env as never);
      expect(viaRegistry).toBeInstanceOf(MappedTracker);
      expect((await viaRegistry.getIssue("", 1)).title).toBe("first");
    } finally {
      process.chdir(cwd);
    }
    expect(() => makeTracker({ kind: "nope" } as never)).toThrow('tracker.kind "nope" is not registered');
  });
});

describe("factory tools probe", () => {
  test("reports list and read working, and update only when asked", async () => {
    const { tracker, stored } = setup();
    const rows = await probeMapped(tracker);
    expect(rows.map((r) => [r.call, r.status])).toEqual([
      ["list", "ok"],
      ["read", "ok"],
      ["update", "skipped"],
    ]);
    expect(stored()).toEqual(ISSUES);
    const written = await probeMapped(tracker, true);
    expect(written.find((r) => r.call === "update")!.status).toBe("ok");
    expect(stored()).toEqual(ISSUES);
  });

  test("names the call that fails and still reports the others", async () => {
    const bad = { ...MAPPING, calls: { ...MAPPING.calls, update: { tool: "missing", args: {} } } };
    const { tracker } = setup(bad);
    const rows = await probeMapped(tracker, true);
    expect(rows.map((r) => [r.call, r.status])).toEqual([
      ["list", "ok"],
      ["read", "ok"],
      ["update", "failed"],
    ]);
    expect(rows[2]!.detail).toContain("unknown tool missing");
  });

  test("the command prints each call and exits 4 when one fails", async () => {
    const { dir, env } = setup({ ...MAPPING, calls: { ...MAPPING.calls, read: { tool: "missing", args: {} } } });
    writeFileSync(
      join(dir, ".factory/config.json"),
      JSON.stringify({ repo: "acme/x", tracker: { kind: "mapped", mapping: "acme", project: "ACME" } }),
    );
    const run = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "..", "bin", "factory"), "tools", "--repo-dir", dir],
      {
        env: { ...env, FACTORY_HOME: join(dir, "home") } as Record<string, string>,
        cwd: dir,
      },
    );
    const out = run.stdout.toString();
    expect(out).toMatch(/list\s+ok\s+2 open issue/);
    expect(out).toMatch(/read\s+failed\s+tracker\/missing returned an error/);
    expect(out).toMatch(/update\s+skipped/);
    expect(run.exitCode).toBe(4);
  });
});
