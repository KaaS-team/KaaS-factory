// The runner owns the verdict heading and round, the three common reject causes, and the
// prior-finding rule; the verify step posts what it settles.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { validateVerdict, type VerdictArtifact } from "../src/artifacts";
import {
  applyPriorFindings,
  applyVerdictRules,
  verdictHeading,
  verdictPost,
  withVerdictHeading,
} from "../src/engine/verdict-rules";
import { parseWorkflowText } from "../src/engine/workflows";
import { LABEL } from "../src/labels";
import { classifyProof, type ProofResult } from "../src/proof";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(removeEngineDirs);

const bundledWorkflow = (name: string) => {
  const r = parseWorkflowText(readFileSync(`template/.factory/workflows/${name}.yml`, "utf8"));
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.workflow;
};

const v = (result: VerdictArtifact["result"], findings: VerdictArtifact["findings"] = []): VerdictArtifact => ({
  result,
  rounds: 1,
  findings,
});
const must = { severity: "must" as const, confidence: 4, what: "breaks X" };
const should = { severity: "should" as const, confidence: 4, what: "rename Y" };
const facts = { changed: ["a"], offPlanSent: false };

describe("heading", () => {
  test("only a reject names its round", () => {
    expect(verdictHeading("reject", 2, 3)).toBe("## Verdict: reject (round 2 of 3)");
    expect(verdictHeading("pass", 2, 3)).toBe("## Verdict: pass");
  });
  test("the model's heading is replaced, not duplicated", () => {
    const out = withVerdictHeading(
      "<!-- factory:verdict v1 -->\n## Verdict: pass\n\nbody",
      "## Verdict: reject (round 1 of 2)",
    );
    expect(out).toBe("<!-- factory:verdict v1 -->\n## Verdict: reject (round 1 of 2)\n\nbody");
  });
  test("verdictPost leaves a comment alone without a result and lists runner findings", () => {
    expect(verdictPost("c", undefined, 1, 2)).toBe("c");
    const out = verdictPost("body", v("reject", [{ ...must, where: "runner" }]), 1, 2);
    expect(out).toContain("### Runner findings\n- breaks X");
  });
});

describe("rules", () => {
  test("a compile-only proof never passes", () => {
    const out = applyVerdictRules(v("pass"), { ...facts, proof: "compile-only" });
    expect(out.result).toBe("reject");
    expect(JSON.stringify(out.findings)).toContain("does not compile");
    expect(applyVerdictRules(v("pass"), { ...facts, proof: "bites" }).result).toBe("pass");
  });
  test("a should-only reject goes to a human; a must keeps it a reject", () => {
    expect(applyVerdictRules(v("reject", [should]), facts).result).toBe("uncertain");
    expect(applyVerdictRules(v("reject", [should, must]), facts).result).toBe("reject");
    expect(applyVerdictRules(v("reject", ["plain"]), facts).result).toBe("reject");
  });
  test("off-plan files reject once, only for an issue plan", () => {
    const plan = { files: ["a"], source: "issue" };
    const f = { changed: ["a", "b", ".factory/x"], offPlanSent: false, plan };
    const out = applyVerdictRules(v("pass"), f);
    expect(out.result).toBe("reject");
    expect(JSON.stringify(out.findings)).toContain("Files changed outside the plan: b");
    expect(applyVerdictRules(v("pass"), { ...f, offPlanSent: true }).result).toBe("pass");
    expect(applyVerdictRules(v("pass"), { ...f, plan: { files: ["a"], source: "planner" } }).result).toBe("pass");
  });
  test("an open prior finding stops a pass", () => {
    expect(applyPriorFindings(v("pass"), ["breaks X"]).result).toBe("uncertain");
    const done = { ...v("pass"), prior: [{ what: "breaks X", status: "resolved" as const }] };
    expect(applyPriorFindings(done, ["breaks X"]).result).toBe("pass");
    expect(applyPriorFindings(v("reject", [must]), ["breaks X"]).result).toBe("reject");
  });
});

