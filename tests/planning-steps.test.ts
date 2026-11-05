import { afterAll, describe, expect, test } from "bun:test";
import { mergeConfig, configProblems } from "../src/config";
import { parseWorkflowText } from "../src/engine/workflows";
import { LABEL } from "../src/labels";
import { pollOnce } from "../src/watch";
import { engine, removeEngineDirs } from "./engine-harness";
import { baseIssue } from "./harness";

afterAll(removeEngineDirs);

const flow = (uses: string) => {
  const parsed = parseWorkflowText(`
name: planning
steps:
  go:
    uses: ${uses}
    label: factory:planning
    next: done
  done:
    uses: report
    label: factory:reporting
`);
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  return parsed.workflow;
};

// A fake tracker: the engine's FakeGitHub plus the optional sub-issue link.
function run(uses: string, body: string, config: Record<string, unknown> = {}, link = true) {
  const e = engine(flow(uses), 0, {}, {}, {}, { config });
  e.github.issues.get(1)!.body = body;
  const links: [number, number][] = [];
  if (link)
    Object.assign(e.github, { linkSubIssue: async (_r: string, p: number, c: number) => void links.push([p, c]) });
  return { e, links };
}

const drafts = JSON.stringify([
  { title: "Add export", problem: "Teams cannot export.", acceptance: ["Export writes a CSV."], outOfScope: ["PDF"] },
  { title: "Add import", problem: "Teams cannot import.", acceptance: ["Import reads a CSV."] },
]);

describe("spec step (#610)", () => {
  test("a goal's drafts become issues in Problem, Acceptance and Out of scope form", async () => {
    const { e } = run("spec", "Goal.\n\n```spec\n" + drafts + "\n```\n");
    expect(await e.run()).toBe("shipped");
    const made = [e.github.issues.get(2)!, e.github.issues.get(3)!];
    expect(made.map((i) => i.title)).toEqual(["Add export", "Add import"]);
    expect(made[0]!.body).toBe(
      "## Problem\n\nTeams cannot export.\n\n## Acceptance\n\n- Export writes a CSV.\n\n## Out of scope\n\n- PDF\n",
    );
    expect(made[1]!.body).toContain("## Out of scope\n\n- Nothing else.");
  });

  test("a goal with no usable drafts fails and files nothing", async () => {
    const { e } = run("spec", "Goal with no block.");
    expect(await e.run()).toBe("failed");
    expect(e.github.issues.size).toBe(1);
    expect(e.github.issues.get(1)!.comments.at(-1)!.body).toContain("no ```spec block");
  });

  test("a draft with no acceptance is refused by name", async () => {
    const bad = JSON.stringify([{ title: "t", problem: "p", acceptance: [] }]);
    const { e } = run("spec", "```spec\n" + bad + "\n```");
    expect(await e.run()).toBe("failed");
    expect(e.github.issues.get(1)!.comments.at(-1)!.body).toContain("draft 1: acceptance");
  });
});

describe("decompose step (#610)", () => {
  const epic = "Epic.\n\n- [ ] Export CSV\n- [ ] #7 already filed\n- [x] Shipped part\n";

  test("each unfiled checklist item becomes a child linked as a sub-issue and written back", async () => {
    const { e, links } = run("decompose", epic);
    expect(await e.run()).toBe("shipped");
    expect(e.github.issues.get(2)!.title).toBe("Export CSV");
    expect(e.github.issues.get(2)!.body).toContain("## Acceptance");
    expect(links).toEqual([[1, 2]]);
    expect(e.github.edited.at(-1)!.body).toContain("- [ ] #2 Export CSV");
    expect(e.github.issues.size).toBe(2);
  });

  test("a tracker that cannot link sub-issues fails before filing anything", async () => {
    const { e } = run("decompose", epic, {}, false);
    expect(await e.run()).toBe("failed");
    expect(e.github.issues.size).toBe(1);
  });
});

describe("prioritize step (#610)", () => {
  const rice = (r: number, i: number, c: number, f: number) =>
    `Reach: ${r}\nImpact: ${i}\nConfidence: ${c}\nEffort: ${f}\n`;

  test("rank comes from the configured method and an unconfigured repo is refused", async () => {
    const { e } = run("prioritize", rice(10, 2, 1, 4), { prioritize: { method: "rice" } });
    e.github.issues.set(2, { ...baseIssue(2, [LABEL.ready]), body: rice(100, 3, 1, 1) });
    expect(await e.run()).toBe("shipped");
    expect(
      e.github.issues
        .get(1)!
        .comments.map((c) => c.body)
        .join("\n"),
    ).toContain("Ranked 2 of 2 by RICE, score 5");
    const none = run("prioritize", rice(1, 1, 1, 1));
    expect(await none.e.run()).toBe("failed");
  });

  test("WSJF scores (value + urgency + risk) / size", async () => {
    const { e } = run("prioritize", "Value: 8\nUrgency: 3\nRisk: 1\nSize: 4\n", { prioritize: { method: "wsjf" } });
    expect(await e.run()).toBe("shipped");
    expect(
      e.github.issues
        .get(1)!
        .comments.map((c) => c.body)
        .join("\n"),
    ).toContain("Ranked 1 of 1 by WSJF, score 3");
  });

  test("config accepts rice and wsjf only", () => {
    expect(configProblems({ repo: "a/b", prioritize: { method: "rice" } })).toEqual([]);
    expect(configProblems({ repo: "a/b", prioritize: { method: "moscow" } }).join(" ")).toContain("prioritize.method");
  });

  test("pickup follows the rank, and the oldest first without a method", async () => {
    const order = async (config: Record<string, unknown>) => {
      const { e } = run("prioritize", rice(1, 1, 1, 1), config);
      e.github.issues.set(1, { ...baseIssue(1, [LABEL.ready]), body: rice(1, 1, 1, 1) });
      e.github.issues.set(2, { ...baseIssue(2, [LABEL.ready]), body: rice(9, 1, 1, 1) });
      e.github.issues.set(3, { ...baseIssue(3, [LABEL.ready]), body: "unscored" });
      return (await pollOnce(e.deps, mergeConfig({ repo: "acme/widgets", ...config }))).processed;
    };
    expect(await order({ prioritize: { method: "rice" } })).toEqual([2, 1, 3]);
    expect(await order({})).toEqual([1, 2, 3]);
  });
});
