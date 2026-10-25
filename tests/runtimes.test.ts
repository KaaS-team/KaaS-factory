// Runtimes: where a gate or check command runs. The adapters' behaviour is the
// contract suite in tests/adapters.test.ts; this pins their argv, the frame
// that carries streams through a merged log, and how names are resolved.

import { describe, expect, test } from "bun:test";
import { containerArgs } from "../src/adapters/docker/execution";
import { lwprArgs } from "../src/adapters/lwpr/execution";
import { agentArgs, guestGit, MicrosandboxExecution, sandboxArgs } from "../src/adapters/microsandbox/execution";
import { CommandExecutor } from "../src/agents/executor";
import { Agent37Execution, CHUNK } from "../src/adapters/agent37/execution";
import { archiveArgs, HttpSandboxExecution } from "../src/adapters/http-sandbox/execution";
import { sshArgs } from "../src/adapters/ssh/execution";
import { wrapArgs } from "../src/adapters/wrap/execution";
import { startAgent37 } from "./fixtures/agent37";
import { startSandbox } from "./fixtures/http-sandbox";
import { configProblems } from "../src/config";
import { framed, shq, unframe } from "../src/core/frame";
import { parseWorkflowText } from "../src/engine/workflows";
import { loadMachineConfig } from "../src/machine";
import { BUILTIN_RUNTIMES, runtimeProblems, runtimeRefs, runtimesFrom, unknownRuntimes } from "../src/runtimes";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("frame", () => {
  test("carries stdout, stderr and the code through one merged, noisy log", () => {
    const p = Bun.spawnSync([
      "bash",
      "-c",
      `echo "[runtime] start"; bash -c ${shq(framed("echo out; echo err >&2; printf 'x'; exit 4"))} 2>&1; echo "[runtime] end"`,
    ]);
    expect(p.exitCode).toBe(0);
    expect(unframe(p.stdout.toString(), p.exitCode)).toEqual({ stdout: "out\nx", stderr: "err\n", code: 4 });
  });
  test("no frame means the runtime failed before the command: its output is the error", () => {
    expect(unframe("box unreachable\n", 255)).toEqual({
      stdout: "",
      stderr: "box unreachable\n",
      code: 255,
      runtimeFailed: "box unreachable",
    });
    expect(unframe("", 0).code).toBe(1);
  });
});

describe("argv", () => {
  test("docker: read-only, no capabilities, no new privileges, no network, capped, as this user", () => {
    expect(containerArgs({ kind: "docker", image: "oven/bun:1.3" }, "make test", "/w", "501:20")).toEqual([
      "docker",
      "run",
      "--rm",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,exec,size=1g",
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges",
      "--network",
      "none",
      "--memory",
      "4g",
      "--cpus",
      "2",
      "--pids-limit",
      "512",
      "--user",
      "501:20",
      "-e",
      "HOME=/tmp",
      "-v",
      "/w:/w",
      "-w",
      "/w",
      "oven/bun:1.3",
      "bash",
      "-c",
      "make test",
    ]);
    const gvisor = containerArgs({ kind: "docker", image: "i", network: "bridge", runtime: "runsc" }, "c", "/w", "1:1");
    expect(gvisor.slice(gvisor.indexOf("--network"), gvisor.indexOf("--network") + 2)).toEqual(["--network", "bridge"]);
    expect(gvisor).toContain("runsc");
  });
  test("lwpr: the command is framed after --", () => {
    const argv = lwprArgs({ kind: "lwpr", app: "web", timeoutMin: 20, setup: false }, "make test");
    expect(argv.slice(0, 9)).toEqual([
      "lwpr",
      "run",
      "--app",
      "web",
      "--timeout-min",
      "20",
      "--no-setup",
      "--",
      "bash",
    ]);
    expect(argv.at(-1)).toBe(framed("make test"));
  });
  test("ssh: rsync skips .git and node_modules, then one quoted remote line", () => {
    const { sync, run } = sshArgs({ kind: "ssh", host: "ci1", dir: "/srv/f/" }, "make test", "/w/issue-7");
    expect(sync).toContain("--exclude=.git");
    expect(sync).toContain("--exclude=node_modules");
    expect(sync.slice(-2)).toEqual(["/w/issue-7/", "ci1:/srv/f/issue-7/"]);
    expect(run).toEqual(["ssh", "-o", "BatchMode=yes", "ci1", `bash -c 'cd '\\''/srv/f/issue-7'\\'' && make test'`]);
  });
});

