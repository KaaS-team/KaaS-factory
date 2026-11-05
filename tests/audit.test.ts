// `factory audit`: three lenses, one report with findings, fixes and a plan, filed as issues on request.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, type AuditInput, LENSES, renderReport } from "../src/audit";
import { fileFindings, parseChanges, readAuditInput } from "../src/audit-cli";
import { FakeGitHub } from "./harness";

const dir = join(import.meta.dir, "fixtures", "audit");
const fixture = JSON.parse(readFileSync(join(dir, "repo.json"), "utf8")) as Pick<AuditInput, "files" | "changes">;
const input: AuditInput = { ...fixture, read: () => undefined };

describe("audit", () => {
  test("scores three lenses, each out of 100", () => {
    const report = audit(input);
    expect(report.scores.map((s) => s.lens)).toEqual([...LENSES]);
    expect(LENSES).toEqual(["repo", "process", "prs"]);
    for (const s of report.scores) expect(s.score).toBeGreaterThanOrEqual(0);
    const repo = report.scores.find((s) => s.lens === "repo")!;
    expect(repo.score).toBe(Math.round((repo.passed / repo.total) * 100));
    expect(repo.passed).toBeLessThan(repo.total);
  });

  test("every finding has a fix and sits in the plan; the layers agree", () => {
    const report = audit(input);
    expect(report.findings.length).toBeGreaterThan(0);
    const planned = report.plan.flatMap((p) => p.findings).sort();
    expect(planned).toEqual(report.findings.map((f) => f.id).sort());
    for (const f of report.findings) expect(f.fix.length).toBeGreaterThan(0);
    expect(report.findings[0]!.severity).toBe("high");
  });

  test("the lens that finds a problem is the one that scores it", () => {
    const withCi = audit({ ...input, files: [...input.files, ".github/workflows/ci.yml"] });
    expect(audit(input).findings.some((f) => f.id === "repo-ci")).toBe(true);
    expect(withCi.findings.some((f) => f.id === "repo-ci")).toBe(false);
    const noPrs = audit({ ...input, changes: [] });
    expect(noPrs.findings.some((f) => f.lens === "prs")).toBe(true);
    const tidy = audit({ ...input, changes: input.changes.filter((c) => !c.subject.startsWith("Revert")) });
    expect(tidy.findings.some((f) => f.id === "prs-reverts")).toBe(false);
    expect(audit(input).findings.some((f) => f.id === "prs-reverts")).toBe(true);
  });

  test("a fixture repo produces the golden report", () => {
    const golden = readFileSync(join(dir, "report.golden.md"), "utf8");
    expect(renderReport(audit(input))).toBe(golden);
    expect(renderReport(audit(input))).toBe(renderReport(audit(input)));
  });

  test("findings file as issues, and a second run skips the ones still open", async () => {
    const github = new FakeGitHub([]);
    const report = audit(input);
    const first = await fileFindings(github, "acme/w", report);
    expect(first.filed).toEqual(report.findings.map((f) => f.id));
    const second = await fileFindings(github, "acme/w", report);
    expect(second.filed).toEqual([]);
    expect(second.skipped).toEqual(first.filed);
  });

  test("a git repo is read as files plus first-parent PR changes", () => {
    mkdirSync(tmpdir(), { recursive: true });
    const repo = mkdtempSync(join(tmpdir(), "factory-audit-"));
    const g = (...a: string[]) =>
      Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], {
        cwd: repo,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    g("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.ts"), "x");
    g("add", "-A");
    g("commit", "-qm", "feat: a (#7)");
    const read = readAuditInput(repo);
    expect(read.files).toEqual(["a.ts"]);
    expect(read.changes).toEqual([{ pr: "7", subject: "feat: a (#7)", files: ["a.ts"] }]);
    expect(parseChanges("\u0001no number\nx.ts\n")).toEqual([]);
  });
});
