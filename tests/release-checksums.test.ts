// The release workflow recomputes every checksum before it publishes (#584). The staged copy under ci/
// is read when present; the supervisor moves it to .github/workflows/.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const path = [
  join(root, "ci", "release-binaries.yml"),
  join(root, ".github", "workflows", "release-binaries.yml"),
].find(existsSync)!;
type Step = { name?: string; run?: string; "working-directory"?: string };
const wf = Bun.YAML.parse(readFileSync(path, "utf8")) as { jobs: { release: { steps: Step[] } } };
const steps = wf.jobs.release.steps;
const verify = steps.find((s) => s.name === "verify checksums");

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Builds assets/ the way the checksums step does, lets `tamper` change it, then runs the verify step's script.
function runVerify(tamper: (dir: string) => void): number {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  dirs.push(dir);
  writeFileSync(join(dir, "factory-bun-linux-x64"), "linux binary");
  writeFileSync(join(dir, "factory-bun-darwin-arm64"), "mac binary");
  const sums = Bun.spawnSync(["sh", "-c", "sha256sum factory-* > SHA256SUMS"], { timeout: 60_000, cwd: dir });
  expect(sums.exitCode).toBe(0);
  tamper(dir);
  return Bun.spawnSync(["bash", "-eo", "pipefail", "-c", verify!.run!], { timeout: 60_000, cwd: dir }).exitCode;
}

describe("release checksum verification", () => {
  test("a verify step exists, runs in assets/, and comes before the upload", () => {
    expect(verify?.["working-directory"]).toBe("assets");
    const at = (needle: string) => steps.findIndex((s) => (s.run ?? "").includes(needle));
    expect(steps.indexOf(verify!)).toBeGreaterThan(at("> SHA256SUMS"));
    expect(steps.indexOf(verify!)).toBeLessThan(at("gh release upload"));
  });

  test("intact files pass", () => {
    expect(runVerify(() => {})).toBe(0);
  });

  test("a corrupted file fails the release", () => {
    expect(runVerify((d) => writeFileSync(join(d, "factory-bun-linux-x64"), "tampered"))).not.toBe(0);
  });

  test("a binary the checksum file omits fails the release", () => {
    expect(runVerify((d) => writeFileSync(join(d, "factory-bun-linux-arm64"), "unlisted"))).not.toBe(0);
  });

  test("a checksum with no file fails the release", () => {
    expect(runVerify((d) => rmSync(join(d, "factory-bun-darwin-arm64")))).not.toBe(0);
  });
});
