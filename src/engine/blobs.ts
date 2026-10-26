// A stage's transcript and artifacts, copied to the shared blob store when the stage ends, so the
// plane on another machine shows the same run page. One spelling of each key, used both ways.
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { runDir } from "../artifacts";
import { streamPath } from "../paths";
import type { BlobStore } from "../ports/blob";

// The dashboard serves an artifact up to 1 MiB, so a bigger one is not worth the upload.
export const MAX_BLOB_BYTES = 1024 * 1024;

// Runs live under RUNS_PREFIX, so a mirror never lists the nightly backups beside them.
export const RUNS_PREFIX = "runs/";
export const blobKeys = {
  transcript: (repo: string, issue: number) => `${RUNS_PREFIX}${repo}/issue-${issue}/transcript.log`,
  stream: (repo: string, issue: number) => `${RUNS_PREFIX}${repo}/issue-${issue}/transcript.stream.jsonl`,
  artifact: (repo: string, issue: number, name: string) => `${RUNS_PREFIX}${repo}/issue-${issue}/files/${name}`,
};

export type BlobKind =
  | { kind: "transcript"; repo: string; issue: number }
  | { kind: "stream"; repo: string; issue: number }
  | { kind: "artifact"; repo: string; issue: number; name: string };

export function parseBlobKey(key: string): BlobKind | undefined {
  const m = key.match(
    /^runs\/([\w.-]+\/[\w.-]+)\/issue-(\d+)\/(transcript\.log|transcript\.stream\.jsonl|files\/([\w.-]+))$/,
  );
  if (!m) return undefined;
  const [, repo, n, rest, name] = m;
  const issue = Number(n);
  if (name) return { kind: "artifact", repo: repo!, issue, name };
  return { kind: rest === "transcript.log" ? "transcript" : "stream", repo: repo!, issue };
}

// The agent writes the run directory, so a symlink there could point at the runner's secrets.
// O_NOFOLLOW refuses a link, O_NONBLOCK keeps a planted FIFO from hanging the open, and reading the
// opened handle means the file cannot be swapped after the check.
async function upload(store: BlobStore, key: string, path: string): Promise<boolean> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
  if (!fh) return false;
  try {
    const s = await fh.stat();
    if (!s.isFile() || s.size > MAX_BLOB_BYTES) return false;
    await store.put(key, new Uint8Array(await fh.readFile()));
    return true;
  } finally {
    await fh.close();
  }
}

// A linked run directory would let every name in it resolve outside the worktree.
async function insideWorktree(dir: string, worktree: string): Promise<boolean> {
  const [d, w] = await Promise.all([realpath(dir).catch(() => ""), realpath(worktree).catch(() => "")]);
  return !!d && !!w && d.startsWith(w + sep);
}

// Never throws: the stage's work is done whether or not the copy lands, and the next stage retries it.
export async function shipStage(
  store: BlobStore | undefined,
  repo: string,
  issue: number,
  worktree: string,
  transcriptFile?: string,
): Promise<number> {
  if (!store) return 0;
  let sent = 0;
  try {
    if (transcriptFile) {
      sent += Number(await upload(store, blobKeys.transcript(repo, issue), transcriptFile));
      sent += Number(await upload(store, blobKeys.stream(repo, issue), streamPath(transcriptFile)));
    }
    const dir = join(worktree, runDir(issue));
    if (!(await insideWorktree(dir, worktree))) return sent;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (/^[\w.-]+$/.test(name))
        sent += Number(await upload(store, blobKeys.artifact(repo, issue, name), join(dir, name)));
    }
  } catch (err) {
    console.error(`[blobs] #${issue}: ${err instanceof Error ? err.message : err}`);
  }
  return sent;
}
