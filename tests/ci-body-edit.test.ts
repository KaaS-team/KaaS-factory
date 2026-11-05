// Editing a PR description reruns only the checks that read it (#583). ci.yml does not list `edited`;
// pr-body.yml does, and holds just the two body readers. The staged copies under ci/ are read first.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const staged = (name: string) => [join(root, "ci", name), join(root, ".github", "workflows", name)].find(existsSync)!;
type Workflow = {
  on: { pull_request?: { types?: string[] } };
  jobs: Record<string, { steps: { name?: string; run?: string; env?: Record<string, string> }[] }>;
};
const load = (name: string) => Bun.YAML.parse(readFileSync(staged(name), "utf8")) as Workflow;
const readsBody = (text: string) => /PR_BODY|pull_request\.body/.test(text);

describe("a body edit", () => {
  test("does not trigger ci", () => {
    expect(load("ci.yml").on.pull_request?.types).not.toContain("edited");
  });

  test("ci runs no step that reads the body", () => {
    expect(readsBody(readFileSync(staged("ci.yml"), "utf8"))).toBe(false);
  });

  test("triggers pr-body, whose steps are exactly the two body readers", () => {
    const wf = load("pr-body.yml");
    expect(wf.on.pull_request?.types).toContain("edited");
    const runs = Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.run ?? "").filter(Boolean));
    expect(runs.sort()).toEqual([
      expect.stringContaining("scripts/check-pr-body.ts"),
      expect.stringContaining("scripts/check-tests-only.ts"),
    ]);
    expect(runs.join("\n")).not.toContain("make ");
  });

  test("no staged or live workflow other than pr-body.yml runs on an edit", () => {
    const dirs = [join(root, "ci"), join(root, ".github", "workflows")].filter(existsSync);
    const onEdit = dirs.flatMap((d) =>
      readdirSync(d)
        .filter((f) => f.endsWith(".yml") && f !== "pr-body.yml")
        .filter(
          (f) =>
            Bun.YAML.parse(readFileSync(join(d, f), "utf8")) &&
            /types:\s*\[[^\]]*\bedited\b/.test(readFileSync(join(d, f), "utf8")),
        )
        .map((f) => `${d}/${f}`),
    );
    expect(onEdit).toEqual([]);
  });
});
