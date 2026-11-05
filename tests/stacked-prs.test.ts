import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryUp, nextToMerge, openStack, planStack, retargetAfterMerge } from "../src/stacked-prs";

const tasks = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];

describe("planStack", () => {
  test("a three-task epic in task mode is three PRs, each based on the previous", () => {
    expect(planStack(tasks, "task", "factory/epic-9", "main")).toEqual([
      { task: "t1", branch: "factory/epic-9-t1", base: "main" },
      { task: "t2", branch: "factory/epic-9-t2", base: "factory/epic-9-t1", parent: "t1" },
      { task: "t3", branch: "factory/epic-9-t3", base: "factory/epic-9-t2", parent: "t2" },
    ]);
  });

  test("epic mode and a single task stay one PR", () => {
    const one = [{ task: "factory/epic-9", branch: "factory/epic-9", base: "main" }];
    expect(planStack(tasks, "epic", "factory/epic-9", "main")).toEqual(one);
    expect(planStack([{ id: "t1" }], "task", "factory/epic-9", "main")).toEqual(one);
  });
});

describe("nextToMerge", () => {
  const plan = planStack(tasks, "task", "e", "main");

  test("the three PRs merge in order, each retargeted to the trunk", () => {
    const order: string[] = [];
    const merged: string[] = [];
    for (let next = nextToMerge(plan, merged, "main"); next; next = nextToMerge(plan, merged, "main")) {
      expect(next.retarget).toBe("main");
      order.push(next.pr.task);
      merged.push(next.pr.task);
    }
    expect(order).toEqual(["t1", "t2", "t3"]);
  });

  test("a PR whose parent is open waits", () => {
    expect(nextToMerge(plan, [], "main")?.pr.task).toBe("t1");
    expect(nextToMerge(plan, ["t1"], "main")?.pr.task).toBe("t2");
    expect(nextToMerge(plan, ["t1", "t2", "t3"], "main")).toBeUndefined();
  });
});

