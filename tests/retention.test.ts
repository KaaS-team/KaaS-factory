import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expiredFiles, sweep } from "../src/retention";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function scratch(): string {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), "retention-"));
}

function aged(path: string, mtimeMs: number): void {
  writeFileSync(path, "x");
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

test("a file exactly at the limit is kept and one millisecond older is listed", () => {
  const entries = [
    { path: "at", mtimeMs: NOW - DAY, kind: "transcript" as const },
    { path: "over", mtimeMs: NOW - DAY - 1, kind: "transcript" as const },
  ];
  expect(expiredFiles(entries, NOW, { transcript: 1 })).toEqual(["over"]);
});

test("a kind with no configured days is never listed", () => {
  const entries = [
    { path: "s", mtimeMs: 0, kind: "stream" as const },
    { path: "o", mtimeMs: 0, kind: "other" as const },
    { path: "a", mtimeMs: 0, kind: "artifact" as const },
  ];
  expect(expiredFiles(entries, NOW, { artifact: 1 })).toEqual(["a"]);
});

test("a symlink pointing outside dir is neither followed nor removed through", () => {
  const root = scratch();
  const dir = join(root, "data");
  const outside = join(root, "outside");
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  mkdirSync(outside);
  aged(join(outside, "secret.txt"), 0);
  symlinkSync(outside, join(dir, "transcripts", "link"));
  symlinkSync(join(outside, "secret.txt"), join(dir, "transcripts", "file-link"));
  const removed = sweep(dir, NOW, { transcript: 1 });
  expect(removed).toEqual([]);
  expect(existsSync(join(outside, "secret.txt"))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("sweep returns exactly the removed paths", () => {
  const root = scratch();
  mkdirSync(join(root, "transcripts"));
  mkdirSync(join(root, "misc"));
  const old = join(root, "transcripts", "old.jsonl");
  const fresh = join(root, "transcripts", "fresh.jsonl");
  const other = join(root, "misc", "old.txt");
  aged(old, NOW - 3 * DAY);
  aged(fresh, NOW);
  aged(other, NOW - 3 * DAY);
  const seen: string[] = [];
  const removed = sweep(root, NOW, { transcript: 1 }, (p) => {
    seen.push(p);
    rmSync(p);
  });
  expect(removed).toEqual([old]);
  expect(seen).toEqual([old]);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(other)).toBe(true);
  rmSync(root, { recursive: true, force: true });
});
