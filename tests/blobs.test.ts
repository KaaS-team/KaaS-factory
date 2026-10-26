// Transcripts and artifacts reach a shared blob store when a stage ends, and the plane mirrors them
// back onto the paths its run page reads, so a run on another machine shows on the plane.
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { S3Client } from "bun";
import { DiskBlobStore } from "../src/adapters/blob-disk/blob";
import { S3BlobStore } from "../src/adapters/blob-s3/blob";
import {
  blobStoreFromEnv,
  importRunState,
  localPathFor,
  mirroredRepos,
  mirrorDown,
  runnerBlobStore,
} from "../src/blobs";
import { mergeConfig } from "../src/config";
import { blobKeys, MAX_BLOB_BYTES, parseBlobKey, shipConfig, shipStage } from "../src/engine/blobs";
import { LABEL } from "../src/labels";
import { configMirrorDir, defaultStatePath } from "../src/paths";
import type { BlobEntry, BlobStore } from "../src/ports/blob";
import { FactoryState } from "../src/state";
import { advanceIssue } from "../src/watch";
import {
  baseIssue,
  FakeGateRunner,
  FakeGit,
  FakeGitHub,
  FakeHoldoutRunner,
  fixtureFor,
  MultiStageExecutor,
} from "./harness";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

async function roundTrip(store: BlobStore) {
  const key = blobKeys.artifact("acme/widgets", 7, "plan.json");
  await store.put(key, bytes('{"risk":"low"}'));
  await store.put("backups/2026-10-26/state.db", bytes("db"));
  expect(text(await store.get(key))).toBe('{"risk":"low"}');
  expect(await store.get("runs/acme/widgets/issue-7/files/missing.json")).toBeUndefined();
  expect(await store.list("runs/")).toEqual([{ key, size: 14 }]);
  await expect(store.put("runs/../../etc/passwd", bytes("x"))).rejects.toThrow("invalid blob key");
}

// A path-style S3 endpoint in memory: PUT, GET, HEAD and ListObjectsV2, the calls the adapter makes.
function fakeS3() {
  const objects = new Map<string, Uint8Array>();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const [, bucket, ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      if (bucket !== "factory") return new Response("NoSuchBucket", { status: 404 });
      if (req.method === "PUT") {
        objects.set(key, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 200, headers: { etag: '"1"' } });
      }
      if (!key && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const rows = [...objects]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`)
          .join("");
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>factory</Name><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${rows}</ListBucketResult>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      const body = objects.get(key);
      if (!body) return new Response(req.method === "HEAD" ? null : "NoSuchKey", { status: 404 });
      const headers = { "content-length": String(body.length), etag: '"1"' };
      return new Response(req.method === "HEAD" ? null : body, { headers });
    },
  });
  return { server, objects };
}

describe("blob store adapters", () => {
  test("the disk adapter stores, lists by prefix and refuses a climbing key", async () => {
    await roundTrip(new DiskBlobStore(tmp("blobs-disk-")));
  });

  test("the S3 adapter speaks to an S3-compatible endpoint through Bun's client", async () => {
    const { server, objects } = fakeS3();
    try {
      const client = new S3Client({
        bucket: "factory",
        endpoint: `http://127.0.0.1:${server.port}`,
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
        region: "auto",
      });
      await roundTrip(new S3BlobStore(client));
      expect([...objects.keys()].sort()).toEqual([
        "backups/2026-10-26/state.db",
        "runs/acme/widgets/issue-7/files/plan.json",
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("the environment picks the bucket over the directory, and neither means no store", () => {
    expect(blobStoreFromEnv({})).toBeUndefined();
    expect(blobStoreFromEnv({ FACTORY_BLOB_DIR: "/tmp/x" })).toBeInstanceOf(DiskBlobStore);
    expect(blobStoreFromEnv({ FACTORY_BLOB_DIR: "/tmp/x", FACTORY_BLOB_BUCKET: "b" })).toBeInstanceOf(S3BlobStore);
  });

  test("every key a stage writes parses back to the run it came from", () => {
    expect(parseBlobKey(blobKeys.transcript("a/b", 3))).toEqual({ kind: "transcript", repo: "a/b", issue: 3 });
    expect(parseBlobKey(blobKeys.stream("a/b", 3))).toEqual({ kind: "stream", repo: "a/b", issue: 3 });
    expect(parseBlobKey(blobKeys.artifact("a/b", 3, "x.md"))).toEqual({
      kind: "artifact",
      repo: "a/b",
      issue: 3,
      name: "x.md",
    });
    expect(parseBlobKey(blobKeys.state("a/b", 3))).toEqual({ kind: "state", repo: "a/b", issue: 3 });
    expect(localPathFor(blobKeys.state("a/b", 3), { FACTORY_HOME: "/x" })).toBeUndefined();
    expect(parseBlobKey("backups/2026-10-26/state.db")).toBeUndefined();
  });
});

