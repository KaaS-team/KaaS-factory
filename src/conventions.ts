// A conventions profile: what a repo's own config files say about its formatter, linter, type
// checker and style, so the build and verify stages write code the repo's own CI accepts. It reads,
// never runs. A command it names is one the repo already configures.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { diskFiles, type RepoFiles } from "./stack";

export interface ConventionFiles extends RepoFiles {
  // File names directly inside `dir` (a directory), or [] when it is missing.
  list(dir: string): string[];
}

export function diskConventionFiles(dir: string): ConventionFiles {
  return {
    ...diskFiles(dir),
    list: (d) => {
      try {
        return readdirSync(join(dir, d));
      } catch {
        return [];
      }
    },
  };
}

export type ToolRole = "format" | "lint" | "typecheck";

export interface Tool {
  readonly role: ToolRole;
  readonly name: string;
  // Runs from the repo root and exits non-zero on a problem. Exit 127 means the tool is not installed.
  readonly cmd: string;
  // A format check runs on the changed files only, so a repo's old style problems never fail a change.
  // `{files}` in `cmd` is replaced by them; `exts` says which changed files the formatter reads.
  readonly exts?: readonly string[];
}

export interface Conventions {
  readonly tools: Tool[];
  // One plain sentence per style fact the repo's config states.
  readonly style: string[];
  readonly tests: string[];
}

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"];

function nodeBin(bin: string, args: string): string {
  return `[ -x node_modules/.bin/${bin} ] || exit 127; node_modules/.bin/${bin} ${args}`;
}

function pathTool(bin: string, args: string): string {
  return `command -v ${bin} >/dev/null 2>&1 || exit 127; ${bin} ${args}`;
}

function pick(files: RepoFiles, names: readonly string[]): string | undefined {
  return names.find((n) => files.exists(n));
}

function pkg(files: RepoFiles): { deps: Set<string>; raw: Record<string, unknown> } {
  try {
    const raw = JSON.parse(files.read("package.json") ?? "{}") as Record<string, unknown>;
    const deps = new Set([
      ...Object.keys((raw.dependencies as object) ?? {}),
      ...Object.keys((raw.devDependencies as object) ?? {}),
    ]);
    return { deps, raw };
  } catch {
    return { deps: new Set(), raw: {} };
  }
}

function nodeTools(files: RepoFiles, tools: Tool[], style: string[]): void {
  const { deps, raw } = pkg(files);
  const biome = pick(files, ["biome.json", "biome.jsonc"]);
  const prettier =
    pick(files, [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.yaml",
      ".prettierrc.yml",
      ".prettierrc.js",
      ".prettierrc.cjs",
      ".prettierrc.mjs",
      "prettier.config.js",
      "prettier.config.cjs",
      "prettier.config.mjs",
    ]) ?? (raw.prettier !== undefined ? "package.json" : undefined);
  if (biome) {
    tools.push({ role: "format", name: "biome", cmd: nodeBin("biome", "format {files}"), exts: JS_EXTS });
    tools.push({ role: "lint", name: "biome", cmd: nodeBin("biome", "lint .") });
    biomeStyle(files.read(biome) ?? "", style);
  } else if (prettier || deps.has("prettier")) {
    tools.push({ role: "format", name: "prettier", cmd: nodeBin("prettier", "--check {files}"), exts: JS_EXTS });
    if (prettier && prettier !== "package.json") prettierStyle(files.read(prettier) ?? "", style);
    else if (prettier) prettierStyle(JSON.stringify(raw.prettier), style);
  }
  const eslint = pick(files, [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.yml",
    ".eslintrc.yaml",
  ]);
  if (!biome && eslint) tools.push({ role: "lint", name: "eslint", cmd: nodeBin("eslint", ".") });
  if (files.exists("tsconfig.json")) tools.push({ role: "typecheck", name: "tsc", cmd: nodeBin("tsc", "--noEmit") });
}

function biomeStyle(text: string, style: string[]): void {
  const indent = /"indentStyle"\s*:\s*"(\w+)"/.exec(text)?.[1];
  const width = /"indentWidth"\s*:\s*(\d+)/.exec(text)?.[1];
  const line = /"lineWidth"\s*:\s*(\d+)/.exec(text)?.[1];
  const quote = /"quoteStyle"\s*:\s*"(\w+)"/.exec(text)?.[1];
  const semi = /"semicolons"\s*:\s*"(\w+)"/.exec(text)?.[1];
  if (indent) style.push(`Indent with ${indent === "tab" ? "tabs" : `spaces${width ? ` (${width})` : ""}`}.`);
  if (line) style.push(`Lines wrap at ${line} columns.`);
  if (quote) style.push(`Use ${quote} quotes in JavaScript and TypeScript.`);
  if (semi) style.push(semi === "asNeeded" ? "Omit semicolons where optional." : "End statements with semicolons.");
}

function prettierStyle(text: string, style: string[]): void {
  const flag = (key: string) => new RegExp(`["']?${key}["']?\\s*[:=]\\s*(true|false)`).exec(text)?.[1];
  const num = (key: string) => new RegExp(`["']?${key}["']?\\s*[:=]\\s*(\\d+)`).exec(text)?.[1];
  const tabs = flag("useTabs");
  const width = num("tabWidth");
  const print = num("printWidth");
  const single = flag("singleQuote");
  const semi = flag("semi");
  if (tabs) style.push(`Indent with ${tabs === "true" ? "tabs" : `spaces${width ? ` (${width})` : ""}`}.`);
  else if (width) style.push(`Indent with ${width} spaces.`);
  if (print) style.push(`Lines wrap at ${print} columns.`);
  if (single) style.push(`Use ${single === "true" ? "single" : "double"} quotes in JavaScript and TypeScript.`);
  if (semi) style.push(semi === "false" ? "Omit semicolons where optional." : "End statements with semicolons.");
}

