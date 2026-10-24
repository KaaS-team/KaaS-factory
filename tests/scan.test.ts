// scan.ts parses `bun audit --json`'s real shape — a real 1.3.14 capture
// from splitbill lives in fixtures/, not a hand-written guess. Before this
// file, parseAuditFindings assumed `{ advisories: [...] }` with a
// `module_name`/`ghsa_id` per advisory; the real output is
// `Record<package, Advisory[]>` with neither field, which would have parsed
// to zero findings against the live repo (audit finding #6).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OSV_ARGV,
  parseAuditFindings,
  parseLighthouseFindings,
  parseOsvFindings,
  scan,
  scanLighthouse,
  type ScanDeps,
} from "../src/scan";
import { GitHub, type CommandResult, type CommandRunner, type GhIssue } from "../src/github";
import { LABEL } from "../src/labels";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "bun-audit-splitbill.json"), "utf8");
const OSV_FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "osv-splitbill.json"), "utf8");

// A Bun project, as far as scan() checks: it never shells out to `bun audit`
// without this marker (plan v2.6.2 item 6).
const bunProjectDir = mkdtempSync(join(tmpdir(), "factory-scan-"));
writeFileSync(join(bunProjectDir, "bun.lock"), "{}");
afterAll(() => rmSync(bunProjectDir, { recursive: true, force: true }));

describe("parseAuditFindings", () => {
  test("groups the real splitbill capture into one finding per package, not per advisory", () => {
    const findings = parseAuditFindings(FIXTURE);
    expect(findings).toHaveLength(2);
    const ids = findings.map((f) => f.id).sort();
    expect(ids).toEqual(["audit:hono", "audit:nanoid"]);
  });

  test("the hono finding rolls up all 41 advisories and cites the worst severity", () => {
    const findings = parseAuditFindings(FIXTURE);
    const hono = findings.find((f) => f.id === "audit:hono")!;
    expect(hono.title).toContain("41 advisories in hono");
    expect(hono.title).toContain("worst: high");
    expect(hono.labelType).toBe("security");
    expect(hono.body).toContain("<!-- factory:scan id=audit:hono -->");
    expect(hono.body).toContain("**Package:** hono");
    // Every advisory's GHSA id (pulled from its url, not a module_name field
    // that doesn't exist in the real payload) shows up in the body.
    expect(hono.body).toContain("GHSA-q7jf-gf43-6x6p");
  });

  test("the nanoid finding is separate from hono's", () => {
    const findings = parseAuditFindings(FIXTURE);
    const nanoid = findings.find((f) => f.id === "audit:nanoid")!;
    expect(nanoid.title).toContain("4 advisories in nanoid");
    expect(nanoid.body).toContain("GHSA-xwg4-73v4-xw9w");
  });

  test("an empty audit ({} - no advisories) parses to no findings", () => {
    expect(parseAuditFindings("{}")).toEqual([]);
  });

  test("unparseable JSON parses to no findings rather than throwing", () => {
    expect(parseAuditFindings("not json")).toEqual([]);
  });

  test("an array payload (not the real object-keyed shape) parses to no findings", () => {
    expect(parseAuditFindings("[]")).toEqual([]);
  });
});

class FakeGitHub extends GitHub {
  created: { title: string; body: string; labels: string[] }[] = [];
  constructor(private readonly openIssues: GhIssue[]) {
    super();
  }
  override async listOpenIssues(): Promise<GhIssue[]> {
    return this.openIssues;
  }
  override async createIssue(_repo: string, title: string, body: string, labels: string[]): Promise<number> {
    this.created.push({ title, body, labels });
    return 42;
  }
}

