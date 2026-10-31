import { expect, test } from "bun:test";
import { join } from "node:path";
import { COMMANDS } from "../src/help";

test("factory --skill names every command and exits 0", async () => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "factory"), "--skill"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  for (const c of COMMANDS) expect(out).toContain(`  ${c.name}:`);
  expect(out.split("\n").length).toBeLessThan(60);
});
