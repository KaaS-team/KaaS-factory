// Picks the blob store from the environment, and mirrors it down onto the plane's own paths, so
// the dashboard reads a run from another machine through the same files it always reads.
// FACTORY_ variables never reach an agent (src/agents/env.ts), so the bucket keys stay with the runner.
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { S3Client } from "bun";
import { DiskBlobStore } from "./adapters/blob-disk/blob";
import { S3BlobStore } from "./adapters/blob-s3/blob";
import { runDir } from "./artifacts";
import { MAX_BLOB_BYTES, parseBlobKey, RUNS_PREFIX, shipConfig } from "./engine/blobs";
import {
  configMirrorDir,
  defaultRepo,
  defaultStatePath,
  servedRepos,
  streamPath,
  transcriptPath,
  workspacesDir,
} from "./paths";
import { type BlobStore, validBlobKey } from "./ports/blob";
import { FactoryState, type Run, type RunStatus, type Stage, type StageRun } from "./state";

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

// A runner's store, which first sends the plane the config this runner started with.
export function runnerBlobStore(cloneDir: string, repo: string, env = process.env): BlobStore | undefined {
  const store = blobStoreFromEnv(env);
  void shipConfig(store, cloneDir, repo);
  return store;
}

// Where a key lives on this machine: the paths the dashboard's run page and proof routes read.
export function localPathFor(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const k = validBlobKey(key) ? parseBlobKey(key) : undefined;
  if (!k || k.kind === "state") return undefined;
  if (k.kind === "config") return join(configMirrorDir(k.repo, env), ".factory", k.file);
  const transcript = transcriptPath(k.repo, k.issue, env);
  if (k.kind === "transcript") return transcript;
  if (k.kind === "stream") return streamPath(transcript);
  return join(workspacesDir(env, k.repo), `issue-${k.issue}`, runDir(k.issue), k.name);
}

// The repos this plane serves. Any runner holding the bucket key can write any key, so the mirror
// reads only these prefixes and never plants another repo's files on the plane.
export function mirroredRepos(env: NodeJS.ProcessEnv = process.env): string[] {
  return servedRepos(env, defaultRepo(env)).filter(validBlobKey);
}

// Each column a runner's state.json may set, with its type: a field outside these, or of another
// type, refuses the whole file, so a runner holding the bucket key cannot plant a malformed row.
type Col = "int" | "num" | "str" | "int?" | "num?" | "str?";
const RUN_COLS = {
  issue: "int",
  repo: "str",
  title: "str",
  stage: "str",
  status: "str",
  started_at: "str",
  updated_at: "str",
  tool_calls: "int",
  tokens_in: "int",
  tokens_out: "int",
  cost_usd: "num",
  gate_line: "str?",
  pr_url: "str?",
  reason: "str?",
  // The runner's status comment id steers the plane's own edits, so it is never taken from a file.
} as const satisfies Record<keyof Omit<Run, "id" | "status_comment_id">, Col>;
const STAGE_COLS = {
  repo: "str",
  issue: "int",
  stage: "str",
  agent: "str",
  model: "str?",
  started_at: "str",
  finished_at: "str",
  duration_ms: "int",
  tool_calls: "int",
  tokens_in: "int",
  tokens_out: "int",
  tokens_cached: "int",
  cost_usd: "num?",
  usage_complete: "int",
  exit_code: "int",
  killed_reason: "str?",
  session_id: "str?",
  verdict: "str?",
  // tokens_cache_write is not mirrored yet (#115 NG-4); a mirrored row reads back 0.
} as const satisfies Record<keyof Omit<StageRun, "id" | "tokens_cache_write">, Col>;
// Records keyed by the union types, so tsc fails here when a stage or a status is added.
const STAGES: Record<Stage, true> = { triage: true, plan: true, build: true, verify: true, pr: true };
const STATUSES: Record<RunStatus, true> = {
  running: true,
  "needs-info": true,
  "awaiting-approval": true,
  verifying: true,
  rejected: true,
  shipped: true,
  failed: true,
  "needs-human": true,
  cancelled: true,
};

