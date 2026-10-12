// The tracker boundary: one contract run against the in-memory tracker and against
// the http adapter talking to the reference server; the route lists in code, server
// and docs held equal; branch-mode linking; and one end-to-end pickup through it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpTracker, TRACKER_ROUTES } from "../src/adapters/http-tracker";
import { ComposedScm, LabelMappedTracker, makeScm, PR_LINK_MARKER, unlinkClosingKeywords } from "../src/scm";
import { mergeConfig } from "../src/config";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { pollOnce } from "../src/watch";
import { EventBus } from "../src/engine/bus";
import { MemoryTracker, SERVER_ROUTES, startTracker } from "./fixtures/tracker-server";
import { FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner, fixtureFor, MultiStageExecutor } from "./harness";
import { trackerContract } from "./ports/tracker.contract";

const TOKEN = "s3cret-test-token";
const server = startTracker(TOKEN);
const env = { TRACKER_TOKEN: TOKEN };
const spec = { kind: "http" as const, url: server.url, tokenEnv: "TRACKER_TOKEN" };
const dirs: string[] = [];
afterAll(() => {
  server.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

trackerContract("in-memory", () => new MemoryTracker());
trackerContract("http adapter against the reference server", () => new HttpTracker(spec, env));

describe("http tracker auth", () => {
  test("a wrong token is refused, and authStatus says so without throwing", async () => {
    const t = new HttpTracker(spec, { TRACKER_TOKEN: "wrong" });
    await expect(t.currentLogin()).rejects.toThrow(/401/);
    const auth = await t.authStatus();
    expect(auth.ok).toBe(false);
    expect(auth.detail).not.toContain("wrong");
  });
  test("an unset token env var names the var, before any request", async () => {
    const t = new HttpTracker(spec, {});
    await expect(t.listOpenIssues("acme/x")).rejects.toThrow("env var TRACKER_TOKEN is not set");
  });
  test("tracker.project overrides the repo as the project key", async () => {
    const t = new HttpTracker({ ...spec, project: "TEAM-1" }, env);
    const n = await t.createIssue("acme/ignored", "x", "", []);
    expect((await server.store.getIssue("TEAM-1", n)).title).toBe("x");
  });
});

describe("Tracker API v1 routes", () => {
  // The docs table's first column, query strings dropped: the published contract.
  const doc = readFileSync(join(import.meta.dir, "..", "docs", "tracker-api.md"), "utf8");
  const docRoutes = [...doc.matchAll(/^\| `(GET|POST|PUT|PATCH|DELETE) ([^`?]+)(?:\?[^`]*)?` \|/gm)].map((m) => `${m[1]} ${m[2]}`);
  const set = (xs: readonly string[]) => [...new Set(xs)].sort();

  test("every TrackerPort method has a route the server serves and the docs list, and no extras", () => {
    expect(docRoutes.length).toBeGreaterThan(0);
    expect(set(Object.values(TRACKER_ROUTES))).toEqual(set(SERVER_ROUTES));
    expect(set(docRoutes)).toEqual(set(SERVER_ROUTES));
  });
});

describe("branch-mode linking", () => {
  function composed() {
    const tracker = new MemoryTracker();
    const host = new FakeGitHub([]);
    return { tracker, host, scm: new ComposedScm(tracker, host, "branch") };
  }

  test("closing keywords are rewritten so they cannot close a GitHub issue", () => {
    expect(unlinkClosingKeywords("Did it.\nCloses #12, fixes: #3 and Resolved #4; see #5")).toBe(
      "Did it.\nCloses tracker issue 12, fixes: tracker issue 3 and Resolved tracker issue 4; see #5",
    );
  });

  test("createPr comments the PR URL on the tracker issue and keeps #n out of the body", async () => {
    const { tracker, host, scm } = composed();
    const n = await tracker.createIssue("acme/w", "x", "", []);
    const url = await scm.createPr({ repo: "acme/w", head: `factory/issue-${n}`, base: "main", title: "Fix #1 widget", body: "Closes #1", draft: true });
    expect(host.createdPrs[0]).toMatchObject({ title: "Fix tracker issue 1 widget", body: "Closes tracker issue 1" });
    expect((await tracker.getIssue("acme/w", n)).comments.map((c) => c.body)).toEqual([`Pull request: ${url}\n\n${PR_LINK_MARKER}`]);
  });

  test("prForIssue finds the PR by head branch and honours excludeHead; references come from the head", async () => {
    const { host, scm } = composed();
    await host.createPr({ repo: "acme/w", head: "factory/issue-7", base: "main", title: "t", body: "Closes #99", draft: false });
    expect((await scm.prForIssue("acme/w", 7))?.number).toBe(1);
    expect(await scm.prForIssue("acme/w", 7, { excludeHead: "factory/issue-7" })).toBeUndefined();
    expect(await scm.prForIssue("acme/w", 99)).toBeUndefined();
    expect((await scm.getPr("acme/w", 1)).closingIssuesReferences).toEqual([{ number: 7 }]);
    host.queuePrStatus(1, { closingIssuesReferences: [{ number: 99 }] } as never);
    expect((await scm.prStatus("acme/w", 1)).closingIssuesReferences).toEqual([{ number: 7 }]);
  });

  test("a merge closes the tracker issue the head names", async () => {
    const { tracker, host, scm } = composed();
    const n = await tracker.createIssue("acme/w", "x", "", []);
    await host.createPr({ repo: "acme/w", head: `factory/issue-${n}`, base: "main", title: "t", body: "", draft: false });
    host.mergePr = async () => {};
    await scm.mergePr("acme/w", 1, "abc");
    expect((await tracker.getIssue("acme/w", n)).state).toBe("CLOSED");
  });

  test("makeScm picks closes mode for github and branch mode for http, and maps labels", async () => {
    expect(makeScm(mergeConfig({ repo: "acme/w" })).link).toBe("closes");
    const scm = makeScm(mergeConfig({ repo: "acme/w", tracker: spec, labels: { [LABEL.ready]: "ready-for-ai" } }), env);
    expect([scm.link, scm.trackerKind]).toEqual(["branch", "http"]);
    const n = await scm.createIssue("acme/mapped", "x", "", [LABEL.ready]);
    expect((await server.store.getIssue("acme/mapped", n)).labels).toEqual([{ name: "ready-for-ai" }]);
    expect((await scm.getIssue("acme/mapped", n)).labels).toEqual([{ name: LABEL.ready }]);
  });
});

describe("end to end on an http tracker", () => {
  // A ready issue on the reference server, driven by the runner to in-review with its PR open.
  async function runToReview() {
    const repo = "acme/widgets";
    const team = { [LABEL.ready]: "ready-for-ai", [LABEL.inReview]: "ai-in-review" };
    const http = new HttpTracker(spec, env);
    const host = new FakeGitHub([]);
    const github = new ComposedScm(new LabelMappedTracker(http, team), host, "branch", "http");
    const n = await github.createIssue(repo, "Fix the widget", "It is broken.", [LABEL.ready]);
    expect((await server.store.getIssue(repo, n)).labels).toEqual([{ name: "ready-for-ai" }]);

    const workspacesDir = mkdtempSync(join(tmpdir(), "factory-ws-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "factory-clone-"));
    dirs.push(workspacesDir, cloneDir);
    const state = new FactoryState(":memory:");
    state.setToggle("auto_approve_low_risk", true);
    const executor = new MultiStageExecutor();
    const push = (stage: Parameters<typeof fixtureFor>[0], files: Record<string, string>) => executor.push(stage, n, fixtureFor(stage, n), files);
    push("triage", {
      "triage-comment.md": "<!-- factory:triage v1 -->\ntriage",
      "triage.json": JSON.stringify({ disposition: "proceed", type: "bug", risk: "low", done_when: "x", files_expected: ["src/a.ts"], gate_level: "make check", confidence: 0.9 }),
    });
    push("plan", {
      "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
      "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["src/a.ts"], autoApproveEligible: true }),
    });
    push("build", { "status-comment.md": "<!-- factory:status v1 -->\nbuilding", "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }) });
    push("verify", { "verdict-comment.md": "<!-- factory:verdict v1 -->\nverdict", "verdict.json": JSON.stringify({ result: "pass", rounds: 1, findings: [] }) });
    push("pr", { "pr-body.md": `Did it.\nCloses #${n}` });

    const bus = new EventBus({ store: state, sinks: [], source: "s", autoDeliver: false });
    const deps = { github, git: new FakeGit(), state, executor, gateRunner: new FakeGateRunner(), holdoutRunner: new FakeHoldoutRunner(), cloneDir, workspacesDir, bus };
    await pollOnce(deps, mergeConfig({ repo }));
    return { repo, n, host, state, deps };
  }

  test("a ready issue is picked up by the runner and ends with its PR URL commented back", async () => {
    const { repo, n, host, state } = await runToReview();
    const issue = await server.store.getIssue(repo, n);
    expect(issue.labels).toEqual([{ name: "ai-in-review" }]);
    const url = `https://github.com/${repo}/pull/1`;
    expect(issue.comments.some((c) => c.body.includes(`Pull request: ${url}`))).toBe(true);
    expect(host.createdPrs).toHaveLength(1);
    expect(host.createdPrs[0]!.head).toBe(`factory/issue-${n}`);
    expect(host.createdPrs[0]!.body).not.toContain(`#${n}`);
    expect(host.createdPrs[0]!.body).toContain(`Closes tracker issue ${n}`);
    state.close();
  });

  // merge.policy is off (the default), so only the watcher noticing the merge closes the tracker issue.
  test("a PR a human merges on GitHub closes the tracker issue and emits pr.merged by human, once", async () => {
    const { repo, n, host, state, deps } = await runToReview();
    (host.prs[0] as { state: string }).state = "merged";
    await pollOnce(deps, mergeConfig({ repo }));
    const issue = await server.store.getIssue(repo, n);
    expect(issue.state).toBe("CLOSED");
    expect(issue.labels).toEqual([]);
    const merged = () => state.busEvents().filter((e) => e.type === "factory.pr.merged").map((e) => JSON.parse(e.data));
    expect(merged()).toEqual([{ repo, issue: n, pr: 1, by: "human" }]);
    expect(state.listRetros(repo).map((r) => r.outcome)).toEqual(["merged"]);
    await pollOnce(deps, mergeConfig({ repo }));
    expect(merged()).toHaveLength(1);
    expect(state.listRetros(repo)).toHaveLength(1);
    state.close();
  });
});