describe("a stage ships its run to the blob store", () => {
  test("a stage on a runner reaches the blob store and the plane mirrors it onto its run paths", async () => {
    const store = new DiskBlobStore(tmp("blobs-shared-"));
    const github = new FakeGitHub([baseIssue(1, [LABEL.ready])]);
    const executor = new MultiStageExecutor();
    const deps = {
      github,
      git: new FakeGit(),
      state: new FactoryState(":memory:"),
      executor,
      gateRunner: new FakeGateRunner(),
      holdoutRunner: new FakeHoldoutRunner(),
      cloneDir: tmp("blobs-clone-"),
      workspacesDir: tmp("blobs-ws-"),
      blobs: store,
    };
    const triage = JSON.stringify({
      disposition: "proceed",
      type: "bug",
      risk: "medium",
      done_when: "x",
      files_expected: ["src/a.ts"],
      gate_level: "make check",
      confidence: 0.9,
    });
    executor.push("triage", 1, fixtureFor("triage", 1), {
      "triage-comment.md": "<!-- factory:triage v1 -->\ntriage",
      "triage.json": triage,
    });
    executor.push("plan", 1, fixtureFor("plan", 1), {
      "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
      "plan.json": JSON.stringify({ risk: "medium", steps: ["a"], files: ["src/a.ts"], tests: ["t"] }),
    });
    await advanceIssue(deps, mergeConfig({ repo: "acme/widgets" }), github.issues.get(1)!);

    const key = blobKeys.artifact("acme/widgets", 1, "triage.json");
    const shipped = text(await store.get(key))!;
    expect(JSON.parse(shipped)).toEqual(JSON.parse(triage));

    const plane = { FACTORY_HOME: tmp("blobs-plane-"), FACTORY_REPO: "acme/widgets" };
    expect(await mirrorDown(store, plane)).toBeGreaterThan(0);
    const local = localPathFor(key, plane)!;
    expect(existsSync(local)).toBe(true);
    expect(readFileSync(local, "utf8")).toBe(shipped);
    expect(await mirrorDown(store, plane)).toBe(0);

    const db = new FactoryState(defaultStatePath(plane, "acme/widgets"));
    const runner = deps.state.getRun("acme/widgets", 1)!;
    expect(db.getRun("acme/widgets", 1)).toEqual({ ...runner, id: db.getRun("acme/widgets", 1)!.id });
    expect(db.listStageRuns("acme/widgets", { issue: 1 }).map((r) => r.stage)).toEqual(["triage", "plan"]);
    db.close();
  });
});

describe("a stage ships only files inside its worktree", () => {
  test("a symlinked artifact or run directory is skipped while a real artifact ships", async () => {
    const store = new DiskBlobStore(tmp("blobs-link-store-"));
    const secret = join(tmp("blobs-link-secret-"), "factory.env");
    writeFileSync(secret, "GH_TOKEN=leak");
    const wt = tmp("blobs-link-wt-");
    const run = join(wt, ".factory/runs/issue-1");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "plan.json"), "{}");
    symlinkSync(secret, join(run, "secrets.txt"));
    // A FIFO with no writer would block a plain open forever.
    expect(spawnSync("mkfifo", [join(run, "pipe.log")]).status).toBe(0);
    expect(await shipStage(store, "acme/widgets", 1, wt)).toBe(1);
    expect(await store.get(blobKeys.artifact("acme/widgets", 1, "secrets.txt"))).toBeUndefined();

    const outside = tmp("blobs-link-outside-");
    writeFileSync(join(outside, "factory.env"), "GH_TOKEN=leak");
    mkdirSync(join(wt, ".factory/runs"), { recursive: true });
    symlinkSync(outside, join(wt, ".factory/runs/issue-2"));
    expect(await shipStage(store, "acme/widgets", 2, wt)).toBe(0);
  });
});

