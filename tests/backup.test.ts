// The nightly SQLite backup: env fallback, a verified snapshot with a manifest written last, and pruning.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BackupConfig,
  backupConfigFromEnv,
  backupOnce,
  backupSources,
  listBackups,
  nextRunAt,
  pruneBackups,
  restoreBackup,
  scheduleBackups,
  startBackups,
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
  at: "03:30",
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
      at: "03:30",
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
      at: "03:30",
    });
    expect(() => backupConfigFromEnv({ FACTORY_BACKUP_BUCKET: "bak", FACTORY_BACKUP_AT: "25:00" })).toThrow(
      "FACTORY_BACKUP_AT must be HH:MM (UTC), got 25:00",
    );
    // KEEP_DAYS=0 would let `backup now` prune the backup it just wrote.
    for (const bad of ["0", "-1", "abc"])
      expect(backupConfigFromEnv({ FACTORY_BACKUP_BUCKET: "bak", FACTORY_BACKUP_KEEP_DAYS: bad })?.keepDays).toBe(14);
  });

  test("backupSources finds the shared DB and each repo's DB", () => {
    const home = tmp();
    mkdirSync(join(home, "acme", "widgets"), { recursive: true });
    mkdirSync(join(home, "acme", "empty"), { recursive: true });
    for (const p of ["factory.db", "acme/widgets/factory.db"]) stateDb(join(home, p), 1).close();
    const runState = [join(home, "factory.db"), join(home, "acme/widgets/factory.db")];
    expect(backupSources(home)).toEqual(runState);
    const others = ["plane.db", "machine.db", "integrations.db"].map((n) => join(home, n));
    for (const p of others) stateDb(p, 1).close();
    expect(backupSources(home)).toEqual([...runState, ...others]);
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

  const rowsOf = (path: string) => {
    const db = new Database(path, { readonly: true });
    const n = (db.query("SELECT count(*) AS n FROM t").get() as { n: number }).n;
    db.close();
    return n;
  };
  const twoDbHome = () => {
    const home = tmp();
    stateDb(join(home, "factory.db"), 3).close();
    stateDb(join(home, "plane.db"), 5).close();
    return home;
  };

  test("restore into an empty dir gives back the same rows", async () => {
    const home = twoDbHome();
    const { server } = fakeS3();
    try {
      const config = configFor(server.port!);
      const { id } = await backupOnce(config, backupSources(home), home);
      const to = tmp();
      const written = await restoreBackup(config, { id, to, force: false });
      expect(written).toEqual([join(to, "factory.db"), join(to, "plane.db")]);
      expect(rowsOf(join(to, "factory.db"))).toBe(3);
      expect(rowsOf(join(to, "plane.db"))).toBe(5);
    } finally {
      server.stop(true);
    }
  });

  test("restore without force changes nothing; with force replaces files and clears stale WAL", async () => {
    const home = twoDbHome();
    const { server } = fakeS3();
    try {
      const config = configFor(server.port!);
      const { id } = await backupOnce(config, backupSources(home), home);
      const to = tmp();
      writeFileSync(join(to, "plane.db"), "old");
      writeFileSync(join(to, "plane.db-wal"), "stale");
      await expect(restoreBackup(config, { id, to, force: false })).rejects.toThrow("pass --force");
      expect(readFileSync(join(to, "plane.db"), "utf8")).toBe("old");
      expect(existsSync(join(to, "factory.db"))).toBe(false);
      await restoreBackup(config, { id, to, force: true });
      expect(rowsOf(join(to, "plane.db"))).toBe(5);
      expect(existsSync(join(to, "plane.db-wal"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("a tampered object fails the sha check and nothing is written", async () => {
    const home = twoDbHome();
    const { server, objects } = fakeS3();
    try {
      const config = configFor(server.port!);
      const { id } = await backupOnce(config, backupSources(home), home);
      objects.set(`backups/${id}/plane.db`, new Uint8Array([1, 2, 3]));
      const to = tmp();
      await expect(restoreBackup(config, { id, to, force: true })).rejects.toThrow("sha256 does not match");
      expect(existsSync(join(to, "factory.db"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("date picks the newest backup of that day; an unknown id is an error", async () => {
    const home = twoDbHome();
    const { server } = fakeS3();
    try {
      const config = configFor(server.port!);
      await backupOnce(config, backupSources(home), home, new Date("2026-10-01T01:00:00.000Z"));
      stateDb(join(home, "machine.db"), 7).close();
      await backupOnce(config, backupSources(home), home, new Date("2026-10-01T09:00:00.000Z"));
      const to = tmp();
      const written = await restoreBackup(config, { date: "2026-10-01", to, force: false });
      expect(written.map((p) => p.slice(to.length + 1))).toContain("machine.db");
      await expect(restoreBackup(config, { id: "nope", to, force: false })).rejects.toThrow("no backup");
      await expect(restoreBackup(config, { date: "2026-11-01", to, force: false })).rejects.toThrow("no backup");
    } finally {
      server.stop(true);
    }
  });

  test("a manifest with a ../ name is refused", async () => {
    const home = twoDbHome();
    const { server, objects } = fakeS3();
    try {
      const config = configFor(server.port!);
      const { id, files } = await backupOnce(config, backupSources(home), home);
      const bad = [{ ...files[0]!, key: `backups/${id}/../x` }];
      objects.set(`backups/${id}/manifest.json`, new TextEncoder().encode(JSON.stringify({ files: bad })));
      await expect(restoreBackup(config, { id, to: tmp(), force: true })).rejects.toThrow("unsafe path");
    } finally {
      server.stop(true);
    }
  });

  test("nextRunAt is the same day before the time and the next day after it", () => {
    expect(nextRunAt(new Date("2026-10-01T01:00:00Z"), "03:30").toISOString()).toBe("2026-10-01T03:30:00.000Z");
    expect(nextRunAt(new Date("2026-10-01T03:30:00Z"), "03:30").toISOString()).toBe("2026-10-02T03:30:00.000Z");
    expect(nextRunAt(new Date("2026-10-01T22:00:00Z"), "03:30").toISOString()).toBe("2026-10-02T03:30:00.000Z");
  });

  test("scheduleBackups runs once per firing, re-arms, and survives a failed run", async () => {
    const home = twoDbHome();
    const { server } = fakeS3();
    try {
      const logs: string[] = [];
      const timers: { fn: () => void; ms: number }[] = [];
      const timer = (fn: () => void, ms: number) => timers.push({ fn, ms });
      const now = () => new Date("2026-10-01T01:00:00Z");
      const config = configFor(server.port!);
      const stop = scheduleBackups(config, home, (l) => logs.push(l), timer, now);
      expect(timers).toHaveLength(1);
      expect(timers[0]!.ms).toBe(2.5 * 3_600_000);
      timers[0]!.fn();
      await Bun.sleep(300);
      expect(logs[0]).toMatch(/^\[backup\] .+, 2 file\(s\); pruned 0$/);
      expect(timers).toHaveLength(2);
      expect((await listBackups(config)).length).toBe(1);
      rmSync(join(home, "factory.db"));
      rmSync(join(home, "plane.db"));
      timers[1]!.fn();
      await Bun.sleep(100);
      expect(logs[1]).toContain("[backup] failed: no state databases");
      expect(timers).toHaveLength(3);
      stop();
    } finally {
      server.stop(true);
    }
  });

  test("startBackups does nothing without a bucket and schedules with one", () => {
    const calls: unknown[][] = [];
    const schedule = ((...a: unknown[]) => {
      calls.push(a);
      return () => {};
    }) as unknown as typeof scheduleBackups;
    expect(startBackups({}, schedule)).toBeUndefined();
    expect(calls).toHaveLength(0);
    const env = { FACTORY_BACKUP_BUCKET: "b", FACTORY_HOME: "/h" };
    expect(startBackups(env, schedule)).toBeInstanceOf(Function);
    expect(calls[0]).toEqual([backupConfigFromEnv(env), "/h"]);
  });

  test("the stack starts backups before it hands over to the plane", () => {
    const src = readFileSync(join(import.meta.dir, "../src/deploy/stack.ts"), "utf8");
    expect(src.indexOf("startBackups(env);")).toBeGreaterThan(-1);
    expect(src.indexOf("startBackups(env);")).toBeLessThan(src.indexOf("await plane();"));
  });

  test("the CLI says when backups are off", () => {
    const env = { ...process.env, FACTORY_BACKUP_BUCKET: "", FACTORY_BLOB_BUCKET: "" };
    const r = Bun.spawnSync(["bun", "bin/factory", "backup", "list"], { cwd: join(import.meta.dir, ".."), env });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("backups are off");
  });
});
