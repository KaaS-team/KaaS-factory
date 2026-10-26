// A stage's transcript, artifacts and run rows, copied to the shared blob store when the stage ends,
// so the plane on another machine shows the same run page and Line. One spelling of each key, used both ways.
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { runDir } from "../artifacts";
import { streamPath } from "../paths";
import type { BlobStore } from "../ports/blob";
import type { FactoryState } from "../state";

// The dashboard serves an artifact up to 1 MiB, so a bigger one is not worth the upload.
export const MAX_BLOB_BYTES = 1024 * 1024;

// Runs live under RUNS_PREFIX, so a mirror never lists the nightly backups beside them.
export const RUNS_PREFIX = "runs/";
export const blobKeys = {
  transcript: (repo: string, issue: number) => `${RUNS_PREFIX}${repo}/issue-${issue}/transcript.log`,
  stream: (repo: string, issue: number) => `${RUNS_PREFIX}${repo}/issue-${issue}/transcript.stream.jsonl`,
  artifact: (repo: string, issue: number, name: string) => `${RUNS_PREFIX}${repo}/issue-${issue}/files/${name}`,
  state: (repo: string, issue: number) => `${RUNS_PREFIX}${repo}/issue-${issue}/state.json`,
  // `file` is a path under the clone's .factory/ that CONFIG_FILE accepts.
  config: (repo: string, file: string) => `${RUNS_PREFIX}${repo}/config/${file}`,
};

// The files the Settings, Workflows and Minions pages read. One plain name per directory level and
// no leading dot, so no key names a file outside .factory/ on either side.
const CONFIG_FILE = /^(config\.json|mcp\.json|workflows\/\w[\w.-]*\.(?:yml|md)|minions\/\w[\w.-]*\.ya?ml)$/;

export type BlobKind =
  | { kind: "transcript"; repo: string; issue: number }
  | { kind: "stream"; repo: string; issue: number }
  | { kind: "state"; repo: string; issue: number }
  | { kind: "config"; repo: string; file: string }
  | { kind: "artifact"; repo: string; issue: number; name: string };

export function parseBlobKey(key: string): BlobKind | undefined {
  const c = key.match(/^runs\/([\w.-]+\/[\w.-]+)\/config\/(.+)$/);
  if (c) return CONFIG_FILE.test(c[2]!) ? { kind: "config", repo: c[1]!, file: c[2]! } : undefined;
  const m = key.match(
    /^runs\/([\w.-]+\/[\w.-]+)\/issue-(\d+)\/(transcript\.log|transcript\.stream\.jsonl|state\.json|files\/([\w.-]+))$/,
  );
  if (!m) return undefined;
  const [, repo, n, rest, name] = m;
  const issue = Number(n);
  if (name) return { kind: "artifact", repo: repo!, issue, name };
  const kind = rest === "state.json" ? "state" : rest === "transcript.log" ? "transcript" : "stream";
  return { kind, repo: repo!, issue };
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

type RunRows = Pick<FactoryState, "getRun" | "listStageRuns">;

// The issue's run row and every stage attempt, which the plane writes into its own DB (src/blobs.ts).
// Never throws, like shipStage: the run is recorded here whether or not the copy lands.
export async function shipRunState(store: BlobStore | undefined, state: RunRows, repo: string, issue: number) {
  const run = state.getRun(repo, issue);
  if (!store || !run) return 0;
  let page = state.listStageRuns(repo, { issue, limit: 500 });
  const stages = [...page];
  while (page.length === 500) {
    page = state.listStageRuns(repo, { issue, after: page.at(-1)!.id, limit: 500 });
    stages.push(...page);
  }
  const body = new TextEncoder().encode(JSON.stringify({ run, stages }));
  return store.put(blobKeys.state(repo, issue), body).then(
    () => 1,
    (err) => (console.error(`[blobs] #${issue} state: ${err instanceof Error ? err.message : err}`), 0),
  );
}

// Never throws: the stage's work is done whether or not the copy lands, and the next stage retries it.
export async function shipStage(
  store: BlobStore | undefined,
  repo: string,
  issue: number,
  worktree: string,
  transcriptFile?: string,
  state?: RunRows,
): Promise<number> {
  if (!store) return 0;
  let sent = 0;
  try {
    if (state) sent += await shipRunState(store, state, repo, issue);
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

// The repo's config, workflows and minions from the runner's own clone, never an agent's worktree,
// so the plane shows what this runner runs. Never throws, like shipStage.
export async function shipConfig(store: BlobStore | undefined, cloneDir: string, repo: string): Promise<number> {
  if (!store) return 0;
  const root = join(cloneDir, ".factory");
  // A commit can make .factory or workflows/ a symlink, and O_NOFOLLOW guards only the last name.
  const sub = async (d: string) =>
    (await insideWorktree(join(root, d), cloneDir))
      ? (await readdir(join(root, d)).catch(() => [] as string[])).map((f) => `${d}/${f}`)
      : [];
  let sent = 0;
  try {
    if (!(await insideWorktree(root, cloneDir))) return 0;
    for (const file of ["config.json", "mcp.json", ...(await sub("workflows")), ...(await sub("minions"))])
      if (CONFIG_FILE.test(file)) sent += Number(await upload(store, blobKeys.config(repo, file), join(root, file)));
  } catch (err) {
    console.error(`[blobs] config: ${err instanceof Error ? err.message : err}`);
  }
  return sent;
}
