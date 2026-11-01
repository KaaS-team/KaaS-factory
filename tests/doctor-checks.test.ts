// The doctor registry: checks join doctor by an entry in src/doctor-checks.ts, never in src/cli.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig } from "../src/config";
import type { DoctorCheck } from "../src/doctor";
import { DOCTOR_CHECKS, type DoctorEnv, liveDoctorChecks } from "../src/doctor-checks";

const ROOT = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const row = (name: string): DoctorCheck => ({ name, ok: true, detail: "stub", fixable: false });

describe("doctor check registry", () => {
  test("the live checks keep their order: core rows, then the merge method row", () => {
    expect(DOCTOR_CHECKS.map((source) => source.name)).toEqual(["coreChecks", "mergeMethod"]);
  });

  test("every source declared in src/doctor-checks.ts is registered", () => {
    const declared = [...read("src/doctor-checks.ts").matchAll(/^const (\w+): DoctorCheckSource\b/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual(DOCTOR_CHECKS.map((source) => source.name).sort());
  });

  test("rows come out in registry order, each source's rows kept together", async () => {
    const env = {} as DoctorEnv;
    const config = {} as FactoryConfig;
    const rows = await liveDoctorChecks(config, env, [
      async () => [row("a1"), row("a2")],
      async () => [],
      async () => [row("b1")],
    ]);
    expect(rows.map((r) => r.name)).toEqual(["a1", "a2", "b1"]);
  });

  test("src/cli.ts composes no check inline", () => {
    const cli = read("src/cli.ts").replace(/^\s*\/\/.*$/gm, "");
    expect(cli).toContain("liveDoctorChecks");
    expect(cli).not.toMatch(/\brunDoctor\b/);
    expect(cli).not.toMatch(/\bmergeMethodCheck\b/);
    expect(cli).not.toMatch(/\bagentChecks\b/);
  });
});