describe("the plane mirrors only what it serves", () => {
  test("a key for an unlisted repo and a malformed key are skipped while a valid one mirrors", async () => {
    const good = blobKeys.artifact("acme/widgets", 2, "plan.json");
    const objects = new Map<string, string>([
      [good, "{}"],
      [blobKeys.artifact("evil/other", 2, "plan.json"), "planted"],
      ["runs/acme/widgets/../../evil/x/issue-1/files/a.md", "climb"],
      ["runs/acme/widgets/issue-2/files/sub/deep.md", "nested"],
    ]);
    // Serves whatever a runner wrote with no key check, and ignores the prefix, so the mirror's
    // own repo check is what keeps another repo's keys off the plane.
    const store: BlobStore = {
      put: async () => {},
      get: async (k) => (objects.has(k) ? bytes(objects.get(k)!) : undefined),
      list: async (): Promise<BlobEntry[]> => [...objects].map(([key, v]) => ({ key, size: v.length })),
    };
    const plane = { FACTORY_HOME: tmp("blobs-allow-"), FACTORY_REPO: "acme/widgets" };
    expect(mirroredRepos(plane)).toEqual(["acme/widgets"]);
    expect(mirroredRepos({ FACTORY_HOME: plane.FACTORY_HOME, FACTORY_REPOS: "a/b, ../x ,c" })).toEqual(["a/b"]);
    expect(await mirrorDown(store, plane)).toBe(1);
    expect(readFileSync(localPathFor(good, plane)!, "utf8")).toBe("{}");
    expect(localPathFor("runs/acme/widgets/../../evil/x/issue-1/files/a.md", plane)).toBeUndefined();
    expect(existsSync(localPathFor(blobKeys.artifact("evil/other", 2, "plan.json"), plane)!)).toBe(false);
    expect(await mirrorDown(store, { FACTORY_HOME: plane.FACTORY_HOME })).toBe(0);
  });
});

// A runner's state for one issue, shipped the way a stage ships it.
async function shipRows(store: BlobStore, repo: string, issue: number, verdict?: string) {
  const st = new FactoryState(":memory:");
  st.upsertRun({ issue, repo, title: "t", stage: "verify", status: "verifying" });
  for (const [stage, at] of [
    ["build", "2026-10-26T10:00:00.000Z"],
    ["verify", "2026-10-26T11:00:00.000Z"],
  ] as const)
    st.recordStageRun({
      repo,
      issue,
      stage,
      agent: "claude",
      model: null,
      started_at: at,
      finished_at: at,
      duration_ms: 1,
      tool_calls: 2,
      tokens_in: 3,
      tokens_out: 4,
      cost_usd: 0.5,
      exit_code: 0,
      killed_reason: null,
    });
  if (verdict) st.setVerifyVerdict(repo, issue, verdict);
  expect(await shipStage(store, repo, issue, tmp("blobs-rows-wt-"), undefined, st)).toBe(1);
  st.close();
}

const counts = (env: NodeJS.ProcessEnv, repo: string) => {
  if (!existsSync(defaultStatePath(env, repo))) return null;
  const db = new FactoryState(defaultStatePath(env, repo));
  try {
    return {
      runs: db.listRuns().length,
      stages: db.listStageRuns(repo).length,
      repos: db.listRuns().map((r) => r.repo),
    };
  } finally {
    db.close();
  }
};

