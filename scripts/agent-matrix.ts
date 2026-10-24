#!/usr/bin/env bun
// `make agent-matrix REPO_DIR=<splitbill fork> ISSUE=<N>`: runs `factory verify-agent` for every preset
// whose CLI is installed and names the rest as skipped. It spends tokens, so it is not in `make check`.
import { resolve } from "node:path";
import { matrixPlan } from "../src/verify-agent";

const repoDir = process.env.REPO_DIR;
const issue = process.env.ISSUE;
if (!repoDir || !issue) {
  console.error("agent-matrix: set REPO_DIR (a fork of the demo app) and ISSUE (its seeded bug issue number)");
  process.exit(2);
}
const which = async (bin: string) => (await Bun.spawn(["which", bin], { stdout: "pipe", stderr: "pipe" }).exited) === 0;
const { run, skipped } = await matrixPlan(which);
for (const name of skipped) console.log(`skipped ${name}: CLI not on PATH`);
let failed = 0;
for (const name of run) {
  console.log(`\n== ${name}`);
  const proc = Bun.spawn(
    ["bun", resolve(import.meta.dir, "../bin/factory"), "verify-agent", name, "--repo-dir", repoDir, "--issue", issue],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await proc.exited) !== 0) failed += 1;
}
console.log(`\nagent-matrix: ${run.length - failed} passed, ${failed} failed, ${skipped.length} skipped`);
process.exit(failed ? 1 : 0);
