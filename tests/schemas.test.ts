// The schemas and the validators must agree: same fields, and the fixture
// artifacts the validators accept satisfy the schema's required list.

import { expect, test, describe } from "bun:test";
import { STEP_KEYS, validateStepJson, validateVerdict, type ArtifactStage } from "../src/artifacts";
import { replySchema, stageSchema } from "../src/schemas";

const STAGES: ArtifactStage[] = ["triage", "plan", "build", "verify", "pr", "retro"];
const GOOD: Record<ArtifactStage, object> = {
  triage: {
    disposition: "proceed",
    type: "bug",
    risk: "low",
    done_when: "x",
    files_expected: [],
    gate_level: "g",
    confidence: 0.9,
  },
  plan: { risk: "low", revision: 1, files: [], autoApproveEligible: true },
  build: { status: "green", gate_line: "l", rounds: 1 },
  verify: { result: "pass", rounds: 1, findings: [] },
  pr: {},
  retro: {},
};

test("every stage has a schema whose properties are exactly the validator's fields", () => {
  for (const stage of STAGES) {
    const s = stageSchema(stage) as { properties: object; required: string[]; additionalProperties: boolean };
    const keys = Object.keys(s.properties);
    if (stage !== "verify")
      expect(keys.sort(), stage).toEqual([...STEP_KEYS[stage as Exclude<ArtifactStage, "verify">]].sort());
    expect(s.additionalProperties).toBe(false);
    for (const r of s.required) expect(keys, `${stage}: required ${r} is not a property`).toContain(r);
  }
});

test("a good artifact for each stage satisfies the schema's required list and the validator", () => {
  for (const stage of STAGES) {
    const good = GOOD[stage] as Record<string, unknown>;
    for (const r of (stageSchema(stage) as { required: string[] }).required)
      expect(good, `${stage}.${r}`).toHaveProperty(r);
    expect(stage === "verify" ? validateVerdict(good).ok : validateStepJson(stage, good).ok, stage).toBe(true);
  }
});

test("the reply schema wraps the stage schema", () => {
  const r = replySchema("plan") as { properties: { artifact: unknown } };
  expect(r.properties.artifact).toEqual(stageSchema("plan"));
});

describe("validators enforce the schema, not just the key list", () => {
  test("a missing required field or a bad enum fails; a blocked step owes only its outcome", () => {
    expect(validateStepJson("plan", { risk: "low" })).toEqual({
      ok: false,
      reason: 'plan.json: "revision" is required',
    });
    expect(validateStepJson("build", { status: "purple", gate_line: "x", rounds: 1 }).ok).toBe(false);
    expect(validateStepJson("triage", { outcome: "blocked", summary: "no sandbox key" })).toEqual({ ok: true });
  });

  test("a blocked verify with no verdict is accepted so the runner can route it", () => {
    const r = validateVerdict({ outcome: "blocked", summary: "cannot run the tests" });
    expect(r.ok).toBe(true);
    expect(validateVerdict({ outcome: "complete" }).ok).toBe(false);
  });
});

// v2.7.0 item 1: the triage schema's `type` enum is bounded by the repo's
// actual type list, not a fixed five, so a route-added type (e.g. "content")
// validates when the caller passes it, and still fails closed by default.
// plan v2.12.0 item B.5: the ui route's build step records a screenshot
// manifest so factory-verify can require and score it.
describe("build's screenshots field", () => {
  const base = { status: "green" as const, gate_line: "l", rounds: 1 };

  test("an array of manifest entries validates", () => {
    const good = { ...base, screenshots: [{ state: "guest", viewport: "1440", theme: "light", path: "x.png" }] };
    expect(validateStepJson("build", good)).toEqual({ ok: true });
  });

  test("absent screenshots still validates: only the ui route ever sends it", () => {
    expect(validateStepJson("build", base)).toEqual({ ok: true });
  });

  test("a non-array screenshots field fails", () => {
    expect(validateStepJson("build", { ...base, screenshots: "x.png" }).ok).toBe(false);
  });

  test("an array of strings, not objects, fails", () => {
    expect(validateStepJson("build", { ...base, screenshots: ["x.png"] }).ok).toBe(false);
  });
});

describe("triage's type enum follows the repo's routes, not a fixed list", () => {
  const contentTriage = {
    disposition: "proceed",
    type: "content",
    risk: "low",
    done_when: "x",
    files_expected: [],
    gate_level: "g",
    confidence: 0.9,
  };

  test("a route-added type is rejected against the default TYPE_LABELS", () => {
    expect(validateStepJson("triage", contentTriage).ok).toBe(false);
  });

  test("the same type validates once the repo's type list is passed", () => {
    expect(
      validateStepJson("triage", contentTriage, ["bug", "feature", "docs", "security", "dependency", "content"]),
    ).toEqual({ ok: true });
  });
});

// v2.7.0 item 8: build/verify read `proof` from the plan artifact, never the
// type name, so the plan schema has to carry and validate it.
describe("plan's proof field", () => {
  test('"test" and "check" both validate; a typo does not', () => {
    const base = { risk: "low", revision: 1, files: [] as string[], autoApproveEligible: true };
    expect(validateStepJson("plan", { ...base, proof: "test" })).toEqual({ ok: true });
    expect(validateStepJson("plan", { ...base, proof: "check" })).toEqual({ ok: true });
    expect(validateStepJson("plan", { ...base, proof: "vibes" }).ok).toBe(false);
  });

  test("proof is optional: an older plan with none still validates", () => {
    expect(validateStepJson("plan", { risk: "low", revision: 1, files: [], autoApproveEligible: true })).toEqual({
      ok: true,
    });
  });
});

describe("a retro proposes one change", () => {
  const ok = { outcome: "complete", summary: "s" };
  test("a lesson alone, a skill edit alone, or nothing all validate", () => {
    expect(validateStepJson("retro", ok)).toEqual({ ok: true });
    expect(validateStepJson("retro", { ...ok, lesson: "l" })).toEqual({ ok: true });
    expect(validateStepJson("retro", { ...ok, skill_name: "factory-build", skill_edit: "e" })).toEqual({ ok: true });
  });

  test("a lesson with a skill edit fails, and so does half a skill edit", () => {
    expect(validateStepJson("retro", { ...ok, lesson: "l", skill_name: "factory-build", skill_edit: "e" })).toEqual({
      ok: false,
      reason: 'retro.json: "lesson" and "skill_edit" cannot appear together',
    });
    expect(validateStepJson("retro", { ...ok, skill_name: "factory-build" })).toEqual({
      ok: false,
      reason: 'retro.json: "skill_name" needs "skill_edit"',
    });
    expect(validateStepJson("retro", { ...ok, skill_edit: "e" })).toEqual({
      ok: false,
      reason: 'retro.json: "skill_edit" needs "skill_name"',
    });
  });
});
