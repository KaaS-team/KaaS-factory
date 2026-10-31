// An allow-listed docker run is confined to an internal network: no bridge, no direct route.
import { describe, expect, test } from "bun:test";
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

  const hasDocker = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  test.skipIf(!hasDocker)("a direct connection from the container has no route", async () => {
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
});