describe("proof and artifact", () => {
  const proof = (tail: string): ProofResult => ({ status: "bites", reverted: [], tests: [], cmd: "t", tail });
  test("a compile error with no added file is compile-only", () => {
    expect(classifyProof(proof("error TS2304: x"), 0).status).toBe("compile-only");
    expect(classifyProof(proof("error TS2304: x"), 1).status).toBe("bites");
    expect(classifyProof(proof("expected 1 to be 2"), 0).status).toBe("bites");
  });
  test("validateVerdict checks prior", () => {
    expect(validateVerdict({ ...v("pass"), prior: [{ what: "a", status: "resolved" }] }).ok).toBe(true);
    const bad = validateVerdict({ ...v("pass"), prior: [{ what: "a", status: "maybe" }] });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toContain("prior");
  });
});

const BUILD = {
  "status-comment.md": "<!-- factory:status v1 -->\nb",
  "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
};
const verdict = (comment: string, json: object) => ({
  "verdict-comment.md": `<!-- factory:verdict v1 -->\n${comment}\nbody`,
  "verdict.json": JSON.stringify(json),
});

describe("the verify step", () => {
  test("a should-only reject ends at needs-human with the runner's heading", async () => {
    const e = engine(
      bundledWorkflow("bug-to-pr"),
      0,
      {},
      {},
      {},
      {
        outputs: {
          build: [BUILD],
          verify: [verdict("## Verdict: pass", { result: "reject", rounds: 1, findings: [should] })],
        },
      },
    );
    expect(await e.run()).toBe("needs-human");
    const posted = e.github.issues
      .get(1)!
      .comments.map((c) => c.body)
      .find((b) => b.includes("factory:verdict"))!;
    expect(posted.startsWith("<!-- factory:verdict v1 -->\n## Verdict: uncertain\n")).toBe(true);
    expect(posted).not.toContain("## Verdict: pass");
    expect(e.github.issues.get(1)!.labels.map((l) => l.name)).toContain(LABEL.needsHuman);
  });

  test("a reject posts its round, the rebuild sees it, and the next verify finds prior-findings.json", async () => {
    const e = engine(
      bundledWorkflow("bug-to-pr"),
      0,
      {},
      {},
      {},
      {
        outputs: {
          build: [BUILD, BUILD],
          verify: [
            verdict("", { result: "reject", rounds: 1, findings: [must] }),
            verdict("", { result: "pass", rounds: 1, findings: [], prior: [{ what: "breaks X", status: "resolved" }] }),
          ],
        },
      },
    );
    let seen: boolean | undefined;
    const real = e.executor.runStage.bind(e.executor);
    e.executor.runStage = ((opts: Parameters<typeof real>[0]) => {
      if (opts.stage === "verify" && e.executor.pinned.filter(([s]) => s === "verify").length === 1)
        seen = existsSync(`${opts.cwd}/.factory/runs/issue-1/prior-findings.json`);
      return real(opts);
    }) as typeof real;
    expect(await e.run()).toBe("shipped");
    const posted = e.github.issues
      .get(1)!
      .comments.map((c) => c.body)
      .filter((b) => b.includes("factory:verdict"));
    expect(posted[0]).toContain(`## Verdict: reject (round 1 of ${e.deps.workflow.limits.rejects})`);
    expect(e.executor.resumed.find((r) => r)?.failure).toContain("## Verdict: reject (round 1 of");
    expect(seen).toBe(true);
  });
});

describe("templates", () => {
  const read = (p: string) => readFileSync(`template/.claude/skills/${p}`, "utf8");
  test("verify skill names the new inputs and the runner owns the heading", () => {
    const skill = read("factory-verify/SKILL.md");
    for (const s of ["prior-findings.json", "operator-answers.md", '"prior"', "compile-only"])
      expect(skill).toContain(s);
    const t = read("factory-comment/assets/verdict.md");
    expect(t).not.toContain("## Verdict");
    expect(t).not.toContain("round {{round}}");
  });
});
