// The npm wrapper downloads the release binary and checks its sha256 before it lands.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, install } from "../npm/install.js";

const bytes = Buffer.from("#!/bin/sh\necho factory\n");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function release(sums: string) {
  const urls: string[] = [];
  const fetchFn = async (url: string) => {
    urls.push(url);
    if (url.endsWith("/SHA256SUMS")) return new Response(sums);
    return url.endsWith("/factory-linux-x64") ? new Response(bytes) : new Response("no", { status: 404 });
  };
  return { urls, fetchFn };
}

function tmp() {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), "npm-wrapper-"));
}

describe("npm wrapper install", () => {
  test("a good checksum installs the binary for the platform", async () => {
    const dir = tmp();
    try {
      const { urls, fetchFn } = release(`${sha(bytes)}  factory-linux-x64\n${"0".repeat(64)}  factory-darwin-arm64\n`);
      const dest = join(dir, "bin", "factory-bin");
      await install({ version: "8.0.0", dest, platform: "linux", arch: "x64", fetchFn });
      expect(readFileSync(dest)).toEqual(bytes);
      expect(urls).toContain("https://github.com/KaaS-team/KaaS-factory/releases/download/v8.0.0/factory-linux-x64");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a bad checksum fails, names the file, and leaves no binary", async () => {
    const dir = tmp();
    try {
      const { fetchFn } = release(`${"a".repeat(64)}  factory-linux-x64\n`);
      const dest = join(dir, "factory-bin");
      await expect(install({ version: "8.0.0", dest, platform: "linux", arch: "x64", fetchFn })).rejects.toThrow(
        /checksum mismatch for factory-linux-x64/,
      );
      expect(existsSync(dest)).toBe(false);
      expect(existsSync(`${dest}.part`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing SHA256SUMS entry fails and names the file", async () => {
    const dir = tmp();
    try {
      const { fetchFn } = release(`${sha(bytes)}  factory-darwin-x64\n`);
      await expect(
        install({ version: "8.0.0", dest: join(dir, "b"), platform: "linux", arch: "x64", fetchFn }),
      ).rejects.toThrow(/no entry for factory-linux-x64/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("asset names match what build-binary writes, and an unsupported platform is refused", () => {
    expect(assetName("darwin", "arm64")).toBe("factory-darwin-arm64");
    expect(assetName("linux", "x64")).toBe("factory-linux-x64");
    expect(() => assetName("win32", "x64")).toThrow(/win32\/x64/);
  });
});