describe("the plane writes a runner's run rows into that repo's own DB", () => {
  test("a state file lands only in its repo's DB, an unserved repo is skipped, and a replay changes nothing", async () => {
    const store = new DiskBlobStore(tmp("blobs-rows-store-"));
    const plane = { FACTORY_HOME: tmp("blobs-rows-plane-"), FACTORY_REPO: "acme/widgets", FACTORY_REPOS: "acme/b" };
    await shipRows(store, "acme/b", 4);
    await shipRows(store, "evil/other", 4);
    expect(await mirrorDown(store, plane)).toBe(1);
    expect(counts(plane, "acme/b")).toEqual({ runs: 1, stages: 2, repos: ["acme/b"] });
    expect(counts(plane, "acme/widgets")).toBeNull();
    expect(counts(plane, "evil/other")).toBeNull();

    expect(await mirrorDown(store, plane)).toBe(0);
    expect(counts(plane, "acme/b")).toEqual({ runs: 1, stages: 2, repos: ["acme/b"] });

    await shipRows(store, "acme/b", 4, "pass");
    expect(await mirrorDown(store, plane)).toBe(1);
    expect(counts(plane, "acme/b")).toEqual({ runs: 1, stages: 2, repos: ["acme/b"] });
    const db = new FactoryState(defaultStatePath(plane, "acme/b"));
    expect(db.listStageRuns("acme/b", { issue: 4 }).map((r) => r.verdict)).toEqual([null, "pass"]);
    db.close();
  });

  test("a state file whose rows name another repo, issue or type is refused whole", async () => {
    const st = new FactoryState(":memory:");
    const store = new DiskBlobStore(tmp("blobs-rows-src-"));
    await shipRows(store, "acme/widgets", 5);
    const good = JSON.parse(text(await store.get(blobKeys.state("acme/widgets", 5)))!);
    const body = (f: unknown) => bytes(JSON.stringify(f));
    const stage0 = good.stages[0];
    for (const bad of [
      { ...good, run: { ...good.run, repo: "acme/b" } },
      { ...good, stages: [{ ...stage0, repo: "acme/b" }] },
      { ...good, stages: [{ ...stage0, issue: 6 }] },
      { ...good, stages: [{ ...stage0, tokens_in: "3" }] },
      { ...good, run: { ...good.run, status: "pwned" } },
      { ...good, stages: "x" },
      { ...good, run: { ...good.run, pr_url: "javascript:alert(1)" } },
      { ...good, run: { ...good.run, pr_url: "https://github.com/acme/b/pull/1" } },
      { ...good, run: { ...good.run, pr_url: "https://github.com/acme/widgets/pull/1/../../x" } },
      { ...good, stages: Array.from({ length: 1001 }, (_, i) => ({ ...stage0, started_at: `${i}` })) },
    ])
      expect(() => importRunState(st, "acme/widgets", 5, body(bad))).toThrow("is not a run of that issue");
    expect(() => importRunState(st, "acme/b", 5, body(good))).toThrow("is not a run of that issue");
    expect(st.listRuns()).toEqual([]);
    expect(importRunState(st, "acme/widgets", 5, body(good))).toBe(3);
    expect(importRunState(st, "acme/widgets", 5, body(good))).toBe(0);
    importRunState(
      st,
      "acme/widgets",
      5,
      body({ ...good, run: { ...good.run, pr_url: "https://github.com/acme/widgets/pull/12" } }),
    );
    expect(st.getRun("acme/widgets", 5)?.pr_url).toBe("https://github.com/acme/widgets/pull/12");
    // The status comment id steers the plane's own edits, so a file never sets it.
    importRunState(st, "acme/widgets", 5, body({ ...good, run: { ...good.run, status_comment_id: 99 } }));
    expect(st.getRun("acme/widgets", 5)?.status_comment_id ?? null).toBeNull();
    st.close();
  });

  test("a state file larger than the cap is skipped even when the store lists it small", async () => {
    const disk = new DiskBlobStore(tmp("blobs-rows-big-"));
    await shipRows(disk, "acme/b", 4);
    const key = blobKeys.state("acme/b", 4);
    await disk.put(key, bytes(text(await disk.get(key))! + " ".repeat(MAX_BLOB_BYTES)));
    const store: BlobStore = {
      put: (k, b) => disk.put(k, b),
      get: (k) => disk.get(k),
      list: async (p) => (await disk.list(p)).map((o) => ({ ...o, size: 1 })),
    };
    const plane = { FACTORY_HOME: tmp("blobs-rows-big-plane-"), FACTORY_REPO: "acme/widgets", FACTORY_REPOS: "acme/b" };
    expect(await mirrorDown(store, plane)).toBe(0);
  });
});

