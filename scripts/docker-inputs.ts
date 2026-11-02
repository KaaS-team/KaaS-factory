// Whether a CI event should build the Docker image: only when changed files touch COPY sources.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

export function copySources(dockerfile: string): string[] {
  const copied = [...dockerfile.matchAll(/^COPY (?!--from)(.+) \.\/\S*$/gm)].flatMap((m) =>
    (m[1] ?? "").split(" ").map((p) => p.replace(/\/$/, "")),
  );
  return [...copied, "Dockerfile", ".dockerignore"];
}

export function touchesImage(changed: readonly string[], sources: readonly string[]): boolean {
  for (const path of changed) {
    for (const src of sources) {
      if (path === src) return true;
      if (path.startsWith(`${src}/`)) return true;
    }
  }
  return false;
}

function changedBetween(base: string, head: string): string[] {
  const proc = Bun.spawnSync(["git", "diff", "--name-only", `${base}...${head}`], { cwd: ROOT });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().split("\n").filter(Boolean);
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: bun scripts/docker-inputs.ts <base> <head>");
    process.exit(2);
  }
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  const build = touchesImage(changedBetween(base, head), copySources(dockerfile));
  console.log(build ? "build=true" : "build=false");
}
