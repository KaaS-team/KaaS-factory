import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../src/config";
import { recordEvidence } from "../src/merge-evidence";
import { metricsFor } from "../src/metrics-get";
import { FactoryState } from "../src/state";

const REPO = "acme/web";
const CONFIG = mergeConfig({ repo: REPO, protectedPaths: ["infra/**"] });
const pass = { reviewers: [{ model: "m", blockers: 0 }] } as never;

function open(): { state: FactoryState; done: () => void } {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "metrics-evidence-"));
  return { state: new FactoryState(join(dir, "state.db")), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("metricsFor merge evidence", () => {
  test("reports agreement per repo and protected path plus readiness gaps from a fixture history", () => {
    const { state, done } = open();
    recordEvidence(state, CONFIG, { pr: 1, review: pass, decision: "APPROVED", paths: ["infra/a.tf"] });
    recordEvidence(state, CONFIG, { pr: 2, review: pass, decision: "CHANGES_REQUESTED", paths: ["infra/b.tf"] });
    recordEvidence(state, CONFIG, { pr: 3, review: pass, decision: "APPROVED", paths: ["src/x.ts"] });
    const got = metricsFor([{ repo: REPO, state, config: CONFIG }], { operator: false }).mergeEvidence;
    expect(got?.length).toBe(1);
    const report = got?.[0]?.report ?? "";
    expect(report).toContain("acme/web: agent versus human review, 2/3 agree");
    expect(report).toContain("infra/**: 1/2 agree");
    expect(report).toContain("merge.smokeUrl is not set");
    expect(report).toContain("thin review evidence: 3 of 10");
    done();
  });

  test("a source without its config adds no evidence section", () => {
    const { state, done } = open();
    expect(metricsFor([{ repo: REPO, state }], { operator: false }).mergeEvidence).toBe(undefined);
    done();
  });
});
