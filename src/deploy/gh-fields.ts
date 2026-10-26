// v6.0.0's image pinned a gh too old for `closingIssuesReferences`, so every hosted inbox read failed.
// gh rejects an unknown --json field before it calls GitHub, so each field set the code asks for runs
// here with a dummy token; the docker-build CI job runs this inside the image.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GhJsonCall {
  file: string;
  args: string[];
}

const SCANNED = ["src", "dashboard", "ee"];

// Every gh call written as an array literal whose first two strings are a command and its verb.
export function ghJsonCalls(text: string, file = ""): GhJsonCall[] {
  const calls: GhJsonCall[] = [];
  for (const m of text.matchAll(/\[\s*"(pr|issue|label|run|release|repo|workflow)",\s*"([a-z-]+)",([^\]]*)\]/g)) {
    const fields = m[3]!.match(/"--json",\s*"([^"]+)"/)?.[1];
    if (!fields) continue;
    const view = m[2] === "view" ? ["1"] : [];
    calls.push({ file, args: [m[1]!, m[2]!, ...view, "--repo", "kaas-team/probe", "--json", fields] });
  }
  return calls;
}

export function repoGhJsonCalls(root: string): GhJsonCall[] {
  return SCANNED.flatMap((dir) => {
    let names: string[];
    try {
      names = readdirSync(join(root, dir), { recursive: true }) as string[];
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith(".ts") && !n.includes("node_modules"))
      .flatMap((n) => ghJsonCalls(readFileSync(join(root, dir, n), "utf8"), join(dir, n)));
  });
}

// The calls whose fields this gh does not know, each with gh's own complaint.
export function unknownFields(calls: GhJsonCall[], gh = "gh"): { call: GhJsonCall; error: string }[] {
  const env = { ...process.env, GH_TOKEN: "dummy", GH_PROMPT_DISABLED: "1", GH_CONFIG_DIR: "/nonexistent" };
  return calls.flatMap((call) => {
    const out = Bun.spawnSync([gh, ...call.args], { env, timeout: 20_000 });
    const text = `${out.stdout}${out.stderr}`;
    const line = text.split("\n").find((l) => l.startsWith("Unknown JSON field"));
    return line ? [{ call, error: line }] : [];
  });
}

if (import.meta.main) {
  const calls = repoGhJsonCalls(join(import.meta.dir, "..", ".."));
  if (calls.length === 0) throw new Error("gh-fields: found no gh --json calls, so the scan is broken");
  const bad = unknownFields(calls);
  for (const b of bad) console.error(`${b.call.file}: gh ${b.call.args.slice(0, 2).join(" ")}: ${b.error}`);
  console.log(`gh-fields: ${calls.length} call(s), ${bad.length} with a field this gh does not know`);
  process.exit(bad.length ? 1 : 0);
}
