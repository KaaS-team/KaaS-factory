import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { livePath } from "../src/paths";
import { connectControl, hostControl, parseRequest, serveControl, sshArgv } from "../src/ssh-control";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(): NodeJS.ProcessEnv {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "ssh-control-"));
  dirs.push(dir);
  const env = { FACTORY_HOME: dir };
  mkdirSync(join(dir, "acme", "app"), { recursive: true });
  writeFileSync(join(dir, "acme", "app", "factory.db"), "");
  return env;
}

function liveRun(env: NodeJS.ProcessEnv, issue: number): number {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  const file = livePath("acme/app", issue, env);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: child.pid, issue, stage: "build", agent: "claude" }));
  return child.pid as number;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("ssh control", () => {
  test("a request line is parsed, anything else is named as refused", () => {
    expect(parseRequest('{"op":"list"}')).toEqual({ op: "list" });
    expect(parseRequest('{"op":"cancel","repo":"a/b","issue":3}')).toEqual({ op: "cancel", repo: "a/b", issue: 3 });
    expect(parseRequest("nope")).toBe("not JSON");
    expect(parseRequest('{"op":"rm"}')).toBe("unknown op");
  });

  test("a host that ssh would read as an option is refused", () => {
    expect(() => sshArgv("-oProxyCommand=x")).toThrow("not a valid ssh host");
    expect(sshArgv("box")).toEqual(["ssh", "-T", "-o", "BatchMode=yes", "box", "factory", "runner", "control-serve"]);
  });

  test("serve answers list and cancel over a pair of streams", async () => {
    const env = home();
    const pid = liveRun(env, 7);
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (b: Buffer) => lines.push(...b.toString().split("\n").filter(Boolean)));
    const done = serveControl(input, output, hostControl(env));
    input.write(
      '{"op":"list"}\n{"op":"cancel","repo":"acme/app","issue":7}\n{"op":"cancel","repo":"../x","issue":1}\n',
    );
    input.end();
    await done;
    expect(JSON.parse(lines[0]!)).toEqual({
      ok: true,
      runs: [{ repo: "acme/app", issue: 7, stage: "build", agent: "claude" }],
    });
    expect(JSON.parse(lines[1]!)).toEqual({ ok: true, cancelled: true });
    expect(JSON.parse(lines[2]!).ok).toBe(false);
    await Bun.sleep(100);
    expect(alive(pid)).toBe(false);
  });

  test("the client lists and cancels through a spawned process standing in for ssh, with no port", async () => {
    const env = home();
    const pid = liveRun(env, 9);
    const stand = (extra: Record<string, string>) => [
      "env",
      ...Object.entries({ ...env, ...extra }).map(([k, v]) => `${k}=${v}`),
      "bun",
      join(import.meta.dir, "..", "bin", "factory"),
      "runner",
      "control-serve",
    ];
    const listed = await connectControl(stand({}), { op: "list" });
    expect(listed).toEqual({ ok: true, runs: [{ repo: "acme/app", issue: 9, stage: "build", agent: "claude" }] });
    const cancelled = await connectControl(stand({}), { op: "cancel", repo: "acme/app", issue: 9 });
    expect(cancelled).toEqual({ ok: true, cancelled: true });
    await Bun.sleep(100);
    expect(alive(pid)).toBe(false);
  });

  test("a failed ssh is an error, not a hang", async () => {
    await expect(connectControl(["false"], { op: "list" })).rejects.toThrow("exited 1");
  });
});