function editorconfig(text: string, style: string[]): void {
  const indent = /^\s*indent_style\s*=\s*(\w+)/m.exec(text)?.[1];
  const size = /^\s*indent_size\s*=\s*(\w+)/m.exec(text)?.[1];
  if (indent && !style.some((s) => s.startsWith("Indent with")))
    style.push(`Indent with ${indent === "tab" ? "tabs" : `spaces${size ? ` (${size})` : ""}`}.`);
}

function pythonTools(files: RepoFiles, tools: Tool[]): void {
  const text = `${files.read("pyproject.toml") ?? ""}\n${files.read("ruff.toml") ?? ""}\n${files.read("requirements-dev.txt") ?? ""}`;
  const py = [".py"];
  if (/\[tool\.ruff|\bruff\b/.test(text) || files.exists("ruff.toml")) {
    tools.push({ role: "format", name: "ruff", cmd: pathTool("ruff", "format --check {files}"), exts: py });
    tools.push({ role: "lint", name: "ruff", cmd: pathTool("ruff", "check .") });
  } else if (/\[tool\.black\]|\bblack\b/.test(text)) {
    tools.push({ role: "format", name: "black", cmd: pathTool("black", "--check {files}"), exts: py });
  }
  if (/\[tool\.mypy\]|\bmypy\b/.test(text) || files.exists("mypy.ini"))
    tools.push({ role: "typecheck", name: "mypy", cmd: pathTool("mypy", ".") });
}

function otherTools(files: RepoFiles, tools: Tool[]): void {
  if (files.exists("go.mod")) {
    tools.push({
      role: "format",
      name: "gofmt",
      cmd: `command -v gofmt >/dev/null 2>&1 || exit 127; test -z "$(gofmt -l {files})"`,
      exts: [".go"],
    });
    tools.push({ role: "lint", name: "go vet", cmd: pathTool("go", "vet ./...") });
  }
  if (files.exists("Cargo.toml")) {
    tools.push({ role: "format", name: "rustfmt", cmd: pathTool("rustfmt", "--check {files}"), exts: [".rs"] });
    tools.push({ role: "lint", name: "clippy", cmd: pathTool("cargo", "clippy -- -D warnings") });
  }
  if (files.exists(".rubocop.yml")) tools.push({ role: "lint", name: "rubocop", cmd: pathTool("rubocop", "") });
}

const TEST_DIRS = ["tests", "test", "__tests__", "spec"];

function testLayout(files: ConventionFiles): string[] {
  const out: string[] = [];
  const dir = TEST_DIRS.find((d) => files.exists(d));
  const names = (dir ? files.list(dir) : []).filter((n) => /\.(test|spec)\.|_test\.|_spec\.|^test_/.test(n));
  if (dir) out.push(`Tests live in \`${dir}/\`.`);
  const suffix = [".test.", ".spec."].find((s) => names.some((n) => n.includes(s)));
  if (suffix) out.push(`Test files are named \`*${suffix.slice(0, -1)}.<ext>\`.`);
  if (!dir) {
    const colocated = files.list("src").find((n) => /\.(test|spec)\./.test(n));
    if (colocated) out.push("Tests sit beside the code they cover in `src/`.");
  }
  return out;
}

export function detectConventions(files: ConventionFiles): Conventions {
  const tools: Tool[] = [];
  const style: string[] = [];
  if (files.exists("package.json")) nodeTools(files, tools, style);
  pythonTools(files, tools);
  otherTools(files, tools);
  const ec = files.read(".editorconfig");
  if (ec) editorconfig(ec, style);
  if (files.exists("tsconfig.json") && /"type"\s*:\s*"module"/.test(files.read("package.json") ?? ""))
    style.push("Modules are ESM: use `import`, not `require`.");
  return { tools, style, tests: testLayout(files) };
}

// The section the build and verify stages read. "" when the repo states nothing.
export function renderConventions(c: Conventions): string {
  const lines: string[] = [];
  const names = (role: ToolRole) => [...new Set(c.tools.filter((t) => t.role === role).map((t) => t.name))].join(", ");
  for (const [role, label] of [
    ["format", "Formatter"],
    ["lint", "Linter"],
    ["typecheck", "Type checker"],
  ] as const) {
    const n = names(role);
    if (n)
      lines.push(
        `- ${label}: ${n}. The gate runs it, and ${role === "format" ? "a format diff fails the build" : "a failure fails the build"}.`,
      );
  }
  for (const s of [...c.style, ...c.tests]) lines.push(`- ${s}`);
  if (lines.length === 0) return "";
  return `Match the repo's own style. Write code its formatter would leave unchanged.\n\n${lines.join("\n")}`;
}

export async function conventionsSection(dir: string): Promise<{ label: string; body: string } | undefined> {
  const body = renderConventions(detectConventions(diskConventionFiles(dir)));
  return body ? { label: "detected conventions", body } : undefined;
}
