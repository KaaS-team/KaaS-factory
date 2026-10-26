// Verify in a clean room: a fresh clone at the head, no network, holdouts from the base only.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noNetworkPrefix, runCleanRoom } from "../src/clean-room";

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

test("verify runs in a fresh checkout with no network, and holdouts come in from the base only then", async () => {
  const repo = mkdtempSync(join(tmpdir(), "clean-room-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "holdout.txt"), "base");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "holdout.txt"), "edited by the build");
  writeFileSync(join(repo, "app.txt"), "head");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "head");
  const head = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "leftover.txt"), "left by the build session");

  const server = Bun.serve({ port: 0, fetch: () => new Response("reached") });
  const cmd = [
    "test ! -e leftover.txt",
    'test "$(cat app.txt)" = head',
    'test "$(cat holdout.txt)" = base',
    `! curl -sf -m 3 http://127.0.0.1:${server.port}/`,
  ].join(" && ");
  try {
    const run = await runCleanRoom({
      repoDir: repo,
      sha: head,
      holdouts: { baseSha: base, paths: ["holdout.txt"] },
      cmd,
    });
    // Same run, no sandbox: the network check alone goes red, which shows it bites.
    const open = await runCleanRoom(
      { repoDir: repo, sha: head, holdouts: { baseSha: base, paths: ["holdout.txt"] }, cmd },
      ["env"],
    );
    expect(open).toMatchObject({ ran: true });
    expect(open.exitCode).not.toBe(0);
    const offline = cmd.slice(0, cmd.lastIndexOf(" && "));
    expect(
      await runCleanRoom(
        { repoDir: repo, sha: head, holdouts: { baseSha: base, paths: ["holdout.txt"] }, cmd: offline },
        ["env"],
      ),
    ).toMatchObject({ ran: true, exitCode: 0 });
    const usable = Bun.spawnSync([...(noNetworkPrefix() ?? ["false"]), "true"]).exitCode === 0;
    if (usable) expect(run).toMatchObject({ ran: true, exitCode: 0 });
    else expect(run.ran).toBe(false);
    expect(
      await runCleanRoom({ repoDir: repo, sha: head, holdouts: { baseSha: base, paths: [] }, cmd: "true" }, [
        "/nonexistent-sandbox",
      ]),
    ).toMatchObject({ ran: false });
  } finally {
    server.stop(true);
  }
});