describe("wrap", () => {
  test("the command is one argv element, and {cwd} is the worktree wherever it appears", () => {
    const argv = wrapArgs(
      {
        kind: "wrap",
        argv: ["firecracker-ctr", "run", "--mount", "src={cwd},dst={cwd}", "img", "bash", "-c", "{cmd}"],
      },
      "make test && echo 'ok'",
      "/w/issue-7",
    );
    expect(argv).toEqual([
      "firecracker-ctr",
      "run",
      "--mount",
      "src=/w/issue-7,dst=/w/issue-7",
      "img",
      "bash",
      "-c",
      "make test && echo 'ok'",
    ]);
  });
  test("argv needs {cmd} exactly once", () => {
    expect(runtimeProblems({ fc: { kind: "wrap", argv: ["fc", "bash", "-c", "{cmd}"] } })).toEqual([]);
    expect(
      runtimeProblems({
        a: { kind: "wrap", argv: ["fc", "bash", "-c", "x {cmd}"] },
        b: { kind: "wrap", argv: ["{cmd}", "{cmd}"] },
      }),
    ).toEqual([
      'runtimes.a.argv: needs "{cmd}" as exactly one element, where the bash command goes',
      'runtimes.b.argv: needs "{cmd}" as exactly one element, where the bash command goes',
    ]);
  });
});

describe("http sandbox", () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "factory-http-"));
    for (const sub of [".git", "node_modules", "dist"]) {
      Bun.spawnSync(["mkdir", "-p", join(d, sub)]);
      writeFileSync(join(d, sub, "f"), sub);
    }
    return d;
  };

  test("sends the worktree without .git or the excluded directories", async () => {
    const sandbox = startSandbox("t");
    try {
      const run = (exclude?: string[]) =>
        new HttpSandboxExecution(
          { kind: "http", url: sandbox.url, tokenEnv: "T", ...(exclude ? { exclude } : {}) },
          { T: "t" },
        ).run("ls -A | sort | tr '\\n' ' '", dir());
      expect((await run()).stdout).toBe("dist ");
      expect((await run(["dist"])).stdout).toBe("node_modules ");
      expect(archiveArgs({ kind: "http", url: "u" })).toEqual([
        "tar",
        "-czf",
        "-",
        "--exclude=./.git",
        "--exclude=./node_modules",
        ".",
      ]);
    } finally {
      sandbox.stop();
    }
  });

  test("the token goes in the header only, and never into what a step logs", async () => {
    const sandbox = startSandbox("right");
    try {
      const wrong = await new HttpSandboxExecution(
        { kind: "http", url: sandbox.url, tokenEnv: "T" },
        { T: "wrong-token-value" },
      ).run("true", dir());
      expect(wrong).toEqual({
        stdout: "",
        stderr: `sandbox ${sandbox.url} answered 401: unauthorized`,
        code: 1,
        runtimeFailed: `sandbox ${sandbox.url} answered 401: unauthorized`,
      });
      expect(sandbox.requests.at(-1)?.auth).toBe("Bearer wrong-token-value");
      const unset = await new HttpSandboxExecution({ kind: "http", url: sandbox.url, tokenEnv: "T" }, {}).run(
        "true",
        dir(),
      );
      expect(unset).toEqual({
        stdout: "",
        stderr: `sandbox ${sandbox.url}: env var T is not set`,
        code: 1,
        runtimeFailed: `sandbox ${sandbox.url}: env var T is not set`,
      });
      expect(sandbox.requests.length).toBe(1);
    } finally {
      sandbox.stop();
    }
  });

  test("an unreachable sandbox or a malformed answer fails the step, never throws", async () => {
    const down = await new HttpSandboxExecution({ kind: "http", url: "http://127.0.0.1:1/exec" }).run("true", dir());
    expect(down.code).toBe(1);
    expect(down.stderr).toStartWith("sandbox http://127.0.0.1:1/exec unreachable:");
    const odd = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ out: "?" }) });
    try {
      const r = await new HttpSandboxExecution({ kind: "http", url: `http://127.0.0.1:${odd.port}/` }).run(
        "true",
        dir(),
      );
      expect(r).toEqual({
        stdout: "",
        stderr: `sandbox http://127.0.0.1:${odd.port}/ answered without {stdout, stderr, code}: {"out":"?"}`,
        code: 1,
        runtimeFailed: `sandbox http://127.0.0.1:${odd.port}/ answered without {stdout, stderr, code}: {"out":"?"}`,
      });
    } finally {
      odd.stop(true);
    }
  });

  test("the url is https, or plain http only to this machine", () => {
    expect(
      runtimeProblems({
        a: { kind: "http", url: "https://sb.example.com/exec", tokenEnv: "SB" },
        b: { kind: "http", url: "http://localhost:8080/exec" },
      }),
    ).toEqual([]);
    expect(
      runtimeProblems({
        c: { kind: "http", url: "http://sb.example.com/exec" },
        d: { kind: "http", url: "http://localhost.evil.com/x" },
      }),
    ).toEqual([
      "runtimes.c.url: https (plain http only to localhost), since the worktree is sent to it",
      "runtimes.d.url: https (plain http only to localhost), since the worktree is sent to it",
    ]);
  });
});

