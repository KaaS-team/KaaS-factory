import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPlanAcceptance } from "../src/acceptance";
import { mergeConfig } from "../src/config";
import type { WatchDeps } from "../src/engine/common";
import { issueRef, postRunDetails, prBody, renderRunDetails, renderWhatChanged } from "../src/engine/pr-body";
import {
  buildStatement,
  decodeStatement,
  envelopeFromBody,
  renderReceipt,
  sealRunFiles,
  unsignedEnvelope,
} from "../src/receipt";
import { ShellSetupRunner } from "../src/setup";
import type { StageRun } from "../src/state";
import { visibleLeaks } from "./harness";

const LONG = `${"The monthly plan page shows its price, the currency and the renewal date to every signed-in user. ".repeat(3)}End.`;
const plan = { goal: "Monthly plan shows its price.", criteria: [{ id: "AC-1", text: LONG }] };
const proof = { status: "bites" as const, reverted: ["src/a.ts"], tests: ["tests/a.test.ts"], cmd: "x", tail: "" };
const run = (stage: string, model: string): StageRun =>
  ({
    stage,
    agent: "claude",
    model,
    duration_ms: 5000,
    tool_calls: 4,
    cost_usd: 1.23,
    exit_code: 0,
    killed_reason: null,
    verdict: null,
  }) as unknown as StageRun;
const runs = [run("build", "claude-opus-5-5"), run("verify", "gpt-5")];

function receipt(criteria = 1): string {
  return renderReceipt(unsignedEnvelope(statement(true, criteria)));
}

function statement(operatorDetail: boolean, criteria = 1) {
  return buildStatement({
    repo: "o/r",
    issue: 7,
    baseRef: "main",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    at: "2026-01-01T00:00:00Z",
    acceptance: {
      base: "origin/main",
      errors: [],
      acs: Array.from({ length: criteria }, () => ({
        spec: "s",
        ac: "AC-1",
        text: "t",
        holdout: ["h"],
        new: true,
        base: "fail" as const,
        head: "pass" as const,
        ok: true,
      })),
    },
    holdout: { ok: true },
    holdoutRequired: true,
    proof,
    runs,
    files: { "proof.json": "{}" },
    operatorDetail,
  });
}

function finishedBody(): string {
  return prBody("Why: users could not see the price.\n\nCloses #7", {
    whatChanged: renderWhatChanged(plan.goal, ["src/a.ts"], proof),
    acceptance: renderPlanAcceptance(plan, [{ id: "AC-1", status: "pass" }], undefined),
    runDetails: issueRef(mergeConfig({ repo: "o/r" }), 7),
  });
}