const MAX_STAGE_ROWS = 1000;
type Bound = Record<string, string | number | null>;
function bind(row: unknown, cols: Record<string, Col>, repo: string, issue: number): Bound | undefined {
  if (!row || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  if (r.repo !== repo || r.issue !== issue || !Object.hasOwn(STAGES, String(r.stage))) return undefined;
  if (cols === RUN_COLS && !Object.hasOwn(STATUSES, String(r.status))) return undefined;
  const out: Bound = {};
  for (const [k, t] of Object.entries(cols)) {
    const v = r[k];
    const ok =
      v === null
        ? t.endsWith("?")
        : t.startsWith("int")
          ? Number.isSafeInteger(v)
          : t.startsWith("num")
            ? typeof v === "number" && Number.isFinite(v)
            : typeof v === "string";
    if (!ok) return undefined;
    out[`$${k}`] = v as string | number | null;
  }
  // The run page links pr_url, so a planted javascript: or foreign URL would be one click away.
  if (cols === RUN_COLS && out.$pr_url !== null && !isPrOf(String(out.$pr_url), repo)) return undefined;
  return out;
}

const isPrOf = (url: string, repo: string) =>
  url.toLowerCase().startsWith(`https://github.com/${repo.toLowerCase()}/pull/`) &&
  /^\d+$/.test(url.slice(`https://github.com/${repo}/pull/`.length));

// The plane's own ids differ from the runner's, so a stage attempt is known by (repo, issue, stage,
// started_at). Each write skips a row that already matches, so a replay changes nothing.
const UPSERT_RUN = `INSERT INTO runs (issue, repo, title, stage, status, started_at, updated_at,
    tool_calls, tokens_in, tokens_out, cost_usd, gate_line, pr_url, reason)
  VALUES ($issue, $repo, $title, $stage, $status, $started_at, $updated_at, $tool_calls, $tokens_in,
      $tokens_out, $cost_usd, $gate_line, $pr_url, $reason)
  ON CONFLICT(repo, issue) DO UPDATE SET title = excluded.title, stage = excluded.stage, status =
      excluded.status, started_at = excluded.started_at, updated_at = excluded.updated_at, tool_calls =
      excluded.tool_calls, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out, cost_usd =
      excluded.cost_usd, gate_line = excluded.gate_line, pr_url = excluded.pr_url, reason = excluded.reason
  WHERE (runs.title, runs.stage, runs.status, runs.started_at, runs.updated_at, runs.tool_calls,
      runs.tokens_in, runs.tokens_out, runs.cost_usd, runs.gate_line, runs.pr_url, runs.reason)
    IS NOT (excluded.title, excluded.stage, excluded.status, excluded.started_at, excluded.updated_at,
        excluded.tool_calls, excluded.tokens_in, excluded.tokens_out, excluded.cost_usd, excluded.gate_line,
        excluded.pr_url, excluded.reason)`;
const UPDATE_STAGE = `UPDATE stage_runs SET agent = $agent, model = $model, finished_at = $finished_at,
    duration_ms = $duration_ms, tool_calls = $tool_calls, tokens_in = $tokens_in, tokens_out = $tokens_out,
    tokens_cached = $tokens_cached, cost_usd = $cost_usd, usage_complete = $usage_complete, exit_code =
    $exit_code, killed_reason = $killed_reason, session_id = $session_id, verdict = $verdict
  WHERE repo = $repo AND issue = $issue AND stage = $stage AND started_at = $started_at
    AND (agent, model, finished_at, duration_ms, tool_calls, tokens_in, tokens_out, tokens_cached,
        cost_usd, usage_complete, exit_code, killed_reason, session_id, verdict)
    IS NOT ($agent, $model, $finished_at, $duration_ms, $tool_calls, $tokens_in, $tokens_out,
        $tokens_cached, $cost_usd, $usage_complete, $exit_code, $killed_reason, $session_id, $verdict)`;
const INSERT_STAGE = `INSERT INTO stage_runs (repo, issue, stage, agent, model, started_at, finished_at,
    duration_ms, tool_calls, tokens_in, tokens_out, tokens_cached, cost_usd, usage_complete, exit_code,
    killed_reason, session_id, verdict)
  SELECT $repo, $issue, $stage, $agent, $model, $started_at, $finished_at, $duration_ms, $tool_calls,
      $tokens_in, $tokens_out, $tokens_cached, $cost_usd, $usage_complete, $exit_code, $killed_reason,
      $session_id, $verdict
  WHERE NOT EXISTS (SELECT 1 FROM stage_runs WHERE repo = $repo AND issue = $issue AND stage = $stage
      AND started_at = $started_at)`;

// Writes a runner's state.json into the plane's DB for that repo; returns how many rows changed.
// Throws on a file whose rows do not all belong to the key's repo and issue.
export function importRunState(state: FactoryState, repo: string, issue: number, body: Uint8Array): number {
  const file = JSON.parse(new TextDecoder().decode(body)) as { run?: unknown; stages?: unknown };
  const run = bind(file?.run, RUN_COLS, repo, issue);
  const stages =
    Array.isArray(file?.stages) && file.stages.length <= MAX_STAGE_ROWS
      ? file.stages.map((s) => bind(s, STAGE_COLS, repo, issue))
      : [undefined];
  if (!run || stages.some((s) => !s)) throw new Error(`state for ${repo}#${issue} is not a run of that issue`);
  return state.write((db) => {
    let changed = db.query(UPSERT_RUN).run(run).changes;
    for (const s of stages as Bound[]) {
      changed += db.query(UPDATE_STAGE).run(s).changes;
      changed += db.query(INSERT_STAGE).run(s).changes;
    }
    return changed;
  });
}

// Copies every key whose local copy is missing or a different size, and writes each state.json into
// the repo's own DB; returns how many it wrote or changed.
// A bad key is logged and skipped, so one planted name never stops the rest of the mirror.
export async function mirrorDown(
  store: BlobStore,
  env: NodeJS.ProcessEnv = process.env,
  repos: readonly string[] = mirroredRepos(env),
): Promise<number> {
  let wrote = 0;
  for (const repo of repos) {
    let db: FactoryState | undefined;
    try {
      for (const { key, size } of await store.list(`${RUNS_PREFIX}${repo}/`)) {
        try {
          const k = parseBlobKey(key);
          const mine = k?.repo === repo ? k : undefined;
          const path = mine && localPathFor(key, env);
          if (!mine || size > MAX_BLOB_BYTES || (mine.kind !== "state" && !path)) {
            console.error(`[blobs] mirror: skipped ${JSON.stringify(key)}`);
            continue;
          }
          // Transcripts only grow, so an equal size is the same file; an edited config can keep its size.
          const config = mine.kind === "config";
          if (path && !config && (await stat(path).catch(() => undefined))?.size === size) continue;
          const body = await store.get(key);
          // The listed size is the store's word; the body read is the one that counts.
          if (!body || body.byteLength > MAX_BLOB_BYTES) continue;
          if (config && Buffer.from(body).equals(await readFile(path!).catch(() => Buffer.alloc(0)))) continue;
          if (mine.kind === "state") {
            db ??= new FactoryState(defaultStatePath(env, repo));
            wrote += Number(importRunState(db, repo, mine.issue, body) > 0);
            continue;
          }
          await mkdir(dirname(path!), { recursive: true });
          await Bun.write(path!, body);
          wrote++;
        } catch (err) {
          console.error(`[blobs] mirror: ${JSON.stringify(key)}: ${err instanceof Error ? err.message : err}`);
        }
      }
    } finally {
      db?.close();
    }
  }
  return wrote;
}
