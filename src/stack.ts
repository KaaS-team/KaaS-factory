// `factory init`: read a repo's own files and say how it installs, tests and
// lints, as gates and setup commands for .factory/config.json. Pure over a
// file reader, so each stack is a fixture in tests/fixtures/stacks/.
// It reads, never runs: a command it writes is one the repo already names.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GateSpec } from "./config";

export interface RepoFiles {
  exists(path: string): boolean;
  read(path: string): string | undefined;
}

export function diskFiles(dir: string): RepoFiles {
  return {
    exists: (p) => existsSync(join(dir, p)),
    read: (p) => {
      const file = join(dir, p);
      return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : undefined;
    },
  };
}

export interface Stack {
  readonly name: string; // "bun", "pnpm", "uv", "go", "ruby", ...; "unknown" when nothing matched
  readonly setup: string[];
  readonly gates: GateSpec[];
  // Bash patterns the build and verify stages may run.
  readonly commands: string[];
  readonly ci?: string;
  readonly notes: string[];
}

// npm init's placeholder test script fails by design; it is not a test.
const NPM_PLACEHOLDER = /no test specified/;

function makeTargets(files: RepoFiles): Set<string> {
  const text = files.read("Makefile") ?? "";
  return new Set([...text.matchAll(/^([A-Za-z][\w-]*):/gm)].map((m) => m[1]!));
}

function node(files: RepoFiles): Stack | undefined {
  const raw = files.read("package.json");
  if (raw === undefined) return undefined;
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return { name: "node", setup: [], gates: [], commands: [], notes: ["package.json is not valid JSON"] };
  }
  const pm =
    files.exists("bun.lock") || files.exists("bun.lockb")
      ? "bun"
      : files.exists("pnpm-lock.yaml")
        ? "pnpm"
        : files.exists("yarn.lock")
          ? "yarn"
          : "npm";
  const run = (s: string) => (pm === "yarn" ? `yarn ${s}` : `${pm} run ${s}`);
  const setup = {
    bun: "bun install --frozen-lockfile",
    pnpm: "pnpm install --frozen-lockfile",
    yarn: "yarn install --frozen-lockfile",
    npm: "npm ci",
  }[pm]!;
  const gates: GateSpec[] = [];
  const test = scripts.test && !NPM_PLACEHOLDER.test(scripts.test) ? "test" : undefined;
  if (test) gates.push({ name: "test", cmd: run(test), required: true, role: "test" });
  const typecheck = ["typecheck", "type-check", "tsc"].find((s) => scripts[s]);
  if (typecheck) gates.push({ name: "typecheck", cmd: run(typecheck), required: true, role: "typecheck" });
  if (scripts.lint) gates.push({ name: "lint", cmd: run("lint"), required: true, role: "lint" });
  if (scripts.build) gates.push({ name: "build", cmd: run("build"), required: true, role: "build" });
  return {
    name: pm,
    setup: [setup],
    gates,
    commands: [`${pm} *`, ...(pm === "npm" ? ["npx *"] : pm === "bun" ? ["bunx *"] : [])],
    notes: [],
  };
}

function python(files: RepoFiles): Stack | undefined {
  const pyproject = files.read("pyproject.toml");
  if (pyproject === undefined && !files.exists("requirements.txt")) return undefined;
  const text = `${pyproject ?? ""}\n${files.read("requirements.txt") ?? ""}\n${files.read("requirements-dev.txt") ?? ""}`;
  const pm = files.exists("uv.lock") ? "uv" : files.exists("poetry.lock") ? "poetry" : "pip";
  const run = (cmd: string) => (pm === "pip" ? `python -m ${cmd}` : `${pm} run ${cmd}`);
  const setup = {
    uv: "uv sync --frozen",
    poetry: "poetry install --no-interaction",
    pip: "python -m pip install -r requirements.txt",
  }[pm]!;
  const gates: GateSpec[] = [];
  if (/\bpytest\b/.test(text) || files.exists("tests") || files.exists("test"))
    gates.push({ name: "test", cmd: run("pytest"), required: true, role: "test" });
  if (/\bruff\b/.test(text)) gates.push({ name: "lint", cmd: run("ruff check ."), required: true, role: "lint" });
  if (/\bmypy\b/.test(text)) gates.push({ name: "typecheck", cmd: run("mypy ."), required: true, role: "typecheck" });
  return {
    name: pm,
    setup: pm === "pip" && !files.exists("requirements.txt") ? [] : [setup],
    gates,
    commands: pm === "pip" ? ["python *", "pytest *"] : [`${pm} *`],
    notes: [],
  };
}

