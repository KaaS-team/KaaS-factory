// Running with no watcher: `factory dispatch` for an Actions matrix, `factory routine` for a cloud tick.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudRoutine, dispatchJobs, INTAKE_LABELS, RESUME_LABELS, writeActionsOutput } from "../src/dispatch";
import { COMMANDS } from "../src/help";
import { LABEL } from "../src/labels";
import { baseIssue, FakeGitHub } from "./harness";

describe("dispatch and routine", () => {
  test("dispatch names the issues one tick would advance, and a routine runs factory tick on its cron", async () => {
    const blocked = { ...baseIssue(3, [LABEL.ready]), body: "Blocked by: #9" };
    const github = new FakeGitHub([
      baseIssue(5, [LABEL.awaitingApproval]),
      baseIssue(2, [LABEL.ready]),
      blocked,
      baseIssue(9, []),
      baseIssue(4, [LABEL.building]),
      baseIssue(6, [LABEL.ready, "needs:gpu"]),
      baseIssue(7, [LABEL.failed]),
    ]);
    const result = await dispatchJobs(github, "acme/widgets", { maxOpenFactoryPrs: 3 });
    expect(result).toEqual({
      jobs: [
        { issue: 2, label: LABEL.ready },
        { issue: 5, label: LABEL.awaitingApproval },
        { issue: 7, label: LABEL.failed },
      ],
    });
    const gpu = await dispatchJobs(github, "acme/widgets", { maxOpenFactoryPrs: 3, capabilities: ["gpu"] });
    expect(gpu.jobs.map((j) => j.issue)).toEqual([2, 5, 6, 7]);

    const out = join(mkdtempSync(join(tmpdir(), "factory-dispatch-")), "output");
    writeActionsOutput(result, out);
    expect(readFileSync(out, "utf8")).toBe('matrix={"include":[{"issue":2},{"issue":5},{"issue":7}]}\ncount=3\n');

    // STOP_IF holds new pickups back, never a resume.
    github.prs = [1, 2, 3].map((n) => ({
      number: n,
      url: `https://github.com/acme/widgets/pull/${n}`,
      state: "open" as const,
      headRefName: `factory/issue-${n}`,
      isDraft: false,
    }));
    const held = await dispatchJobs(github, "acme/widgets", { maxOpenFactoryPrs: 3 });
    expect(held.jobs.map((j) => j.issue)).toEqual([5, 7]);
    expect(held.paused).toContain("STOP_IF");

    const routine = cloudRoutine({ repo: "acme/widgets", runnerRepo: "KaaS-team/KaaS-factory", runnerRef: "v5.4.0" });
    expect(routine.cron).toBe("*/30 * * * *");
    expect(routine.prompt).toContain('bin/factory" tick --repo acme/widgets --json');
    expect(routine.prompt).toContain("--branch v5.4.0 https://github.com/KaaS-team/KaaS-factory.git");
    const used = [...routine.prompt.matchAll(/bin\/factory" (\w+)/g)].map((m) => m[1]);
    expect(used.every((c) => COMMANDS.some((k) => k.name === c))).toBe(true);
    expect(() =>
      cloudRoutine({ repo: "acme/widgets", runnerRepo: "x/y", runnerRef: "v1", cron: "every hour" }),
    ).toThrow("needs 5 fields");
    expect(() => cloudRoutine({ repo: "acme; rm -rf /", runnerRepo: "x/y", runnerRef: "v1" })).toThrow("owner/name");
  });

  test("dispatch lists the same labels pollOnce does", () => {
    const watch = readFileSync(join(import.meta.dir, "../src/watch.ts"), "utf8");
    const listed = watch.slice(watch.indexOf("const [readyRaw"), watch.indexOf("const { clear: ready }"));
    const labels = [...listed.matchAll(/listIssuesByLabel\(config\.repo, LABEL\.(\w+)\)/g)].map(
      (m) => LABEL[m[1] as keyof typeof LABEL],
    );
    expect(labels.sort()).toEqual([...INTAKE_LABELS, ...RESUME_LABELS, LABEL.blocked].sort());
  });
});
