// `factory onboard --json`: completed, blocked or failed with the next action, and a live doctor verdict.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../src/config";
import { dispatchJobs } from "../src/dispatch";
import type { DoctorCheck } from "../src/doctor";
import {
  buildOnboardReport,
  doctorOutput,
  doctorStatus,
  onboardOutput,
  unusableConfigCheck,
} from "../src/onboard-json";
import { FactoryState } from "../src/state";
import { baseIssue, FakeGitHub } from "./harness";

const check = (ok: boolean, warn = false): DoctorCheck => ({
  name: "gh authenticated",
  ok,
  detail: "run gh auth login",
  fixable: false,
  ...(warn ? { warn } : {}),
});

function repoDir(opts: { installed: boolean; config?: string }): string {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "factory-onboard-"));
  mkdirSync(join(dir, ".factory"), { recursive: true });
  if (opts.installed) writeFileSync(join(dir, ".factory", "gates.sh"), "#!/bin/sh\n");
  if (opts.config !== undefined) writeFileSync(join(dir, ".factory", "config.json"), opts.config);
  return dir;
}

const filled = JSON.stringify({ repo: "acme/widgets", gates: [{ name: "test", run: "true" }] });

describe("onboard --json", () => {
  test("doctor status is Ready, Not checked or Needs setup", () => {
    expect(doctorStatus(undefined)).toBe("Not checked");
    expect(doctorStatus([check(true)])).toBe("Ready");
    expect(doctorStatus([check(false, true)])).toBe("Ready");
    expect(doctorStatus([check(true), check(false)])).toBe("Needs setup");
  });

  test("doctor --json carries the status; a config that cannot load is Not checked, not Needs setup", () => {
    const live = JSON.parse(doctorOutput([check(false)], true));
    expect(live.ok).toBe(false);
    expect(live.data.status).toBe("Needs setup");
    const dead = JSON.parse(doctorOutput([unusableConfigCheck(new Error("bad json"))], true, false));
    expect(dead.data.status).toBe("Not checked");
    expect(dead.data.checks[0].detail).toBe("bad json");
    expect(doctorOutput([check(true)], false)).toBe("  [ok] gh authenticated — run gh auth login");
  });

  test("onboard output is {ok,data} in json and a readable summary otherwise", async () => {
    const report = await buildOnboardReport(repoDir({ installed: true, config: filled }), async () => [check(true)]);
    const json = JSON.parse(onboardOutput(report, true));
    expect(json.ok).toBe(true);
    expect(json.data.doctor).toBe("Ready");
    expect(onboardOutput(report, false)).toContain("factory onboard: completed, doctor Ready.");
  });

  test("an empty repo is blocked, with the install command as the next action and doctor not run", async () => {
    const dir = repoDir({ installed: false });
    let ran = 0;
    const report = await buildOnboardReport(dir, async () => {
      ran++;
      return [check(true)];
    });
    expect(ran).toBe(0);
    expect(report.status).toBe("blocked");
    expect(report.doctor).toBe("Not checked");
    expect(report.next).toBe(`factory install ${dir}`);
  });

  test("an installed repo without a filled-in config points at init", async () => {
    const dir = repoDir({ installed: true, config: '{"repo":"TODO"}' });
    const report = await buildOnboardReport(dir, async () => [check(true)]);
    expect(report.steps.map((s) => s.state)).toEqual(["completed", "blocked", "blocked"]);
    expect(report.next).toBe(`factory init --repo-dir ${dir}`);
  });

  test("a set-up repo runs doctor live: Ready completes, a failed check blocks with its detail", async () => {
    const dir = repoDir({ installed: true, config: filled });
    const ready = await buildOnboardReport(dir, async () => [check(true)]);
    expect(ready.status).toBe("completed");
    expect(ready.doctor).toBe("Ready");
    expect(ready.next).toContain("factory:ready");
    const bad = await buildOnboardReport(dir, async () => [check(false)]);
    expect(bad.status).toBe("blocked");
    expect(bad.doctor).toBe("Needs setup");
    expect(bad.next).toBe("gh authenticated: run gh auth login");
  });

  test("a doctor that throws is failed, and the status stays Not checked", async () => {
    const dir = repoDir({ installed: true, config: filled });
    const report = await buildOnboardReport(dir, async () => {
      throw new Error("gh missing");
    });
    expect(report.status).toBe("failed");
    expect(report.doctor).toBe("Not checked");
    expect(report.steps[2]?.next).toContain("gh missing");
  });

  test("an unlabelled issue starts nothing", async () => {
    const github = new FakeGitHub([baseIssue(1, []), baseIssue(2, ["bug"])]);
    const result = await dispatchJobs(
      { github, state: new FactoryState(":memory:") },
      mergeConfig({ repo: "acme/widgets" }),
    );
    expect(result).toEqual({ jobs: [] });
  });
});
