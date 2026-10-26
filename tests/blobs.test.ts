// Transcripts and artifacts reach a shared blob store when a stage ends, and the plane mirrors them
// back onto the paths its run page reads, so a run on another machine shows on the plane.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "bun";
import { DiskBlobStore } from "../src/adapters/blob-disk/blob";
import { S3BlobStore } from "../src/adapters/blob-s3/blob";
import { blobStoreFromEnv, localPathFor, mirrorDown } from "../src/blobs";
import { mergeConfig } from "../src/config";
import { blobKeys, parseBlobKey } from "../src/engine/blobs";
import { LABEL } from "../src/labels";
import type { BlobStore } from "../src/ports/blob";
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

    const plane = { FACTORY_HOME: tmp("blobs-plane-") };
    expect(await mirrorDown(store, plane)).toBeGreaterThan(0);
    const local = localPathFor(key, plane)!;
    expect(existsSync(local)).toBe(true);
    expect(readFileSync(local, "utf8")).toBe(shipped);
    expect(await mirrorDown(store, plane)).toBe(0);
  });
});
