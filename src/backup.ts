// Snapshots the factory's SQLite state to an S3/R2 bucket, one timestamped folder per run with a sha256
// manifest written last, so a folder without a manifest is a partial upload and never a restore point.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { S3Client } from "bun";
import { defaultStatePath, discoverRepos, factoryHome } from "./paths";

export const BACKUP_PREFIX = "backups/";
const DAY_MS = 86_400_000;

export interface BackupConfig {
  bucket: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region: string;
  keepDays: number;
}

export interface BackupFile {
  key: string;
  bytes: number;
  sha256: string;
}

export interface BackupEntry {
  id: string;
  at: Date;
  keys: string[];
}

// Backups share the blob store's bucket and credentials unless FACTORY_BACKUP_* says otherwise.
export function backupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BackupConfig | undefined {
  const pick = (name: string) => env[`FACTORY_BACKUP_${name}`] ?? env[`FACTORY_BLOB_${name}`];
  const bucket = pick("BUCKET");
  if (!bucket) return undefined;
  const keepDays = Number(env.FACTORY_BACKUP_KEEP_DAYS);
  return {
    bucket,
    endpoint: pick("ENDPOINT"),
    accessKeyId: pick("ACCESS_KEY_ID"),
    secretAccessKey: pick("SECRET_ACCESS_KEY"),
    region: pick("REGION") ?? "auto",
    // 0 would put the cutoff at the prune call, so `backup now` would delete the backup it just wrote.
    keepDays: env.FACTORY_BACKUP_KEEP_DAYS && Number.isFinite(keepDays) && keepDays >= 1 ? keepDays : 14,
  };
}

export function backupClient(config: BackupConfig): S3Client {
  return new S3Client({
    bucket: config.bucket,
    endpoint: config.endpoint,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
  });
}

// Every state DB under FACTORY_HOME: the shared one and each repo's own.
export function backupSources(home: string = factoryHome()): string[] {
  const env = { FACTORY_HOME: home };
  return [defaultStatePath(env), ...discoverRepos(env).map((repo) => defaultStatePath(env, repo))].filter((p) =>
    existsSync(p),
  );
}

const stampOf = (at: Date) => at.toISOString().replace(/[:.]/g, "-");
const dateOf = (id: string) => {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/.exec(id);
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : undefined;
};

// VACUUM INTO reads through the WAL, so rows not yet checkpointed into the main file are in the copy.
function snapshot(source: string, target: string): void {
  const src = new Database(source);
  try {
    src.run("VACUUM INTO ?", [target]);
  } finally {
    src.close();
  }
  const copy = new Database(target, { readonly: true });
  try {
    const verdict = (copy.query("PRAGMA integrity_check").get() as { integrity_check: string } | null)?.integrity_check;
    if (verdict !== "ok") throw new Error(`backup of ${source} failed integrity_check: ${verdict}`);
  } finally {
    copy.close();
  }
}

export async function backupOnce(
  config: BackupConfig,
  sources: readonly string[],
  home: string = factoryHome(),
  now: Date = new Date(),
): Promise<{ id: string; files: BackupFile[] }> {
  // An empty backup would still count as a restore point and let prune age out the real ones.
  if (!sources.length) throw new Error(`no state databases under ${home}; is FACTORY_HOME right?`);
  const client = backupClient(config);
  const id = stampOf(now);
  const scratch = await mkdtemp(join(tmpdir(), "factory-backup-"));
  try {
    // Every snapshot is checked before the first upload, so a bad DB leaves nothing in the bucket.
    const staged = sources.map((source, i) => {
      const target = join(scratch, `${i}.db`);
      snapshot(source, target);
      return { target, name: relative(home, source).replaceAll("\\", "/") };
    });
    const files: BackupFile[] = [];
    for (const { target, name } of staged) {
      const body = new Uint8Array(await readFile(target));
      const key = `${BACKUP_PREFIX}${id}/${name}`;
      await client.write(key, body);
      files.push({ key, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
    }
    await client.write(`${BACKUP_PREFIX}${id}/manifest.json`, JSON.stringify({ createdAt: now.toISOString(), files }));
    return { id, files };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// Every backup folder in the bucket, newest first; partial ones included, with no manifest key in them.
async function folders(client: S3Client): Promise<BackupEntry[]> {
  const byId = new Map<string, string[]>();
  let continuationToken: string | undefined;
  do {
    const page = await client.list({ prefix: BACKUP_PREFIX, ...(continuationToken ? { continuationToken } : {}) });
    for (const o of page.contents ?? []) {
      const id = o.key.slice(BACKUP_PREFIX.length).split("/")[0] ?? "";
      const at = dateOf(id);
      if (at) byId.set(id, [...(byId.get(id) ?? []), o.key]);
    }
    continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (continuationToken);
  return [...byId].map(([id, keys]) => ({ id, at: dateOf(id)!, keys })).sort((a, b) => b.at.getTime() - a.at.getTime());
}

export async function listBackups(config: BackupConfig): Promise<BackupEntry[]> {
  const all = await folders(backupClient(config));
  return all.filter((b) => b.keys.includes(`${BACKUP_PREFIX}${b.id}/manifest.json`));
}

// Deletes every object of each backup older than keepDays, a partial upload included; returns the ids.
export async function pruneBackups(config: BackupConfig, now: Date = new Date()): Promise<string[]> {
  const client = backupClient(config);
  const cutoff = now.getTime() - config.keepDays * DAY_MS;
  const old = (await folders(client)).filter((b) => b.at.getTime() < cutoff);
  for (const b of old) {
    // Manifest first: a delete that fails midway leaves a folder listBackups skips, never one that looks restorable.
    const manifest = `${BACKUP_PREFIX}${b.id}/manifest.json`;
    for (const key of [manifest, ...b.keys.filter((k) => k !== manifest)]) await client.delete(key);
  }
  return old.map((b) => b.id);
}