function go(files: RepoFiles): Stack | undefined {
  if (!files.exists("go.mod")) return undefined;
  return {
    name: "go",
    setup: ["go mod download"],
    gates: [
      { name: "test", cmd: "go test ./...", required: true, role: "test" },
      { name: "vet", cmd: "go vet ./...", required: true, role: "lint" },
    ],
    commands: ["go *"],
    notes: [],
  };
}

function ruby(files: RepoFiles): Stack | undefined {
  if (!files.exists("Gemfile")) return undefined;
  const lock = `${files.read("Gemfile.lock") ?? ""}\n${files.read("Gemfile") ?? ""}`;
  const gates: GateSpec[] = [];
  if (files.exists("spec") || /\brspec\b/.test(lock))
    gates.push({ name: "test", cmd: "bundle exec rspec", required: true, role: "test" });
  else if (files.exists("bin/rails") && files.exists("test"))
    gates.push({ name: "test", cmd: "bin/rails test", required: true, role: "test" });
  if (/\brubocop\b/.test(lock)) gates.push({ name: "lint", cmd: "bundle exec rubocop", required: true, role: "lint" });
  return {
    name: files.exists("bin/rails") ? "rails" : "ruby",
    setup: ["bundle install"],
    gates,
    commands: ["bundle *", ...(files.exists("bin/rails") ? ["bin/rails *"] : [])],
    notes: [],
  };
}

function rust(files: RepoFiles): Stack | undefined {
  if (!files.exists("Cargo.toml")) return undefined;
  return {
    name: "rust",
    setup: ["cargo fetch"],
    gates: [
      { name: "test", cmd: "cargo test", required: true, role: "test" },
      { name: "clippy", cmd: "cargo clippy -- -D warnings", required: false, role: "lint" },
    ],
    commands: ["cargo *"],
    notes: [],
  };
}

// The package managers whose node_modules `npm ls` can read.
const NODE_STACKS = new Set(["bun", "pnpm", "yarn", "npm", "node"]);

// What every stage may run to read installed versions, so a dependency plan is not refused (#87). Offline
// forms only: `npm view` and `uv tree` reach the registry, a free `*` admits --registry, and `node *` runs any code.
export function readCommands(stack: Pick<Stack, "name">): string[] {
  const node = NODE_STACKS.has(stack.name) ? ["npm ls", "npm ls --all", "npm ls --depth *"] : [];
  const uv = stack.name === "uv" ? ["uv pip list", "uv tree --frozen --offline"] : [];
  return [...node, ...uv, "git ls-tree *"];
}

function ciOf(files: RepoFiles): string | undefined {
  if (files.exists(".github/workflows")) return "GitHub Actions";
  if (files.exists(".gitlab-ci.yml")) return "GitLab CI";
  if (files.exists(".circleci")) return "CircleCI";
  if (files.exists("Jenkinsfile")) return "Jenkins";
  return undefined;
}

export function detectStack(files: RepoFiles): Stack {
  const found = node(files) ?? python(files) ?? go(files) ?? ruby(files) ?? rust(files);
  const targets = makeTargets(files);
  const ci = ciOf(files);
  // A Makefile `check` target is the repo's own gate, so it wins over guessing.
  if (targets.has("check")) {
    return {
      name: found?.name ?? "make",
      setup: found?.setup ?? [],
      gates: [{ name: "check", cmd: "make check", required: true, role: "test" }],
      commands: [...(found?.commands ?? []), "make *"],
      ci,
      notes: ["`make check` is the gate; it is assumed to run the tests"],
    };
  }
  const stack = found ?? { name: "unknown", setup: [], gates: [], commands: [], notes: [] };
  const gates = [...stack.gates];
  if (!gates.some((g) => g.role === "test") && targets.has("test"))
    gates.unshift({ name: "test", cmd: "make test", required: true, role: "test" });
  const notes = [...stack.notes];
  if (gates.length === 0)
    notes.push("no test, lint or build command found: add a gate by hand, or the factory parks every issue");
  else if (!gates.some((g) => g.role === "test"))
    notes.push("no test command found: the proof will be unavailable on every PR");
  return { ...stack, gates, commands: [...stack.commands, ...(targets.size ? ["make *"] : [])], ci, notes };
}