describe("names", () => {
  test("machine.json runtimes: each problem named", () => {
    expect(
      runtimeProblems({
        ok: { kind: "docker", image: "i" },
        sb: { kind: "ssh", host: "h", dir: "/d", exclude: ["dist"] },
      }),
    ).toEqual([]);
    expect(
      runtimeProblems({
        local: { kind: "local" },
        "a b": { kind: "lwpr" },
        d: { kind: "docker" },
        s: { kind: "ssh", host: "h", dir: "/d", port: 22 },
        x: { kind: "vm" },
      }),
    ).toEqual([
      'runtimes.local: "local" is built in',
      "runtimes.a b: a name is letters, digits, _ and -",
      "runtimes.d.image: required for docker",
      "runtimes.s.port: unknown key for ssh (allowed: kind, host, dir, exclude)",
      "runtimes.x.kind: one of local, docker, ssh, lwpr, wrap, http, agent37, microsandbox, pool",
    ]);
  });
  test("a bad machine.json runtime stops boot", () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    writeFileSync(
      join(home, "machine.json"),
      JSON.stringify({ slots: 1, runtimes: { box: { kind: "ssh", host: "h" } } }),
    );
    expect(() => loadMachineConfig({ FACTORY_HOME: home })).toThrow("runtimes.box.dir: required for ssh");
    writeFileSync(
      join(home, "machine.json"),
      JSON.stringify({ slots: 1, runtimes: { box: { kind: "ssh", host: "h", dir: "/d" } } }),
    );
    expect(Object.keys(runtimesFrom(loadMachineConfig({ FACTORY_HOME: home }).runtimes))).toEqual([
      "local",
      "lwpr",
      "box",
    ]);
  });
  test("config runtime and a check step's runtime are looked up, and an unknown one is named", () => {
    expect(configProblems({ repo: "a/b", runtime: { gates: "docker1", check: "lwpr" } })).toEqual([]);
    expect(configProblems({ repo: "a/b", runtime: { verify: "x" } })[0]).toContain("runtime.verify: unknown key");
    const refs = runtimeRefs({ runtime: { gates: "box" } }, { lint: { runtime: "gpu" }, build: {} });
    expect(unknownRuntimes(refs, { ...BUILTIN_RUNTIMES, box: {} })).toEqual([
      'steps.lint.runtime: no runtime "gpu" (have: local, lwpr, box; add it to FACTORY_HOME/machine.json runtimes)',
    ]);
  });
  test("runtime: is for check steps only", () => {
    const flow = (uses: string) =>
      parseWorkflowText(
        `name: m\nsteps:\n  a:\n    uses: ${uses}\n    label: factory:a\n${uses === "check" ? "    run: make lint\n" : ""}    runtime: lwpr\n    next: p\n  p:\n    uses: pr\n    label: factory:in-review\n`,
      );
    const ok = flow("check");
    expect(ok.ok && ok.workflow.steps.a!.runtime).toBe("lwpr");
    const bad = flow("build");
    expect(!bad.ok && bad.problems.join()).toContain("steps.a.runtime: a build step runs no command");
  });
});

