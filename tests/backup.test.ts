// The nightly SQLite backup: env fallback, a verified snapshot with a manifest written last, and pruning.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BackupConfig,
  backupConfigFromEnv,
  backupOnce,
  backupSources,
  listBackups,
  pruneBackups,
} from "../src/backup";
import { fakeS3 } from "./helpers/fake-s3";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "backup-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const configFor = (port: number, keepDays = 14): BackupConfig => ({
  bucket: "factory",
  endpoint: `http://127.0.0.1:${port}`,
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  region: "auto",
  keepDays,
});

function stateDb(path: string, rows: number, wal = false): Database {
  const db = new Database(path);
  if (wal) {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA wal_autocheckpoint = 0");
  }
  db.run("CREATE TABLE t (n INTEGER)");
  for (let i = 0; i < rows; i++) db.run("INSERT INTO t VALUES (?)", [i]);
  return db;
}

describe("backup", () => {
  test("env fallback: FACTORY_BACKUP_* over FACTORY_BLOB_*, keep days 14, no bucket is off", () => {
    expect(backupConfigFromEnv({})).toBeUndefined();
    expect(backupConfigFromEnv({ FACTORY_BACKUP_KEEP_DAYS: "3" })).toBeUndefined();
    expect(
      backupConfigFromEnv({
        FACTORY_BLOB_BUCKET: "blobs",
        FACTORY_BLOB_ENDPOINT: "https://blob",
        FACTORY_BLOB_ACCESS_KEY_ID: "blob-id",
        FACTORY_BLOB_SECRET_ACCESS_KEY: "blob-secret",
      }),
    ).toEqual({
      bucket: "blobs",
      endpoint: "https://blob",
      accessKeyId: "blob-id",
      secretAccessKey: "blob-secret",
      region: "auto",
      keepDays: 14,
    });
    expect(
      backupConfigFromEnv({
        FACTORY_BLOB_BUCKET: "blobs",
        FACTORY_BLOB_ENDPOINT: "https://blob",
        FACTORY_BLOB_ACCESS_KEY_ID: "blob-id",
        FACTORY_BLOB_SECRET_ACCESS_KEY: "blob-secret",
        FACTORY_BLOB_REGION: "eu",
        FACTORY_BACKUP_BUCKET: "bak",
        FACTORY_BACKUP_ENDPOINT: "https://bak",
        FACTORY_BACKUP_REGION: "us",
        FACTORY_BACKUP_KEEP_DAYS: "3",
      }),
    ).toEqual({
      bucket: "bak",
      endpoint: "https://bak",
      accessKeyId: "blob-id",
      secretAccessKey: "blob-secret",
      region: "us",
      keepDays: 3,
    });
    // KEEP_DAYS=0 would let `backup now` prune the backup it just wrote.
    for (const bad of ["0", "-1", "abc"])
      expect(backupConfigFromEnv({ FACTORY_BACKUP_BUCKET: "bak", FACTORY_BACKUP_KEEP_DAYS: bad })?.keepDays).toBe(14);
  });

  test("backupSources finds the shared DB and each repo's DB", () => {
    const home = tmp();
    mkdirSync(join(home, "acme", "widgets"), { recursive: true });
    mkdirSync(join(home, "acme", "empty"), { recursive: true });
    for (const p of ["factory.db", "acme/widgets/factory.db"]) stateDb(join(home, p), 1).close();
    expect(backupSources(home)).toEqual([join(home, "factory.db"), join(home, "acme/widgets/factory.db")]);
  });

  test("manifest hashes match uploaded bytes and manifest is written last", async () => {
    const home = tmp();
    mkdirSync(join(home, "acme", "widgets"), { recursive: true });
    stateDb(join(home, "factory.db"), 3).close();
    stateDb(join(home, "acme/widgets/factory.db"), 5).close();
    const { server, objects } = fakeS3();
    try {
      const { id, files } = await backupOnce(configFor(server.port!), backupSources(home), home);
      const keys = [...objects.keys()];
      expect(keys.at(-1)).toBe(`backups/${id}/manifest.json`);
      expect(keys).toHaveLength(3);
      const manifest = JSON.parse(new TextDecoder().decode(objects.get(keys.at(-1)!)));
      expect(manifest.files).toEqual(files);
      expect(files.map((f) => f.key)).toEqual([`backups/${id}/factory.db`, `backups/${id}/acme/widgets/factory.db`]);
      for (const f of manifest.files) {
        const body = objects.get(f.key)!;
        expect(f.bytes).toBe(body.length);
        expect(f.sha256).toBe(createHash("sha256").update(body).digest("hex"));
      }
    } finally {
      server.stop(true);
    }
  });

  test("snapshot includes uncheckpointed WAL rows", async () => {
    const home = tmp();
    const path = join(home, "factory.db");
    const writer = stateDb(path, 4, true);
    const { server, objects } = fakeS3();
    try {
      const { files } = await backupOnce(configFor(server.port!), [path], home);
      const restored = join(home, "restored.db");
      writeFileSync(restored, objects.get(files[0]!.key)!);
      const copy = new Database(restored, { readonly: true });
      expect((copy.query("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(4);
      copy.close();
    } finally {
      writer.close();
      server.stop(true);
    }
  });

  test("a snapshot that fails integrity_check uploads nothing", async () => {
    const home = tmp();
    const path = join(home, "factory.db");
    writeFileSync(path, "not a database at all, just text that is long enough to be read as a header");
    const { server, objects } = fakeS3();
    try {
      await expect(backupOnce(configFor(server.port!), [path], home)).rejects.toThrow();
      expect(objects.size).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("no sources is an error and uploads nothing", async () => {
    const { server, objects } = fakeS3();
    try {
      await expect(backupOnce(configFor(server.port!), [], tmp())).rejects.toThrow("no state databases");
      expect(objects.size).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("listBackups skips backups without a manifest, newest first", async () => {
    const home = tmp();
    stateDb(join(home, "factory.db"), 1).close();
    const { server, objects } = fakeS3();
    try {
      const config = configFor(server.port!);
      const old = await backupOnce(config, backupSources(home), home, new Date("2026-10-01T00:00:00.000Z"));
      const recent = await backupOnce(config, backupSources(home), home, new Date("2026-10-02T00:00:00.000Z"));
      objects.set("backups/2026-10-03T00-00-00-000Z/factory.db", new Uint8Array([1]));
      expect((await listBackups(config)).map((b) => b.id)).toEqual([recent.id, old.id]);
    } finally {
      server.stop(true);
    }
  });

  test("prune deletes backups older than keepDays, keeps newer", async () => {
    const home = tmp();
    stateDb(join(home, "factory.db"), 1).close();
    const { server, objects } = fakeS3();
    try {
      const config = configFor(server.port!, 14);
      const now = new Date("2026-10-27T00:00:00.000Z");
      const old = await backupOnce(config, backupSources(home), home, new Date("2026-10-01T00:00:00.000Z"));
      const fresh = await backupOnce(config, backupSources(home), home, new Date("2026-10-20T00:00:00.000Z"));
      expect(await pruneBackups(config, now)).toEqual([old.id]);
      expect([...objects.keys()].every((k) => k.startsWith(`backups/${fresh.id}/`))).toBe(true);
      expect(objects.size).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("a prune whose data-file delete fails leaves no listed backup", async () => {
    const home = tmp();
    stateDb(join(home, "factory.db"), 1).close();
    const { server, objects } = fakeS3({ failDelete: (key) => key.endsWith("factory.db") });
    try {
      const config = configFor(server.port!, 14);
      await backupOnce(config, backupSources(home), home, new Date("2026-10-01T00:00:00.000Z"));
      await expect(pruneBackups(config, new Date("2026-10-27T00:00:00.000Z"))).rejects.toThrow();
      expect(objects.size).toBe(1);
      expect(await listBackups(config)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});