// Answers by program name; a program with no answer is not installed (127).
class FakeRunner implements CommandRunner {
  calls: string[][] = [];
  constructor(private readonly answers: Record<string, CommandResult>) {}
  async run(argv: string[]): Promise<CommandResult> {
    this.calls.push(argv);
    return this.answers[argv[0]!] ?? { stdout: "", stderr: "not installed", code: 127 };
  }
}
// bun audit exits non-zero when it finds advisories; so does osv-scanner (1).
const bunOnly = (stdout = FIXTURE) => new FakeRunner({ bun: { stdout, stderr: "", code: 1 } });
const osv = (stdout: string, code = 1) =>
  new FakeRunner({ "osv-scanner": { stdout, stderr: "", code }, bun: { stdout: FIXTURE, stderr: "", code: 1 } });

function issue(number: number, body: string): GhIssue {
  return { number, title: "seed", body, labels: [], comments: [] };
}

describe("scan()", () => {
  test("files only the finding not already open, per plan's audit:hono seed marker", async () => {
    // Mirrors the splitbill seed: issue #6 already carries the audit:hono
    // marker (filed by hand as the workshop's seeded dependency issue), so a
    // live scan should only file nanoid.
    const github = new FakeGitHub([issue(6, "some body\n<!-- factory:scan id=audit:hono -->\nmore text")]);
    const deps: ScanDeps = { github, runner: bunOnly() };
    const result = await scan(deps, "acme/widgets", bunProjectDir);

    expect(result.skipped).toHaveLength(1);
    expect(result.filed).toHaveLength(1);
    expect(github.created).toHaveLength(1);
    expect(github.created[0]!.title).toContain("nanoid");
    expect(github.created[0]!.labels).toEqual(["security", LABEL.monitor]);
  });

  test("files both findings when nothing is open yet", async () => {
    const github = new FakeGitHub([]);
    const deps: ScanDeps = { github, runner: bunOnly() };
    const result = await scan(deps, "acme/widgets", bunProjectDir);
    expect(result.filed).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  test("without osv-scanner, a Bun project calls only bun audit, never bun outdated (there is no outdated --json)", async () => {
    const runner = bunOnly("{}");
    const result = await scan({ github: new FakeGitHub([]), runner }, "acme/widgets", bunProjectDir);
    expect(runner.calls).toEqual([OSV_ARGV, ["bun", "audit", "--json"]]);
    expect(result.source).toBe("bun audit");
  });

  test("without osv-scanner, a repo with no bun.lock skips with a clear message, never running bun", async () => {
    const runner = bunOnly();
    const noBunDir = mkdtempSync(join(tmpdir(), "factory-scan-py-"));
    const github = new FakeGitHub([]);
    const result = await scan({ github, runner }, "acme/pyapp", noBunDir);
    expect(result).toEqual({ filed: [], skipped: [], skippedReason: expect.stringContaining("install osv-scanner") });
    expect(runner.calls).toEqual([OSV_ARGV]);
    expect(github.created).toEqual([]);
    rmSync(noBunDir, { recursive: true, force: true });
  });

  test("osv-scanner wins when installed, on any repo, and bun is never run", async () => {
    const runner = osv(OSV_FIXTURE);
    const github = new FakeGitHub([issue(6, "<!-- factory:scan id=audit:hono -->")]);
    const pyDir = mkdtempSync(join(tmpdir(), "factory-scan-osv-"));
    const result = await scan({ github, runner }, "acme/widgets", pyDir);
    rmSync(pyDir, { recursive: true, force: true });
    expect(runner.calls).toEqual([OSV_ARGV]);
    expect(result).toMatchObject({
      source: "osv-scanner",
      filed: [expect.stringContaining("nanoid")],
      skipped: [expect.stringContaining("hono")],
    });
  });

  test("osv-scanner with no lockfile it reads, or an error, skips: its output is never read as zero findings", async () => {
    expect(
      (await scan({ github: new FakeGitHub([]), runner: osv("", 128) }, "a/b", bunProjectDir)).skippedReason,
    ).toContain("no lockfile");
    const failed = await scan({ github: new FakeGitHub([]), runner: osv("", 2) }, "a/b", bunProjectDir);
    expect(failed.skippedReason).toContain("osv-scanner failed (exit 2)");
  });
});

describe("parseOsvFindings", () => {
  test("the real splitbill capture: one finding per package, severity lowercased, same marker as bun audit", () => {
    const findings = parseOsvFindings(OSV_FIXTURE);
    expect(findings.map((f) => f.id)).toEqual(["audit:hono", "audit:nanoid"]);
    const nanoid = findings[1]!;
    expect(nanoid.title).toBe("4 advisories in nanoid (worst: high)");
    expect(nanoid.body).toContain("<!-- factory:scan id=audit:nanoid -->");
    expect(nanoid.body).toContain("from `osv-scanner`");
  });

  test("a package in two lockfiles is one finding, its advisories merged by id", () => {
    const report = JSON.parse(OSV_FIXTURE);
    report.results.push(structuredClone(report.results[0]));
    const findings = parseOsvFindings(JSON.stringify(report));
    expect(findings).toHaveLength(2);
    expect(findings[1]!.title).toStartWith("4 advisories");
  });

  test("no results, and unparseable output, are no findings", () => {
    expect(parseOsvFindings('{"results":[]}')).toEqual([]);
    expect(parseOsvFindings("not json")).toEqual([]);
  });
});

// The shape a target's lighthouse.mjs writes with LIGHTHOUSE_REPORT set: one row per category under its bar.
const LIGHTHOUSE = JSON.stringify({
  misses: [
    { path: "/pricing", mode: "mobile", category: "Performance", score: 91, bar: 95, audits: ["lcp: LCP (3.1 s)"] },
    { path: "/pricing", mode: "desktop", category: "Accessibility", score: 96, bar: 100, audits: [] },
    { path: "/blog", mode: "mobile", category: "SEO", score: 92, bar: 100 },
  ],
});

describe("scanLighthouse()", () => {
  test("files one bug per page, naming its worst miss, under factory:monitor", async () => {
    const github = new FakeGitHub([]);
    const result = await scanLighthouse(github, "acme/site", LIGHTHOUSE);
    expect(result.source).toBe("lighthouse");
    expect(github.created.map((c) => c.title)).toEqual([
      "Lighthouse below the bar on /pricing (mobile Performance 91, bar 95)",
      "Lighthouse below the bar on /blog (mobile SEO 92, bar 100)",
    ]);
    expect(github.created[0]!.labels).toEqual(["bug", LABEL.monitor]);
    expect(github.created[0]!.body).toContain("<!-- factory:scan id=lighthouse:/pricing -->");
    expect(github.created[0]!.body).toContain("desktop Accessibility:** 96, bar 100");
    expect(github.created[0]!.body).toContain("lcp: LCP (3.1 s)");
  });

  test("a page already open is never filed again, so a nightly miss stays one issue", async () => {
    const github = new FakeGitHub([issue(9, "<!-- factory:scan id=lighthouse:/pricing -->")]);
    const result = await scanLighthouse(github, "acme/site", LIGHTHOUSE);
    expect(result.skipped).toHaveLength(1);
    expect(github.created.map((c) => c.title)).toEqual([expect.stringContaining("/blog")]);
  });

  test("a clean run files nothing", async () => {
    const github = new FakeGitHub([]);
    expect((await scanLighthouse(github, "acme/site", '{"misses":[]}')).filed).toEqual([]);
    expect(github.created).toEqual([]);
  });

  test("a report with no misses array is a skip with a reason, never a pass", async () => {
    const github = new FakeGitHub([]);
    const result = await scanLighthouse(github, "acme/site", "lighthouse crashed");
    expect(result.skippedReason).toContain("misses");
    // JSON of the wrong shape (a run that wrote its error object) is a skip too
    expect((await scanLighthouse(github, "acme/site", '{"error":"NO_FCP"}')).skippedReason).toContain("misses");
    expect(parseLighthouseFindings("{}")).toEqual([]);
    expect(github.created).toEqual([]);
  });
});
