// install.sh's default (skip existing files) behavior has no test today;
// this file covers that plus the new --update (audit finding #17: template
// fixes couldn't reach an already-installed repo) and --ci flags. Runs the
// real script against a scratch target dir — no fakes, this is a shell
// script.

import { describe, expect, test, setDefaultTimeout } from "bun:test";

// Real git processes: a loaded machine can exceed bun's 5s default.
setDefaultTimeout(30_000);
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, sha256 } from "../src/doctor";

const SCRIPT = join(import.meta.dir, "..", "install.sh");

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bash", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function scratchTarget(): string {
  return mkdtempSync(join(tmpdir(), "factory-install-"));
}

describe("install.sh (default)", () => {
  test("writes the template into an empty target", () => {
    const target = scratchTarget();
    const { code } = run([target]);
    expect(code).toBe(0);
    expect(existsSync(join(target, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(target, ".claude", "hooks", "guard-paths.sh"))).toBe(true);
    rmSync(target, { recursive: true, force: true });
  });

  // The `src/labels.ts:48` claim ("set by the issue form") is only true once
  // install actually ships a form (plan v2.6.2 item 5); this fails if the
  // template stops shipping one or a form starts applying `factory:ready`.
  test("ships issue forms (type label only) and a PR template", () => {
    const target = scratchTarget();
    run([target]);
    for (const type of ["bug", "feature", "docs"]) {
      const path = join(target, ".github", "ISSUE_TEMPLATE", `${type}.yml`);
      expect(existsSync(path)).toBe(true);
      const body = readFileSync(path, "utf8");
      const labelsLine = body.split("\n").find((l) => l.startsWith("labels:"));
      expect(labelsLine).toBe(`labels: ["${type}"]`); // the form applies only its type label
    }
    const pr = readFileSync(join(target, ".github", "pull_request_template.md"), "utf8");
    for (const heading of ["## Summary", "## Plan", "## Gate evidence", "## Verify verdict", "## Risk and rollback"]) {
      expect(pr).toContain(heading);
    }
    rmSync(target, { recursive: true, force: true });
  });

  // `src/labels.ts:48` claims type labels are "set by the issue form" — true
  // only once something actually creates those labels on the repo. The form
  // itself can't (a GitHub issue form applies a label, it doesn't create
  // one), so install's own next-step points at the command that does.
  test("tells the user to run `factory doctor --fix`, which is what actually creates the labels", () => {
    const target = scratchTarget();
    const { stdout } = run([target]);
    expect(stdout).toContain("factory doctor --fix");
    rmSync(target, { recursive: true, force: true });
  });

  test("never overwrites a file that already exists", () => {
    const target = scratchTarget();
    mkdirSync(join(target, ".claude"), { recursive: true });
    writeFileSync(join(target, ".claude", "settings.json"), "custom content");
    const { stdout } = run([target]);
    expect(stdout).toContain("skip (exists): .claude/settings.json");
    expect(readFileSync(join(target, ".claude", "settings.json"), "utf8")).toBe("custom content");
    rmSync(target, { recursive: true, force: true });
  });

  test("--dry-run writes nothing", () => {
    const target = scratchTarget();
    run([target, "--dry-run"]);
    expect(existsSync(join(target, ".claude", "settings.json"))).toBe(false);
    rmSync(target, { recursive: true, force: true });
  });
});

describe("install.sh --update", () => {
  test("overwrites a factory-owned file that already exists", () => {
    const target = scratchTarget();
    run([target]); // first install
    writeFileSync(join(target, ".claude", "hooks", "guard-paths.sh"), "#!/usr/bin/env bash\n# stale\n");
    const { stdout } = run([target, "--update"]);
    expect(stdout).toContain("overwrote: .claude/hooks/guard-paths.sh");
    const updated = readFileSync(join(target, ".claude", "hooks", "guard-paths.sh"), "utf8");
    expect(updated).toContain("fails closed"); // the current template content, not the stale stub
    rmSync(target, { recursive: true, force: true });
  });

  test("never silently overwrites settings.json; writes a .factory-new for review when it differs", () => {
    const target = scratchTarget();
    run([target]);
    writeFileSync(join(target, ".claude", "settings.json"), '{"custom": true}');
    const { stdout } = run([target, "--update"]);
    expect(stdout).toContain("not overwritten");
    expect(readFileSync(join(target, ".claude", "settings.json"), "utf8")).toBe('{"custom": true}');
    expect(existsSync(join(target, ".claude", "settings.json.factory-new"))).toBe(true);
    rmSync(target, { recursive: true, force: true });
  });

  test("leaves settings.json alone (no .factory-new) when it already matches the template", () => {
    const target = scratchTarget();
    run([target]);
    const { stdout } = run([target, "--update"]);
    expect(stdout).toContain("unchanged: .claude/settings.json");
    expect(existsSync(join(target, ".claude", "settings.json.factory-new"))).toBe(false);
    rmSync(target, { recursive: true, force: true });
  });
});

describe("install.sh --ci", () => {
  test("writes an inert factory.yml.example placeholder", () => {
    const target = scratchTarget();
    const { code, stdout } = run([target, "--ci"]);
    expect(code).toBe(0);
    expect(stdout).toContain("inert");
    const written = join(target, ".github", "workflows", "factory.yml.example");
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, "utf8")).toContain("FACTORY_MODE=actions");
    rmSync(target, { recursive: true, force: true });
  });
});

