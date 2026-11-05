// make fast runs this: each generated file whose source changed gets its freshness check now, not after a push (#633).
// A generated file lists the script that writes it; a change to that script, a file it imports, or the file itself selects its check.
//
//   bun scripts/check-generated-docs.ts <base>   run the checks the change since <base> selects
import { importClosure } from "./import-graph";

export interface Generated {
  readonly file: string;
  readonly generator: string;
  readonly sources?: readonly string[]; // path prefixes outside the generator's imports
  readonly check: readonly string[];
}

export const GENERATED: readonly Generated[] = [
  {
    file: "docs/cli-reference.md",
    generator: "scripts/gen-cli-reference.ts",
    check: ["make", "check-cli-reference"],
  },
  {
    file: "docs/agents.md",
    generator: "scripts/gen-agents-doc.ts",
    check: ["bun", "test", "tests/agents-registry.test.ts"],
  },
  {
    file: "docs/integrations.md",
    generator: "scripts/gen-integrations-doc.ts",
    sources: ["integrations/"],
    check: ["bun", "test", "tests/integrations.test.ts"],
  },
  {
    file: "src/api/openapi.json",
    generator: "scripts/openapi.ts",
    check: ["bun", "test", "tests/api-routes.test.ts"],
  },
];

export function affected(changed: readonly string[], root: string): Generated[] {
  return GENERATED.filter((g) => {
    const closure = importClosure(g.generator, root);
    return changed.some((f) => f === g.file || closure.has(f) || (g.sources ?? []).some((p) => f.startsWith(p)));
  });
}

if (import.meta.main) {
  const base = process.argv[2];
  if (base === undefined) {
    console.error("usage: bun scripts/check-generated-docs.ts <base>");
    process.exit(2);
  }
  const root = new URL("..", import.meta.url).pathname;
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root });
  const mergeBase = git("merge-base", base, "HEAD").stdout.toString().trim() || base;
  const diff = git("diff", "--name-only", mergeBase);
  if (diff.exitCode !== 0) {
    console.error(`check-generated-docs: git diff against ${base} failed: ${diff.stderr}`);
    process.exit(2);
  }
  const changed = diff.stdout.toString().split("\n").filter(Boolean);
  let failed = false;
  for (const g of affected(changed, root)) {
    console.log(`check-generated-docs: ${g.file} (${g.check.join(" ")})`);
    if (Bun.spawnSync([...g.check], { cwd: root, stdout: "inherit", stderr: "inherit" }).exitCode !== 0) failed = true;
  }
  if (failed) process.exit(1);
  console.log("check-generated-docs: ok");
}