describe("a PR body built from a finished run", () => {
  test("pr body has no duplicated section", () => {
    const headings = finishedBody()
      .split("\n")
      .filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## What changed", "## Acceptance"]);
  });

  test("pr body keeps every criterion whole", () => {
    expect(LONG.length).toBeGreaterThan(200);
    expect(finishedBody()).toContain(`AC-1: ${LONG.replace(/\s+/g, " ")} | pass |`);
  });

  test("pr body carries no operator detail", () => {
    const body = finishedBody();
    expect(body).not.toMatch(/\$|claude-|gpt-|gemini-|tokens?\b|## Factory run/);
  });

  test("pr body carries no attestation blob", () => {
    const body = finishedBody();
    expect(body).not.toMatch(/[A-Za-z0-9+/=]{40,}/);
    expect(body).not.toContain("Envelope for kaas-verify");
    expect(body).toContain("run-details comment on #7");
  });

  test("a non-GitHub tracker's issue is named without a #, which GitHub would link to its own issue", () => {
    const http = { tracker: { kind: "http" } } as Parameters<typeof issueRef>[0];
    expect(prBody("x", { runDetails: issueRef(http, 7) })).toContain("comment on tracker issue 7.");
    expect(issueRef(http, 7)).not.toContain("#");
  });
});

describe("an epic's PR body", () => {
  test("tasks follow What changed and the closing line precedes the run-details pointer", () => {
    const body = prBody("Text.", {
      whatChanged: "## What changed",
      tasks: "## Tasks",
      acceptance: "## Acceptance",
      closes: "Closes #5, closes #6",
      runDetails: "#5",
    });
    const at = (s: string) => body.indexOf(s);
    expect([
      at("## What changed"),
      at("## Tasks"),
      at("Text."),
      at("## Acceptance"),
      at("Closes #5"),
      at("receipt"),
    ]).toEqual(
      [
        ...[at("## What changed"), at("## Tasks"), at("Text."), at("## Acceptance"), at("Closes #5"), at("receipt")],
      ].sort((a, b) => a - b),
    );
    expect(at("receipt")).toBeGreaterThan(0);
  });
});

describe("the run-details comment", () => {
  test("run details comment holds the receipt envelope", () => {
    const comment = receipt();
    expect(envelopeFromBody(comment)?.payloadType).toBe("application/vnd.in-toto+json");
    expect(comment).not.toContain("## Factory run");
    expect(visibleLeaks(comment.replace(/```json\n.+\n```/, ""))).toEqual([]);
  });

  test("receipt never contradicts the criteria table", () => {
    const text = receipt(0);
    expect(text).not.toContain("0 of 0");
    expect(text).toContain("the acceptance table is the record");
    expect(receipt(1)).toContain("Proven: 1 of 1 criteria.");
  });

  test("the posted receipt drops model and spend, built from a real worktree", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-run-details-"));
    const sh = (cmd: string) =>
      Bun.spawnSync(["sh", "-c", cmd], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    sh(
      "git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD",
    );
    const dir = ".factory/runs/issue-7";
    mkdirSync(join(repo, dir), { recursive: true });
    const exec = new ShellSetupRunner();
    const text = await renderRunDetails(exec, {
      worktree: repo,
      runDir: dir,
      repo: "o/r",
      issue: 7,
      base: "main",
      runs,
      holdoutRequired: false,
      seal: await sealRunFiles(exec, repo, dir),
    });
    rmSync(repo, { recursive: true, force: true });
    const steps = decodeStatement(envelopeFromBody(text)!).predicate.steps;
    expect(steps.length).toBe(runs.length);
    expect(steps.every((s) => s.model === null && s.costUsd === null)).toBe(true);
    expect(text).not.toMatch(/\$|claude-|gpt-/);
  });

  test("posting twice edits the one comment, so a retry or a revise leaves no duplicate", async () => {
    const settings = new Map<string, string>();
    const calls: string[] = [];
    const deps = {
      state: { getSetting: (k: string) => settings.get(k), setSetting: (k: string, v: string) => settings.set(k, v) },
      github: {
        commentIssue: async () => (calls.push("post"), 9),
        editComment: async (_r: string, id: number) => void calls.push(`edit ${id}`),
      },
    } as unknown as WatchDeps;
    const config = mergeConfig({ repo: "o/r" });
    await postRunDetails(deps, config, 7, "## Receipt");
    await postRunDetails(deps, config, 7, "## Receipt");
    expect(calls).toEqual(["post", "edit 9"]);
  });

  test("a deleted comment is replaced, and a tracker with no comment ids is posted to once", async () => {
    const settings = new Map<string, string>();
    const calls: string[] = [];
    let id: number | undefined = 9;
    let deleted = false;
    const deps = {
      state: { getSetting: (k: string) => settings.get(k), setSetting: (k: string, v: string) => settings.set(k, v) },
      github: {
        commentIssue: async () => (calls.push("post"), id),
        editComment: async () => {
          calls.push("edit");
          if (deleted) throw new Error("not found");
        },
      },
    } as unknown as WatchDeps;
    const config = mergeConfig({ repo: "o/r" });
    await postRunDetails(deps, config, 7, "## Receipt");
    deleted = true;
    await postRunDetails(deps, config, 7, "## Receipt");
    expect(calls).toEqual(["post", "edit", "post"]);
    settings.clear();
    calls.length = 0;
    id = undefined;
    await postRunDetails(deps, config, 8, "## Receipt");
    await postRunDetails(deps, config, 8, "## Receipt");
    expect(calls).toEqual(["post"]);
  });
});