describe("install.sh scaffold", () => {
  test("writes an executable gates.sh, a config example and a charter", () => {
    const target = scratchTarget();
    run([target]);
    for (const f of ["gates.sh", "mutate.sh", "config.example.json", "charter.md"]) {
      expect(existsSync(join(target, ".factory", f))).toBe(true);
    }
    expect(Bun.spawnSync(["test", "-x", join(target, ".factory", "gates.sh")]).exitCode).toBe(0);
    expect(Bun.spawnSync(["test", "-x", join(target, ".factory", "mutate.sh")]).exitCode).toBe(0);
    expect(existsSync(join(target, ".factory", "config.json"))).toBe(false);
    rmSync(target, { recursive: true, force: true });
  });

  // v3.0 folded factory-verifier into the verify skill and replaced factory-explorer with
  // Claude Code's Explore; a repo updated from v2 must not keep either.
  test("--update removes the agents v3.0 retired, and a plain install leaves them", () => {
    for (const update of [true, false]) {
      const target = scratchTarget();
      mkdirSync(join(target, ".claude", "agents"), { recursive: true });
      for (const f of ["factory-verifier.md", "factory-explorer.md"])
        writeFileSync(join(target, ".claude", "agents", f), "old");
      const { stdout } = run(update ? [target, "--update"] : [target]);
      for (const f of ["factory-verifier.md", "factory-explorer.md"]) {
        expect(existsSync(join(target, ".claude", "agents", f))).toBe(!update);
        if (update) expect(stdout).toContain(`removed (retired): .claude/agents/${f}`);
      }
      expect(existsSync(join(target, ".claude", "agents", "factory-reviewer.md"))).toBe(true);
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("--update refreshes gates.sh but never touches the repo's charter", () => {
    const target = scratchTarget();
    run([target]);
    writeFileSync(join(target, ".factory", "charter.md"), "my charter");
    writeFileSync(join(target, ".factory", "gates.sh"), "old");
    writeFileSync(join(target, ".factory", "mutate.sh"), "old");
    chmodSync(join(target, ".factory", "mutate.sh"), 0o644);
    run([target, "--update"]);
    expect(readFileSync(join(target, ".factory", "charter.md"), "utf8")).toBe("my charter");
    expect(readFileSync(join(target, ".factory", "gates.sh"), "utf8")).not.toBe("old");
    // A repo installed before mutate.sh shipped gets it, executable, from --update (#42).
    expect(readFileSync(join(target, ".factory", "mutate.sh"), "utf8")).not.toBe("old");
    expect(Bun.spawnSync(["test", "-x", join(target, ".factory", "mutate.sh")]).exitCode).toBe(0);
    rmSync(target, { recursive: true, force: true });
  });

  test("writes a starter lessons.md, and --update never overwrites accumulated lessons", () => {
    const target = scratchTarget();
    run([target]);
    expect(existsSync(join(target, ".factory", "memory", "lessons.md"))).toBe(true);
    writeFileSync(join(target, ".factory", "memory", "lessons.md"), "my accumulated lessons");
    run([target, "--update"]);
    expect(readFileSync(join(target, ".factory", "memory", "lessons.md"), "utf8")).toBe("my accumulated lessons");
    rmSync(target, { recursive: true, force: true });
  });
});

// `bin/factory install` wiring: fixDoctor itself is unit-tested directly
// (tests/doctor.test.ts) since `cmdInstall` builds its ScmPort with `makeScm(config)`, no
// seam to inject a fake for an in-process test. This proves the wiring
// exists and is skipped on --dry-run, so a real install is never silently
// missing the label-creation step it claims to run (plan v2.11.0 item A).
describe("factory install calls fixDoctor", () => {
  const bin = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");
  const start = bin.indexOf("async function cmdInstall");
  const end = bin.indexOf("async function main");
  const cmdInstall = bin.slice(start, end);

  test("calls fixDoctor after a real install", () => {
    // Whitespace-blind, so the formatter can wrap the call.
    expect(cmdInstall.replace(/\s+/g, "")).toContain(
      "awaitfixDoctor(makeScm(config),config.repo,config.routes,awaitworkflowFor(resolve(target),config)",
    );
  });

  test("returns before fixDoctor when --dry-run is set", () => {
    const dryRunIdx = cmdInstall.indexOf('has("dry-run")');
    const returnIdx = cmdInstall.indexOf("return;", dryRunIdx);
    const fixDoctorIdx = cmdInstall.indexOf("fixDoctor(");
    expect(dryRunIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(dryRunIdx);
    expect(returnIdx).toBeLessThan(fixDoctorIdx);
  });
});

describe("install.sh --agents", () => {
  const { PRESETS } = require("../src/agents/presets") as typeof import("../src/agents/presets");
  const { lstatSync, readlinkSync } = require("node:fs") as typeof import("node:fs");

  test("every preset's skills dir is linked to .claude/skills and resolves to the real skills", () => {
    const target = scratchTarget();
    const names = Object.keys(PRESETS);
    const { code, stderr } = run([target, "--agents", names.join(",")]);
    expect(code, stderr).toBe(0);
    for (const p of Object.values(PRESETS)) {
      if (p.skillsDir === ".claude/skills") continue;
      expect(lstatSync(join(target, p.skillsDir)).isSymbolicLink(), p.skillsDir).toBe(true);
      expect(
        existsSync(join(target, p.skillsDir, "factory-plan", "SKILL.md")),
        `${p.skillsDir} does not resolve (${readlinkSync(join(target, p.skillsDir))})`,
      ).toBe(true);
    }
    rmSync(target, { recursive: true, force: true });
  });

  test("writes a context pointer per agent only when absent: GEMINI.md for gemini, AGENTS.md otherwise", () => {
    const target = scratchTarget();
    writeFileSync(join(target, "AGENTS.md"), "mine");
    run([target, "--agents", "gemini,pi"]);
    expect(readFileSync(join(target, "GEMINI.md"), "utf8")).toContain(".claude/skills");
    expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toBe("mine");
    rmSync(target, { recursive: true, force: true });
  });

  test("an unknown agent fails before anything is linked; --dry-run writes no links", () => {
    const target = scratchTarget();
    expect(run([target, "--agents", "nope"]).code).toBe(1);
    expect(existsSync(join(target, ".claude"))).toBe(false); // nothing written before the check
    expect(run([target, "--agents", "--dry-run"]).code).toBe(1); // a flag is not an agent list
    expect(run([target, "--agents"]).code).toBe(1);
    const dry = scratchTarget();
    run([dry, "--agents", "pi", "--dry-run"]);
    expect(existsSync(join(dry, ".pi"))).toBe(false);
    rmSync(target, { recursive: true, force: true });
    rmSync(dry, { recursive: true, force: true });
  });
});

describe("install manifest and doctor drift", () => {
  const drift = async (target: string, templateOverrides?: string[]) => {
    const readFile = async (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : undefined);
    const github = { authStatus: async () => ({ ok: true, detail: "" }) } as never;
    const d = {
      github,
      git: {} as never,
      which: async () => true,
      fileExists: async () => true,
      readFile,
      isExecutable: async () => true,
    };
    const checks = await runDoctor(d, { repo: "a/b", cloneDir: target, baselineTag: "", templateOverrides });
    return checks.find((c) => c.name === "factory files unchanged since install");
  };

  test("lists every factory file it installed, but not repo-owned files or a file the repo already had", () => {
    const target = scratchTarget();
    mkdirSync(join(target, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(target, ".claude", "hooks", "guard-paths.sh"), "# ours\n");
    expect(run([target]).code).toBe(0);
    const files = JSON.parse(readFileSync(join(target, ".factory", "manifest.json"), "utf8")).files;
    expect(files[".claude/settings.json"]).toBe(sha256(readFileSync(join(target, ".claude", "settings.json"), "utf8")));
    expect(files[".claude/hooks/guard-paths.sh"]).toBeUndefined();
    expect(files[".factory/charter.md"]).toBeUndefined();
    rmSync(target, { recursive: true, force: true });
  });

  test("doctor passes on a fresh install and names a file edited after it, unless overridden", async () => {
    const target = scratchTarget();
    expect(run([target]).code).toBe(0);
    expect((await drift(target))?.ok).toBe(true);
    writeFileSync(join(target, ".claude", "hooks", "guard-paths.sh"), "# edited\n");
    const check = (await drift(target))!;
    expect(check.ok).toBe(false);
    expect(check.warn).toBe(true);
    expect(check.detail).toContain(".claude/hooks/guard-paths.sh");
    expect((await drift(target, [".claude/hooks/"]))?.ok).toBe(true);
    rmSync(target, { recursive: true, force: true });
  });

  test("--dry-run writes no manifest", () => {
    const target = scratchTarget();
    expect(run([target, "--dry-run"]).code).toBe(0);
    expect(existsSync(join(target, ".factory", "manifest.json"))).toBe(false);
    rmSync(target, { recursive: true, force: true });
  });
});
