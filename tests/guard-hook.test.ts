// Exercises template/.claude/hooks/guard-paths.sh directly, as Claude Code
// would call it: JSON on stdin, exit 2 + stderr to block. No claude, no
// network — just the hook script and a scratch project directory.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", "template", ".claude", "hooks", "guard-paths.sh");

// A minimal PATH with everything the hook's bash needs (env's shebang
// lookup, mktemp/cat/rm/command) but no python3, to prove the "python3
// missing" branch actually fires rather than just existing in the script.
function pathWithoutPython3(): string {
  const binDir = mkdtempSync(join(tmpdir(), "factory-nopython-bin-"));
  for (const tool of ["bash", "mktemp", "cat", "rm", "sh"]) {
    const real = Bun.spawnSync(["which", tool]).stdout.toString().trim();
    if (real) symlinkSync(real, join(binDir, tool));
  }
  return binDir;
}

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "factory-guard-"));
  mkdirSync(join(projectDir, ".factory"), { recursive: true });
  writeFileSync(join(projectDir, ".factory", "config.json"), JSON.stringify({ protectedPaths: ["src/payments/**"] }));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

async function runHook(input: unknown, env: Record<string, string> = {}): Promise<{ code: number; stderr: string }> {
  const { FACTORY_STAGE: _stage, ...base } = process.env;
  const proc = Bun.spawn([HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...base, CLAUDE_PROJECT_DIR: projectDir, ...env },
  });
  proc.stdin.write(JSON.stringify(input));
  await proc.stdin.end();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stderr };
}

