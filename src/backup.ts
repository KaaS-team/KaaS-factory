// Snapshots the factory's SQLite state to an S3/R2 bucket, one timestamped folder per run with a sha256
// manifest written last, so a folder without a manifest is a partial upload and never a restore point.
import { Database } from "bun:sqlite";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
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
  at: string;
  // Signs the manifest; read from FACTORY_BACKUP_SIGNING_KEY and never uploaded.
  signingKey?: string;
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

// Backups use their own bucket and credentials, never the blob store's, which the runners hold.
export function backupConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = console.error,
): BackupConfig | undefined {
  const vars = ["BUCKET", "ENDPOINT", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"] as const;
  const missing = vars.filter((name) => !env[`FACTORY_BACKUP_${name}`]);
  if (missing.length === vars.length) return undefined;
  if (missing.length) {
    warn(`backups are off: ${missing.map((name) => `FACTORY_BACKUP_${name}`).join(", ")} unset`);
    return undefined;
  }
  const keepDays = Number(env.FACTORY_BACKUP_KEEP_DAYS);
  const at = env.FACTORY_BACKUP_AT ?? "03:30";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new Error(`FACTORY_BACKUP_AT must be HH:MM (UTC), got ${at}`);
  return {
    bucket: env.FACTORY_BACKUP_BUCKET!,
    endpoint: env.FACTORY_BACKUP_ENDPOINT,
    accessKeyId: env.FACTORY_BACKUP_ACCESS_KEY_ID,
    secretAccessKey: env.FACTORY_BACKUP_SECRET_ACCESS_KEY,
    region: env.FACTORY_BACKUP_REGION ?? "auto",
    // 0 would put the cutoff at the prune call, so `backup now` would delete the backup it just wrote.
    keepDays: env.FACTORY_BACKUP_KEEP_DAYS && Number.isFinite(keepDays) && keepDays >= 1 ? keepDays : 14,
    at,
    ...(env.FACTORY_BACKUP_SIGNING_KEY ? { signingKey: env.FACTORY_BACKUP_SIGNING_KEY } : {}),
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

const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const signHex = (key: string, manifest: string) => createHmac("sha256", key).update(manifest).digest("hex");

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const FLAT_NAMES = new Set(["factory.db", "plane.db", "machine.db", "integrations.db"]);
// factory.db, the three other DBs, or <owner>/<repo>/factory.db; nothing else is ever restored.
function allowedName(name: string): boolean {
  if (FLAT_NAMES.has(name)) return true;
  const parts = name.split("/");
  return (
    parts.length === 3 && parts[2] === "factory.db" && parts.every((p) => SEGMENT.test(p) && p !== "." && p !== "..")
  );
}

// Every state DB under FACTORY_HOME: the run state (shared and per repo), the board, leases and integration links.
export function backupSources(home: string = factoryHome()): string[] {
  const env = { FACTORY_HOME: home };
  const runState = [defaultStatePath(env), ...discoverRepos(env).map((repo) => defaultStatePath(env, repo))];
  const others = ["plane.db", "machine.db", "integrations.db"].map((name) => join(home, name));
  return [...runState, ...others].filter((p) => existsSync(p));
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
      files.push({ key, bytes: body.length, sha256: sha256Hex(body) });
    }
    const manifest = JSON.stringify({ createdAt: now.toISOString(), files });
    // The signature goes first: the manifest is the commit marker, so a folder with one is always complete.
    if (config.signingKey)
      await client.write(`${BACKUP_PREFIX}${id}/manifest.sig`, signHex(config.signingKey, manifest));
    await client.write(`${BACKUP_PREFIX}${id}/manifest.json`, manifest);
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

// Downloads and checks every file of one backup, and only then writes any of them under `to`.
export async function restoreBackup(
  config: BackupConfig,
  opts: { id?: string; date?: string; to: string; force: boolean },
): Promise<string[]> {
  const { force } = opts;
  const all = await listBackups(config);
  const pick = opts.id ? all.find((b) => b.id === opts.id) : all.find((b) => opts.date && b.id.startsWith(opts.date));
  if (!pick) throw new Error(`no backup ${opts.id ?? opts.date} in the bucket`);
  const client = backupClient(config);
  const prefix = `${BACKUP_PREFIX}${pick.id}/`;
  if (!config.signingKey)
    throw new Error("FACTORY_BACKUP_SIGNING_KEY is unset; restore needs it to verify the manifest");
  const raw = await client.file(`${prefix}manifest.json`).text();
  const sigFile = client.file(`${prefix}manifest.sig`);
  if (!(await sigFile.exists())) throw new Error("manifest.sig is missing; refusing an unsigned manifest");
  const got = Buffer.from((await sigFile.text()).trim());
  const want = Buffer.from(signHex(config.signingKey, raw));
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error("manifest signature does not match");
  const manifest = JSON.parse(raw) as { files: BackupFile[] };
  const staged: { target: string; bytes: Uint8Array }[] = [];
  for (const f of manifest.files) {
    if (!f.key.startsWith(prefix)) throw new Error(`${f.key}: key is outside ${prefix}`);
    const name = f.key.slice(prefix.length);
    if (!allowedName(name)) throw new Error(`${name}: unsafe path in the manifest`);
    const target = join(opts.to, name);
    if (!resolve(target).startsWith(resolve(opts.to) + sep)) throw new Error(`${name}: unsafe path in the manifest`);
    const bytes = new Uint8Array(await client.file(f.key).arrayBuffer());
    if (sha256Hex(bytes) !== f.sha256) throw new Error(`${name}: sha256 does not match the manifest`);
    staged.push({ target, bytes });
  }
  for (const { target } of staged)
    if (existsSync(target) && !force) throw new Error(`${target} exists; pass --force to overwrite`);
  for (const { target, bytes } of staged) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(`${target}.restore`, bytes);
    await rename(`${target}.restore`, target);
    await rm(`${target}-wal`, { force: true });
    await rm(`${target}-shm`, { force: true });
  }
  return staged.map((f) => f.target);
}

// The first UTC instant after `now` at HH:MM.
export function nextRunAt(now: Date, at: string): Date {
  const [h, m] = at.split(":").map(Number);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
  return next.getTime() > now.getTime() ? next : new Date(next.getTime() + DAY_MS);
}

type Timer = (fn: () => void, ms: number) => unknown;

// One backup a day at config.at; a failed run is logged and the next day is armed all the same.
export function scheduleBackups(
  config: BackupConfig,
  home: string,
  log: (line: string) => void = console.error,
  timer: Timer = setTimeout,
  now: () => Date = () => new Date(),
): () => void {
  let pending: unknown;
  let stopped = false;
  const arm = () => {
    if (!stopped) pending = timer(() => void run(), nextRunAt(now(), config.at).getTime() - now().getTime());
  };
  const run = async () => {
    try {
      const { id, files } = await backupOnce(config, backupSources(home), home);
      const pruned = await pruneBackups(config);
      log(`[backup] ${id}, ${files.length} file(s); pruned ${pruned.length}`);
    } catch (err) {
      log(`[backup] failed: ${err instanceof Error ? err.message : err}`);
    }
    arm();
  };
  arm();
  return () => {
    stopped = true;
    clearTimeout(pending as ReturnType<typeof setTimeout>);
  };
}

export function startBackups(env: NodeJS.ProcessEnv = process.env, schedule = scheduleBackups) {
  const config = backupConfigFromEnv(env);
  return config ? schedule(config, factoryHome(env)) : undefined;
}
