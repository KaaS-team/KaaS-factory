// Issue #44: a tracker card is customer-facing, so the text outside HTML
// comments never shows the worker's host, a dollar amount or a model.
// FakeGitHub and MemoryTracker refuse such a write (assertCustomerSafe), so
// every test that drives a comment through them checks it. This file walks
// every place src/ writes to a tracker and pins which test drives it through
// one of those fakes, so a new writer cannot land unchecked.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, relative, resolve } from "node:path";
import { GitHubSpend } from "../src/adapters/github-store/spend";
import { baseIssue, FakeGitHub, visibleLeaks } from "./harness";

const ROOT = resolve(import.meta.dir, "..");
const SRC = join(ROOT, "src");
const WRITE_RE = /\.(commentIssue|editComment|createIssue)\(/g;

// Every src file that writes to a tracker: how many call sites it has, and
// either the test that drives them through a checking fake, or why the
// visible text is not the factory's own rendering.
const WRITERS: Record<string, { sites: number; driver: string } | { sites: number; echoes: string }> = {
  "adapters/github-store/spend.ts": { sites: 3, driver: "tests/tracker-comments.test.ts" },
  "blockers.ts": { sites: 1, driver: "tests/blockers.test.ts" },
  "engine/common.ts": { sites: 3, driver: "tests/spend-caps.test.ts" },
  "engine/triggers.ts": { sites: 2, driver: "tests/triggers.test.ts" },
  "scm.ts": { sites: 7, driver: "tests/tracker-contract.test.ts" },
  "watch.ts": { sites: 3, driver: "tests/scenarios.test.ts" },
  "cli.ts": { sites: 1, echoes: "factory park posts the --reason its caller passed" },
  "inbox.ts": { sites: 1, echoes: "act posts the /factory command an operator typed" },
  "reset.ts": { sites: 1, echoes: "reset re-files the seed issues the repo itself holds" },
  "scan.ts": { sites: 1, echoes: "scan files the audit tool's own finding text" },
};

function writeSites(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!d.isFile() || !d.name.endsWith(".ts")) continue;
    const file = join(d.parentPath, d.name);
    const n = [...readFileSync(file, "utf8").matchAll(WRITE_RE)].length;
    if (n > 0) out[relative(SRC, file)] = n;
  }
  return out;
}

describe("tracker comments show no operator detail", () => {
  test("the visible-text check sees the #44 leak and ignores the hidden marker", () => {
    const leaked = `Factory spend by worker ${hostname()}-13647: $0.54 over 2 stage run(s).`;
    expect(visibleLeaks(leaked)).toContain("dollar amount");
    expect(visibleLeaks(`${leaked.replace(hostname(), "Params-MacBook-Pro-2.local")}`)).toContain(".local host");
    expect(visibleLeaks(`${leaked}`).some((l) => l.startsWith("hostname"))).toBe(true);
    expect(visibleLeaks("ran on claude-sonnet-5 (model)")).toContain("model");
    expect(
      visibleLeaks(
        `Factory usage record.\n<!-- factory:spend {"holder":"${hostname()}","costUsd":0.54,"model":"x"} -->`,
      ),
    ).toEqual([]);
  });

  test("every src file that writes to a tracker is listed, with its call-site count", () => {
    const listed = Object.fromEntries(Object.entries(WRITERS).map(([f, w]) => [f, w.sites]));
    expect(writeSites()).toEqual(listed);
  });

  test("each listed driver exists, drives its module, and writes through a checking fake", () => {
    for (const [file, w] of Object.entries(WRITERS)) {
      if (!("driver" in w)) continue;
      const path = join(ROOT, w.driver);
      expect(existsSync(path)).toBe(true);
      const text = readFileSync(path, "utf8");
      expect({ file, uses: /\b(FakeGitHub|MemoryTracker)\b/.test(text) }).toEqual({ file, uses: true });
    }
  });

  test("the spend ledger comment keeps the worker, host and dollars hidden, and reads back", async () => {
    const github = new FakeGitHub([baseIssue(1, [])]);
    const holder = `${hostname()}-${process.pid}`;
    const store = new GitHubSpend(github, "acme/repo", holder);
    const at = new Date().toISOString();
    await store.record({ issue: 1, stage: "build", costUsd: 0.54, tokensIn: 10, tokensOut: 5, at });
    await store.record({ issue: 1, stage: "verify", costUsd: null, tokensIn: 1, tokensOut: 1, at });
    const written = [...github.issues.values()].flatMap((i) => i.comments.map((c) => c.body));
    expect(written.length).toBe(2);
    for (const body of written) {
      expect(visibleLeaks(body)).toEqual([]);
      expect(body.replace(/<!--[\s\S]*?-->/g, "")).not.toContain(String(process.pid));
    }
    // A second handle on the same tracker reads the hidden marker back.
    const reader = new GitHubSpend(github, "acme/repo", "other");
    expect(await reader.issue(1)).toEqual({ costUsd: 0.54, unreportedRuns: 1 });
    expect(await reader.since(at)).toEqual({ costUsd: 0.54, unreportedRuns: 1 });
  });
});
