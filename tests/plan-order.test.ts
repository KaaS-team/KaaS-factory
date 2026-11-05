import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planOrderLines } from "../src/plan-order";
import { baseIssue } from "./harness";

const issue = (n: number, title: string, body: string, labels: string[] = []) => ({
  ...baseIssue(n, labels),
  title,
  body,
});

const graph = [
  issue(10, "Schema", "Deps: none\nMilestone: M1\n", ["factory:ready"]),
  issue(11, "API", "Deps: #10\nMilestone: M1\n", ["factory:blocked"]),
  issue(12, "UI", "Deps: #11\n", ["factory:blocked"]),
  issue(13, "Docs", "Deps: none\n", ["factory:ready"]),
  issue(14, "Deploy", "Runner: operator\n"),
  issue(15, "Loop A", "Deps: #16\n"),
  issue(16, "Loop B", "Deps: #15\n"),
  issue(17, "Unrelated", "No metadata here.\n"),
];

test("the fixture graph prints the golden order, critical path and reasons", () => {
  const golden = readFileSync(join(import.meta.dir, "fixtures", "plan-order", "graph.txt"), "utf8");
  expect(`${planOrderLines(graph).join("\n")}\n`).toBe(golden);
});
