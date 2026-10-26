// `--json-schema` constrains only Claude's final message, so it never replaces the stop-artifact hook:
// the runner arms the hook with the artifact schema whether or not the flag is on.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../src/agents/executor";

const HOOK = join(import.meta.dir, "..", "template", ".claude", "hooks", "stop-artifact.sh");

test("--json-schema constrains only the final message, and the hook still checks the artifact files", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-json-schema-"));
  const bin = join(root, "bin");
  const keep = join(root, "keep");
  mkdirSync(bin);
  mkdirSync(keep);
  // A stand-in `claude` that records its argv and the schema the runner armed the hook with.
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/bash\nprintf '%s\\n' "$@" > "${keep}/argv"\ncp "$FACTORY_SCRATCH_DIR/artifact.schema.json" "${keep}/" 2>/dev/null\nexit 0\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  try {
    for (const outputSchema of [true, false]) {
      rmSync(join(keep, "artifact.schema.json"), { force: true });
      const ex = new CommandExecutor({ c: { preset: "claude", outputSchema } } as never, { build: "c" } as never);
      await ex.runStage({ stage: "build", issue: 7, cwd: root, maxBudgetUsd: 1 } as never).catch(() => undefined);
      const argv = readFileSync(join(keep, "argv"), "utf8").split("\n");
      const at = argv.indexOf("--json-schema");
      if (outputSchema) expect(JSON.parse(argv[at + 1]!)).toHaveProperty("type");
      else expect(at).toBe(-1);

      // The flag or not, the hook is armed and sends back an artifact file that breaks the schema.
      const scratch = join(root, "scratch");
      const runs = join(root, "runs");
      mkdirSync(scratch, { recursive: true });
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(scratch, "artifact.schema.json"), readFileSync(join(keep, "artifact.schema.json")));
      writeFileSync(join(runs, "build.json"), JSON.stringify({ status: "green", rounds: 1 }));
      const proc = Bun.spawn(["bash", HOOK], {
        stdin: new Blob([JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false })]),
        stdout: "pipe",
        env: { ...process.env, FACTORY_STAGE: "build", FACTORY_SCRATCH_DIR: scratch, FACTORY_ARTIFACT_DIR: runs },
      });
      const out = await new Response(proc.stdout).text();
      expect(JSON.parse(out)).toMatchObject({ decision: "block" });
      rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    process.env.PATH = PATH;
    rmSync(root, { recursive: true, force: true });
  }
});
