// An allow-listed docker run is confined to an internal network: no bridge, no direct route.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { containerArgs, type DockerSpec, withProxyNetwork } from "../src/adapters/docker/execution";
import { createNetworkArgs, withInternalEgress } from "../src/adapters/docker/egress-network";
import { egressEnv } from "../src/egress-env";

const NET = "factory-egress-t";
const netOf = (a: string[]) => a[a.indexOf("--network") + 1];

describe("docker egress network", () => {
  test("no spec with an allow list names bridge or host, whatever network it asks for", () => {
    for (const network of [undefined, "bridge", "host", "none"]) {
      const spec: DockerSpec = { kind: "docker", image: "node:22", allow: ["a.test"], network };
      const args = containerArgs(
        withProxyNetwork(spec, NET),
        "true",
        "/w",
        "1:1",
        egressEnv("http://172.30.0.1:9", ["a.test"]),
      );
      expect(netOf(args)).toBe(NET);
      expect(args).not.toContain("bridge");
      expect(args).not.toContain("host");
      expect(args.join(" ")).not.toContain("host-gateway");
    }
  });

  test("the network is created --internal", () => {
    expect(createNetworkArgs(NET)).toEqual(["docker", "network", "create", "--internal", NET]);
  });

  test("a spec without an allow list is untouched", () => {
    const spec: DockerSpec = { kind: "docker", image: "node:22", network: "bridge" };
    expect(withProxyNetwork(spec, NET)).toEqual(spec);
  });

  // Needs a docker daemon, pulls busybox and waits on the network, so it flaked on PRs that touched nothing near
  // it (#567). Tagged: it runs in the non-blocking quarantine job. The other tests here pin the same argv.
  const hasDocker =
    Bun.spawnSync(["docker", "info"], { timeout: 60_000, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  test("a direct connection from the container has no route @quarantine", async () => {
    if (!hasDocker) return;
    const probe = await withInternalEgress(["a.test"], async (net) => {
      const p = Bun.spawn(
        [
          "docker",
          "run",
          "--rm",
          "--network",
          net,
          "busybox",
          "sh",
          "-c",
          "ip route; nc -w 3 1.1.1.1 80 </dev/null; echo rc=$?",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      return `${await new Response(p.stdout).text()}${await new Response(p.stderr).text()}`;
    });
    expect(probe).not.toContain("default via");
    expect(probe).not.toContain("rc=0");
  });

  // The live probe needs a daemon and the network, so it must stay out of the blocking run (#567).
  test("the live docker probe is quarantined, so it cannot fail an unrelated PR", () => {
    const ledger = JSON.parse(readFileSync("tests/quarantine.json", "utf8")) as { file: string; test: string }[];
    const mine = ledger.filter((e) => e.file === "tests/docker-egress-network.test.ts");
    expect(mine.map((e) => e.test)).toEqual(["a direct connection from the container has no route @quarantine"]);
    expect(readFileSync(import.meta.path, "utf8")).toContain(`test("${mine[0]!.test}"`);
  });
});
