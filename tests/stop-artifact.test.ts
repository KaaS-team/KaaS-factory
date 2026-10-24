// Exercises template/.claude/hooks/stop-artifact.sh as Claude Code calls it on
// Stop, and holds its answers to the runner's own validators, so the hook never
// sends an agent back over a file the runner would accept.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactStage, JSON_FILENAMES, validateStepJson, validateVerdict } from "../src/artifacts";
import { stopArtifactSpec } from "../src/agents/executor";
import { TYPE_LABELS } from "../src/labels";

const HOOK = join(import.meta.dir, "..", "template", ".claude", "hooks", "stop-artifact.sh");
let root: string;
let scratch: string;
let artifacts: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "factory-stop-"));
  scratch = join(root, "scratch");
  artifacts = join(root, "runs");
  mkdirSync(scratch);
  mkdirSync(artifacts);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function arm(stage: ArtifactStage): void {
  writeFileSync(join(scratch, "artifact.schema.json"), JSON.stringify(stopArtifactSpec(stage, TYPE_LABELS)));
}

async function stop(
  env: Record<string, string> = {
    FACTORY_STAGE: "build",
    FACTORY_SCRATCH_DIR: scratch,
    FACTORY_ARTIFACT_DIR: artifacts,
  },
): Promise<{ code: number; reason?: string }> {
  const { FACTORY_STAGE: _s, FACTORY_SCRATCH_DIR: _d, FACTORY_ARTIFACT_DIR: _a, ...base } = process.env;
  const proc = Bun.spawn(["bash", HOOK], {
    stdin: new Blob([JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false })]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...base, ...env },
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const reply = out.trim() ? (JSON.parse(out) as { decision: string; reason: string }) : undefined;
  if (reply) expect(reply.decision).toBe("block");
  return { code, reason: reply?.reason };
}

const write = (stage: ArtifactStage, body: unknown) =>
  writeFileSync(join(artifacts, JSON_FILENAMES[stage]), typeof body === "string" ? body : JSON.stringify(body));

describe("stop-artifact hook", () => {
  test("passes a valid artifact", async () => {
    arm("build");
    write("build", { status: "green", gate_line: "ok", rounds: 1 });
    expect(await stop()).toEqual({ code: 0, reason: undefined });
  });

  test("sends the agent back with the problem, twice, then lets it stop", async () => {
    arm("build");
    write("build", { status: "green", rounds: 1 });
    const first = await stop();
    expect(first.reason).toContain('build.json: "gate_line" is required');
    expect(first.reason).toContain(join(artifacts, "build.json"));
    expect((await stop()).reason).toContain("gate_line");
    expect(await stop()).toEqual({ code: 0, reason: undefined });
  });

  test("a missing file blocks", async () => {
    arm("verify");
    expect((await stop()).reason).toContain("verdict.json was not written");
  });

  test("does nothing outside a stage or without the runner's schema file", async () => {
    write("build", "{}");
    expect((await stop()).reason).toBeUndefined(); // armed by nothing
    arm("build");
    expect((await stop({ FACTORY_SCRATCH_DIR: scratch, FACTORY_ARTIFACT_DIR: artifacts })).reason).toBeUndefined();
  });

  test("pr and retro are never checked: the runner requires no file from them", () => {
    expect([stopArtifactSpec("pr", TYPE_LABELS), stopArtifactSpec("retro", TYPE_LABELS)]).toEqual([
      undefined,
      undefined,
    ]);
  });

  test("a broken schema file lets the stop through", async () => {
    writeFileSync(join(scratch, "artifact.schema.json"), "{bad");
    write("build", "{}");
    expect(await stop()).toEqual({ code: 0, reason: undefined });
  });
});

