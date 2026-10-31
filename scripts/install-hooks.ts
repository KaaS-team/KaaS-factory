// Points git at the repo's .githooks so commit-msg signs off and pre-push runs the cheap checks.
//
//   bun scripts/install-hooks.ts      (make hooks)
const out = Bun.spawnSync(["git", "config", "core.hooksPath", ".githooks"]);
if (out.exitCode !== 0) {
  console.error(`git config core.hooksPath: ${out.stderr.toString().trim()}`);
  process.exit(1);
}
console.log("hooks: core.hooksPath set to .githooks");
