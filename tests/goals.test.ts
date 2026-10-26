// goals.json is the one list of what was asked and how each ask is proven; these pin its rules.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  declaresTest,
  type Goal,
  type Ledger,
  lint,
  next,
  type Repo,
  repoAt,
  untrackedDeferrals,
  weakProbe,
} from "../scripts/goals";

const ROOT = join(import.meta.dir, "..");
const ledger = JSON.parse(readFileSync(join(ROOT, "goals.json"), "utf8")) as Ledger;

const fake = (files: Record<string, string>, version = "5.0.0", mutations: Repo["mutations"] = []): Repo => ({
  read: (p) => files[p],
  version,
  mutations,
});
const goal = (over: Partial<Goal> = {}): Goal => ({
  id: "g",
  phase: "P1",
  ask: "an ask",
  source: "user",
  owner: "agent",
  ...over,
});
const doc = (...goals: Goal[]): Ledger => ({ phases: [{ id: "P1", title: "one", release: "5.1.0" }], goals });

test("the ledger lints clean against this repo", () => {
  expect(lint(ledger, repoAt(ROOT))).toEqual([]);
});

describe("goals rules", () => {
  test("a probe that only checks existence, echoes or calls --help is refused", () => {
    expect(weakProbe("#!/bin/bash\nbun bin/factory pool --help >/dev/null\n")).toBe("calls --help");
    expect(weakProbe("#!/bin/bash\nset -e\ntest -f tests/x.test.ts\n")).toBe("only checks existence or echoes");
    expect(weakProbe("echo 'not built' >&2\nexit 1\n")).toBe("only checks existence or echoes");
    expect(weakProbe("#!/bin/bash\ncurl -sf https://factory.kaas.team/health | grep -q ok\n")).toBeUndefined();
    expect(weakProbe("true\n")).toBe("only checks existence or echoes");
    expect(weakProbe(":\n")).toBe("only checks existence or echoes");
    expect(weakProbe("bun test tests/x.test.ts || true\n")).toBe("swallows a failure with || true");
  });

  test("a probe is a script directly under scripts/probes", () => {
    const run = "bun test tests/x.test.ts\n";
    const files = { "scripts/probes/x.sh": run, "scripts/probes/../../package.json": run };
    expect(lint(doc(goal({ proof: { probe: "scripts/probes/x.sh" } })), fake(files))).toEqual([]);
    expect(lint(doc(goal({ proof: { probe: "scripts/probes/../../package.json" } })), fake(files))).toEqual([
      "goal g: a probe is scripts/probes/<name>.sh",
    ]);
  });

  test("a test proof needs the named test and a mutation on that file", () => {
    const proof = { test: "tests/a.test.ts", name: "it works", mutation: "a: it works" };
    const files = { "tests/a.test.ts": 'test("it works", () => {});' };
    expect(
      lint(doc(goal({ proof })), fake(files, "5.0.0", [{ name: "a: it works", test: "tests/a.test.ts" }])),
    ).toEqual([]);
    expect(lint(doc(goal({ proof })), fake(files))).toEqual([
      'goal g: mutation "a: it works" is not in tests/mutations.json for tests/a.test.ts',
    ]);
    expect(
      lint(
        doc(goal({ proof: { ...proof, name: "other" } })),
        fake(files, "5.0.0", [{ name: "a: it works", test: "tests/a.test.ts" }]),
      ),
    ).toEqual(['goal g: no test named "other" in tests/a.test.ts']);
  });

  test("a test name in a comment or a stray string is not a test", () => {
    expect(declaresTest('test("it works", () => {});', "it works")).toBe(true);
    expect(declaresTest('  test(\n    "it works",\n    () => {},\n  );', "it works")).toBe(true);
    expect(declaresTest('// test("it works", () => {});', "it works")).toBe(false);
    expect(declaresTest('test("it works", () => {});', "it")).toBe(false);
    expect(declaresTest('const x = "it works";', "it works")).toBe(false);
  });

  test("out needs Param's quote and a date", () => {
    const out = { by: "param" as const, quote: "drop it", date: "2026-10-26" };
    expect(lint(doc(goal({ out })), fake({}))).toEqual([]);
    expect(lint(doc(goal({ out: { ...out, quote: " " } })), fake({}))).toEqual([
      'goal g: out needs {by: "param", quote, date}',
    ]);
  });

  test("a deferral after v5.0.0 must name a goal that exists", () => {
    const log =
      "# Changelog\n\n## v5.1.0\n\nNot in this release:\n\n- A thing (goal: g).\n- Another thing.\n- Third (goal: nope).\n\n## v5.0.0\n\nNot in this release:\n\n- Old.\n";
    expect(untrackedDeferrals(log, new Set(["g"]))).toEqual([
      "CHANGELOG v5.1.0: deferral names no goal: - Another thing.",
      "CHANGELOG v5.1.0: goal nope is not in goals.json",
    ]);
  });

  test("a release that includes a phase needs a proof for each of its goals", () => {
    expect(lint(doc(goal()), fake({}, "5.0.1"))).toEqual([]);
    expect(lint(doc(goal()), fake({}, "5.1.0"))).toEqual([
      "goal g: v5.1.0 includes phase P1, but this goal has no proof",
    ]);
  });

  test("SessionStart prints the next goal, and next skips proven and out goals", () => {
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8"));
    const commands = settings.hooks.SessionStart.flatMap((h: { hooks: { command: string }[] }) =>
      h.hooks.map((x) => x.command),
    );
    expect(commands.some((c: string) => c.endsWith("bun scripts/goals.ts --next"))).toBe(true);
    const proof = { probe: "scripts/probes/x.sh" };
    const out = { by: "param" as const, quote: "q", date: "2026-10-26" };
    expect(next(doc(goal({ id: "a", proof }), goal({ id: "b", out }), goal({ id: "c" })))?.id).toBe("c");
  });

  test("every deferral bullet from v3.1.0 to v5.0.0 is a goal", () => {
    const sources = new Set(ledger.goals.map((g) => g.source));
    const missing: string[] = [];
    for (const section of readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").split(/^## /m).slice(1)) {
      const version = section.split(/\s/)[0]!;
      const at = section.indexOf("Not in this release");
      if (at === -1 || !/^v(3\.[1-9]|4|5\.0\.0)/.test(version)) continue;
      const bullets = section
        .slice(at)
        .split(/\n(?=- )/)
        .slice(1);
      bullets.forEach((_, i) => {
        if (!sources.has(`CHANGELOG ${version} #${i + 1}`)) missing.push(`${version} #${i + 1}`);
      });
    }
    expect(missing).toEqual([]);
  });
});