// Each case is [stage, file body]. The hook must block exactly when the runner
// rejects a step file, naming the same problem; for verify, whose validator is
// deeper, it must never block a verdict the runner accepts.
const CASES: [ArtifactStage, unknown][] = [
  [
    "triage",
    {
      disposition: "proceed",
      type: "bug",
      risk: "low",
      done_when: "x",
      files_expected: ["a"],
      gate_level: "full",
      confidence: 0.5,
    },
  ],
  [
    "triage",
    {
      disposition: "proceed",
      type: "bug",
      risk: "low",
      done_when: "x",
      files_expected: ["a"],
      gate_level: "full",
      confidence: 1.5,
    },
  ],
  [
    "triage",
    {
      disposition: "maybe",
      type: "bug",
      risk: "low",
      done_when: "x",
      files_expected: [],
      gate_level: "full",
      confidence: 0,
    },
  ],
  [
    "triage",
    {
      disposition: "proceed",
      type: "bug",
      risk: "low",
      done_when: "x",
      files_expected: [1],
      gate_level: "full",
      confidence: 0,
    },
  ],
  ["triage", { outcome: "blocked", summary: "no access" }],
  ["triage", { outcome: "blocked", summary: "  " }],
  ["triage", { outcome: "later" }],
  ["plan", { risk: "low", revision: 1, files: ["a"], autoApproveEligible: true }],
  ["plan", { risk: "low", revision: 1.5, files: ["a"], autoApproveEligible: true }],
  ["plan", { risk: "low", revision: 2, files: ["a"], autoApproveEligible: "yes" }],
  ["plan", '{"risk":"low","revision":2.0,"files":["a"],"autoApproveEligible":true}'],
  ["plan", { risk: "low", revision: true, files: ["a"], autoApproveEligible: true }],
  ["plan", { risk: "low", revision: 1, files: ["a"], autoApproveEligible: true, proof: "vibes" }],
  ["build", { status: "green", gate_line: "ok", rounds: 1, screenshots: [{}] }],
  ["build", { status: "green", gate_line: "ok", rounds: 1, screenshots: ["a.png"] }],
  ["build", { status: "green", gate_line: null, rounds: 1 }],
  ["build", { status: "green", gate_line: "ok", rounds: 1, extra: 1 }],
  ["build", { outcome: "failed" }],
  ["build", { status: "green", gate_line: "ok", rounds: 1, summary: "\u001f" }],
  ["build", { status: "green", gate_line: "ok", rounds: 1, summary: "\u00a0\u3000" }],
  ["build", []],
  ["build", "not json"],
  ["build", '{"status":"green","gate_line":"ok","rounds":NaN}'],
  ["verify", { result: "pass", rounds: 1, findings: [] }],
  [
    "verify",
    {
      result: "reject",
      rounds: 2,
      findings: [{ severity: "must", confidence: 4, what: "x" }],
      criteria: [{ id: "AC-1", status: "fail" }],
    },
  ],
  [
    "verify",
    {
      result: "uncertain",
      rounds: 1,
      findings: [],
      criteria: [{ id: "AC-1", status: "unverified", gap: "no access" }],
    },
  ],
  ["verify", { result: "pass", rounds: 1, findings: [], summary: "\u001f" }],
  ["verify", { outcome: "blocked", summary: "denied" }],
  ["verify", { outcome: "blocked", summary: "no access", result: "maybe" }],
  ["verify", { outcome: "failed", rounds: "x" }],
];

describe("stop-artifact matches the runner", () => {
  for (const [i, [stage, body]] of CASES.entries()) {
    test(`case ${i}: ${stage} ${typeof body === "string" ? body : JSON.stringify(body)}`, async () => {
      arm(stage);
      write(stage, body);
      const { reason } = await stop();
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof body === "string" ? body : JSON.stringify(body));
      } catch {
        expect(reason).toContain("is not valid JSON");
        return;
      }
      if (stage === "verify") {
        if (validateVerdict(parsed).ok) expect(reason).toBeUndefined();
        return;
      }
      const runner = validateStepJson(stage, parsed);
      if (runner.ok) expect(reason).toBeUndefined();
      else expect(reason).toContain(`not done: ${runner.reason}.`);
    });
  }
});
