// Picks the blob store from the environment, and mirrors it down onto the plane's own paths, so
// the dashboard reads a run from another machine through the same files it always reads.
// FACTORY_ variables never reach an agent (src/agents/env.ts), so the bucket keys stay with the runner.
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { S3Client } from "bun";
import { DiskBlobStore } from "./adapters/blob-disk/blob";
import { S3BlobStore } from "./adapters/blob-s3/blob";
import { runDir } from "./artifacts";
import { parseBlobKey, RUNS_PREFIX } from "./engine/blobs";
import { servedRepos, streamPath, transcriptPath, workspacesDir } from "./paths";
import { type BlobStore, validBlobKey } from "./ports/blob";

export function blobStoreFromEnv(env: NodeJS.ProcessEnv = process.env): BlobStore | undefined {
  if (env.FACTORY_BLOB_BUCKET) {
    return new S3BlobStore(
      new S3Client({
        bucket: env.FACTORY_BLOB_BUCKET,
        endpoint: env.FACTORY_BLOB_ENDPOINT,
        accessKeyId: env.FACTORY_BLOB_ACCESS_KEY_ID,
        secretAccessKey: env.FACTORY_BLOB_SECRET_ACCESS_KEY,
        region: env.FACTORY_BLOB_REGION ?? "auto",
      }),
    );
  }
  return env.FACTORY_BLOB_DIR ? new DiskBlobStore(env.FACTORY_BLOB_DIR) : undefined;
}

// Where a key lives on this machine: the paths the dashboard's run page and proof routes read.
export function localPathFor(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const k = validBlobKey(key) ? parseBlobKey(key) : undefined;
  if (!k) return undefined;
  const transcript = transcriptPath(k.repo, k.issue, env);
  if (k.kind === "transcript") return transcript;
  if (k.kind === "stream") return streamPath(transcript);
  return join(workspacesDir(env, k.repo), `issue-${k.issue}`, runDir(k.issue), k.name);
}

// The repos this plane serves. Any runner holding the bucket key can write any key, so the mirror
// reads only these prefixes and never plants another repo's files on the plane.
export function mirroredRepos(env: NodeJS.ProcessEnv = process.env): string[] {
  return servedRepos(env, env.FACTORY_REPO ?? "").filter(validBlobKey);
}

// Copies every key whose local copy is missing or a different size; returns how many it wrote.
// A bad key is logged and skipped, so one planted name never stops the rest of the mirror.
export async function mirrorDown(
  store: BlobStore,
  env: NodeJS.ProcessEnv = process.env,
  repos: readonly string[] = mirroredRepos(env),
): Promise<number> {
  let wrote = 0;
  for (const repo of repos) {
    for (const { key, size } of await store.list(`${RUNS_PREFIX}${repo}/`)) {
      try {
        const path = parseBlobKey(key)?.repo === repo ? localPathFor(key, env) : undefined;
        if (!path) {
          console.error(`[blobs] mirror: skipped ${JSON.stringify(key)}`);
          continue;
        }
        if ((await stat(path).catch(() => undefined))?.size === size) continue;
        const body = await store.get(key);
        if (!body) continue;
        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, body);
        wrote++;
      } catch (err) {
        console.error(`[blobs] mirror: ${JSON.stringify(key)}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return wrote;
}