describe("agent37", () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "factory-a37-"));
    for (const sub of [".git", "node_modules", "dist"]) {
      Bun.spawnSync(["mkdir", "-p", join(d, sub)]);
      writeFileSync(join(d, sub, "f"), sub);
    }
    return d;
  };
  const spec = (url: string, root: string) => ({ kind: "agent37", instance: "i1", tokenEnv: "K", url, root }) as const;

  test("sends the worktree in chunks under the body cap, runs there, answers its exit code, cleans up", async () => {
    const box = startAgent37("k", "i1");
    const root = mkdtempSync(join(tmpdir(), "factory-a37-root-"));
    try {
      const d = dir();
      // Random bytes do not compress, so the archive needs several chunks.
      writeFileSync(join(d, "big.bin"), crypto.getRandomValues(new Uint8Array(3 * CHUNK)));
      const r = await new Agent37Execution(spec(box.url, root), { K: "k" }).run(
        "ls -A | sort | tr '\\n' ' '; printf \"it's\" >&2; exit 3",
        d,
      );
      expect(r).toEqual({ stdout: "big.bin dist ", stderr: "it's", code: 3 });
      expect(box.commands.filter((c) => c.startsWith("printf %s ")).length).toBeGreaterThan(3);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      box.stop();
    }
  });

  test("the key goes in the header only; unset, wrong or unreachable fails the step, never throws", async () => {
    const box = startAgent37("right", "i1");
    try {
      const unset = await new Agent37Execution(spec(box.url, "/tmp/x"), {}).run("true", dir());
      expect(unset.runtimeFailed).toBe("agent37 i1: env var K is not set");
      expect(box.keys.length).toBe(0);
      const wrong = await new Agent37Execution(spec(box.url, "/tmp/x"), { K: "wrong-key-value" }).run("true", dir());
      expect(wrong).toMatchObject({ code: 1, runtimeFailed: "agent37 i1 answered 401: unauthorized" });
      expect(wrong.stderr).not.toContain("wrong-key-value");
      expect(box.keys.at(-1)).toBe("wrong-key-value");
      const down = await new Agent37Execution(spec("http://127.0.0.1:1", "/tmp/x"), { K: "k" }).run("true", dir());
      expect(down.code).toBe(1);
      expect(down.runtimeFailed).toStartWith("agent37 i1 unreachable:");
    } finally {
      box.stop();
    }
  });

  test("machine.json: instance and tokenEnv are required, the url is https or loopback", () => {
    expect(runtimeProblems({ a: { kind: "agent37", instance: "i1", tokenEnv: "AGENT37_API_KEY" } })).toEqual([]);
    const a37 = { kind: "agent37", instance: "i1", tokenEnv: "K" };
    expect(runtimeProblems({ a37, free: { kind: "pool", members: [{ runtime: "a37", minutes: 60 }] } })).toEqual([]);
    expect(
      runtimeProblems({
        b: { kind: "agent37", instance: "i1" },
        c: { kind: "agent37", instance: "i1", tokenEnv: "K", url: "http://sandbox.agent37.app" },
      }),
    ).toEqual([
      "runtimes.b.tokenEnv: required for agent37",
      "runtimes.c.url: https (plain http only to localhost), since the worktree is sent to it",
    ]);
  });
});