describe("acting on the stack", () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
    return out.trim();
  }
  const commit = async (dir: string, file: string, text: string, msg: string) => {
    writeFileSync(join(dir, file), text);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", msg);
  };

  // main <- e-t1 (a.txt) <- e-t2 (b.txt) <- e-t3 (c.txt), all pushed.
  async function stackRepo() {
    mkdirSync(tmpdir(), { recursive: true });
    const root = mkdtempSync(join(tmpdir(), "stacked-prs-"));
    roots.push(root);
    const remote = join(root, "remote.git");
    await git(root, "init", "-q", "--bare", "-b", "main", remote);
    const work = join(root, "work");
    await git(root, "clone", "-q", remote, work);
    for (const [k, v] of [
      ["user.email", "t@example.com"],
      ["user.name", "t"],
      ["commit.gpgsign", "false"],
    ])
      await git(work, "config", k!, v!);
    await git(work, "checkout", "-q", "-b", "main");
    await commit(work, "base.txt", "base\n", "base");
    await git(work, "push", "-q", "origin", "main");
    const plan = planStack(tasks, "task", "e", "main");
    for (const [i, p] of plan.entries()) {
      await git(work, "checkout", "-q", "-B", p.branch, i ? plan[i - 1]!.branch : "main");
      await commit(work, `${p.task}.txt`, `${p.task}\n`, p.task);
      await git(work, "push", "-q", "-f", "origin", p.branch);
    }
    return { work, plan, remote };
  }

  const fakeHost = () => {
    const created: { base: string; head: string; draft?: boolean }[] = [];
    const retargets: { number: number; base: string }[] = [];
    const open = new Map<string, { number: number; url: string }>();
    return {
      created,
      retargets,
      open,
      createPr: async (o: { base: string; head: string; draft?: boolean }) => {
        created.push({ base: o.base, head: o.head, draft: o.draft });
        const number = created.length;
        open.set(o.head, { number, url: `https://x/pull/${number}` });
        return `https://x/pull/${number}`;
      },
      findPrByHead: async (_r: string, head: string) => open.get(head),
      retargetPr: async (_r: string, number: number, base: string) => {
        retargets.push({ number, base });
      },
    };
  };

  test("open: one draft PR per slice, each based on the slice below, none duplicated on a second pass", async () => {
    const { plan } = await stackRepo();
    const host = fakeHost();
    const describe = (p: { task: string }) => ({ title: `slice ${p.task}`, body: "b" });
    await openStack(host, "o/r", plan, describe);
    expect(host.created).toEqual([
      { base: "main", head: "e-t1", draft: true },
      { base: "e-t1", head: "e-t2", draft: true },
      { base: "e-t2", head: "e-t3", draft: true },
    ]);
    await openStack(host, "o/r", plan, describe);
    expect(host.created).toHaveLength(3);
  });

  test("merge and retarget: the next slice is rebased onto the base and its PR base moves to it", async () => {
    const { work, plan } = await stackRepo();
    const host = fakeHost();
    await openStack(host, "o/r", plan, (p) => ({ title: p.task, body: "" }));
    // t1 squash-merges on main: same content, different commit.
    const t1Head = await git(work, "rev-parse", "e-t1");
    await git(work, "checkout", "-q", "main");
    await commit(work, "t1.txt", "t1\n", "squash t1");
    await git(work, "push", "-q", "origin", "main");
    const out = await retargetAfterMerge(host, work, "o/r", plan, ["t1"], "main", t1Head);
    expect("parked" in out).toBe(false);
    expect(out.retargeted?.task).toBe("t2");
    expect(host.retargets).toEqual([{ number: 2, base: "main" }]);
    const remoteT2 = await git(work, "ls-remote", "origin", "refs/heads/e-t2");
    expect(remoteT2.startsWith(await git(work, "rev-parse", "e-t2"))).toBe(true);
    // t2 now sits directly on main's tip, without t1's original commit.
    expect(await git(work, "rev-parse", "e-t2~1")).toBe(await git(work, "rev-parse", "origin/main"));
  });

  test("a fix on the bottom slice is carried up through every slice above it", async () => {
    const { work, plan } = await stackRepo();
    const old = await git(work, "rev-parse", "e-t1");
    await git(work, "checkout", "-q", "e-t1");
    await commit(work, "fix.txt", "fix\n", "review fix");
    const out = await carryUp(work, plan, "t1", old);
    expect("parked" in out).toBe(false);
    expect(out.carried).toEqual(["t2", "t3"]);
    for (const b of ["e-t2", "e-t3"]) {
      await git(work, "merge-base", "--is-ancestor", "e-t1", b);
      expect(await git(work, "show", `${b}:fix.txt`)).toBe("fix");
    }
  });

  test("a conflict in the middle of the stack parks naming the slice and file, and leaves no rebase running", async () => {
    const { work, plan } = await stackRepo();
    // t2 and t3 both touch shared.txt; the fix on t1 rewrites it too.
    for (const [b, text] of [
      ["e-t2", "two\n"],
      ["e-t3", "three\n"],
    ] as const) {
      await git(work, "checkout", "-q", b);
      if (b === "e-t3") await git(work, "rebase", "-q", "e-t2");
      await commit(work, "shared.txt", text, `shared ${b}`);
    }
    const old = await git(work, "rev-parse", "e-t1");
    await git(work, "checkout", "-q", "e-t1");
    await commit(work, "shared.txt", "one\n", "t1 shared");
    const out = await carryUp(work, plan, "t1", old);
    expect(out.parked?.task).toBe("t2");
    expect(out.parked?.reason).toContain("slice t2");
    expect(out.parked?.reason).toContain("shared.txt");
    expect(out.carried).toEqual([]);
    expect(existsSync(join(work, await git(work, "rev-parse", "--git-path", "rebase-merge")))).toBe(false);
  });
});
