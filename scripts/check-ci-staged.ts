// Cloud runs cannot push to .github/workflows, so they stage workflow changes under ci/ for a lander to move (#635).
//   bun scripts/check-ci-staged.ts   print each staged file's diff against its live twin; exit 1 on a rule below
// A staged file with no live twin must carry a `# staged: new` line. A staged file equal to its live twin was
// already moved: delete the ci/ copy, or the next lander overwrites live changes with an old one.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const STAGED = "ci";
export const LIVE = ".github/workflows";
export const NEW_NOTE = /^#\s*staged:\s*new\b/m;

export interface Staged {
  readonly name: string;
  readonly text: string;
  readonly live: string | undefined;
}

export function problems(files: readonly Staged[]): string[] {
  return files.flatMap((f) => {
    if (f.live === undefined)
      return NEW_NOTE.test(f.text)
        ? []
        : [
            `${STAGED}/${f.name}: no ${LIVE}/${f.name} and no "# staged: new" note; add the note, or it was moved and its copy was deleted`,
          ];
    if (f.live === f.text)
      return [`${STAGED}/${f.name}: identical to ${LIVE}/${f.name}, already moved live; delete the ${STAGED}/ copy`];
    return [];
  });
}

export function readStaged(root: string): Staged[] {
  const dir = join(root, STAGED);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /\.ya?ml$/.test(n))
    .sort()
    .map((name) => {
      const live = join(root, LIVE, name);
      return {
        name,
        text: readFileSync(join(dir, name), "utf8"),
        live: existsSync(live) ? readFileSync(live, "utf8") : undefined,
      };
    });
}

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname;
  const files = readStaged(root);
  for (const f of files) {
    if (f.live === undefined || f.live === f.text) continue;
    console.log(`--- ${LIVE}/${f.name}\n+++ ${STAGED}/${f.name}`);
    const d = Bun.spawnSync(["diff", "-u", join(root, LIVE, f.name), join(root, STAGED, f.name)]);
    console.log(d.stdout.toString().split("\n").slice(2).join("\n"));
  }
  const bad = problems(files);
  for (const p of bad) console.error(`check-ci-staged: ${p}`);
  if (bad.length > 0) process.exit(1);
  console.log(`check-ci-staged: ok (${files.length} staged)`);
}