describe("microsandbox", () => {
  const spec = {
    kind: "microsandbox",
    image: "node:22-slim",
    allow: ["httpbin.org", "postman-echo.com"],
    secrets: ["PROBE@httpbin.org"],
  } as const;

  test("denies egress by default, allows each host on 443, mounts the worktree at its own path", () => {
    expect(sandboxArgs(spec, "make check", "/w", "n1")).toEqual(
      "msb run -q --no-tty --no-stdin --name n1 --no-net --net-rule allow@dns --net-rule allow@httpbin.org:tcp:443 --net-rule allow@postman-echo.com:tcp:443 --secret PROBE@httpbin.org --secret-violation-action block-and-log -m 4G -c 2 -v /w:/w -w /w node:22-slim -- bash -c"
        .split(" ")
        .concat("make check"),
    );
    expect(sandboxArgs({ kind: "microsandbox", image: "i" }, "x", "/w", "n")).not.toContain("allow@dns");
    expect(sandboxArgs(spec, "x", "/var/w", "n", "/private/var/w")).toContain("/private/var/w:/var/w");
  });

  test("an unset secret fails the step before a VM starts", async () => {
    const r = await new MicrosandboxExecution(spec, {}).run("true", tmpdir());
    expect(r).toEqual({ stdout: "", stderr: "", code: 1, runtimeFailed: "microsandbox: env var PROBE is not set" });
  });

  test("machine.json: image is required, each secret is ENV@hosts and its hosts are allowed", () => {
    expect(runtimeProblems({ m: spec })).toEqual([]);
    expect(
      runtimeProblems({
        a: { kind: "microsandbox" },
        b: { kind: "microsandbox", image: "i", secrets: ["KEY=value@x.com"] },
        c: { kind: "microsandbox", image: "i", allow: ["a.com"], secrets: ["K@a.com,b.com"] },
      }),
    ).toEqual([
      "runtimes.a.image: required for microsandbox",
      'runtimes.b.secrets: "KEY=value@x.com" is not ENV@host[,host]',
      'runtimes.c.secrets: "K@a.com,b.com" sends to b.com, which is not in allow',
    ]);
  });

  test("an agent in the VM gets its folders, plain env and the prompt file, never the host env", () => {
    const argv = agentArgs(
      spec,
      {
        argv: ["claude", "-p"],
        cwd: "/w",
        mounts: ["/s"],
        env: { FACTORY_ISSUE: "7" },
        stdinFile: "/s/stdin",
        name: "n",
      },
      (d) => `/real${d}`,
    );
    expect(argv.slice(argv.indexOf("4G") + 3)).toEqual(
      "-v /real/w:/w -v /real/s:/s -e FACTORY_ISSUE=7 -w /w node:22-slim -- bash -c"
        .split(" ")
        .concat('exec "$@" < "$0"', "/s/stdin", "claude", "-p"),
    );
  });

  test("with agentRuntime set, the executor starts the agent through msb with the prompt as a file", async () => {
    const d = mkdtempSync(join(tmpdir(), "factory-msb-agent-"));
    mkdirSync(join(d, ".claude/skills/factory-plan"), { recursive: true });
    writeFileSync(join(d, ".claude/skills/factory-plan/SKILL.md"), "---\nname: factory-plan\n---\nPlan it.\n");
    const saved = process.env.PATH;
    process.env.PATH = `${join(import.meta.dir, "fixtures", "runtimes")}:${saved}`;
    try {
      const agent = 'echo "${MSB_STAND_IN:-host} $(wc -c)" > "$FACTORY_ARTIFACT_DIR/ran"';
      await new CommandExecutor(
        { x: { command: ["sh", "-c", agent] } },
        { default: "x" },
        {},
        undefined,
        spec,
      ).runStage({ stage: "plan", issue: 7, cwd: d, maxBudgetUsd: 1 });
    } finally {
      process.env.PATH = saved;
    }
    const [via, bytes] = readFileSync(join(d, ".factory/runs/issue-7/ran"), "utf8").trim().split(/\s+/);
    expect(via).toBe("1");
    expect(Number(bytes)).toBeGreaterThan(10);
  });

  // A repo with a committed holdout and a sparse worktree that hides it, as the runner makes one.
  function holdoutWorktree(): string {
    const d = mkdtempSync(join(tmpdir(), "factory-msb-git-"));
    const sh = (c: string) => expect(Bun.spawnSync(["bash", "-c", c], { cwd: d }).exitCode).toBe(0);
    sh(
      "git init -q -b main main && cd main && echo a > a && mkdir holdout && echo secret-7m1 > holdout/t && git add . && " +
        "git -c user.email=t@t -c user.name=t commit -qm i && git worktree add -q -b work ../wt && cd ../wt && " +
        "git sparse-checkout init --no-cone && git sparse-checkout set '/*' '!/holdout/' && echo b >> a",
    );
    return join(d, "wt");
  }

  test("the guest repo works, withholds every hidden path's blobs, and cannot push", () => {
    const wt = holdoutWorktree();
    const env = {
      ...process.env,
      ...guestGit(wt, mkdtempSync(join(tmpdir(), "factory-msb-scratch-")), ["holdout/**"]),
    };
    const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: wt, env });
    expect(git("status", "--short").stdout.toString()).toBe(" M a\n");
    expect(git("log", "--format=%s", "-1").stdout.toString()).toBe("i\n");
    expect(git("show", "main:a").stdout.toString()).toBe("a\n");
    const leak = git("show", "main:holdout/t");
    expect(leak.exitCode).not.toBe(0);
    expect(leak.stdout.toString()).not.toContain("secret-7m1");
    expect(git("ls-remote", "origin").exitCode).not.toBe(0);
    expect(git("push", "origin", "HEAD").exitCode).not.toBe(0);
  });

  test("outside a git worktree the guest gets no repo", () => {
    expect(guestGit(mkdtempSync(join(tmpdir(), "factory-msb-plain-")), "/s", ["holdout/**"])).toEqual({});
  });

  test.skipIf(!Bun.which("msb"))(
    "live: an agent in the VM has a working git that cannot read the holdouts",
    async () => {
      const wt = holdoutWorktree();
      mkdirSync(join(wt, ".claude/skills/factory-build"), { recursive: true });
      writeFileSync(join(wt, ".claude/skills/factory-build/SKILL.md"), "---\nname: factory-build\n---\nBuild it.\n");
      const out = '"$FACTORY_ARTIFACT_DIR"';
      const agent = [
        `git status --short --untracked-files=no > ${out}/status`,
        `git show main:holdout/t > ${out}/leak 2>/dev/null; echo $? > ${out}/leak-code`,
      ].join("; ");
      await new CommandExecutor({ x: { command: ["bash", "-c", agent] } }, { default: "x" }, {}, undefined, {
        kind: "microsandbox",
        image: "buildpack-deps:bookworm-scm",
      }).runStage({ stage: "build", issue: 7, cwd: wt, maxBudgetUsd: 1, hiddenPaths: ["holdout/**"] });
      const read = (f: string) => readFileSync(join(wt, ".factory/runs/issue-7", f), "utf8").trim();
      expect(read("status")).toBe("M a");
      expect(read("leak")).toBe("");
      expect(read("leak-code")).not.toBe("0");
    },
    300_000,
  );

  test.skipIf(!Bun.which("msb"))(
    "live: an agent stage runs in the VM, reads its prompt, and holds only a placeholder for the key",
    async () => {
      const d = mkdtempSync(join(tmpdir(), "factory-msb-agent-"));
      mkdirSync(join(d, ".claude/skills/factory-plan"), { recursive: true });
      writeFileSync(join(d, ".claude/skills/factory-plan/SKILL.md"), "---\nname: factory-plan\n---\nPlan it.\n");
      const probe = "fake-probe-value-7m1";
      const out = '"$FACTORY_ARTIFACT_DIR"';
      const agent = [
        `wc -c < /dev/stdin > ${out}/prompt-bytes`,
        `uname -s > ${out}/kernel`,
        `echo "probe=$PROBE host=\${FACTORY_TEST_HOST_ONLY:-unset}" > ${out}/env`,
        `node -e 'fetch("https://httpbin.org/headers",{headers:{"X-P":process.env.PROBE}}).then(r=>r.text()).then(t=>process.stdout.write(t))' > ${out}/sent`,
      ].join("; ");
      Object.assign(process.env, { PROBE: probe, FACTORY_TEST_HOST_ONLY: "leaked" });
      try {
        await new CommandExecutor(
          { x: { command: ["sh", "-c", agent] } },
          { default: "x" },
          {},
          undefined,
          spec,
        ).runStage({ stage: "plan", issue: 7, cwd: d, maxBudgetUsd: 1 });
      } finally {
        delete process.env.PROBE;
        delete process.env.FACTORY_TEST_HOST_ONLY;
      }
      const read = (f: string) => readFileSync(join(d, ".factory/runs/issue-7", f), "utf8").trim();
      expect(Number(read("prompt-bytes"))).toBeGreaterThan(10);
      expect(read("kernel")).toBe("Linux");
      expect(read("env")).toBe("probe=$MSB_PROBE host=unset");
      expect(read("sent")).toContain(probe);
    },
    120_000,
  );

  // A real microVM and two public echo servers, so it runs only where msb is installed.
  test.skipIf(!Bun.which("msb"))(
    "live: an unlisted host is refused, and the key reaches only its own host",
    async () => {
      const probe = "fake-probe-value-3k9";
      const js = `const h={"X-P":process.env.PROBE};
for(const u of["https://httpbin.org/headers","https://postman-echo.com/headers","https://example.com"])
await fetch(u,{headers:h}).then(async r=>console.log(r.status,JSON.stringify(await r.text())),e=>console.log("err"));`;
      const d = mkdtempSync(join(tmpdir(), "factory-msb-"));
      writeFileSync(join(d, "probe.mjs"), js);
      const r = await new MicrosandboxExecution(spec, { ...process.env, PROBE: probe }).run(
        'echo "guest=$PROBE"; node probe.mjs; touch made; exit 4',
        d,
      );
      const [guest, own, other, unlisted] = r.stdout.trim().split("\n");
      expect(r.stderr).toBe("");
      expect(r.code).toBe(4);
      expect(guest).toBe("guest=$MSB_PROBE");
      expect(own).toStartWith("200 ");
      expect(own).toContain(probe);
      expect(other).toStartWith("403 ");
      expect(other).not.toContain(probe);
      expect(unlisted).toContain("network_policy_denied");
      expect(readdirSync(d)).toContain("made");
    },
    120_000,
  );
});
