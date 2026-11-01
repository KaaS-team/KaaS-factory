// The changelog step kind: the pure edit, and the engine dispatching `uses: changelog`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addChangelogEntry, changelogLine } from "../src/changelog";
import { parseWorkflowText } from "../src/engine/workflows";
import { ALL_STEP_TYPES } from "../src/engine/registry";
import { engine, removeEngineDirs } from "./engine-harness";

beforeAll(() => mkdirSync(tmpdir(), { recursive: true }));
afterAll(removeEngineDirs);

describe("addChangelogEntry", () => {
  test("creates the Unreleased section under the title", () => {
    expect(addChangelogEntry("# Changelog\n", "- a (#1)", 1)).toBe("# Changelog\n\n## Unreleased\n\n- a (#1)\n");
  });
  test("puts a new line at the top of an existing section", () => {
    const text = "# Changelog\n\n## Unreleased\n\n- a (#1)\n\n## 1.0.0\n\n- old (#0)\n";
    expect(addChangelogEntry(text, "- b (#2)", 2)).toBe(
      "# Changelog\n\n## Unreleased\n\n- b (#2)\n- a (#1)\n\n## 1.0.0\n\n- old (#0)\n",
    );
  });
  test("a line for the same issue is not added twice", () => {
    const text = "# Changelog\n\n## Unreleased\n\n- a (#1)\n";
    expect(addChangelogEntry(text, "- a again (#1)", 1)).toBe(text);
  });
  test("an entry under a released version does not count", () => {
    const text = "## Unreleased\n\n## 1.0.0\n\n- a (#1)\n";
    expect(addChangelogEntry(text, "- a (#1)", 1)).toBe("## Unreleased\n\n- a (#1)\n\n## 1.0.0\n\n- a (#1)\n");
  });
});

test("the line prefers the plan goal and collapses whitespace", () => {
  expect(changelogLine(7, "Add\n  x", "title")).toBe("- Add x (#7)");
  expect(changelogLine(7, undefined, "title")).toBe("- title (#7)");
});

describe("uses: changelog in a workflow", () => {
  const wf = () => {
    const parsed = parseWorkflowText(
      "name: cl-flow\nsteps:\n  log:\n    uses: changelog\n    label: factory:logging\n    next: done\n  done:\n    uses: report\n    label: factory:reporting\n",
    );
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    return parsed.workflow;
  };
  test("is registered and the engine writes and commits CHANGELOG.md alone", async () => {
    expect(typeof ALL_STEP_TYPES.changelog?.run).toBe("function");
    const e = engine(wf(), 0);
    expect(await e.run()).toBe("shipped");
    expect(e.git.committedPaths).toEqual([["CHANGELOG.md"]]);
    expect(e.git.pushed).toEqual([1]);
    const dir = join(e.deps.workspacesDir, readdirSync(e.deps.workspacesDir)[0]!);
    expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain("(#1)");
  });
});
