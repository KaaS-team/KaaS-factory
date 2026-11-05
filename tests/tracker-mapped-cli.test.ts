// The same mapping over a declared CLI tool instead of an MCP server. The fake CLI keeps its issues in a file.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeMapped } from "../src/adapters/trackers/mapped";
import { makeMappedTracker } from "../src/adapters/trackers/mapped-make";
import { mappingProblems } from "../src/adapters/trackers/mapping";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const FAKE_CLI = `
const [db, cmd, ...rest] = process.argv.slice(2);
const fs = require("node:fs");
const issues = JSON.parse(fs.readFileSync(db, "utf8"));
const opt = (name) => rest[rest.indexOf("--" + name) + 1];
if (cmd === "list") {
  const label = opt("label");
  console.log(JSON.stringify({ items: issues.filter((i) => opt("project") === "ACME" && (!label || i.tags.includes(label))) }));
} else if (cmd === "get") {
  const i = issues.find((x) => x.key === "ACME-" + rest[0]);
  if (!i) { console.error("no such issue"); process.exit(2); }
  console.log(JSON.stringify(i));
} else if (cmd === "set") {
  const i = issues.find((x) => x.key === "ACME-" + rest[0]);
  Object.assign(i, { tags: opt("labels") ? opt("labels").split(",") : [], status: opt("state"), text: opt("body") });
  fs.writeFileSync(db, JSON.stringify(issues));
  console.log("{}");
} else { console.error("unknown command " + cmd); process.exit(1); }
`;

const MAPPING = {
  cli: "tracker-cli",
  calls: {
    list: { argv: ["list", "--project", "{{project}}", "--label", "{{label}}"], items: "items" },
    read: { argv: ["get", "{{number}}"] },
    update: {
      argv: ["set", "{{number}}", "--labels", "{{labels}}", "--state", "{{state}}", "--body", "{{body}}"],
    },
  },
  fields: { number: "key", title: "name", body: "text", labels: "tags", state: "status" },
  states: { open: "Open", closed: "Done" },
};
const ISSUES = [
  { key: "ACME-1", name: "first", text: "do it", tags: ["factory:ready", "bug"], status: "Open" },
  { key: "ACME-2", name: "second", text: "", tags: ["other"], status: "Open" },
  { key: "ACME-3", name: "third", text: "", tags: ["factory:ready"], status: "Done" },
];

function setup(mapping: object = MAPPING, declare = true) {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "mapped-cli-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".factory/trackers"), { recursive: true });
  const db = join(dir, "db.json");
  writeFileSync(db, JSON.stringify(ISSUES));
  writeFileSync(join(dir, "fake-cli.ts"), FAKE_CLI);
  if (declare)
    writeFileSync(
      join(dir, ".factory/cli-tools.json"),
      JSON.stringify({ tools: { "tracker-cli": { command: process.execPath, args: ["fake-cli.ts", db] } } }),
    );
  writeFileSync(join(dir, ".factory/trackers/acme.json"), JSON.stringify(mapping));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const tracker = makeMappedTracker({ kind: "mapped", mapping: "acme", project: "ACME" }, dir, env);
  return { tracker, stored: () => JSON.parse(readFileSync(db, "utf8")) as typeof ISSUES };
}

describe("a mapping that names a declared CLI tool", () => {
  test("is valid with argv calls, and refused with tool/args calls or with a server beside it", () => {
    expect(mappingProblems(MAPPING)).toEqual([]);
    const withTool = { ...MAPPING, calls: { ...MAPPING.calls, read: { tool: "get", args: {} } } };
    expect(mappingProblems(withTool).join()).toContain('calls.read: a "cli" mapping names "argv"');
    expect(mappingProblems({ ...MAPPING, server: "x" }).join()).toContain('exactly one of "server"');
  });
});

describe("the generic tracker over a fake CLI", () => {
  test("list: open issues, all or by label", async () => {
    const { tracker } = setup();
    expect((await tracker.listOpenIssues()).map((i) => i.number)).toEqual([1, 2]);
    expect((await tracker.listIssuesByLabel("", "factory:ready")).map((i) => i.number)).toEqual([1]);
  });

  test("read: one issue, and a failing command names the tool and its error", async () => {
    const { tracker } = setup();
    expect(await tracker.getIssue("", 1)).toMatchObject({ number: 1, title: "first", body: "do it" });
    await expect(tracker.getIssue("", 9)).rejects.toThrow("tracker-cli get exited 2: no such issue");
  });

  test("update: labels, state and body reach the CLI through its one update call", async () => {
    const { tracker, stored } = setup();
    await tracker.addLabels("", 2, ["factory:planning"]);
    expect(stored()[1]!.tags).toEqual(["other", "factory:planning"]);
    await tracker.editIssueBody("", 2, "new body");
    expect(stored()[1]).toMatchObject({ text: "new body", status: "Open" });
    await tracker.closeIssue("", 2);
    expect(stored()[1]!.status).toBe("Done");
    expect((await tracker.getIssue("", 2)).state).toBe("CLOSED");
  });

  test("a mapping naming a tool the repo did not declare is refused with that name", async () => {
    const { tracker } = setup(MAPPING, false);
    await expect(tracker.listOpenIssues()).rejects.toThrow('cli tool "tracker-cli" is not declared');
  });

  test("the probe reports list and read working over the CLI", async () => {
    const rows = await probeMapped(setup().tracker, true);
    expect(rows.map((r) => [r.call, r.status])).toEqual([
      ["list", "ok"],
      ["read", "ok"],
      ["update", "ok"],
    ]);
  });
});
