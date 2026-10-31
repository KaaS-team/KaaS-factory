// The docker and wrap runtimes reach the network only through the egress proxy (src/egress-env.ts).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerArgs, withProxyNetwork } from "../src/adapters/docker/execution";
import { CMD, WrapExecution } from "../src/adapters/wrap/execution";
import { egressEnv, LOOPBACK } from "../src/egress-env";
import { runtimeProblems } from "../src/runtimes";

const tmp = (prefix: string) => {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), prefix));
};

describe("egress env", () => {
  test("points every proxy variable at the proxy and keeps NO_PROXY to loopback", () => {
    const env = egressEnv("http://127.0.0.1:9", ["registry.npmjs.org", "api.model.test"]);
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
    expect(env.https_proxy).toBe("http://127.0.0.1:9");
    expect(env.NO_PROXY).toBe(LOOPBACK);
    expect(env.FACTORY_EGRESS_ALLOW).toBe("registry.npmjs.org,api.model.test");
  });

  test("refuses an allow entry that is not a hostname", () => {
    expect(() => egressEnv("http://127.0.0.1:9", ["a.test,evil.test"])).toThrow('"a.test,evil.test" is not a hostname');
  });

  test("docker with an allow list uses the internal network and the proxy env; without it, none", () => {
    const spec = { kind: "docker", image: "node:22", allow: ["registry.npmjs.org"] } as const;
    const on = containerArgs(
      withProxyNetwork(spec, "factory-egress-t"),
      "true",
      "/w",
      "1:1",
      egressEnv("http://172.30.0.1:9", spec.allow),
    );
    expect(on[on.indexOf("--network") + 1]).toBe("factory-egress-t");
    expect(on).toContain("HTTPS_PROXY=http://172.30.0.1:9");
    const off = containerArgs({ kind: "docker", image: "node:22" }, "true", "/w", "1:1");
    expect(off[off.indexOf("--network") + 1]).toBe("none");
    expect(off.join(" ")).not.toContain("PROXY");
  });

  test("config accepts allow on docker and wrap", () => {
    expect(runtimeProblems({ d: { kind: "docker", image: "x", allow: ["a.test"] } })).toEqual([]);
    expect(runtimeProblems({ w: { kind: "wrap", argv: ["sh", "-c", "{cmd}"], allow: ["a.test"] } })).toEqual([]);
  });

  test("wrap runs the command with the proxy up: an allowed host goes through, an unlisted one is refused", async () => {
    const dir = tmp("egress-wrap-");
    const run = new WrapExecution({
      kind: "wrap",
      argv: ["bash", "-c", CMD],
      allow: ["only.test"],
    });
    const got = await run.run(
      `printf %s "$HTTPS_PROXY" > ${dir}/url; curl -s -o /dev/null -w '%{http_code}' "$HTTPS_PROXY/other.test/x"`,
      dir,
    );
    expect(got.stdout).toBe("403");
    expect(readFileSync(join(dir, "url"), "utf8")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("wrap without allow sets no proxy variable", async () => {
    const dir = tmp("egress-wrap-none-");
    const run = new WrapExecution({ kind: "wrap", argv: ["bash", "-c", CMD] });
    const got = await run.run('printf %s "${FACTORY_EGRESS_ALLOW-unset}"', dir);
    expect(got.stdout).toBe("unset");
  });
});