describe("guard-paths.sh", () => {
  test("blocks an edit to a repo-declared protected path", async () => {
    const { code, stderr } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: `${projectDir}/src/payments/charge.ts` },
    });
    expect(code).toBe(2);
    expect(stderr).toContain("protected path");
  });

  test("blocks a write under .claude/", async () => {
    const { code } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: `${projectDir}/.claude/settings.json` },
    });
    expect(code).toBe(2);
  });

  test("blocks git push --force", async () => {
    const { code, stderr } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git push --force origin main" },
    });
    expect(code).toBe(2);
    expect(stderr).toContain("force");
  });

  test("blocks git merge", async () => {
    const { code } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git merge feature-branch" },
    });
    expect(code).toBe(2);
  });

  const mergeOrForce = [
    'git "merge" feature',
    "git push origin main '--force'",
    "git push -f origin main",
    "git push --force-with-lease origin x",
    "git push origin +main",
    "git -C sub merge main",
    "git -c a.b=c merge x",
    "/usr/bin/git merge x",
    "gh -R o/r pr merge 1",
    "gh pr merge 1 --squash",
    "bash -c 'git merge x'",
    "eval git merge x",
    "ls && FOO=1 git merge x",
    "timeout 60 git push -f origin HEAD",
    "nice git -C sub merge main",
    "echo main | xargs git merge",
    "sudo -u bot gh pr merge 1",
    "bash -lc 'git \"merge\" x'",
    "sh -ec 'git fetch && git push origin +main'",
    'out="$(git merge main)"',
    "bash <<'EOF'\ngit merge main\nEOF",
    "git -C x \\\n  merge --ff-only origin/main",
    "git \\\n  push -f origin main",
    "gh pr \\\n  merge 12 --squash",
    "gh pr -R o/r merge 12 --squash",
    "gh pr --repo o/r merge --auto 12",
    "bash -c -- 'git -C x merge y'",
    "bash -c -e 'git -C x merge y'",
    "cat <<'EOF'\nline \\\nEOF\ngit -C . merge feature",
    "timeout 120 bash -c 'git push -f origin feature'",
    "find . -exec sh -c 'git push -f origin main' \\;",
    "bash <<'EOF'\ngit push -f origin main\nEOF",
    'echo "$(git push -f origin main)"',
    "echo `git push origin +main`",
    "sudo -u git git push -f origin main",
    "echo foo\\\\\ngit -C . merge feature",
    "git merge<file",
    "git 2>&1 merge main",
    "git push -f>/dev/null",
    "gh pr merge<<<y",
    "git -C ~/src/gh merge main",
    "git --git-dir=/x/gh merge y",
    "gh -R me/git pr merge 3",
    "git push --mirror",
    "git --super-prefix x/ merge y",
    "git submodule foreach sh -c 'git push -f origin HEAD'",
    "git bisect run sh -c 'git merge x'",
    'git submodule foreach bash -c "git merge origin/main"',
    "git -C git push -f",
  ];
  for (const command of mergeOrForce) {
    test(`blocks a merge or force-push: ${command}`, async () => {
      expect((await runHook({ tool_name: "Bash", tool_input: { command } })).code).toBe(2);
    });
  }

  for (const command of [
    "git merge-base main HEAD",
    "gh pr merge-queue",
    "git push origin main",
    "git log --grep=force -- push",
    "git branch --merged",
    "grep -rn git src",
    "git log --oneline --grep='git merge'",
    "git commit -m 'fix merge of totals'",
    "gh pr view 12 -R o/r --json mergeable",
    "git push -u origin \\\n  feature",
  ]) {
    test(`allows a read-only command near merge or push: ${command}`, async () => {
      expect((await runHook({ tool_name: "Bash", tool_input: { command } })).code).toBe(0);
    });
  }

  test("fails CLOSED on a path or cwd that cannot be resolved (NUL, lone surrogate)", async () => {
    const nulPath = await runHook({ tool_name: "Write", tool_input: { file_path: "a\u0000b" } });
    const nulCwd = await runHook({ tool_name: "Write", tool_input: { file_path: "a" }, cwd: "\u0000" });
    const surrogate = await runHook({ tool_name: "Write", tool_input: { file_path: "\ud800" } });
    expect([nulPath.code, nulCwd.code, surrogate.code]).toEqual([2, 2, 2]);
  });

  test("fails CLOSED when protectedPaths is malformed, instead of dropping it", async () => {
    const codes = [];
    for (const config of ['{"protectedPaths":[1]}', '{"protectedPaths":null}', '{"protectedPaths":"src/**"}', "{bad"]) {
      writeFileSync(join(projectDir, ".factory", "config.json"), config);
      codes.push(
        (await runHook({ tool_name: "Write", tool_input: { file_path: `${projectDir}/src/widgets/list.ts` } })).code,
      );
    }
    rmSync(join(projectDir, ".factory", "config.json"));
    symlinkSync(join(projectDir, "missing.json"), join(projectDir, ".factory", "config.json"));
    codes.push(
      (await runHook({ tool_name: "Write", tool_input: { file_path: `${projectDir}/src/widgets/list.ts` } })).code,
    );
    expect(codes).toEqual([2, 2, 2, 2, 2]);
  });

  test("allows an edit to an unprotected path", async () => {
    const { code } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: `${projectDir}/src/widgets/list.ts` },
    });
    expect(code).toBe(0);
  });

  test("always allows a write under .factory/runs/, even though .factory/** is otherwise protected", async () => {
    const { code } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: `${projectDir}/.factory/runs/issue-42/triage.json` },
    });
    expect(code).toBe(0);
  });

  // Lessons are written only by `factory learn`, through a reviewed PR; a stage that edits
  // the file would teach every later run without review.
  test("blocks an edit of .factory/memory/lessons.md: only the runner writes lessons", async () => {
    for (const tool_name of ["Edit", "Write"]) {
      const { code } = await runHook({
        tool_name,
        tool_input: { file_path: `${projectDir}/.factory/memory/lessons.md` },
      });
      expect(code).toBe(2);
    }
  });

  test("allows a plain read-only Bash command", async () => {
    const { code } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "git status --short" },
    });
    expect(code).toBe(0);
  });

  test("fails CLOSED (blocks) when its input is not valid JSON", async () => {
    const proc = Bun.spawn([HOOK], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });
    proc.stdin.write("not json");
    await proc.stdin.end();
    expect(await proc.exited).toBe(2);
  });

  test("fails open when .factory/config.json is missing", async () => {
    rmSync(join(projectDir, ".factory", "config.json"));
    const { code } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: `${projectDir}/src/payments/charge.ts` },
    });
    // no config.json means no repo-declared protected paths; .claude/** and
    // .factory/** are still always protected, but src/payments isn't.
    expect(code).toBe(0);
  });

  test("fails CLOSED (blocks) when python3 is not on PATH, instead of failing open", async () => {
    const binDir = pathWithoutPython3();
    const proc = Bun.spawn([HOOK], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { CLAUDE_PROJECT_DIR: projectDir, PATH: binDir },
    });
    proc.stdin.write(
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: `${projectDir}/src/widgets/list.ts` } }),
    );
    await proc.stdin.end();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    rmSync(binDir, { recursive: true, force: true });
    expect(code).toBe(2);
    expect(stderr).toContain("python3");
  });

  test("blocks a NotebookEdit to a protected path", async () => {
    const { code } = await runHook({
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: `${projectDir}/.claude/x.ipynb` },
    });
    expect(code).toBe(2);
  });

  // A session in another worktree: CLAUDE_PROJECT_DIR is the main checkout, the
  // file lives in a linked worktree with its own protected paths.
  test("protects paths relative to the git worktree that holds the file, not CLAUDE_PROJECT_DIR", async () => {
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", projectDir, ...args], {
        stderr: "pipe",
      });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const other = `${projectDir}-wt`;
    expect(git("worktree", "add", "-q", other).exitCode).toBe(0);
    mkdirSync(join(other, ".factory"), { recursive: true });
    writeFileSync(join(other, ".factory", "config.json"), JSON.stringify({ protectedPaths: ["src/auth/**"] }));
    const auth = await runHook({ tool_name: "Edit", tool_input: { file_path: `${other}/src/auth/login.ts` } });
    const claude = await runHook({ tool_name: "Write", tool_input: { file_path: `${other}/.claude/settings.json` } });
    const free = await runHook({ tool_name: "Edit", tool_input: { file_path: `${other}/src/ui/list.ts` } });
    rmSync(other, { recursive: true, force: true });
    expect([auth.code, claude.code, free.code]).toEqual([2, 2, 0]);
  });

  // An agent can create src/.git with Bash; that must not make src/ the root
  // and turn src/payments/charge.ts into an unprotected "payments/charge.ts".
  test("a planted .git marker does not move the root", async () => {
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "src", ".git"), "gitdir: /elsewhere\n");
    const { code } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: `${projectDir}/src/payments/charge.ts` },
    });
    expect(code).toBe(2);
  });
});