describe("a repo's config reaches the plane", () => {
  test("the runner ships only .factory config, workflow and minion files, never a link or a dotfile", async () => {
    const store = new DiskBlobStore(tmp("blobs-cfg-store-"));
    const clone = tmp("blobs-cfg-clone-");
    for (const d of ["workflows", "minions"]) mkdirSync(join(clone, ".factory", d), { recursive: true });
    const secret = join(tmp("blobs-cfg-secret-"), "factory.env");
    writeFileSync(secret, "GH_TOKEN=leak");
    writeFileSync(join(clone, ".factory", "config.json"), "{}");
    writeFileSync(join(clone, ".factory", "workflows", "ship.yml"), "name: ship");
    writeFileSync(join(clone, ".factory", "workflows", ".hidden.yml"), "x");
    writeFileSync(join(clone, ".factory", "workflows", "notes.txt"), "x");
    writeFileSync(join(clone, ".factory", "minions", "m.yaml"), "name: m");
    symlinkSync(secret, join(clone, ".factory", "workflows", "evil.yml"));
    expect(await shipConfig(store, clone, "acme/widgets")).toBe(3);
    expect((await store.list("runs/")).map((e) => e.key).sort()).toEqual([
      blobKeys.config("acme/widgets", "config.json"),
      blobKeys.config("acme/widgets", "minions/m.yaml"),
      blobKeys.config("acme/widgets", "workflows/ship.yml"),
    ]);
    // The watcher's store sends the same files on its own, in the background.
    const runner = runnerBlobStore(clone, "acme/other", { FACTORY_BLOB_DIR: tmp("blobs-cfg-runner-") })!;
    for (let i = 0; i < 100 && (await runner.list("runs/")).length < 3; i++) await Bun.sleep(50);
    expect((await runner.list("runs/acme/other/config/")).length).toBe(3);
  });

  test("the mirror writes a config file under the repo's config dir and refuses traversal, odd names and oversize", async () => {
    const good = blobKeys.config("acme/widgets", "workflows/ok.yml");
    const objects = new Map<string, number>([
      [good, 2],
      ["runs/acme/widgets/config/workflows/../config.json", 2],
      ["runs/acme/widgets/config/workflows/..yml", 2],
      ["runs/acme/widgets/config/workflows/sub/x.yml", 2],
      ["runs/acme/widgets/config/secrets.env", 2],
      ["runs/acme/widgets/config/.factory/config.json", 2],
      [blobKeys.config("acme/widgets", "workflows/big.yml"), MAX_BLOB_BYTES + 1],
      [blobKeys.config("evil/other", "config.json"), 2],
    ]);
    // Lists whatever a runner wrote with no key check, so the mirror's own checks are what refuse.
    const store: BlobStore = {
      put: async () => {},
      get: async (k) => (objects.has(k) ? bytes("x".repeat(objects.get(k)!)) : undefined),
      list: async (): Promise<BlobEntry[]> => [...objects].map(([key, size]) => ({ key, size })),
    };
    const plane = { FACTORY_HOME: tmp("blobs-cfg-plane-"), FACTORY_REPO: "acme/widgets" };
    expect(await mirrorDown(store, plane)).toBe(1);
    const dir = configMirrorDir("acme/widgets", plane);
    expect(localPathFor(good, plane)).toBe(join(dir, ".factory", "workflows", "ok.yml"));
    expect(readdirSync(plane.FACTORY_HOME, { recursive: true }).sort()).toEqual([
      "acme",
      "acme/widgets",
      "acme/widgets/config",
      "acme/widgets/config/.factory",
      "acme/widgets/config/.factory/workflows",
      "acme/widgets/config/.factory/workflows/ok.yml",
    ]);
    const named = [...objects.keys()].filter((k) => parseBlobKey(k));
    expect(named).toEqual([
      good,
      blobKeys.config("acme/widgets", "workflows/big.yml"),
      blobKeys.config("evil/other", "config.json"),
    ]);
  });
});
