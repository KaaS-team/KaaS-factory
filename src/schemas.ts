// JSON Schema (draft-07) for each stage artifact. The property lists come from
// STEP_KEYS and VERDICT_KEYS in artifacts.ts, so the validators stay the one
// definition of which fields exist; only the field types are written here.

import { type ArtifactStage, STEP_KEYS, VERDICT_KEY_LIST } from "./artifacts";
import { TYPE_LABELS } from "./labels";

type Prop = Record<string, unknown>;
const str: Prop = { type: "string" };
const int: Prop = { type: "integer" };
const strings: Prop = { type: "array", items: str };
const outcome: Prop = { enum: ["complete", "blocked", "failed"] };
const risk: Prop = { enum: ["low", "medium", "high"] };

// `types` is the repo's full type list (TYPE_LABELS plus config.routes keys,
// per typesFor in labels.ts): a repo-added type (e.g. lwp's "content") must
// validate here too, not just at the config layer (plan v2.7.0 item 1).
function typesOf(stage: ArtifactStage, types: readonly string[]): Record<string, Prop> {
  const byStage: Record<ArtifactStage, Record<string, Prop>> = {
    triage: {
      disposition: { enum: ["proceed", "needs-info", "refused", "duplicate"] },
      type: { enum: [...types] },
      risk,
      done_when: str,
      files_expected: strings,
      gate_level: str,
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    plan: {
      status: { enum: ["needs-info"] },
      risk,
      revision: int,
      files: strings,
      autoApproveEligible: { type: "boolean" },
      commentId: int,
      // Read by factory-build/factory-verify, never inferred from the type
      // name (plan v2.7.0 item 8). Absent means "test", today's behavior.
      proof: { enum: ["test", "check"] },
      // The PR body's What changed and Acceptance come from these, so they are this issue's own (#90).
      goal: str,
      criteria: { type: "array", items: { type: "object" } },
      spec: str,
      // Set only when the plan was written in the issue (engine/import-plan.ts), never by the planner.
      tasks: { type: "array", items: { type: "object" } },
      mutations: { type: "array", items: { type: "object" } },
      bodyHash: str,
      source: { enum: ["issue", "planner"] },
      model: str,
    },
    build: {
      status: { enum: ["green", "red", "needs-info"] },
      gate_line: str,
      rounds: int,
      // The ui route's proof: one entry per state x viewport x theme (plan
      // v2.12.0 item B.5, "a factory-verify visual check"). Absent on every
      // other route, where there is nothing to screenshot. `fits` checks
      // array-of-object shallowly, same as verify's findings/criteria; the
      // per-item shape (state, viewport, theme, path, all required) is
      // enforced by factory-verify reading the manifest, not by this schema.
      screenshots: { type: "array", items: { type: "object" } },
    },
    verify: {
      result: { enum: ["pass", "reject", "uncertain"] },
      rounds: int,
      findings: { type: "array", items: { anyOf: [str, { type: "object" }] } },
      criteria: { type: "array", items: { type: "object" } },
    },
    pr: {},
    retro: { lesson: str, skill_name: str, skill_edit: str },
  };
  return byStage[stage];
}

const REQUIRED: Record<ArtifactStage, readonly string[]> = {
  triage: ["disposition", "type", "risk", "done_when", "files_expected", "gate_level", "confidence"],
  plan: ["risk", "revision", "files", "autoApproveEligible"],
  build: ["status", "gate_line", "rounds"],
  verify: ["result", "rounds", "findings"],
  pr: [],
  // Nothing is required: "no proposal" is a valid, and expected, retro.
  retro: [],
};

// Field combinations the runner checks after the schema: `needs` (a field requires another) and
// `apart` (fields that never appear together). They stay out of stageSchema, which is handed to
// other agents' structured-output flags (codex --output-schema) that may not accept draft-07's
// `dependencies` or `not`. A retro proposes one change: a skill edit names its skill, and a
// lesson never comes with a skill edit.
const COMBINATIONS: Partial<
  Record<ArtifactStage, { needs: Record<string, readonly string[]>; apart: readonly (readonly string[])[] }>
> = {
  retro: { needs: { skill_name: ["skill_edit"], skill_edit: ["skill_name"] }, apart: [["lesson", "skill_edit"]] },
};

// `types` bounds the triage `type` enum: TYPE_LABELS unless the caller knows
// the repo's config.routes and passes typesFor(routes) instead (plan v2.7.0
// item 1). Only triage's schema uses it.
export function stageSchema(stage: ArtifactStage, types: readonly string[] = TYPE_LABELS): Record<string, unknown> {
  const keys = stage === "verify" ? VERDICT_KEY_LIST : STEP_KEYS[stage];
  const types_ = typesOf(stage, types);
  const properties: Record<string, Prop> = {};
  for (const k of keys) properties[k] = k === "outcome" ? outcome : k === "summary" ? str : (types_[k] ?? {});
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties,
    required: REQUIRED[stage],
    additionalProperties: false,
  };
}

// The read-only reply envelope around a stage's schema.
export function replySchema(stage: ArtifactStage, types: readonly string[] = TYPE_LABELS): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { artifact: stageSchema(stage, types), comment: str, question: str },
    required: ["artifact"],
    additionalProperties: false,
  };
}

// Checks a parsed artifact against its own schema: required fields, types and
// enums. A step that reports blocked or failed owes only its outcome, so the
// required list is skipped for it.
export function schemaProblem(
  stage: ArtifactStage,
  o: Record<string, unknown>,
  types: readonly string[] = TYPE_LABELS,
): string | undefined {
  const schema = stageSchema(stage, types) as { properties: Record<string, Prop>; required: readonly string[] };
  if (o.outcome !== "blocked" && o.outcome !== "failed") {
    const missing = schema.required.find((k) => o[k] === undefined);
    if (missing) return `"${missing}" is required`;
  }
  for (const [k, prop] of Object.entries(schema.properties)) {
    if (o[k] !== undefined && !fits(prop, o[k])) return `"${k}" has the wrong type or value`;
  }
  const combos = COMBINATIONS[stage];
  for (const [k, needs] of Object.entries(combos?.needs ?? {})) {
    const missing = o[k] === undefined ? undefined : needs.find((n) => o[n] === undefined);
    if (missing) return `"${k}" needs "${missing}"`;
  }
  for (const fields of combos?.apart ?? []) {
    if (fields.every((k) => o[k] !== undefined))
      return `${fields.map((k) => `"${k}"`).join(" and ")} cannot appear together`;
  }
  return undefined;
}

function fits(prop: Prop, v: unknown): boolean {
  if (Array.isArray(prop.anyOf)) return (prop.anyOf as Prop[]).some((p) => fits(p, v));
  if (Array.isArray(prop.enum)) return prop.enum.includes(v);
  switch (prop.type) {
    case "string":
      return typeof v === "string";
    case "integer":
      return Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "number":
      return (
        typeof v === "number" &&
        v >= ((prop.minimum as number | undefined) ?? -Infinity) &&
        v <= ((prop.maximum as number | undefined) ?? Infinity)
      );
    case "array":
      return Array.isArray(v) && v.every((x) => fits((prop.items as Prop | undefined) ?? {}, x));
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    default:
      return true;
  }
}