// The shapes `--permission-mode dontAsk` refused in the 2.1.289 repro
// (docs/decisions/stage-shell-shapes.md). In a stage the hook names the shape and
// the fix; the CLI's own message read "Bash denied" and verifiers gave up.
describe("guard-paths.sh subagent dispatch", () => {
  const agent = (run_in_background: boolean) => ({
    tool_name: "Agent",
    tool_input: { subagent_type: "factory-reviewer", prompt: "review", run_in_background },
  });
  test("inside a stage a backgrounded subagent is refused, a foreground one passes", async () => {
    const bg = await runHook(agent(true), { FACTORY_STAGE: "verify" });
    expect(bg.code).toBe(2);
    expect(bg.stderr).toContain("foreground");
    expect((await runHook(agent(false), { FACTORY_STAGE: "verify" })).code).toBe(0);
  });
  test("outside a stage a backgrounded subagent passes", async () => {
    expect((await runHook(agent(true))).code).toBe(0);
  });
});

describe("guard-paths.sh shell shapes inside a stage", () => {
  const refused: Array<[string, string]> = [
    ["git show main:README.md > README.md && git status --short", "git restore --source="],
    ["git diff main HEAD > /tmp/x.diff", "write files"],
    ["make check 2>/tmp/err.log", "write files"],
    ["bun test &> out.txt", "write files"],
    ["ls 2>&1>f", "write files"],
    ["echo $(git rev-parse HEAD)", "$(...)"],
    ["echo `git rev-parse HEAD`", "$(...)"],
    ["bun test; echo exit=$?", "$?"],
    ["ls src/{money,ui}", "brace expansion"],
    ["cd src && ls", "repo root"],
    ["git status --short && cd src", "repo root"],
    ["FOO=1 bun test", "VAR=value"],
    ['grep -n "$(whoami)" src/x.ts', "$(...)"],
    [`grep "don't" a > out.txt; grep "won't" b`, "write files"],
    ["ls >& out.txt", "write files"],
    ["ls\ncd src", "repo root"],
    ["git status\nFOO=1 make", "VAR=value"],
    ["make check > 1", "write files"],
    ["make check >-", "write files"],
    ["echo $'\\'' > out.txt", "write files"],
    ["(cd src && ls)", "repo root"],
    ["ls & cd src", "repo root"],
    ["env FOO=1 bun test", "VAR=value"],
    ["ls # don't\nls > out.txt", "write files"],
    ["git commit -F - <<'EOF'\ndon't\nEOF\necho x > out.txt", "write files"],
    ["cat <<EOF\nit's $(whoami)\nEOF", "$(...)"],
    ["touch f{1..3}", "brace expansion"],
    ["if cd /tmp; then ls; fi", "repo root"],
    ["PATH+=:/x ls", "VAR=value"],
    ['grep -c foo <<< "hello"\necho hi > out.txt', "write files"],
    ["cat <<\\EOF\ndon't\nEOF\necho hi > out.txt", "write files"],
    ["echo ${?}", "$?"],
  ];
  for (const [command, hint] of refused)
    test(`refuses: ${command}`, async () => {
      const { code, stderr } = await runHook(
        { tool_name: "Bash", tool_input: { command } },
        { FACTORY_STAGE: "verify" },
      );
      expect(code).toBe(2);
      expect(stderr).toContain(hint);
      expect(stderr).toContain("Bash still works");
    });

  const allowed = [
    "git status --short && git log --oneline -1",
    "git status --short; git log --oneline -1",
    "make check | tail -3",
    "bun test > /dev/null 2>&1",
    "bun test 2>&1",
    "cat README.md | wc -l",
    "git restore --source=main -- src/a.ts src/b.ts",
    "git rev-parse HEAD^{tree}",
    "grep -n 'a > b' src/x.ts",
    "grep -n 'echo $(x)' src/x.ts",
    "git log --format='%H {a,b}'",
    'grep -rn "a{1,3}" src',
    'grep -rn "x && cd y" src',
    'grep -E "foo|BAR=1" src',
    "make check 2>&1 | tail -20",
    "ls 2>&-",
    "echo a # > not a redirect",
    "git rev-parse HEAD@{1}",
    "git commit -F - <<'EOF'\nit's fine; a > b {a,b}\ncd x\nEOF",
    "(make test 2>&1) | tail",
    "ls -la >/dev/stderr",
    "grep -c x <<< 'a > b'",
    "git commit -F - <<\\EOF\nfix: a > b, not $(x)\nEOF",
  ];
  for (const command of allowed)
    test(`allows: ${command}`, async () => {
      const { code, stderr } = await runHook(
        { tool_name: "Bash", tool_input: { command } },
        { FACTORY_STAGE: "verify" },
      );
      expect(stderr).toBe("");
      expect(code).toBe(0);
    });

  test("stays fast on long commands, so the hook never times out and fails open", async () => {
    const pushes = `echo ${"git push ".repeat(10900)}`;
    const nested = ["bash -c", "bash -c", "bash -c"].reduce((c, w) => `${w} '${c.replaceAll("'", "'\\''")}'`, pushes);
    const started = Date.now();
    const codes = [];
    for (const command of [nested, `echo ${"1".repeat(99000)}`, `{${".".repeat(99000)}`, "! ".repeat(100000)])
      codes.push((await runHook({ tool_name: "Bash", tool_input: { command } }, { FACTORY_STAGE: "build" })).code);
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test("fails CLOSED on a non-string command, path or cwd, or a tool_input that is not an object", async () => {
    const nullCommand = await runHook(
      { tool_name: "Bash", tool_input: { command: null } },
      { FACTORY_STAGE: "verify" },
    );
    const stringInput = await runHook({ tool_name: "Bash", tool_input: "ls" });
    const numberPath = await runHook({ tool_name: "Write", tool_input: { file_path: 123 } });
    const numberCwd = await runHook({ tool_name: "Write", tool_input: { file_path: "a.txt" }, cwd: 5 });
    expect([nullCommand.code, stringInput.code, numberPath.code, numberCwd.code]).toEqual([2, 2, 2, 2]);
  });

  test("outside a stage (no FACTORY_STAGE) the same shapes pass: a person at the keyboard can chain freely", async () => {
    const { code } = await runHook({ tool_name: "Bash", tool_input: { command: "cd src && ls > /tmp/x" } });
    expect(code).toBe(0);
  });
});
